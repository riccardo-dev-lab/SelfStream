/**
 * Tennis Live Streams — Multi-source scraper
 *
 * Sources:
 *   1. tennistream.com/watch-tennis/ — main schedule + channel pages
 *   2. watchsports.to — live match listing with stream provider URLs
 *   3. dlhd.pk — Tennis ATP/WTA Rome categories + stream pages
 *   4. wikisport.club — player iframes (ten01-ten10.php)
 *
 * Player backends:
 *   - wikisport.club/court/tenXX.php  — JS redirect with base64 HLS paths
 *   - embedsports.me/atp-tour/...     — embed sports player
 *   - sportswin.click/play.php        — watchsports.to stream providers
 *   - sportora.ru/stream/             — watchsports.to stream providers
 *   - viparena.site/sch/cool.php      — watchsports.to stream providers
 *   - donis.jimpenopisonline.online   — dlhd.pk main player
 */

import { request } from 'undici';
import { makeProxyToken, resolveUrl } from './proxy';

const TENNIS_SCHEDULE_URL = 'https://tennistream.com/watch-tennis/';

interface TennisMatch {
    time: string;
    match: string;
    section: string;
    channels: string[];
}

interface TennisStream {
    url: string;
    name: string;
    title?: string;
}

let scheduleCache: { data: TennisMatch[]; fetchedAt: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function matchAll(str: string, pattern: RegExp): RegExpExecArray[] {
    const results: RegExpExecArray[] = [];
    let m: RegExpExecArray | null;
    const p = new RegExp(pattern.source, 'gi');
    while ((m = p.exec(str)) !== null) {
        results.push(m);
        if (m[0].length === 0) p.lastIndex++;
    }
    return results;
}

// ──────────────────────────────────────────────
// Source 1: tennistream.com/watch-tennis/
// ──────────────────────────────────────────────

async function fetchTennisSchedule(): Promise<TennisMatch[]> {
    const now = Date.now();
    if (scheduleCache && (now - scheduleCache.fetchedAt) < CACHE_TTL) {
        return scheduleCache.data;
    }

    try {
        const { body, statusCode } = await request(TENNIS_SCHEDULE_URL, {
            headers: {
                'User-Agent': USER_AGENT,
                'Referer': 'https://tennistream.com/',
            },
            headersTimeout: 8000,
            bodyTimeout: 10000,
        });

        if (statusCode !== 200) {
            await body.text();
            return scheduleCache?.data || [];
        }

        const html = await body.text();
        const matches = parseTennisSchedule(html);

        scheduleCache = { data: matches, fetchedAt: now };
        return matches;
    } catch (err: any) {
        console.error('[Tennis] Schedule fetch error:', err?.message);
        return scheduleCache?.data || [];
    }
}

function parseTennisSchedule(html: string): TennisMatch[] {
    const matches: TennisMatch[] = [];
    const tablePattern = /<table[^>]*>([\s\S]*?)<\/table>/gi;
    const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const sectionPattern = /<h[123456][^>]*>([\s\S]*?)<\/h[123456]>/gi;

    const tables = matchAll(html, tablePattern);

    for (const tableMatch of tables) {
        const tableHtml = tableMatch[1];

        let currentSection = 'Unknown';
        const sections = matchAll(tableHtml, sectionPattern);
        for (const section of sections) {
            const text = section[1].replace(/<[^>]+>/g, '').trim();
            if (text) currentSection = text;
        }

        const rows = matchAll(tableHtml, rowPattern);
        for (const rowMatch of rows) {
            const rowHtml = rowMatch[1];

            // Extract match text (Player A vs Player B)
            const vsMatch = rowHtml.match(/>([^<]{5,80}vs[^<]{5,80})</i);
            if (!vsMatch) continue;

            const matchText = vsMatch[1].replace(/<[^>]+>/g, '').trim();

            // Extract time
            const cells = matchAll(rowHtml, cellPattern);
            let timeStr = '';
            for (const cell of cells) {
                const text = cell[1].replace(/<[^>]+>/g, '').trim();
                if (/^\d{1,2}:\d{2}$/.test(text)) {
                    timeStr = text;
                    break;
                }
            }

            // Extract channel links
            const watchLinks = matchAll(rowHtml, /href="([^"]*)"/gi).map(m => m[1]);
            const channels = watchLinks.filter(c => c.startsWith('https://tennistream.com/channel'));

            if (timeStr && matchText && channels.length > 0) {
                matches.push({ time: timeStr, match: matchText, section: currentSection, channels });
            }
        }
    }

    return matches;
}

function extractPlayerSource(html: string): string | null {
    const iframePattern = /<iframe[^>]*src="([^"]*)"/gi;
    const exclusions = ['chatango', 'twitter', 'syndication', 'platform.twitter', 'fonts'];

    const iframes = matchAll(html, iframePattern);
    for (const match of iframes) {
        const src = match[1];
        if (!exclusions.some(ex => src.toLowerCase().includes(ex))) {
            return src;
        }
    }
    return null;
}

function extractPlayerSourcesFromPage(html: string): string[] {
    const sources: string[] = [];
    const iframePattern = /<iframe[^>]*src="([^"]*)"/gi;

    const iframes = matchAll(html, iframePattern);
    for (const match of iframes) {
        const src = match[1];
        if (!src.includes('chatango') && !src.includes('twitter') && src.startsWith('http')) {
            sources.push(src);
        }
    }
    return sources;
}

async function fetchChannelPage(url: string): Promise<string | null> {
    try {
        const { body, statusCode } = await request(url, {
            headers: {
                'User-Agent': USER_AGENT,
                'Referer': 'https://tennistream.com/',
            },
            headersTimeout: 8000,
            bodyTimeout: 10000,
        });

        if (statusCode !== 200) return null;
        return await body.text();
    } catch (err: any) {
        console.error(`[Tennis] Channel fetch error for ${url}:`, err?.message);
        return null;
    }
}

// ──────────────────────────────────────────────
// Source 2: watchsports.to
// ──────────────────────────────────────────────

interface WatchSportsMatch {
    players: string;
    round: string;
    live: boolean;
    streamCount: number;
    link: string;
}

async function fetchWatchSportsMatches(): Promise<WatchSportsMatch[]> {
    try {
        const { body, statusCode } = await request('https://watchsports.to/', {
            headers: { 'User-Agent': USER_AGENT, 'Referer': 'https://watchsports.to/' },
            headersTimeout: 8000, bodyTimeout: 10000,
        });

        if (statusCode !== 200) return [];
        const html = await body.text();

        // Find the tennis game-list section
        const tennisListMatch = html.match(/id="tennis-games"[^>]*>([\s\S]*?)<\/ul>/i);
        if (!tennisListMatch) return [];

        const listContent = tennisListMatch[1];

        // Extract all match li elements
        const matchItems = matchAll(listContent, /<li[^>]*data-group="[^"]*"[^>]*>([\s\S]*?)<\/li>/gi);
        const matches: WatchSportsMatch[] = [];

        for (const item of matchItems) {
            const itemHtml = item[1];

            // Extract href
            const hrefMatch = itemHtml.match(/href="([^"]*tennis\/\d+)"/);
            if (!hrefMatch) continue;
            let href = hrefMatch[1];
            if (!href.startsWith('http')) href = 'https://watchsports.to' + href;

            // Extract player names
            const teamNames = matchAll(itemHtml, /<span class="team-name">([^<]+)<\/span>/gi)
                .map(m => m[1]);
            if (teamNames.length < 2) continue;

            const players = `${teamNames[0]} vs ${teamNames[1]}`;

            // Extract round
            const roundMatch = itemHtml.match(/<span class="tennis-round">([^<]+)<\/span>/);
            const round = roundMatch ? roundMatch[1] : '';

            // Stream count
            const streamsMatch = itemHtml.match(/(\d+)\s+streams/i);
            const streamCount = streamsMatch ? parseInt(streamsMatch[1], 10) : 0;

            // Live status
            const isLive = itemHtml.includes('is-live');

            matches.push({ players, round, live: isLive, streamCount, link: href });
        }

        return matches;
    } catch (err: any) {
        console.error('[Tennis] WatchSports fetch error:', err?.message);
        return [];
    }
}

async function fetchWatchSportsStreamProviders(matchLink: string): Promise<string[]> {
    try {
        const { body, statusCode } = await request(matchLink, {
            headers: { 'User-Agent': USER_AGENT, 'Referer': 'https://watchsports.to/' },
            headersTimeout: 8000, bodyTimeout: 10000,
        });

        if (statusCode !== 200) return [];
        const html = await body.text();

        // Extract stream provider links (sportswin.click, sportora.ru, viparena.site)
        const providerLinks = matchAll(html, /href="(https?:\/\/[^"]*?(?:sportswin|sportora|viparena)[^"]*)"/gi);
        return providerLinks.map(m => m[1]);
    } catch (err: any) {
        console.error(`[Tennis] WatchSports provider fetch error for ${matchLink}:`, err?.message);
        return [];
    }
}

// ──────────────────────────────────────────────
// Source 3: dlhd.pk
// ──────────────────────────────────────────────

interface DlhdMatch {
    match: string;
    type: string;
    streamIds: number[];
}

async function fetchDlhdTennisMatches(): Promise<DlhdMatch[]> {
    try {
        // Scrape both ATP and WTA Rome categories
        const catUrls = [
            'https://dlhd.pk/index.php?cat=Tennis+ATP+%E2%80%93+Rome+Clay+%E2%80%93+Singles',
            'https://dlhd.pk/index.php?cat=Tennis+WTA+%E2%80%93+Rome+Clay+%E2%80%93+Singles',
        ];

        const allMatches: DlhdMatch[] = [];

        for (const catUrl of catUrls) {
            try {
                const { body, statusCode } = await request(catUrl, {
                    headers: { 'User-Agent': USER_AGENT, 'Referer': 'https://dlhd.pk/' },
                    headersTimeout: 8000, bodyTimeout: 10000,
                });

                if (statusCode !== 200) continue;
                const html = await body.text();

                // Extract match text (Player A vs Player B) with emoji flags
                const vsPatterns = matchAll(html, />([^<]{10,100}vs[^<]{10,100})</gi);
                const tennisMatches: string[] = [];

                for (const vp of vsPatterns) {
                    const text = vp[1].replace(/<[^>]+>/g, '').trim();
                    // Filter for actual tennis matches (skip other sports)
                    const lowerText = text.toLowerCase();
                    if (lowerText.includes('tennis') || lowerText.includes('doubles') || lowerText.includes('singles')) {
                        tennisMatches.push(text);
                    }
                }

                // Extract watch.php IDs
                const watchLinks = matchAll(html, /href="\/watch\.php\?id=(\d+)"[^>]*>([^<]+)<\/a>/gi);
                const watchIds: number[] = [];
                const seenIds = new Set<number>();

                for (const wl of watchLinks) {
                    const id = parseInt(wl[1], 10);
                    const label = wl[2].replace(/<[^>]+>/g, '').trim().toLowerCase();
                    if (!seenIds.has(id) && (label.includes('tennis') || label.includes('stream'))) {
                        watchIds.push(id);
                        seenIds.add(id);
                    }
                }

                // Extract stream.php links
                const streamLinks = matchAll(html, /href="\/stream\/stream-(\d+)\.php"[^>]*>([^<]+)<\/a>/gi);
                const streamIds: number[] = [];
                const seenStreamIds = new Set<number>();

                for (const sl of streamLinks) {
                    const id = parseInt(sl[1], 10);
                    const label = sl[2].replace(/<[^>]+>/g, '').trim().toLowerCase();
                    if (!seenStreamIds.has(id) && label.includes('tennis')) {
                        streamIds.push(id);
                        seenStreamIds.add(id);
                    }
                }

                // Combine: use watchIds as stream pool, create matches from vs patterns
                if (tennisMatches.length > 0 && watchIds.length > 0) {
                    for (const matchText of tennisMatches) {
                        allMatches.push({
                            match: matchText,
                            type: catUrl.includes('ATP') ? 'ATP' : 'WTA',
                            streamIds: watchIds,
                        });
                    }
                }
            } catch (err: any) {
                console.error(`[Tennis] dlhd.pk category fetch error:`, err?.message);
            }
        }

        return allMatches;
    } catch (err: any) {
        console.error('[Tennis] dlhd.pk main fetch error:', err?.message);
        return [];
    }
}

async function fetchDlhdStreamPage(streamId: number): Promise<string | null> {
    try {
        const { body, statusCode } = await request(`https://dlhd.pk/stream/stream-${streamId}.php`, {
            headers: { 'User-Agent': USER_AGENT, 'Referer': 'https://dlhd.pk/' },
            headersTimeout: 8000, bodyTimeout: 10000,
        });

        if (statusCode !== 200) return null;
        const html = await body.text();

        // Extract iframe src
        const iframeMatch = html.match(/<iframe[^>]*src="([^"]*)"/i);
        return iframeMatch ? iframeMatch[1] : null;
    } catch (err: any) {
        console.error(`[Tennis] dlhd.pk stream page error for ${streamId}:`, err?.message);
        return null;
    }
}

// ──────────────────────────────────────────────
// Source 4: wikisport.club player resolution
// ──────────────────────────────────────────────

async function resolveWikisportPlayer(playerUrl: string): Promise<string | null> {
    /**
     * Resolves wikisport.club/court/tenXX.php to actual HLS stream.
     * The page contains JS with atob() encoded paths and redirects.
     * Strategy: fetch page, extract base64-encoded paths, decode them.
     */
    try {
        const { body, statusCode } = await request(playerUrl, {
            headers: {
                'User-Agent': USER_AGENT,
                'Referer': 'https://tennistream.com/',
            },
            headersTimeout: 8000, bodyTimeout: 15000,
            maxRedirections: 10,
        });

        if (statusCode !== 200) return null;
        const html = await body.text();

        // Extract atob() encoded paths
        const atobMatches = matchAll(html, /atob\('([^']+)'\)/gi);
        for (const match of atobMatches) {
            try {
                const decoded = decodeURIComponent(escape(atob(match[1])));
                if (decoded.includes('.m3u8') || decoded.includes('/hls/') || decoded.includes('stream')) {
                    let url = decoded;
                    if (!url.startsWith('http')) {
                        url = resolveUrl(playerUrl, url);
                    }
                    return url;
                }
            } catch {
                continue;
            }
        }

        // Also look for direct m3u8 references
        const m3u8Matches = matchAll(html, /(?:src|m3u8|playlist|stream)[^"'<>]*\.m3u8[^"'<>]*/gi);
        for (const match of m3u8Matches) {
            let url = match[0];
            if (!url.startsWith('http')) {
                url = resolveUrl(playerUrl, url);
            }
            return url;
        }

        // Look for nested iframes (redirect chain)
        const nestedIframes = extractPlayerSourcesFromPage(html);
        if (nestedIframes.length > 0) {
            return nestedIframes[0];
        }

        return null;
    } catch (err: any) {
        console.error(`[Tennis] wikisport resolve error for ${playerUrl}:`, err?.message);
        return null;
    }
}

// ──────────────────────────────────────────────
// Source 5: embedsports.me player resolution
// ──────────────────────────────────────────────

async function resolveEmbedsportsPlayer(playerUrl: string): Promise<string | null> {
    /**
     * Resolves embedsports.me/atp-tour/... URLs to actual player/stream.
     * These are embed sports player pages that may contain iframes or m3u8.
     */
    try {
        const { body, statusCode } = await request(playerUrl, {
            headers: {
                'User-Agent': USER_AGENT,
                'Referer': 'https://dlhd.pk/',
            },
            headersTimeout: 8000, bodyTimeout: 15000,
            maxRedirections: 10,
        });

        if (statusCode !== 200) return null;
        const html = await body.text();

        // Look for iframes
        const iframes = extractPlayerSourcesFromPage(html);
        if (iframes.length > 0) {
            return iframes[0];
        }

        // Look for m3u8
        const m3u8Matches = matchAll(html, /(?:src|m3u8|playlist|stream)[^"'<>]*\.m3u8[^"'<>]*/gi);
        for (const match of m3u8Matches) {
            let url = match[0];
            if (!url.startsWith('http')) {
                url = resolveUrl(playerUrl, url);
            }
            return url;
        }

        // Look for video sources
        const videoPatterns = matchAll(html, /(?:embed|iframe|source)[^"'<>]*\.(?:m3u8|mp4|ts)[^"'<>]*/gi);
        for (const match of videoPatterns) {
            let url = match[0];
            if (!url.startsWith('http')) {
                url = resolveUrl(playerUrl, url);
            }
            return url;
        }

        return null;
    } catch (err: any) {
        console.error(`[Tennis] embedsports resolve error for ${playerUrl}:`, err?.message);
        return null;
    }
}

// ──────────────────────────────────────────────
// Source 6: sportswin.click / sportora.ru / viparena.site
// ──────────────────────────────────────────────

async function resolveWatchSportsProvider(providerUrl: string): Promise<string | null> {
    /**
     * Resolves watchsports.to stream provider URLs (sportswin.click, sportora.ru, viparena.site).
     * These may redirect to actual player pages or contain iframes.
     */
    try {
        const { body, statusCode } = await request(providerUrl, {
            headers: {
                'User-Agent': USER_AGENT,
                'Referer': 'https://watchsports.to/',
            },
            headersTimeout: 8000, bodyTimeout: 15000,
            maxRedirections: 10,
        });

        if (statusCode !== 200) return null;
        const html = await body.text();

        // Look for iframes
        const iframes = extractPlayerSourcesFromPage(html);
        if (iframes.length > 0) {
            return iframes[0];
        }

        // Look for m3u8
        const m3u8Matches = matchAll(html, /(?:src|m3u8|playlist|stream)[^"'<>]*\.m3u8[^"'<>]*/gi);
        for (const match of m3u8Matches) {
            let url = match[0];
            if (!url.startsWith('http')) {
                url = resolveUrl(providerUrl, url);
            }
            return url;
        }

        // Look for video sources
        const videoPatterns = matchAll(html, /(?:embed|iframe|source)[^"'<>]*\.(?:m3u8|mp4|ts)[^"'<>]*/gi);
        for (const match of videoPatterns) {
            let url = match[0];
            if (!url.startsWith('http')) {
                url = resolveUrl(providerUrl, url);
            }
            return url;
        }

        return null;
    } catch (err: any) {
        console.error(`[Tennis] WatchSports provider resolve error for ${providerUrl}:`, err?.message);
        return null;
    }
}

// ──────────────────────────────────────────────
// Main entry point: get all tennis streams
// ──────────────────────────────────────────────

async function getTennisStreams(): Promise<TennisStream[]> {
    const streams: TennisStream[] = [];

    // ── Source 1: tennistream.com ──
    try {
        console.log('[Tennis] Fetching tennistream.com schedule...');
        const matches = await fetchTennisSchedule();
        console.log(`[Tennis] tennistream.com: ${matches.length} matches`);

        for (const match of matches) {
            for (const channelUrl of match.channels) {
                try {
                    const html = await fetchChannelPage(channelUrl);
                    if (!html) continue;

                    const playerSource = extractPlayerSource(html);
                    if (!playerSource) continue;

                    const token = makeProxyToken(playerSource, {
                        'User-Agent': USER_AGENT,
                        'Referer': 'https://tennistream.com/',
                    }, 30 * 60 * 1000);

                    streams.push({
                        url: `/proxy/tennis/iframe?token=${token}`,
                        name: `Tennis ${match.section}`,
                        title: `${match.time} - ${match.match}`,
                    });
                } catch (err: any) {
                    console.error(`[Tennis] Stream error for ${match.match}:`, err?.message);
                }
            }
        }
    } catch (err: any) {
        console.error('[Tennis] tennistream.com main error:', err?.message);
    }

    // ── Source 2: watchsports.to ──
    try {
        console.log('[Tennis] Fetching watchsports.to...');
        const wsMatches = await fetchWatchSportsMatches();
        console.log(`[Tennis] watchsports.to: ${wsMatches.length} matches`);

        for (const wsMatch of wsMatches) {
            try {
                const providers = await fetchWatchSportsStreamProviders(wsMatch.link);
                console.log(`[Tennis] watchsports.to ${wsMatch.players}: ${providers.length} providers`);

                for (const providerUrl of providers) {
                    const token = makeProxyToken(providerUrl, {
                        'User-Agent': USER_AGENT,
                        'Referer': 'https://watchsports.to/',
                    }, 30 * 60 * 1000);

                    const liveTag = wsMatch.live ? ' LIVE' : '';
                    streams.push({
                        url: `/proxy/tennis/iframe?token=${token}`,
                        name: `WatchSports Tennis`,
                        title: `${wsMatch.players}${liveTag} — ${wsMatch.round}`,
                    });
                }
            } catch (err: any) {
                console.error(`[Tennis] WatchSports stream error for ${wsMatch.players}:`, err?.message);
            }
        }
    } catch (err: any) {
        console.error('[Tennis] watchsports.to main error:', err?.message);
    }

    // ── Source 3: dlhd.pk ──
    try {
        console.log('[Tennis] Fetching dlhd.pk...');
        const dlhdMatches = await fetchDlhdTennisMatches();
        console.log(`[Tennis] dlhd.pk: ${dlhdMatches.length} matches`);

        for (const dlhdMatch of dlhdMatches) {
            // Use first few stream IDs for this match
            const streamIds = dlhdMatch.streamIds.slice(0, 4);

            for (const streamId of streamIds) {
                try {
                    const playerUrl = await fetchDlhdStreamPage(streamId);
                    if (!playerUrl) continue;

                    const token = makeProxyToken(playerUrl, {
                        'User-Agent': USER_AGENT,
                        'Referer': 'https://dlhd.pk/',
                    }, 30 * 60 * 1000);

                    streams.push({
                        url: `/proxy/tennis/iframe?token=${token}`,
                        name: `DLHD Tennis`,
                        title: `${dlhdMatch.match} — Stream ${streamId}`,
                    });
                } catch (err: any) {
                    console.error(`[Tennis] DLHD stream error for ${streamId}:`, err?.message);
                }
            }
        }
    } catch (err: any) {
        console.error('[Tennis] dlhd.pk main error:', err?.message);
    }

    return streams;
}

export {
    fetchTennisSchedule,
    parseTennisSchedule,
    extractPlayerSource,
    extractPlayerSourcesFromPage,
    fetchChannelPage,
    resolveWikisportPlayer,
    resolveEmbedsportsPlayer,
    resolveWatchSportsProvider,
    fetchWatchSportsMatches,
    fetchWatchSportsStreamProviders,
    fetchDlhdTennisMatches,
    fetchDlhdStreamPage,
    getTennisStreams,
    type TennisMatch,
    type TennisStream,
};
