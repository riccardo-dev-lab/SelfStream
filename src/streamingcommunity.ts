/**
 * StreamingCommunity scraper
 *
 * SC usa Inertia.js (Laravel) — le richieste JSON richiedono:
 *   X-Inertia: true + X-XSRF-TOKEN + session cookie
 *
 * Flusso:
 *   1. Sessione   → home page → XSRF-TOKEN + session cookie + Inertia version
 *   2. Ricerca    → /en/search?q=<titolo> → trova id + slug SC
 *   3. Episodio   → /en/<id>/<slug> → trova episode_id per S+E
 *   4. Embed URL  → /en/<id>/<slug>?episode_id=<n> → iframe vixcloud.co/embed/<n>?token=...
 *   5. Manifest   → extractVixCloudManifest() già implementato in vixcloud.ts
 */

import { request } from 'undici';
import { config } from './config';
import { extractVixCloudManifest } from './vixcloud';
import { makeProxyToken, VIXCLOUD_HEADERS, fetchHLSVariants } from './proxy';

const SC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SC_DOMAIN_FALLBACKS = [
    'streamingcommunity.buzz',
    'streamingcommunity.properties',
    'streamingcommunity.computer',
    'streamingcommunity.website',
    'streamingcommunity.show',
    'streamingcommunity.top',
    'streamingcommunityz.moe',
];

let cachedSCDomain: string | null = null;

async function findActiveSCDomain(preferred: string): Promise<string> {
    const candidates = [preferred, ...SC_DOMAIN_FALLBACKS]
        .filter((d, i, arr) => arr.indexOf(d) === i);

    const found = await Promise.any(
        candidates.map(async domain => {
            const { statusCode } = await request(`https://${domain}/en`, {
                method: 'HEAD',
                headers: { 'User-Agent': SC_UA },
                headersTimeout: 5000,
                bodyTimeout: 500,
            });
            if (statusCode < 400) return domain;
            throw new Error(`dead: ${domain}`);
        })
    ).catch(() => preferred);

    if (found !== preferred) console.log(`[SC] Domain discovery: ${preferred} → ${found}`);
    return found;
}

const SC_BASE_HEADERS: Record<string, string> = {
    'User-Agent': SC_UA,
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'DNT': '1',
    'sec-fetch-site': 'same-origin',
};

interface SCSession {
    cookie: string;
    xsrfToken: string;
    inertiaVersion: string;
}

// ── 1. Sessione ─────────────────────────────────────────────────────────────

async function getSCSession(domain: string): Promise<SCSession | null> {
    try {
        const { headers, body } = await request(`https://${domain}/en`, {
            headers: { ...SC_BASE_HEADERS, 'Accept': 'text/html,application/xhtml+xml' },
        });

        const html = await body.text();

        // Estrai cookies da Set-Cookie
        const rawCookies = headers['set-cookie'];
        const cookieArr = Array.isArray(rawCookies) ? rawCookies : rawCookies ? [rawCookies] : [];

        let xsrfEncoded = '';
        let sessionEncoded = '';

        for (const c of cookieArr) {
            const match = c.match(/^([\w-][\w-]*)=([^;]+)/);
            if (!match) continue;
            if (match[1] === 'XSRF-TOKEN') xsrfEncoded = match[2];
            if (match[1] === 'streamingcommunity_session') sessionEncoded = match[2];
        }

        if (!xsrfEncoded || !sessionEncoded) {
            console.log('[SC] Could not extract session cookies');
            return null;
        }

        const cookie = `XSRF-TOKEN=${xsrfEncoded}; streamingcommunity_session=${sessionEncoded}`;
        // Il token nel header va URL-decoded
        const xsrfToken = decodeURIComponent(xsrfEncoded);

        // Estrai Inertia version dal data-page attribute nell'HTML
        // Formato: data-page="{...&quot;version&quot;:&quot;abc123&quot;...}"
        let inertiaVersion = '';
        // data-page è HTML-encoded: &quot; invece di "
        const versionMatch =
            html.match(/&quot;version&quot;\s*:\s*&quot;([^&]+)&quot;/) ||
            html.match(/"version"\s*:\s*"([^"]+)"/);
        if (versionMatch) inertiaVersion = versionMatch[1];

        console.log(`[SC] Session ok, inertia version: ${inertiaVersion}`);
        return { cookie, xsrfToken, inertiaVersion };
    } catch (err) {
        console.error('[SC] Session error:', err);
        return null;
    }
}

// ── 2. Inertia fetch helper ──────────────────────────────────────────────────

async function inertiaGet(url: string, session: SCSession): Promise<any> {
    const headers: Record<string, string> = {
        ...SC_BASE_HEADERS,
        'Accept': 'text/html, application/xhtml+xml',
        'Cookie': session.cookie,
        'X-Inertia': 'true',
        'X-Requested-With': 'XMLHttpRequest',
        'X-XSRF-TOKEN': session.xsrfToken,
        'Referer': url,
    };
    if (session.inertiaVersion) headers['X-Inertia-Version'] = session.inertiaVersion;

    const { body, statusCode } = await request(url, { headers });

    if (statusCode === 200) return await body.json();

    // 409 = Inertia version mismatch — fallback: GET normale, parsa data-page dall'HTML
    if (statusCode === 409) {
        console.log('[SC] Inertia 409, falling back to full HTML parse...');
        await body.text(); // drain
        const { body: body2, statusCode: sc2 } = await request(url, {
            headers: {
                ...SC_BASE_HEADERS,
                'Accept': 'text/html,application/xhtml+xml',
                'Cookie': session.cookie,
                'Referer': url,
            },
        });
        if (sc2 !== 200) throw new Error(`[SC] HTTP ${sc2} on HTML fallback`);
        const html = await body2.text();
        const match = html.match(/data-page="([^"]+)"/);
        if (!match) throw new Error('[SC] No data-page attribute in HTML fallback');
        return JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&'));
    }

    throw new Error(`[SC] HTTP ${statusCode} for ${url}`);
}

// ── 3. Ricerca titolo ────────────────────────────────────────────────────────

async function searchTitle(
    domain: string,
    query: string,
    type: string,
    session: SCSession
): Promise<{ id: number; slug: string } | null> {
    const url = `https://${domain}/en/search?q=${encodeURIComponent(query)}`;
    const data = await inertiaGet(url, session);
    const titles: any[] = data?.props?.titles || [];

    const scType = type === 'series' ? 'tv' : 'movie';
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const qn = norm(query);

    // 1. Match esatto nome + tipo
    let match = titles.find((t: any) => t.type === scType && norm(t.name) === qn);
    // 2. Match parziale
    if (!match) match = titles.find((t: any) =>
        t.type === scType && (norm(t.name).includes(qn) || qn.includes(norm(t.name)))
    );
    // 3. Primo risultato del tipo corretto
    if (!match) match = titles.find((t: any) => t.type === scType);

    if (!match) return null;
    console.log(`[SC] Match: ${match.name} (id=${match.id}, slug=${match.slug})`);
    return { id: match.id, slug: match.slug };
}

// ── 4. Trova episode_id ──────────────────────────────────────────────────────

async function getEpisodeId(
    domain: string,
    titleId: number,
    slug: string,
    season: number,
    episode: number,
    session: SCSession
): Promise<number | null> {
    const url = `https://${domain}/en/${titleId}/${slug}`;
    const data = await inertiaGet(url, session);

    // SC può esporre stagioni in vari percorsi nei props
    const seasons: any[] =
        data?.props?.title?.seasons ||
        data?.props?.seasons ||
        data?.props?.loadTitle?.seasons ||
        [];

    if (!seasons.length) {
        console.log('[SC] No seasons found in page props');
        return null;
    }

    // Trova la stagione per numero
    const targetSeason =
        seasons.find((s: any) => s.number === season) ||
        seasons[season - 1];

    if (!targetSeason) {
        console.log(`[SC] Season ${season} not found (total: ${seasons.length})`);
        return null;
    }

    const episodes: any[] = targetSeason.episodes || [];
    const ep =
        episodes.find((e: any) => e.number === episode) ||
        episodes[episode - 1];

    if (!ep) {
        console.log(`[SC] Episode ${episode} not found in season ${season}`);
        return null;
    }

    console.log(`[SC] Episode ID: ${ep.id} (S${season}E${episode})`);
    return ep.id;
}

// ── 5. Ottieni URL embed VixCloud ────────────────────────────────────────────
// SC serve il player tramite /it/iframe/<titleId>?episode_id=<episodeId>
// L'HTML di quella pagina contiene l'<iframe src="https://vixcloud.co/embed/...">

async function getEmbedUrl(
    domain: string,
    titleId: number,
    episodeId: number | null,
    lang: string,
    session: SCSession
): Promise<string | null> {
    let iframeUrl = `https://${domain}/it/iframe/${titleId}`;
    if (episodeId) iframeUrl += `?episode_id=${episodeId}&next_episode=1`;

    try {
        const { body, statusCode } = await request(iframeUrl, {
            headers: {
                ...SC_BASE_HEADERS,
                'Accept': 'text/html,application/xhtml+xml',
                'Cookie': session.cookie,
                'Referer': `https://${domain}/it/watch/${titleId}`,
                'X-XSRF-TOKEN': session.xsrfToken,
            },
        });

        if (statusCode !== 200) {
            console.log(`[SC] iframe endpoint returned ${statusCode}`);
            return null;
        }

        const html = await body.text();

        // L'HTML contiene <iframe src="https://vixcloud.co/embed/<id>?token=...">
        const iframeMatch = html.match(/src=["'](https?:\/\/vixcloud\.co\/embed\/[^"']+)["']/);
        if (iframeMatch) {
            let embedUrl = iframeMatch[1].replace(/&amp;/g, '&');
            if (!embedUrl.includes('scz=')) embedUrl += '&scz=1';
            if (!embedUrl.includes('lang=')) embedUrl += `&lang=${lang}`;
            console.log(`[SC] Embed URL: ${embedUrl.substring(0, 80)}...`);
            return embedUrl;
        }

        console.log('[SC] No VixCloud iframe found in SC iframe page');
    } catch (err) {
        console.error('[SC] iframe endpoint error:', (err as any)?.message);
    }

    return null;
}

// ── Entry point pubblico ─────────────────────────────────────────────────────

export async function getSCStreams(
    tmdbId: string,
    type: string,
    season?: string,
    episode?: string,
    lang: string = 'en'
): Promise<any[]> {
    try {
        if (!cachedSCDomain) cachedSCDomain = await findActiveSCDomain(config.scDomain);
        const domain = cachedSCDomain;
        console.log(`[SC] id=${tmdbId}, type=${type}, S=${season}, E=${episode}, lang=${lang}, domain=${domain}`);

        // 1. Sessione
        const session = await getSCSession(domain);
        if (!session) {
            cachedSCDomain = null; // reset so next request re-discovers
            return [];
        }

        // 2. Titolo da TMDB (per la ricerca su SC che non ha tmdb_id)
        let titleName = '';
        try {
            let resp: Response;
            if (tmdbId.startsWith('tt')) {
                resp = await fetch(`https://api.themoviedb.org/3/find/${tmdbId}?api_key=${config.tmdbApiKey}&external_source=imdb_id&language=en`);
                const d = await resp.json() as any;
                titleName = d?.movie_results?.[0]?.title || d?.tv_results?.[0]?.name || '';
            } else {
                const tmdbType = type === 'series' ? 'tv' : 'movie';
                resp = await fetch(`https://api.themoviedb.org/3/${tmdbType}/${tmdbId}?api_key=${config.tmdbApiKey}&language=en`);
                const d = await resp.json() as any;
                titleName = d?.title || d?.name || '';
            }
        } catch {
            console.log('[SC] TMDB lookup failed');
            return [];
        }

        if (!titleName) { console.log('[SC] No title from TMDB'); return []; }
        console.log(`[SC] Searching SC for: "${titleName}"`);

        // 3. Cerca su SC
        const titleResult = await searchTitle(domain, titleName, type, session);
        if (!titleResult) { console.log(`[SC] No match for: ${titleName}`); return []; }

        const { id: titleId, slug } = titleResult;

        // 4. Trova episode_id (solo per serie)
        let episodeId: number | null = null;
        if (type === 'series' && season && episode) {
            episodeId = await getEpisodeId(domain, titleId, slug, parseInt(season), parseInt(episode), session);
            if (!episodeId) return [];
        }

        // 5. Ottieni URL embed VixCloud
        const embedUrl = await getEmbedUrl(domain, titleId, episodeId, lang, session);
        if (!embedUrl) { console.log('[SC] No embed URL'); return []; }

        // 6. Estrai manifest HLS (riusa la logica VixCloud già esistente)
        const hlsUrl = await extractVixCloudManifest(embedUrl);
        if (!hlsUrl) { console.log('[SC] VixCloud manifest extraction failed'); return []; }

        // 7. Fetch master manifest e restituisci una stream per ogni variante 4K/1080p
        const variants = await fetchHLSVariants(hlsUrl, VIXCLOUD_HEADERS);
        console.log(`[SC] Found ${variants.length} variant(s) ≥1080p`);

        if (variants.length > 0) {
            return [{
                name: 'StreamingCommunity 🤌',
                title: 'Stream',
                url: `/proxy/hls/manifest.m3u8?token=${makeProxyToken(hlsUrl, VIXCLOUD_HEADERS)}`,
                quality: variants[0].quality,
            }];
        }

        // Fallback: singolo stream con master manifest
        return [{
            name: 'StreamingCommunity 🤌',
            title: 'Stream',
            url: `/proxy/hls/manifest.m3u8?token=${makeProxyToken(hlsUrl, VIXCLOUD_HEADERS)}`,
            quality: '1080p',
        }];

    } catch (err: any) {
        console.error('[SC] Error:', err?.message || err);
        return [];
    }
}
