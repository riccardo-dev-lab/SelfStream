# SelfStream — Architettura e Documentazione Tecnica

## Indice

1. [Panoramica del Sistema](#1-panoramica-del-sistema)
2. [Struttura dei File](#2-struttura-dei-file)
3. [Flusso Dati Completo](#3-flusso-dati-completo)
4. [Analisi Componente per Componente](#4-analisi-componente-per-componente)
5. [Sistema di Token e Proxy](#5-sistema-di-token-e-proxy)
6. [Gestione Qualità e Lingue](#6-gestione-qualità-e-lingue)
7. [Punti Fragili e Limitazioni](#7-punti-fragili-e-limitazioni)
8. [Miglioramenti Futuri](#8-miglioramenti-futuri)

---

## 1. Panoramica del Sistema

SelfStream è un **addon Stremio** che aggrega stream da tre sorgenti diverse (VixSrc, CinemaCity, VixCloud/AnimeUnity) e li serve attraverso un'unica interfaccia unificata.

Il server è un'applicazione **Express.js** deployata su Vercel come funzione serverless. Ogni richiesta è indipendente — non c'è stato persistente tra una richiesta e l'altra (eccetto la cache in memoria, che si azzera ad ogni cold start).

### Concetti Fondamentali

**Lazy Resolution**: CinemaCity non restituisce l'URL CDN diretto durante la fase di discovery — lo risolve solo quando l'utente clicca play. Questo perché i token CDN scadono in pochi minuti.

**Token System**: Invece di passare URL lunghi e header HTTP nei link (che potrebbero superare i limiti di lunghezza), il server registra gli header in una cache e li referenzia tramite un ID corto (`h1`, `h2`, ...). Questi ID vengono embeddati in token base64url.

**Provider Isolation**: Ogni sorgente (VixSrc, CinemaCity, VixCloud) è un modulo separato. Se uno fallisce, gli altri continuano.

**Config Encoding**: Le preferenze utente (lingua, sorgenti abilitate) sono encodate come token base64url nell'URL del manifest, tipo `/<token>/manifest.json`. Non c'è backend di autenticazione.

---

## 2. Struttura dei File

```
SelfStream/
├── api/
│   └── index.ts          # Entry point Vercel (re-esporta l'app Express)
├── src/
│   ├── addon.ts          # CORE: server Express, orchestrazione stream, proxy HLS
│   ├── config.ts         # Configurazione, tipi UserConfig, lingue disponibili
│   ├── proxy.ts          # Helpers token, cache header, risoluzione URL
│   ├── vixsrc.ts         # Scraper VixSrc.to (film e serie)
│   ├── vixcloud.ts       # Scraper AnimeUnity via VixCloud (anime)
│   ├── cinemacity.ts     # Scraper CinemaCity.cc (film e serie multilingua)
│   ├── landing.ts        # Generatore HTML pagina di configurazione
│   ├── cincit.js         # Implementazione legacy CinemaCity (non usata)
│   └── stremio-addon-sdk.d.ts  # Type stub minimale per l'SDK
├── docs/
│   └── ARCHITECTURE.md   # Questo file
├── Dockerfile.hf         # Docker per deploy HuggingFace/Koyeb
├── vercel.json           # Config Vercel (maxDuration, routes)
├── tsconfig.json
└── package.json
```

### Dipendenze tra file

```
api/index.ts
    └── src/addon.ts
            ├── src/config.ts         (AVAILABLE_LANGUAGES, UserConfig, encodeConfig/decodeConfig)
            ├── src/proxy.ts          (makeProxyToken, decodeProxyToken, resolveUrl, getAddonBase)
            ├── src/vixsrc.ts         (getVixSrcStreams)
            ├── src/vixcloud.ts       (getVixCloudStreams)
            ├── src/cinemacity.ts     (getCinemaCityStreams, extractFreshStreamUrl)
            └── src/landing.ts        (generateLandingPage)

src/vixsrc.ts, src/vixcloud.ts, src/cinemacity.ts
    └── src/proxy.ts                  (makeProxyToken, header constants)
    └── src/config.ts                 (config.tmdbApiKey, config.vixsrcDomain, ...)
```

---

## 3. Flusso Dati Completo

### 3.1 Discovery (Stremio chiede gli stream)

```
Stremio
  GET /<configToken>/stream/movie/tmdb:550.json
        │
        ▼
addon.ts — handleStream(type="movie", id="tmdb:550", userConfig)
        │
        ├─ 1. Parse ID
        │      tmdb:550 → tmdbId = "550"
        │
        ├─ 2. Fetch titolo da TMDB
        │      GET api.themoviedb.org/3/movie/550?api_key=...&language=it
        │      → "Fight Club"
        │
        ├─ 3. Query sorgenti in parallelo
        │
        │   ── VixSrc (vixsrc.ts) ──────────────────────────────────────
        │      a. GET vixsrc.to/api/movie/550 → {src: "/embed/xyz"}
        │      b. GET vixsrc.to/embed/xyz → HTML con window.masterPlaylist
        │      c. Estrai: token, expires, asn, serverUrl
        │      d. canPlayFHD? Se no → return []
        │      e. Costruisce URL HLS: cdn.server/playlist/xyz.m3u8?token=...
        │      f. makeProxyToken(url, VIXSRC_HEADERS)
        │         → registra headers in cache → id "h1"
        │         → token = base64url({u: url, hid: "h1", e: expire})
        │      g. Return: [{url: "/proxy/hls/manifest.m3u8?token=...", quality: "1080p"}]
        │
        │   ── CinemaCity (cinemacity.ts) ────────────────────────────
        │      a. GET tmdb/find/tmdb:550 → imdbId = "tt0137523"
        │      b. searchCinemaCity("tt0137523") → pageUrl
        │      c. Fetch pageUrl → estrai fileData (solo per verificare che esiste)
        │      d. Encode token lazy: base64url({page: pageUrl, lang: "it"})
        │      e. Return: [{url: "/proxy/cc/manifest.m3u8?token=..."}]
        │
        ├─ 4. Arricchisci stream (addon.ts, handleStream)
        │      s.name = "VixSrc 🤌"
        │      s.title = "🎬 Fight Club\n🇮🇹 Italiano · 1080p"
        │      s.behaviorHints = {bingeGroup: "ss-vix-550-s1"} (solo serie)
        │
        └─ Response: {streams: [{name, title, url}, {name, title, url}]}
```

### 3.2 Playback VixSrc (utente clicca play)

```
Player Stremio
  GET /proxy/hls/manifest.m3u8?token=<proxyToken>
        │
        ▼
addon.ts — endpoint /proxy/hls/manifest.m3u8
        │
        ├─ Decode token → {u: "https://cdn.../playlist.m3u8", hid: "h1", e: expire}
        ├─ lookupHeaders("h1") → {User-Agent: ..., Referer: ...}
        ├─ Se cache miss (cold start) → inferisce headers dall'URL
        ├─ Fetch upstream master playlist (CDN)
        ├─ Parsing varianti:
        │      #EXT-X-STREAM-INF:RESOLUTION=1920x1080,BANDWIDTH=4000000
        │      https://cdn.../1080p.m3u8
        │      #EXT-X-STREAM-INF:RESOLUTION=1280x720,BANDWIDTH=2000000
        │      https://cdn.../720p.m3u8
        │
        ├─ Filtra: solo varianti >= 1080p
        ├─ Prende il best (1080p in questo caso, 720p scartata)
        ├─ Riscrive URL: makeProxyToken(segmentUrl, headers)
        └─ Restituisce playlist riscritta:
               #EXTM3U
               #EXT-X-STREAM-INF:RESOLUTION=1920x1080,...
               /proxy/hls/manifest.m3u8?token=<segmentToken>

Player
  GET /proxy/hls/manifest.m3u8?token=<segmentToken>  (media playlist)
        │
        ▼
addon.ts — stessa rotta, ora è una media playlist (segmenti)
        │
        ├─ Riscrive ogni segmento:
        │      https://cdn.../seg001.ts → /proxy/hls/segment.ts?token=<segToken>
        └─ Restituisce media playlist riscritta

Player — loop segmenti
  GET /proxy/hls/segment.ts?token=<segToken>
        │
        ▼
addon.ts — endpoint /proxy/hls/segment.ts
        ├─ Decode token → {u: segmentUrl, h: headers}
        ├─ Fetch segmento CDN con headers
        ├─ (opzionale) Rimuove PNG header finto se presente
        └─ Piped stream → player
```

### 3.3 Playback CinemaCity (lazy resolve)

```
Player Stremio
  GET /proxy/cc/manifest.m3u8?token=<pageToken>
        │
        ▼
addon.ts — endpoint /proxy/cc/manifest.m3u8
        │
        ├─ Decode pageToken → {page: "https://cinemacity.cc/film-xyz.html", lang: "it"}
        │
        ├─ extractFreshStreamUrl(pageUrl, season, episode)  [cinemacity.ts]
        │      ├─ Fetch pagina HTML ORA (token CDN freschi al momento del click)
        │      ├─ extractFileData(): Trova script con atob(), decodifica
        │      ├─ pickStream(): Naviga struttura cartelle stagione/episodio
        │      ├─ extractPlayerReferer(): Trova <iframe src="*player.php*">
        │      ├─ buildStreamHeaders(): Costruisce headers con Referer = player.php URL
        │      └─ Return: {url: "https://cdn.../stream.m3u8", headers: {...}, subtitles: [...]}
        │
        ├─ Fetch master playlist CDN con headers freschi
        ├─ Seleziona variante 1080p+
        ├─ Inietta sottotitoli come #EXT-X-MEDIA:TYPE=SUBTITLES
        ├─ Riscrive tutti gli URI attraverso proxy
        └─ Restituisce playlist riscritta
```

---

## 4. Analisi Componente per Componente

### 4.1 config.ts

Centralizza tutta la configurazione del sistema. Espone:

- `config` — oggetto runtime con TMDB API key (da ENV), domini VixSrc/VixCloud
- `AVAILABLE_LANGUAGES` — array 43 lingue con `{code, label, flag}` (es. `{code: "it", label: "Italiano", flag: "🇮🇹"}`)
- `UserConfig` — interfaccia TypeScript con 5 campi: `vixEnabled`, `vixLang`, `cinemacityEnabled`, `cinemacityLang`, `animeunityEnabled`
- `DEFAULT_CONFIG` — tutte le sorgenti abilitate, lingua inglese
- `encodeConfig/decodeConfig` — conversione UserConfig ↔ token base64url

Il decode è fail-safe: qualsiasi errore di parsing restituisce DEFAULT_CONFIG.

### 4.2 proxy.ts

Il modulo più critico per le performance. Tre responsabilità:

**1. Cache header (righe 24-47)**

Gli header HTTP per le richieste CDN (User-Agent, Referer, Cookie, ecc.) vengono salvati in una Map in memoria con un TTL. Al posto di embeddare gli header interi nel token, si embeddisce solo un ID corto (`h1`, `h2`, ...). Risparmio: da ~1500 chars per token a ~300.

La pulizia è lazy: avviene durante `registerHeaders()` ad ogni nuova registrazione, non con un timer (che sarebbe inutile in serverless).

**2. Token encoding (righe 57-65)**

`makeProxyToken(url, headers, ttlMs)`:
- Registra headers nella cache → ottiene ID
- Crea payload: `{u: url, hid: "h1", e: expireTimestamp}`
- Serializza con `JSON.stringify` → `Buffer.from(...).toString('base64url')`

`decodeProxyToken(token)`:
- Deserializza il token
- Risolve headers: da cache se disponibile, altrimenti inferisce dall'URL (fallback cold start)
- Il fallback inferisce: URL contiene "vixsrc.to" → VIXSRC_HEADERS, "vixcloud" → VIXCLOUD_HEADERS, altri → headers generici

**3. Helpers URL (righe 94-132)**

`resolveUrl(base, relative)` — converte URL relativi in assoluti usando l'URL API nativa con fallback manuale.

`getAddonBase(req)` — costruisce l'URL pubblico dell'addon partendo dagli header della request (`x-forwarded-proto`, `x-forwarded-host`). Gestisce anche il caso specifico di BeamUp (platform di hosting).

### 4.3 vixsrc.ts

Scraping in due fasi:

**Fase 1 — API Resolution**
Chiama `/api/movie/<tmdbId>` o `/api/tv/<tmdbId>/<s>/<e>` di VixSrc → ottiene l'URL embed del player.

**Fase 2 — Embed Extraction**
Fetcha la pagina embed, trova lo script con `window.masterPlaylist`, estrae con regex:
- `token` — token di autenticazione CDN
- `expires` — scadenza timestamp
- `asn` — AS number (geo-detection CDN)
- `url` — URL base del server playlist

Controlla `window.canPlayFHD = true` per sapere se il contenuto è in 1080p. Se non FHD → restituisce array vuoto (nessuno stream sotto 1080p).

Costruisce URL finale: `serverUrl/playlist/xyz.m3u8?token=...&expires=...&lang=it&h=1`

### 4.4 cinemacity.ts

Il modulo più complesso per la struttura dati che deve gestire.

**Autenticazione**: Cookie hardcoded `dle_user_id=32729; dle_password=...`. La CDN è IP-locked (solo il server può accedere, non il client direttamente).

**Flusso discovery**:
1. Fetcha IMDB ID da TMDB (serve per ricerca più affidabile)
2. Cerca su CinemaCity: prima per IMDB ID, poi per titolo localizzato, poi inglese
3. Verifica che la pagina abbia contenuto riproducibile (fetch + estrazione fileData)
4. Restituisce solo il token lazy (non l'URL CDN)

**Decodifica fileData** — la parte più delicata:
- Ogni pagina contiene uno `<script>` con `atob("base64string")`
- Il contenuto decodificato contiene un oggetto JS con `file: [...]` o `sources: [...]`
- Per i film: array piatto di file
- Per le serie: struttura annidata `{folder: [{title: "Season 1", folder: [{title: "Episode 1", file: "..."}]}]}`

**Navigazione stagione/episodio** — usa regex multilingua:
- Stagione: `(?:season|stagione|s)\s*0*<num>`
- Episodio: `(?:episode|episodio|e)\s*0*<num>`
- Fallback: accesso per indice se le regex non matchano

**Headers critici**: Il CDN verifica `Referer = URL del player.php` (l'iframe interno alla pagina), non l'URL della pagina stessa. Se il Referer è sbagliato → 403.

### 4.5 vixcloud.ts

Gestisce l'anime via AnimeUnity + VixCloud embed. Strategia a cascata:

**Percorso principale (animemapping)**:
1. `animemapping.stremio.dpdns.org/kitsu/<id>?ep=<n>` → path AnimeUnity + eventuale remapping episodio
2. Fetch pagina anime → trova `<video-player episodes="[...]">` → JSON.parse episodi
3. Trova episodio per numero → URL episodio
4. Fetch pagina episodio → estrae URL embed VixCloud
5. `extractVixCloudManifest()` → estrae token CDN, costruisce URL HLS

**Fallback (ricerca per titolo)**:
1. Fetch titolo da API Kitsu
2. Ottieni sessione AnimeUnity (CSRF token + cookie da home page)
3. POST ricerca → primo risultato
4. Continua dal punto 2 del percorso principale

**Remapping episodi**: Il mapping Kitsu → AnimeUnity gestisce casi dove lo stesso anime è diviso in più serie su AnimeUnity (es. Bleach TV + Bleach OVA).

### 4.6 landing.ts

Genera la pagina HTML di configurazione. È una funzione che restituisce una stringa HTML completa con CSS e JavaScript embeddati.

Il JavaScript nella pagina implementa gli stessi algoritmi di `encodeConfig/decodeConfig` di config.ts (ma in vanilla JS, senza import). L'URL del manifest viene costruito come `<addonBase>/<encodeConfig(userConfig)>/manifest.json`.

L'installazione avviene tramite redirect a `stremio://<manifestUrl>` (URI scheme Stremio).

### 4.7 addon.ts

Il file principale. Tre aree principali:

**Area 1 — Orchestrazione stream (handleStream)**
- Parsing ID (tmdb:, tt, kitsu: prefixes)
- Fetch titolo TMDB
- Query parallela sorgenti
- Arricchimento stream (name, title, behaviorHints)

**Area 2 — Proxy CinemaCity lazy** (`/proxy/cc/manifest.m3u8`)
- Risolve l'URL CDN fresco al momento del click
- Gestisce sia HLS (riscrittura playlist) che MP4 (redirect 302)
- Inietta sottotitoli come `#EXT-X-MEDIA:TYPE=SUBTITLES`
- Imposta lingua preferita come `DEFAULT=YES`

**Area 3 — Proxy HLS generico** (`/proxy/hls/manifest.m3u8`, `/proxy/hls/segment.ts`)
- Riscrive master playlist: filtra varianti, seleziona 1080p+, riscrive URI
- Riscrive media playlist: converte ogni segmento in URL proxy
- Streama segmenti TS con backpressure (`pipeline()`)
- Rimuove PNG header finto da alcuni CDN (8 byte signature)
- Serve sottotitoli: wrapper M3U8 + proxy VTT con timestamp sync per HLS

---

## 5. Sistema di Token e Proxy

### Formato token proxy

```
Payload JSON:
{
  "u": "https://cdn.example.com/playlist.m3u8?token=xxx",
  "hid": "h1",
  "e": 1720000000000
}

Dopo base64url:
eyJ1IjoiaHR0cHM6Ly9jZG4u...
```

Il token viene passato come query param: `/proxy/hls/manifest.m3u8?token=<token>`

### Formato token lazy CinemaCity

```
Payload JSON:
{
  "page": "https://cinemacity.cc/film-xyz.html",
  "s": 1,
  "e": 3,
  "lang": "it"
}
```

### Ciclo di vita dei token

| Token | TTL default | Generato da | Usato da |
|-------|------------|-------------|----------|
| Proxy HLS (master) | 6 ore | vixsrc.ts, vixcloud.ts | /proxy/hls/manifest.m3u8 |
| Proxy HLS (segmento) | 6 ore | addon.ts proxy | /proxy/hls/segment.ts |
| Proxy HLS (segmento media) | 30 min | addon.ts proxy CC | /proxy/hls/manifest.m3u8 |
| Lazy CinemaCity | nessuno | cinemacity.ts | /proxy/cc/manifest.m3u8 |
| Config utente | permanente | landing.ts JS | addon.ts route param |

---

## 6. Gestione Qualità e Lingue

### Filtro qualità

**VixSrc**: Se `canPlayFHD = false` nel JavaScript embed → stream scartato completamente. Nessun fallback a 720p.

**Proxy HLS**: Quando si riscrive una master playlist, si filtra:
```
varianti → filtra height >= 1080 → se vuoto: usa best disponibile (log warning)
```
Solo la variante migliore sopra soglia viene inclusa nella playlist riscritta. Le altre sono scartate.

### Display lingua in Stremio

Il campo `title` dello stream supporta `\n` per righe multiple:
```
name:  "VixSrc 🤌"
title: "🎬 Fight Club
        🇮🇹 Italiano · 1080p"
```

Il flag e il label vengono risolti da `AVAILABLE_LANGUAGES` in config.ts tramite `getLangInfo(langCode)`.

CinemaCity mostra `HD` invece di una risoluzione specifica perché la risoluzione reale è sconosciuta fino al playback (lazy proxy).

### Binge watching (serie)

Per le serie, ogni stream riceve:
```javascript
behaviorHints: {
  bingeGroup: "ss-vix-<tmdbId>-s<season>"  // VixSrc
  bingeGroup: "ss-cc-<tmdbId>-s<season>"   // CinemaCity
}
```

Tutti gli episodi della stessa stagione dalla stessa sorgente hanno lo stesso `bingeGroup`. Stremio usa questo per l'autoplay: dopo la fine di un episodio, cerca automaticamente il successivo con lo stesso gruppo.

---

## 7. Punti Fragili e Limitazioni

### Cookie hardcoded (CinemaCity)

```typescript
// cinemacity.ts, riga 12
'Cookie': 'dle_user_id=32729; dle_password=894171c6a8dab18ee594d5c652009a35;'
```

Questi cookie appartengono a un account specifico. Scadono periodicamente. Quando scadono, CinemaCity smette di funzionare (Cloudflare rileva la sessione non valida). Il codice rileva questo scenario (`"Just a moment"` in response) e fallisce gracefully, ma richiede aggiornamento manuale.

**Fix futuro**: spostare in ENV, implementare re-login automatico, o usare un account premium dedicato.

### Regex scraping fragile

Tutti e tre i provider sono basati su parsing HTML/JS con regex. Se i provider cambiano la struttura della pagina:

| Provider | Cosa si rompe | Dove |
|----------|--------------|------|
| VixSrc | Estrazione token/expires/url | vixsrc.ts righe 95-107 |
| VixCloud | Estrazione window.masterPlaylist | vixcloud.ts righe 210-234 |
| CinemaCity | Decodifica atob + struttura fileData | cinemacity.ts righe 87-129 |

Ogni modifica ai siti sorgente può richiedere un fix di regex.

### Header cache — cold start serverless

Su Vercel la funzione può essere "spenta" quando non riceve traffico. Al riavvio, la cache header è vuota. I token emessi prima del riavvio hanno `hid: "h1"` ma la cache non conosce più "h1".

Il fallback per inferenza dall'URL copre il 95% dei casi (headers standardizzati per sorgente), ma per CinemaCity i headers includono cookies e referer specifici per pagina — il fallback generico potrebbe non funzionare.

**Fix futuro**: embeddare headers critici direttamente nel token (con dimensione accettabile), o usare Redis/KV store per la cache.

### Filtro 1080p — nessun fallback a 720p su VixSrc

Se `canPlayFHD = false`, VixSrc non restituisce nessuno stream. Il contenuto potrebbe esistere ma solo in 720p, e l'utente non vede nulla.

**Fix futuro**: aggiungere opzione configurabile dall'utente (`minQuality: "720p" | "1080p" | "4K"`).

### Nessuna firma sui token

I token proxy non sono firmati crittograficamente. Un utente che intercetta un token può modificarlo (cambiare l'URL o il `hid`). Non è un problema di sicurezza critico (l'addon è pubblico, nessun dato sensibile nei token), ma è una nota importante.

---

## 8. Miglioramenti Futuri

### 8.1 Cookie CinemaCity → variabile d'ambiente

**Priorità**: Alta  
**Effort**: Basso

Spostare il cookie in una ENV var:
```typescript
// cinemacity.ts
'Cookie': process.env.CINEMACITY_COOKIE || ''
```

Permette di aggiornare il cookie senza fare deploy, direttamente dalla dashboard Vercel.

### 8.2 Cache header persistente (Redis/KV)

**Priorità**: Media  
**Effort**: Medio

La Vercel KV (basata su Upstash Redis) permetterebbe di condividere la cache header tra istanze e tra riavvii:

```typescript
import { kv } from '@vercel/kv';

async function registerHeaders(headers, ttlMs) {
  const id = 'h' + hash(headers);
  await kv.set(id, headers, { px: ttlMs });
  return id;
}
```

Risolverebbe definitivamente il problema del cold start.

### 8.3 Qualità configurabile per utente

**Priorità**: Media  
**Effort**: Medio

Aggiungere a `UserConfig`:
```typescript
minQuality: '720p' | '1080p' | '4K'
```

La landing page mostrarebbe un selector. Il filtro nel proxy HLS userebbe `minQuality` invece di un valore hardcoded.

### 8.4 Aggiunta nuove sorgenti

Il pattern è ben definito. Una nuova sorgente richiede:
1. Un modulo `src/<sorgente>.ts` che esporta `get<Sorgente>Streams(tmdbId, ...) → stream[]`
2. Aggiunta in `UserConfig` in config.ts (`<sorgente>Enabled: boolean`)
3. Chiamata in `handleStream()` in addon.ts
4. Toggle nella landing page (landing.ts)

Sorgenti candidate: SuperStream, 2embed, vidsrc.xyz, FlixHQ.

### 8.5 Cache titoli TMDB

**Priorità**: Bassa  
**Effort**: Basso

Attualmente ogni richiesta stream fa 1-2 chiamate TMDB per il titolo. Con Vercel KV si potrebbe cachare:

```typescript
const cacheKey = `tmdb:${type}:${id}:${lang}`;
const cached = await kv.get(cacheKey);
if (cached) return cached as string;
// ... fetch + kv.set(cacheKey, title, { ex: 86400 })
```

TTL di 24 ore sarebbe appropriato per dati TMDB (cambiano raramente).

### 8.6 Health check endpoint

**Priorità**: Bassa  
**Effort**: Basso

Un endpoint `/health` che testa tutte le sorgenti e restituisce il loro stato:

```json
{
  "vixsrc": "ok",
  "cinemacity": "error: cloudflare_challenge",
  "vixcloud": "ok",
  "tmdb": "ok"
}
```

Utile per debugging e monitoraggio.

### 8.7 Timeout espliciti sulle richieste HTTP

**Priorità**: Media  
**Effort**: Basso

Attualmente nessuna richiesta ai provider ha un timeout esplicito. Se un provider non risponde, la richiesta Stremio aspetta fino al timeout di Vercel (30 secondi con configurazione attuale).

```typescript
const { body } = await request(url, {
  headers,
  bodyTimeout: 8000,
  headersTimeout: 5000,
});
```

Permetterebbe di fallire velocemente e mostrare gli altri stream disponibili.

### 8.8 Tipizzazione completa SDK Stremio

**Priorità**: Bassa  
**Effort**: Basso

`stremio-addon-sdk.d.ts` è attualmente solo:
```typescript
declare module 'stremio-addon-sdk';
```

Aggiungere tipi completi eliminerebbe tutti i `as any` in addon.ts e renderebbe il codice più sicuro da modificare.

---

## Note sulla Struttura Dati Stremio

Un oggetto stream restituito a Stremio ha questa forma:

```typescript
{
  name: string,           // Badge sorgente (es. "VixSrc 🤌")
  title: string,          // Descrizione stream, supporta \n per righe multiple
  url: string,            // URL HLS/MP4 o URL proxy locale
  quality?: string,       // Etichetta qualità (es. "1080p") — ignorato da Stremio UI
  behaviorHints?: {
    bingeGroup?: string,  // Abilita autoplay serie (stessa stringa = stesso gruppo)
    proxyHeaders?: {      // Headers per richieste dirette del player (non usato qui)
      request?: Record<string, string>
    }
  }
}
```

Il campo `quality` non è visualizzato da Stremio nell'UI — le info qualità devono essere nel campo `title` per essere visibili all'utente.
