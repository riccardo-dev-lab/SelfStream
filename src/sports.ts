import { request } from 'undici';
import { makeProxyToken, SPORT_HEADERS } from './proxy';

const SCHEDULE_URL = 'https://daddylive.dad/schedule/schedule-generated.php';
const SERVER_LOOKUP_URL = 'https://allupplay.xyz/server_lookup.php';

export const SPORT_EMOJI: Record<string, string> = {
    'Tennis': '🎾',
    'Soccer': '⚽', 'Football': '⚽',
    'Formula 1': '🏎️',
    'Motorsport': '🏁',
    'MotoGP': '🏍️',
    'Basketball': '🏀',
    'Baseball': '⚾',
    'Boxing': '🥊',
    'Cricket': '🏏',
    'Golf': '⛳',
    'Ice Hockey': '🏒',
    'Rugby': '🏉', 'Rugby League': '🏉', 'Rugby Union': '🏉',
    'Olympics': '🏅',
    'Cycling': '🚴',
    'Swimming': '🏊',
    'Athletics': '🏃',
    'Volleyball': '🏐',
    'Darts': '🎯',
    'Snooker': '🎱',
    'Handball': '🤾',
    'American Football': '🏈',
    'Table Tennis': '🏓',
    'Badminton': '🏸',
    'Gymnastics': '🤸',
    'Wrestling': '🤼',
    'Sailing': '⛵',
    'Equestrian': '🐎',
};

export interface SportEventMeta {
    id: string;
    name: string;
    sport: string;
    time: string;
    description: string;
}

interface ChannelRef { id: string; name: string }

export interface EncodedEvent {
    s: string;   // sport
    n: string;   // event name
    t: string;   // time
    c: ChannelRef[]; // channels
}

let scheduleCache: { data: any; fetchedAt: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000;

async function fetchSchedule(): Promise<any> {
    const now = Date.now();
    if (scheduleCache && (now - scheduleCache.fetchedAt) < CACHE_TTL) {
        return scheduleCache.data;
    }
    try {
        const { body, statusCode } = await request(SCHEDULE_URL, {
            headers: {
                'User-Agent': SPORT_HEADERS['User-Agent'],
                'Referer': 'https://daddylive.dad/',
            },
            headersTimeout: 8000,
            bodyTimeout: 8000,
        });
        if (statusCode !== 200) { await body.text(); return null; }
        const data = await body.json();
        scheduleCache = { data, fetchedAt: now };
        return data;
    } catch (err: any) {
        console.error('[Sports] Schedule fetch error:', err?.message);
        return scheduleCache?.data || null; // use stale cache if available
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
    if (!schedule) return [];

    const events: SportEventMeta[] = [];
    const seen = new Set<string>();

    for (const [dateLabel, sportCategories] of Object.entries(schedule)) {
        if (typeof sportCategories !== 'object' || Array.isArray(sportCategories)) continue;

        for (const [sport, eventList] of Object.entries(sportCategories as Record<string, any>)) {
            if (!Array.isArray(eventList)) continue;

            for (const ev of eventList) {
                const eventName: string = ev?.event || ev?.name || '';
                const time: string = ev?.time || '';
                if (!eventName) continue;

                // Collect channels, deduplicate by ID
                const channelMap = new Map<string, ChannelRef>();
                for (const chGroup of [ev?.channels, ev?.channels2]) {
                    if (!chGroup || typeof chGroup !== 'object') continue;
                    for (const ch of Object.values(chGroup as Record<string, any>)) {
                        if (ch?.channel_id) {
                            const cid = String(ch.channel_id);
                            if (!channelMap.has(cid)) {
                                channelMap.set(cid, { id: cid, name: ch.channel_name || cid });
                            }
                        }
                    }
                }
                if (channelMap.size === 0) continue;

                const channels = Array.from(channelMap.values()).slice(0, 8);
                const dedupeKey = `${sport}:${eventName}`;
                if (seen.has(dedupeKey)) continue;
                seen.add(dedupeKey);

                const encoded: EncodedEvent = { s: sport, n: eventName, t: time, c: channels };
                const id = makeSportId(encoded);
                const emoji = SPORT_EMOJI[sport] || '🏆';

                events.push({
                    id,
                    name: `${emoji} ${eventName}`,
                    sport,
                    time,
                    description: `${sport}${time ? ' · ' + time + ' GMT' : ''} · ${dateLabel}`,
                });
            }
        }
    }

    return events;
}

export async function getChannelStream(channel: ChannelRef): Promise<{ url: string; name: string } | null> {
    try {
        const { body, statusCode } = await request(
            `${SERVER_LOOKUP_URL}?channel_id=premium${channel.id}`,
            {
                headers: {
                    'Referer': `https://allupplay.xyz/premiumtv/daddylivehd.php?id=${channel.id}`,
                    'User-Agent': SPORT_HEADERS['User-Agent'],
                },
                headersTimeout: 6000,
                bodyTimeout: 6000,
            }
        );
        if (statusCode !== 200) { await body.text(); return null; }

        const data: any = await body.json();
        const serverKey: string = data?.server_key;
        if (!serverKey) return null;

        const hlsUrl = `https://${serverKey}new.newkso.ru/${serverKey}/premium${channel.id}/mono.m3u8`;
        const token = makeProxyToken(hlsUrl, SPORT_HEADERS);
        return {
            url: `/proxy/hls/manifest.m3u8?token=${token}`,
            name: channel.name,
        };
    } catch (err: any) {
        console.error(`[Sports] Channel ${channel.id} lookup error:`, err?.message);
        return null;
    }
}
