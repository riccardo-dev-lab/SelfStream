/**
 * Sports Live scraper — Multi-source catalog + stream resolution
 *
 * Sources:
 *   1. falconstreams.net — HTML + API (embedded event data, stream chain resolution)
 *   2. DaddyLive.org — JSON schedule + channel stream pages (m3u8 in HTML)
 *   3. PPV.TO — Nuxt.js API (events + streams)
 *
 * Vercel free tier constraints:
 *   - maxDuration: 30s (vercel.json)
 *   - Cache catalog aggressively (1 min TTL)
 *   - Resolve streams on-demand
 */
import { request } from 'undici';
import { makeProxyToken } from './proxy';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const FALCONSTREAMS_URL = 'https://falconstreams.net/';
const FALCON_API_URL = 'https://falconstreams.net/api/matches';

// ── DaddyLive.org constants ──
const DADDYLIVE_BASE = 'https://daddylive.org';
const DADDYLIVE_SCHEDULE = `${DADDYLIVE_BASE}/cache/tv/tv.json`;
const DADDYLIVE_TV2 = `${DADDYLIVE_BASE}/cache/tv2/tv2.json`;
const DADDYLIVE_STREAM = `${DADDYLIVE_BASE}/live/stream=`;

// ── PPV.TO constants ──
const PPV_API = 'https://api.ppv.to/api';

// ── Sport emoji map ──
export const SPORT_EMOJI: Record<string, string> = {
    'Football': '⚽', 'Soccer': '⚽', 'La-Liga': '⚽', 'La Liga': '⚽',
    'Premier-League': '⚽', 'Premier League': '⚽', 'Ligue-1': '⚽', 'Ligue 1': '⚽',
    'Championship': '⚽', 'Scottish-Premiership': '⚽', 'Scottish Premiership': '⚽',
    'MLS': '⚽', 'USA': '⚽', 'Saudi-Pro-League': '⚽', 'Saudi Pro League': '⚽',
    'Japan-J1-League': '⚽', 'J1-League': '⚽', 'Japan J1 League': '⚽',
    'Cricket': '🏏', 'Tennis': '🎾', 'WNBA': '🏀', 'NBA': '🏀',
    'UFC': '🥊', 'MMA': '🥊', 'Boxing': '🥊', 'WWE': '🥊', 'AEW': '🥊',
    'NFL': '🏈', 'NHL': '🏒', 'MLB': '⚾',
    'Formula-1': '🏎️', 'F1': '🏎️', 'Motorsport': '🏎️', 'MotoGP': '🏍️',
    'Golf': '⛳', 'Cycling': '🚴', 'Athletics': '🏃',
    'Rugby': '🏉', 'Basketball': '🏀', 'Baseball': '⚾',
    'Volleyball': '🏐', 'Handball': '🤾',
    'Important-Games': '⚡', 'Important Games': '⚡',
    'Other': '🏆',
    'tennis': '🎾',
    'Hockey': '🏒', 'Ice Hockey': '🏒', 'AHL Ice Hockey': '🏒',
    'ECHL Ice Hockey': '🏒', 'OHL Ice Hockey': '🏒',
    'QMJHL Ice Hockey': '🏒', 'WHL Ice Hockey': '🏒',
    'Baseball (MLB)': '⚾',
    'Combat sports': '🥊',
};

export interface SportEventMeta {
    id: string;
    name: string;
    sport: string;
    time: string;
    description: string;
    live: boolean;
    links: string[];
    embedHash: string;
    source: string; // 'falcon', 'daddylive', 'ppv'
}

export interface EncodedEvent {
    t: string;  // team match
    s: string;  // sport/league
    tm: string; // time or LIVE
    l: string[]; // links
    h: string;  // hash
    src?: string; // source identifier
}

let scheduleCache: { data: SportEventMeta[]; fetchedAt: number } | null = null;
const CACHE_TTL = 60 * 1000;

// ── HTML event interface (from falconstreams.net page) ──
interface HtmlEvent {
    _id: string;
    category: string;
    details: { text1: string; text2: string; text3: string; text4: string };
    directStreams: Array<{ link: string; name: string; streamer: string }>;
    iframeStreams: Array<{ name: string; src: string }>;
    matchStartTime: string;
    status: string;
    show: boolean;
}

// ── API event interface (from /api/matches) ──
interface ApiMatch {
    _id: string;
    category: string;
    details: { teamA: string; teamB: string };
    status?: string;
}

// ── DaddyLive event channel ──
interface DdlChannel {
    channel_name: string;
    channel_id: string;
}

// ── DaddyLive event ──
interface DdlEvent {
    time: string;
    event: string;
    channels: DdlChannel[];
}

// ── DaddyLive schedule (date-keyed object) ──
interface DdlSchedule {
    [dateKey: string]: { [category: string]: DdlEvent[] };
}

// ── PPV stream interface ──
interface PpvStream {
    id: string;
    name: string;
    url: string;
    country?: string;
    league?: string;
}

// ── PPV response ──
interface PpvResponse {
    success: boolean;
    timestamp: string;
    streams?: PpvStream[];
    [key: string]: any;
}

// ── Parse HTML events with escaped quotes (FalconStreams) ──
function parseHtmlEvents(html: string): HtmlEvent[] {
    const events: HtmlEvent[] = [];

    const idPattern = /\\\"_id\\\\\":\\\\\"([a-f0-9]{24})\\\\\"/g;
    let m: RegExpExecArray | null;

    while ((m = idPattern.exec(html)) !== null) {
        const idPos = m.index;

        const searchBack = html.slice(Math.max(0, idPos - 300), idPos);
        const eventStart = searchBack.lastIndexOf('{');
        if (eventStart < 0) continue;

        const globalOpenPos = idPos - 300 + eventStart;

        let depth = 0;
        let endPos = globalOpenPos;
        const maxSearch = Math.min(globalOpenPos + 3000, html.length);

        for (let i = globalOpenPos; i < maxSearch; i++) {
            const ch = html[i];
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) {
                    endPos = i + 1;
                    break;
                }
            }
        }

        if (endPos <= globalOpenPos) continue;

        const objStr = html.slice(globalOpenPos, endPos);
        const unescaped = objStr.replace(/\\\\\"/g, '"').replace(/\\\\\\\\/g, '\\');

        try {
            const obj = JSON.parse(unescaped) as HtmlEvent;
            if (obj.category && obj.details && obj.show && obj.status !== 'finished') {
                events.push(obj);
            }
        } catch {
            // Skip invalid JSON fragments
        }
    }

    return events;
}

// ── Scrape FalconStreams HTML ──
async function scrapeFalconHtml(): Promise<HtmlEvent[]> {
    try {
        const { body, statusCode } = await request(FALCONSTREAMS_URL, {
            headers: { 'User-Agent': UA, 'Referer': FALCONSTREAMS_URL },
            headersTimeout: 8000, bodyTimeout: 8000,
        });
        if (statusCode !== 200) { await body.text(); return []; }
        const html = await body.text();
        return parseHtmlEvents(html);
    } catch (err: any) {
        console.error('[Sports] FalconHTML scrape error:', err?.message);
        return [];
    }
}

// ── Scrape FalconStreams API ──
async function scrapeFalconApi(): Promise<ApiMatch[]> {
    try {
        const { body, statusCode } = await request(FALCON_API_URL, {
            headers: { 'User-Agent': UA, 'Referer': FALCONSTREAMS_URL },
            headersTimeout: 8000, bodyTimeout: 8000,
        });
        if (statusCode !== 200) { await body.text(); return []; }
        const json = await body.json() as any;
        return json?.matches || [];
    } catch (err: any) {
        console.error('[Sports] FalconAPI scrape error:', err?.message);
        return [];
    }
}

// ── DaddyLive schedule entry (preserves category) ──
interface DdlScheduleEntry {
    time: string;
    event: string;
    channels: DdlChannel[];
    category: string;
}

// ── Scrape DaddyLive.org schedule JSON ──
async function scrapeDaddyLiveSchedule(): Promise<DdlScheduleEntry[]> {
    const allEvents: DdlScheduleEntry[] = [];

    try {
        const { body, statusCode } = await request(DADDYLIVE_SCHEDULE, {
            headers: { 'User-Agent': UA, 'Referer': DADDYLIVE_BASE },
            headersTimeout: 8000, bodyTimeout: 8000,
        });
        if (statusCode !== 200) { await body.text(); return []; }
        const json = await body.json() as DdlSchedule;

        const dateKey = Object.keys(json)[0];
        if (!dateKey) return [];

        const schedule = json[dateKey];
        for (const category of Object.keys(schedule)) {
            const events = schedule[category];
            for (const ev of events) {
                allEvents.push({ ...ev, category });
            }
        }
    } catch (err: any) {
        console.error('[Sports] DaddyLive schedule error:', err?.message);
    }

    // Also fetch tv2 (popular live)
    try {
        const { body, statusCode } = await request(DADDYLIVE_TV2, {
            headers: { 'User-Agent': UA, 'Referer': DADDYLIVE_BASE },
            headersTimeout: 8000, bodyTimeout: 8000,
        });
        if (statusCode === 200) {
            const json = await body.json() as any;
            const popularKey = Object.keys(json)[0];
            if (popularKey && json[popularKey]?.['Live Events']) {
                for (const ev of json[popularKey]['Live Events']) {
                    const key = ev.event.toLowerCase().replace(/[^a-z0-9]/g, '');
                    if (!allEvents.find(e => e.event.toLowerCase().replace(/[^a-z0-9]/g, '') === key)) {
                        allEvents.push({ ...ev, category: 'Live Events' });
                    }
                }
            }
        }
    } catch (err: any) {
        console.error('[Sports] DaddyLive tv2 error:', err?.message);
    }

    return allEvents;
}

// ── Scrape PPV.TO streams API ──
async function scrapePpvStreams(): Promise<PpvStream[]> {
    try {
        const { body, statusCode } = await request(`${PPV_API}/streams`, {
            headers: { 'User-Agent': UA, 'Referer': 'https://ppv.to' },
            headersTimeout: 8000, bodyTimeout: 8000,
        });
        if (statusCode !== 200) { await body.text(); return []; }
        const json = await body.json() as PpvResponse;
        return json.streams || [];
    } catch (err: any) {
        console.error('[Sports] PPV streams error:', err?.message);
        return [];
    }
}

// ── Build iframe player URL from _id (Falcon) ──
function getPlayerUrl(hash: string): string {
    return `https://embedsports.top/embed/echo/${hash}`;
}

// ── Collect all stream links from an event ──
function collectStreamLinks(ev: HtmlEvent | ApiMatch): string[] {
    const links: string[] = [];

    if ('directStreams' in ev) {
        const htmlEv = ev as HtmlEvent;
        for (const ds of htmlEv.directStreams) {
            if (ds.link && !links.includes(ds.link)) {
                links.push(ds.link);
            }
        }
        for (const ifs of htmlEv.iframeStreams) {
            if (ifs.src && !links.includes(ifs.src)) {
                links.push(ifs.src);
            }
        }
    }

    if (links.length === 0 && '_id' in ev) {
        links.push(getPlayerUrl(ev._id));
    }

    return links;
}

// ── Extract m3u8 URLs from DaddyLive stream page ──
function extractM3u8FromDdlPage(html: string): string[] {
    const urls: string[] = [];
    const m3u8Pattern = /https?:\/\/[^"'\s<>]+\.(?:m3u8)[^"'\s<>]*/gi;
    const m = m3u8Pattern.exec(html);
    if (m) {
        urls.push(m[0].replace(/[\"']/g, ''));
    }
    return urls;
}

// ── Extract all iframe sources from HTML ──
function extractAllIframes(html: string): string[] {
    const sources: string[] = [];
    const iframePattern = /<iframe[^>]*src="([^"]*)"/gi;
    const exclusions = ['chatango', 'twitter', 'syndication', 'platform.twitter', 'fonts', 'waust', 'google'];
    let m: RegExpExecArray | null;
    const p = new RegExp(iframePattern.source, 'gi');
    while ((m = p.exec(html)) !== null) {
        const src = m[1];
        if (!exclusions.some(ex => src.toLowerCase().includes(ex)) && src.startsWith('http')) {
            sources.push(src);
        }
    }
    return sources;
}

// ── Resolve iframe chain recursively ──
// Follows: source URL → iframe → iframe → ... → m3u8 or final player
// Max depth: 5 levels
async function resolveStreamChain(
    url: string,
    depth: number = 0,
    visited: Set<string> = new Set()
): Promise<string | null> {
    if (depth > 5) return null;
    if (visited.has(url)) return null;
    visited.add(url);

    if (url.includes('.m3u8')) return url;

    try {
        const { body, statusCode } = await request(url, {
            headers: {
                'User-Agent': UA,
                'Referer': FALCONSTREAMS_URL,
            },
            headersTimeout: 8000,
            bodyTimeout: 10000,
            maxRedirections: 5,
        });

        if (statusCode !== 200) return null;
        const html = await body.text();

        // atob() encoded m3u8
        const atobMatches = Array.from(html.matchAll(/atob\('([^']+)'/gi));
        for (const match of atobMatches) {
            try {
                const decoded = Buffer.from(match[1], 'base64').toString('utf8');
                if (decoded.includes('.m3u8') || decoded.includes('/hls/') || decoded.includes('index.m3u')) {
                    let finalUrl = decoded;
                    if (!finalUrl.startsWith('http')) {
                        try { finalUrl = new URL(decoded, url).href; } catch { finalUrl = 'https://' + decoded; }
                    }
                    return finalUrl;
                }
            } catch { continue; }
        }

        // Direct m3u8 references
        const m3u8Matches = Array.from(html.matchAll(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi));
        for (const match of m3u8Matches) {
            let finalUrl = match[0].replace(/["']|;|\/$/, '');
            if (!finalUrl.startsWith('http')) {
                try { finalUrl = new URL(finalUrl, url).href; } catch { finalUrl = 'https://' + finalUrl; }
            }
            return finalUrl;
        }

        // Nested iframes
        const nestedIframes = extractAllIframes(html);
        for (const iframeUrl of nestedIframes) {
            const resolved = await resolveStreamChain(iframeUrl, depth + 1, visited);
            if (resolved) return resolved;
        }

        return null;
    } catch (err: any) {
        return null;
    }
}

// ── Resolve DaddyLive channel stream ──
async function resolveDaddyLiveStream(channelId: string): Promise<string | null> {
    const streamUrl = `${DADDYLIVE_STREAM}${channelId}`;

    try {
        const { body, statusCode } = await request(streamUrl, {
            headers: { 'User-Agent': UA, 'Referer': DADDYLIVE_BASE },
            headersTimeout: 10000, bodyTimeout: 15000,
            maxRedirections: 3,
        });

        if (statusCode !== 200) return null;
        const html = await body.text();

        // Extract m3u8 URLs from the HTML
        const m3u8s = extractM3u8FromDdlPage(html);
        if (m3u8s.length > 0) {
            return m3u8s[0];
        }

        // Try iframe chain
        const iframes = extractAllIframes(html);
        for (const iframe of iframes) {
            const resolved = await resolveStreamChain(iframe, 0, new Set());
            if (resolved) return resolved;
        }

        return null;
    } catch (err: any) {
        console.log(`[Sports] DaddyLive stream error for ${channelId}:`, err.message);
        return null;
    }
}

// ── Parse match name from DaddyLive event ──
function parseDdlMatchName(event: string): { teamA: string; teamB: string } {
    // Try "Team A vs Team B" pattern
    const vsMatch = event.match(/^(.+?)\s+vs\s+(.+)$/i);
    if (vsMatch) {
        return { teamA: vsMatch[1].trim(), teamB: vsMatch[2].trim() };
    }

    // Try "League : Team A vs Team B" pattern
    const colonMatch = event.match(/^(.+?)\s*:\s*(.+?)\s+vs\s+(.+)$/i);
    if (colonMatch) {
        return { teamA: colonMatch[2].trim(), teamB: colonMatch[3].trim() };
    }

    // Fallback
    return { teamA: event, teamB: '' };
}

// ── Merge all sources into schedule ──
async function fetchSchedule(): Promise<SportEventMeta[]> {
    const now = Date.now();
    if (scheduleCache && (now - scheduleCache.fetchedAt) < CACHE_TTL) {
        return scheduleCache.data;
    }

    // Fetch all sources in parallel
    const [falconHtml, falconApi, ddlEvents, ppvStreams] = await Promise.all([
        scrapeFalconHtml(),
        scrapeFalconApi(),
        scrapeDaddyLiveSchedule(),
        scrapePpvStreams(),
    ]);

    console.log(`[Sports] Sources: FalconHTML=${falconHtml.length}, FalconAPI=${falconApi.length}, DaddyLive=${ddlEvents.length}, PPV=${ppvStreams.length}`);

    // ── Process FalconStreams events ──
    const allEvents: (HtmlEvent | ApiMatch)[] = [];
    const seenFalcon = new Set<string>();

    for (const ev of falconHtml) {
        if (!seenFalcon.has(ev._id)) {
            seenFalcon.add(ev._id);
            allEvents.push(ev);
        }
    }
    for (const ev of falconApi) {
        if (!seenFalcon.has(ev._id)) {
            seenFalcon.add(ev._id);
            allEvents.push(ev);
        }
    }

    // ── Process DaddyLive events ──
    const ddlEventsList: { encoded: EncodedEvent; channels: DdlChannel[]; time: string; event: string; category: string }[] = [];
    const seenDdl = new Set<string>();

    for (const ev of ddlEvents) {
        const { teamA, teamB } = parseDdlMatchName(ev.event);
        const matchKey = `${teamA.toLowerCase()}|${teamB.toLowerCase()}`;
        if (seenDdl.has(matchKey)) continue;
        seenDdl.add(matchKey);

        const sport = ev.category.replace(/_/g, ' ').trim();

        const encoded: EncodedEvent = {
            t: ev.event,
            s: sport,
            tm: ev.time === 'Live' ? 'LIVE' : ev.time,
            l: [],
            h: `ddl:${ev.channels?.[0]?.channel_id || ''}`,
            src: 'daddylive',
        };

        ddlEventsList.push({
            encoded,
            channels: ev.channels || [],
            time: ev.time,
            event: ev.event,
            category: ev.category,
        });
    }

    // ── Process PPV streams ──
    const ppvEventsList: { encoded: EncodedEvent; stream: PpvStream }[] = [];
    const seenPpv = new Set<string>();

    for (const stream of ppvStreams) {
        if (!stream.name) continue;

        const nameKey = stream.name.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (seenPpv.has(nameKey)) continue;
        seenPpv.add(nameKey);

        const encoded: EncodedEvent = {
            t: stream.name,
            s: stream.league || 'Other',
            tm: 'LIVE',
            l: [stream.url],
            h: `ppv:${stream.id}`,
            src: 'ppv',
        };

        ppvEventsList.push({ encoded, stream });
    }

    // ── Convert FalconStreams events ──
    const events: SportEventMeta[] = [];

    for (const ev of allEvents) {
        const teamA = 'text2' in ev.details ? ev.details.text2 : ev.details.teamA;
        const teamB = 'text3' in ev.details ? ev.details.text3 : ev.details.teamB;
        const matchName = `${teamA} vs ${teamB}`;
        const league = ev.category.replace(/-/g, ' ');
        const emoji = SPORT_EMOJI[ev.category] || '🏆';
        const isLive = ev.status === 'live' || ev.status === 'started';

        const links = collectStreamLinks(ev);

        let timeStr = '';
        if ('matchStartTime' in ev) {
            const startTime = new Date(ev.matchStartTime as string);
            timeStr = startTime.toLocaleTimeString('en-US', {
                hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
            });
        }

        const encoded: EncodedEvent = {
            t: matchName, s: league,
            tm: isLive ? 'LIVE' : timeStr,
            l: links.slice(0, 3), h: ev._id, src: 'falcon',
        };

        events.push({
            id: makeSportId(encoded),
            name: `${emoji} ${matchName}`,
            sport: league,
            time: isLive ? 'LIVE' : timeStr,
            description: `${league} · ${isLive ? 'Live' : (ev.details as any).text1 || ''}`,
            live: isLive,
            links: links.slice(0, 3),
            embedHash: ev._id,
            source: 'falcon',
        });
    }

    // ── Convert DaddyLive events ──
    for (const { encoded, channels, time, event } of ddlEventsList) {
        const isLive = time === 'Live';
        const links: string[] = [];

        // Generate stream links for each channel (max 3)
        const channelIds = channels.slice(0, 3).map(c => c.channel_id).filter(Boolean);
        for (const cid of channelIds) {
            links.push(`${DADDYLIVE_STREAM}${cid}`);
        }

        // Add player URL fallback
        if (links.length === 0 && channelIds.length > 0) {
            links.push(getPlayerUrl(`ddl:${channelIds[0]}`));
        }

        encoded.l = links.slice(0, 3);
        events.push({
            id: makeSportId(encoded),
            name: `📺 ${event}`,
            sport: encoded.s,
            time: isLive ? 'LIVE' : time,
            description: `${encoded.s} · ${isLive ? 'Live' : time}`,
            live: isLive,
            links: links.slice(0, 3),
            embedHash: `ddl:${channels[0]?.channel_id || ''}`,
            source: 'daddylive',
        });
    }

    // ── Convert PPV events ──
    for (const { encoded, stream } of ppvEventsList) {
        const links: string[] = [];
        if (stream.url) links.push(stream.url);
        if (links.length === 0) links.push(`ppv:${stream.id}`);

        events.push({
            id: makeSportId(encoded),
            name: `📡 ${stream.name}`,
            sport: encoded.s,
            time: 'LIVE',
            description: `${encoded.s} · Live`,
            live: true,
            links: links.slice(0, 3),
            embedHash: `ppv:${stream.id}`,
            source: 'ppv',
        });
    }

    // ── Filter out past events (non-live events scheduled in the past) ──
    const currentDate = new Date();
    const filtered = events.filter(ev => {
        if (ev.live) return true;
        // Parse HH:MM time and check if it's still in the future
        if (ev.time && /^\d{1,2}:\d{2}$/.test(ev.time)) {
            const [h, m] = ev.time.split(':').map(Number);
            const scheduled = new Date(currentDate);
            scheduled.setHours(h, m, 0, 0);
            if (scheduled.getTime() < currentDate.getTime()) return false;
        }
        return true;
    });

    // ── Sort: live first, then by time ──
    filtered.sort((a, b) => {
        if (a.live && !b.live) return -1;
        if (!a.live && b.live) return 1;
        return a.time.localeCompare(b.time);
    });

    // Limit
    const MAX_EVENTS = 60;
    const finalEvents = filtered.slice(0, MAX_EVENTS);

    scheduleCache = { data: finalEvents, fetchedAt: now };
    return finalEvents;
}

// ── ID encoding/decoding ──
export function makeSportId(ev: EncodedEvent): string {
    return `sport:ev:${Buffer.from(JSON.stringify(ev)).toString('base64url')}`;
}

export function decodeSportId(id: string): EncodedEvent | null {
    try {
        if (!id.startsWith('sport:ev:')) return null;
        return JSON.parse(Buffer.from(id.slice('sport:ev:'.length), 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}

// ── Stream resolution for a specific event ──
export async function getEventStreams(
    links: string[],
    source?: string,
    embedHash?: string
): Promise<{ url: string; name: string }[]> {
    const results: { url: string; name: string }[] = [];

    // DaddyLive fallback: resolve from embedHash when links array is empty
    if (source === 'daddylive' && (!links || links.length === 0) && embedHash) {
        const channelIdMatch = embedHash.match(/^ddl:(.+)$/);
        if (channelIdMatch) {
            try {
                const resolvedUrl = await resolveDaddyLiveStream(channelIdMatch[1]);
                if (resolvedUrl) {
                    const token = makeProxyToken(resolvedUrl, {
                        'User-Agent': UA,
                        'Referer': DADDYLIVE_BASE,
                    });
                    results.push({ url: `/proxy/hls/manifest.m3u8?token=${token}`, name: 'Stream 1' });
                    return results;
                }
            } catch (err: any) {
                console.log(`[Sports] DaddyLive hash resolution error:`, err.message);
            }
        }
    }

    if (!links || links.length === 0) return results;

    for (let i = 0; i < links.length && results.length < 3; i++) {
        const link = links[i];

        try {
            let resolvedUrl: string | null = null;

            if (source === 'daddylive') {
                // Extract channel ID from DaddyLive stream URL
                const channelIdMatch = link.match(/\/live\/stream=([^/?&#]+)/);
                if (channelIdMatch) {
                    resolvedUrl = await resolveDaddyLiveStream(channelIdMatch[1]);
                }
            } else if (source === 'ppv') {
                // PPV URL might be direct m3u8 or needs resolution
                if (link.includes('.m3u8')) {
                    resolvedUrl = link;
                } else {
                    resolvedUrl = await resolveStreamChain(link);
                }
            } else {
                // FalconStreams: use existing iframe chain resolution
                resolvedUrl = await resolveStreamChain(link);
            }

            if (resolvedUrl) {
                const token = makeProxyToken(resolvedUrl, {
                    'User-Agent': UA,
                    'Referer': source === 'daddylive' ? DADDYLIVE_BASE : FALCONSTREAMS_URL,
                });
                results.push({ url: `/proxy/hls/manifest.m3u8?token=${token}`, name: `Stream ${i + 1}` });
            }
        } catch (err: any) {
            console.log(`[Sports] Stream ${i + 1} error:`, err.message);
        }
    }

    return results;
}

// ── Public API: get live sport events ──
export async function getSportEvents(): Promise<SportEventMeta[]> {
    return fetchSchedule();
}
