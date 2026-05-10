/**
 * Tennis Live Streams — tennistream.com scraper
 *
 * Scrapes the schedule from tennistream.com/watch-tennis/
 * Maps each match to its channel page, extracts the player iframe URL,
 * and resolves the actual stream.
 *
 * Player backends:
 *   - wikisport.club/court/tenXX.php  (may be down)
 *   - livetv760.me/export/webmasters.php (works, needs JS redirect)
 *   - livetv.sx/export/webmasters.php    (may be down)
 *
 * Backup sites (scraped independently):
 *   - sportlemon.live
 *   - vipbox.live
 *   - stream2watch.tv
 *   - crackstreams.net
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
    // Ensure global flag is set
    const p = new RegExp(pattern.source, 'gi');
    while ((m = p.exec(str)) !== null) {
        results.push(m);
        // Prevent infinite loop if regex matches empty string
        if (m[0].length === 0) p.lastIndex++;
    }
    return results;
}

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

    // Use [\s\S]*? instead of (.*)s to avoid ES2018 flag requirement
    const tablePattern = /<table[^>]*>([\s\S]*?)<\/table>/gi;
    const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const linkPattern = /<a[^>]*href="([^"]*)"[^>]*>[\s\S]*?WATCH[\s\S]*?<\/a>/gi;
    const sectionPattern = /<h[123456][^>]*>([\s\S]*?)<\/h[123456]>/gi;

    const tables = matchAll(html, tablePattern);

    for (const tableMatch of tables) {
        const tableHtml = tableMatch[1];

        // Extract section header
        let currentSection = 'Unknown';
        const sections = matchAll(tableHtml, sectionPattern);
        for (const section of sections) {
            const text = section[1].replace(/<[^>]+>/g, '').trim();
            if (text) currentSection = text;
        }

        // Extract rows
        const rows = matchAll(tableHtml, rowPattern);
        for (const rowMatch of rows) {
            const rowHtml = rowMatch[1];
            const cells = matchAll(rowHtml, cellPattern);

            if (cells.length < 3) continue;

            const timeStr = cells[0][1].replace(/<[^>]+>/g, '').trim();
            const matchText = cells[2][1].replace(/<[^>]+>/g, '').trim();

            // Extract WATCH links from the row
            const watchLinks = matchAll(rowHtml, linkPattern).map(m => m[1]);
            const channels = watchLinks.filter(c => c.startsWith('http'));

            if (timeStr && matchText && channels.length > 0) {
                // Filter out non-tennistream URLs
                const validChannels = channels.filter(c => c.startsWith('https://tennistream.com/channel'));
                if (validChannels.length > 0) {
                    matches.push({ time: timeStr, match: matchText, section: currentSection, channels: validChannels });
                }
            }
        }
    }

    return matches;
}

function extractPlayerSource(html: string): string | null {
    // Find iframe src, excluding chatango, twitter, etc.
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

async function resolvePlayerUrl(playerUrl: string): Promise<string | null> {
    /**
     * Resolves a player iframe URL to an actual stream URL.
     *
     * Strategy:
     * 1. If it's a tennistream.com channel page, extract iframe source
     * 2. If it's a direct player (wikisport.club, livetv760.me, etc.), try to get the stream
     * 3. For livetv760.me, follow the redirect chain
     */

    // If it's a tennistream.com channel page, fetch and extract iframe
    if (playerUrl.includes('tennistream.com')) {
        const html = await fetchChannelPage(playerUrl);
        if (html) {
            const sources = extractPlayerSourcesFromPage(html);
            if (sources.length > 0) {
                // Return the first non-tennistream source
                for (const src of sources) {
                    if (!src.includes('tennistream.com')) {
                        return src;
                    }
                }
            }
        }
        return null;
    }

    // Direct player URL — try to follow redirect and extract stream
    try {
        const { body } = await request(playerUrl, {
            headers: {
                'User-Agent': USER_AGENT,
                'Referer': 'https://tennistream.com/',
            },
            maxRedirections: 10,
            headersTimeout: 8000,
            bodyTimeout: 15000,
        });

        const html = await body.text();

        // Look for m3u8 or video sources in the page
        const m3u8Pattern = /(?:src|m3u8|playlist|stream|video)[^"'<>]*\.m3u8[^"'<>]*/gi;
        const m3u8Matches = matchAll(html, m3u8Pattern);

        if (m3u8Matches.length > 0) {
            for (const match of m3u8Matches) {
                let url = match[0];
                if (!url.startsWith('http')) {
                    url = resolveUrl(playerUrl, url);
                }
                if (url.includes('.m3u8')) return url;
            }
        }

        // Look for iframe sources (nested players)
        const nestedIframes = extractPlayerSourcesFromPage(html);
        if (nestedIframes.length > 0) {
            return nestedIframes[0];
        }

        // Look for embed sources
        const embedPattern = /(?:embed|iframe|source)[^"'<>]*\.(?:m3u8|mp4|ts)[^"'<>]*/gi;
        const embedMatches = matchAll(html, embedPattern);
        if (embedMatches.length > 0) {
            let url = embedMatches[0][0];
            if (!url.startsWith('http')) {
                url = resolveUrl(playerUrl, url);
            }
            return url;
        }

        return null;
    } catch (err: any) {
        console.error(`[Tennis] Player resolve error for ${playerUrl}:`, err?.message);
        return null;
    }
}

async function getTennisStreams(): Promise<TennisStream[]> {
    /**
     * Main entry point: get all tennis streams from tennistream.com.
     * Returns a list of streams with proxy URLs.
     */
    const matches = await fetchTennisSchedule();
    const streams: TennisStream[] = [];

    for (const match of matches) {
        for (const channelUrl of match.channels) {
            try {
                // Fetch the channel page
                const html = await fetchChannelPage(channelUrl);
                if (!html) continue;

                // Extract player iframe source
                const playerSource = extractPlayerSource(html);
                if (!playerSource) continue;

                // Try to resolve the player URL to an actual stream
                // For now, return the player iframe URL through the proxy
                // The player page itself contains the video player
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

    return streams;
}

export {
    fetchTennisSchedule,
    parseTennisSchedule,
    extractPlayerSource,
    extractPlayerSourcesFromPage,
    fetchChannelPage,
    resolvePlayerUrl,
    getTennisStreams,
     type TennisMatch,
    type TennisStream,
};
