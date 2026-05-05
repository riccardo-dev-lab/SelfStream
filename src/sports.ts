import { request } from 'undici';
import { makeProxyToken, SPORT_HEADERS } from './proxy';

const SCHEDULE_URL = 'https://streamtpcloud.com/eventos.json';

export const SPORT_EMOJI: Record<string, string> = {
    'Fútbol': '⚽', 'Futbol': '⚽', 'Soccer': '⚽', 'Football': '⚽',
    'Tennis': '🎾', 'Tenis': '🎾',
    'Formula 1': '🏎️', 'F1': '🏎️',
    'Motorsport': '🏁', 'Motor': '🏁',
    'MotoGP': '🏍️',
    'Basketball': '🏀', 'Baloncesto': '🏀', 'NBA': '🏀',
    'Baseball': '⚾', 'Béisbol': '⚾',
    'Boxing': '🥊', 'Boxeo': '🥊',
    'Cricket': '🏏',
    'Golf': '⛳',
    'Ice Hockey': '🏒', 'Hockey': '🏒',
    'Rugby': '🏉', 'Rugby League': '🏉', 'Rugby Union': '🏉',
    'Olympics': '🏅', 'Olimpiadas': '🏅',
    'Cycling': '🚴', 'Ciclismo': '🚴',
    'Swimming': '🏊', 'Natación': '🏊',
    'Athletics': '🏃', 'Atletismo': '🏃',
    'Volleyball': '🏐', 'Voleibol': '🏐',
    'Darts': '🎯',
    'Snooker': '🎱',
    'Handball': '🤾', 'Balonmano': '🤾',
    'American Football': '🏈',
    'Table Tennis': '🏓',
    'Badminton': '🏸',
    'MMA': '🥋', 'UFC': '🥋', 'Wrestling': '🤼',
    'Sailing': '⛵', 'Vela': '⛵',
    'Equestrian': '🐎',
};

export interface SportEventMeta {
    id: string;
    name: string;
    sport: string;
    time: string;
    description: string;
    live: boolean;
}

export interface EncodedEvent {
    t: string;   // title
    s: string;   // sport/category
    tm: string;  // time
    l: string[]; // stream links
}

let scheduleCache: { data: any[]; fetchedAt: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000;

async function fetchSchedule(): Promise<any[]> {
    const now = Date.now();
    if (scheduleCache && (now - scheduleCache.fetchedAt) < CACHE_TTL) {
        return scheduleCache.data;
    }
    try {
        const { body, statusCode } = await request(SCHEDULE_URL, {
            headers: {
                'User-Agent': SPORT_HEADERS['User-Agent'],
                'Referer': 'https://streamtpcloud.com/',
            },
            headersTimeout: 8000,
            bodyTimeout: 8000,
            maxRedirections: 3,
        });
        if (statusCode !== 200) { await body.text(); return scheduleCache?.data || []; }
        const data = await body.json() as any[];
        scheduleCache = { data, fetchedAt: now };
        return data;
    } catch (err: any) {
        console.error('[Sports] Schedule fetch error:', err?.message);
        return scheduleCache?.data || [];
    }
}

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

export async function getSportEvents(): Promise<SportEventMeta[]> {
    const schedule = await fetchSchedule();
    if (!schedule.length) return [];

    // Group events by title, collecting all unique stream links
    const eventMap = new Map<string, { links: string[]; sport: string; time: string; live: boolean }>();

    for (const ev of schedule) {
        const title: string = ev?.title || '';
        const link: string = ev?.link || '';
        if (!title || !link) continue;

        const existing = eventMap.get(title);
        if (existing) {
            if (!existing.links.includes(link) && existing.links.length < 5) {
                existing.links.push(link);
            }
        } else {
            eventMap.set(title, {
                links: [link],
                sport: ev?.category || 'Sport',
                time: ev?.time || '',
                live: ev?.status === 'en vivo',
            });
        }
    }

    const events: SportEventMeta[] = [];

    for (const [title, { links, sport, time, live }] of eventMap) {
        const encoded: EncodedEvent = { t: title, s: sport, tm: time, l: links };
        const id = makeSportId(encoded);
        const emoji = SPORT_EMOJI[sport] || '🏆';

        events.push({
            id,
            name: `${emoji} ${title}`,
            sport,
            time,
            description: `${sport}${time ? ' · ' + time : ''}${live ? ' · 🔴 Live' : ''}`,
            live,
        });
    }

    // Live events first, then sort by time
    events.sort((a, b) => {
        if (a.live && !b.live) return -1;
        if (!a.live && b.live) return 1;
        return a.time.localeCompare(b.time);
    });

    return events;
}

async function decryptStreamTP(pageUrl: string): Promise<string | null> {
    try {
        const { body, statusCode } = await request(pageUrl, {
            headers: {
                'User-Agent': SPORT_HEADERS['User-Agent'],
                'Referer': 'https://streamtpcloud.com/',
                'Origin': 'https://streamtpcloud.com',
            },
            headersTimeout: 8000,
            bodyTimeout: 10000,
            maxRedirections: 3,
        });
        if (statusCode !== 200) { await body.text(); return null; }
        const html = await body.text();

        // Two functions that return numbers: function NAME(){return NUMBER;}
        const fnMatches = [...html.matchAll(/function \w+\(\)\{return (\d+);\}/g)];
        if (fnMatches.length < 2) return null;
        const k = parseInt(fnMatches[0][1]) + parseInt(fnMatches[1][1]);

        // Encoded array: VARNAME=[[idx,"base64"],...]
        const arrMatch = html.match(/=(\[\[\d+,"[^"]+"\](?:,\[\d+,"[^"]+"\])*\])/);
        if (!arrMatch) return null;

        let pairs: [number, string][];
        try {
            pairs = JSON.parse(arrMatch[1]);
        } catch {
            return null;
        }

        pairs.sort((a, b) => a[0] - b[0]);
        let url = '';
        for (const [, v] of pairs) {
            const decoded = Buffer.from(v, 'base64').toString();
            const digits = decoded.replace(/\D/g, '');
            if (!digits) continue;
            url += String.fromCharCode(parseInt(digits) - k);
        }

        return url.startsWith('http') ? url : null;
    } catch (err: any) {
        console.error('[Sports] StreamTP decrypt error:', err?.message);
        return null;
    }
}

export async function getEventStreams(links: string[]): Promise<{ url: string; name: string }[]> {
    const results = await Promise.allSettled(
        links.map(async (link, i) => {
            const m3u8Url = await decryptStreamTP(link);
            if (!m3u8Url) return null;
            const token = makeProxyToken(m3u8Url, {
                'User-Agent': SPORT_HEADERS['User-Agent'],
                'Referer': new URL(m3u8Url).origin + '/',
            });
            return { url: `/proxy/hls/manifest.m3u8?token=${token}`, name: `Link ${i + 1}` };
        })
    );

    return results
        .filter((r): r is PromiseFulfilledResult<{ url: string; name: string }> =>
            r.status === 'fulfilled' && r.value !== null)
        .map(r => r.value!);
}
