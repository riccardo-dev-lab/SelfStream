/**
 * HLS Proxy helpers — shared between addon.ts, vixsrc.ts, vixcloud.ts
 *
 * Uses a server-side header cache so proxy tokens stay short.
 * Without this, every segment URL embeds the full CDN URL + all headers (~1500 chars)
 * which exceeds URL length limits in many HLS players.
 */
import { request } from 'undici';

export const VIXSRC_HEADERS: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Connection': 'keep-alive',
    'Referer': 'https://vixsrc.to/'
};

export const VIXCLOUD_HEADERS: Record<string, string> = {
    'Accept': '*/*',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0'
};

// ── Header Cache: store headers server-side, reference by short ID ──
const headerCache = new Map<string, { headers: Record<string, string>; expire: number }>();
let headerIdCounter = 0;

function registerHeaders(headers: Record<string, string>, ttlMs: number): string {
    const now = Date.now();
    // Reuse existing ID if same headers already cached; purge expired entries lazily
    for (const [id, entry] of headerCache) {
        if (entry.expire <= now) { headerCache.delete(id); continue; }
        if (JSON.stringify(entry.headers) === JSON.stringify(headers)) return id;
    }
    const id = 'h' + (++headerIdCounter);
    headerCache.set(id, { headers, expire: now + ttlMs });
    return id;
}

function lookupHeaders(id: string): Record<string, string> | null {
    const entry = headerCache.get(id);
    if (!entry || entry.expire < Date.now()) {
        headerCache.delete(id);
        return null;
    }
    return entry.headers;
}

export function makeProxyToken(url: string, headers: Record<string, string>, ttlMs: number = 6 * 3600 * 1000): string {
    const hid = registerHeaders(headers, ttlMs);
    const payload = {
        u: url,
        hid,
        e: Date.now() + ttlMs
    };
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeProxyToken(token: string): { u: string; h: Record<string, string>; e: number } | null {
    try {
        const raw = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
        // Support both old format (h: {...}) and new format (hid: "h1")
        let headers: Record<string, string>;
        if (raw.hid) {
            const cached = lookupHeaders(raw.hid);
            if (!cached) {
                // Fallback: infer headers from URL when cache is lost (serverless restart)
                const url = raw.u || '';
                if (url.includes('vixsrc.to') || url.includes('rabbitstream')) {
                    headers = { ...VIXSRC_HEADERS };
                } else if (url.includes('vixcloud') || url.includes('animeunity')) {
                    headers = { ...VIXCLOUD_HEADERS };
                } else {
                    // Generic headers for CinemaCity CDN etc
                    headers = {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': '*/*',
                        'Connection': 'keep-alive'
                    };
                }
                console.log(`[Proxy] Header cache miss for ${raw.hid}, using fallback for: ${url.substring(0, 60)}`);
            } else {
                headers = cached;
            }
        } else {
            headers = raw.h || {};
        }
        return { u: raw.u, h: headers, e: raw.e || 0 };
    } catch {
        return null;
    }
}

export function resolveUrl(base: string, relative: string): string {
    if (relative.startsWith('http://') || relative.startsWith('https://')) return relative;
    try {
        return new URL(relative, base).toString();
    } catch {
        const baseUrl = new URL(base);
        if (relative.startsWith('/')) {
            return `${baseUrl.origin}${relative}`;
        }
        const basePath = baseUrl.pathname.substring(0, baseUrl.pathname.lastIndexOf('/') + 1);
        return `${baseUrl.origin}${basePath}${relative}`;
    }
}

export interface HLSVariant {
    url: string;
    height: number;
    bandwidth: number;
    quality: string; // '4K' | '1080p'
}

export async function fetchHLSVariants(
    masterUrl: string,
    headers: Record<string, string>,
    minHeight = 1080
): Promise<HLSVariant[]> {
    try {
        const { body, statusCode } = await request(masterUrl, { headers });
        if (statusCode !== 200) { await body.text(); return []; }
        const text = await body.text();
        if (!text.includes('#EXT-X-STREAM-INF:')) return [];

        const lines = text.split(/\r?\n/);
        const variants: HLSVariant[] = [];

        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
            const info = lines[i];
            const urlLine = lines[i + 1]?.trim();
            i++;
            if (!urlLine || urlLine.startsWith('#')) continue;

            let height = 0, bandwidth = 0;
            const hMatch = info.match(/RESOLUTION=\d+x(\d+)/i);
            if (hMatch) height = parseInt(hMatch[1], 10);
            const bMatch = info.match(/BANDWIDTH=(\d+)/i);
            if (bMatch) bandwidth = parseInt(bMatch[1], 10);

            if (height < minHeight) continue;

            const url = urlLine.startsWith('http') ? urlLine : new URL(urlLine, masterUrl).href;
            const quality = height >= 2160 ? '4K' : '1080p';
            variants.push({ url, height, bandwidth, quality });
        }

        variants.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
        return variants;
    } catch {
        return [];
    }
}

export function getAddonBase(req: any): string {
    const protocol = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    let host = req.headers['x-forwarded-host'] || req.headers.host || req.get('host');
    
    // If the host is just the internal app name (no dots), append the BeamUp domain.
    // BeamUp app names usually look like c15c09a3abc2-svix. We only append the domain
    // if it matches this pattern so that it doesn't interfere with Render or local dev.
    if (host && !host.includes('.') && host !== 'localhost' && process.env.BEAMUP_PROJECT_NAME) {
        // If we have an environment variable from BeamUp, we can definitely append
        host = `${host}.baby-beamup.club`;
    } else if (host && !host.includes('.') && host !== 'localhost') {
        // Fallback: append ONLY if it looks like a typical dokku internal name
        // (starts with alphanumeric, has an internal hyphen, etc.)
        if (/^[a-z0-9]+-[a-z0-9]+$/i.test(host)) {
            host = `${host}.baby-beamup.club`;
        }
    }
    
    // If x-forwarded-host is a list (from multiple proxies), take the first one
    if (host && host.includes(',')) {
        host = host.split(',')[0].trim();
    }
    
    return `${protocol}://${host}`;
}
