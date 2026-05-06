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
const CACHE_TTL = 60 * 1000; // 1 minute

function channelFromLink(link: string): string {
    try {
        const stream = new URL(link).searchParams.get('stream') || '';
        if (!stream) return '';
        if (stream.startsWith('disney')) {
            const n = stream.replace('disney', '');
            return n ? `Disney+ ${n}` : 'Disney+';
        }
        if (stream.startsWith('espn')) {
            const n = stream.replace('espn', '');
            return n ? `ESPN ${n}` : 'ESPN';
        }
        if (stream.startsWith('fanatiz')) {
            const n = stream.replace('fanatiz', '');
            return n ? `Fanatiz ${n}` : 'Fanatiz';
        }
        if (stream.startsWith('fox')) {
            const n = stream.replace('fox', '');
            return n ? `Fox Sports ${n}` : 'Fox Sports';
        }
        if (stream.startsWith('tnt')) {
            const n = stream.replace('tnt', '');
            return n ? `TNT ${n}` : 'TNT';
        }
        return stream.toUpperCase();
    } catch { return ''; }
}

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

function isPastEvent(time: string, live: boolean): boolean {
    if (live) return false;
    if (!time) return false;
    const m = time.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return false;
    const now = new Date();
    const evH = parseInt(m[1]), evM = parseInt(m[2]);
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const evMinutes = evH * 60 + evM;
    // Source times appear to be in UTC; filter if time has passed
    return nowMinutes > evMinutes;
}

export async function getSportEvents(): Promise<SportEventMeta[]> {
    const schedule = await fetchSchedule();
    if (!schedule.length) return [];

    const today = new Date();
    const dateStr = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}`;

    // Group events by title, collecting all unique stream links and channels
    const eventMap = new Map<string, { links: string[]; channels: string[]; sport: string; time: string; live: boolean }>();

    for (const ev of schedule) {
        const title: string = ev?.title || '';
        const link: string = ev?.link || '';
        if (!title || !link) continue;

        const channel = channelFromLink(link);
        const existing = eventMap.get(title);
        if (existing) {
            if (!existing.links.includes(link) && existing.links.length < 5) {
                existing.links.push(link);
                if (channel && !existing.channels.includes(channel)) {
                    existing.channels.push(channel);
                }
            }
        } else {
            eventMap.set(title, {
                links: [link],
                channels: channel ? [channel] : [],
                sport: ev?.category || 'Sport',
                time: ev?.time || '',
                live: ev?.status === 'en vivo',
            });
        }
    }

    const events: SportEventMeta[] = [];

    for (const [title, { links, channels, sport, time, live }] of eventMap) {
        if (isPastEvent(time, live)) continue;

        const encoded: EncodedEvent = { t: title, s: sport, tm: time, l: links };
        const id = makeSportId(encoded);
        const emoji = SPORT_EMOJI[sport] || '🏆';

        const timeDisplay = time ? `${dateStr} ${time}` : '';
        const channelsStr = channels.length ? channels.slice(0, 3).join(', ') : '';

        const descParts = [sport];
        if (timeDisplay) descParts.push(timeDisplay);
        if (channelsStr) descParts.push(`📡 ${channelsStr}`);
        if (live) descParts.push('🔴 Live');

        events.push({
            id,
            name: `${emoji} ${title}`,
            sport,
            time,
            description: descParts.join(' · '),
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

function toPremierUrl(link: string): string {
    try {
        const u = new URL(link);
        const stream = u.searchParams.get('stream') || '';
        return `https://streamtpnew.com/premier.php?stream=${encodeURIComponent(stream)}`;
    } catch {
        return link;
    }
}

async function decryptStreamTP(pageUrl: string): Promise<string | null> {
    try {
        const premierUrl = toPremierUrl(pageUrl);
        const { body, statusCode } = await request(premierUrl, {
            headers: {
                'User-Agent': SPORT_HEADERS['User-Agent'],
                'Referer': 'https://streamtpcloud.com/',
                'Origin': 'https://streamtpcloud.com',
            },
            headersTimeout: 8000,
            bodyTimeout: 10000,
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
            const channel = channelFromLink(link);
            const name = channel ? `📡 ${channel}` : `Link ${i + 1}`;
            return { url: `/proxy/hls/manifest.m3u8?token=${token}`, name };
        })
    );

    return results
        .filter((r): r is PromiseFulfilledResult<{ url: string; name: string }> =>
            r.status === 'fulfilled' && r.value !== null)
        .map(r => r.value!);
}
