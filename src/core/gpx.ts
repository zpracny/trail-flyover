import type { TrackPoint } from './geo.ts';

export interface GpxWaypoint {
    lon: number;
    lat: number;
    name: string;
}

export interface ParsedGpx {
    name: string | null;
    points: TrackPoint[];
    /** Named `<wpt>` waypoints — handy as place labels along the track. */
    waypoints: GpxWaypoint[];
}

const decodeEntities = (s: string) =>
    s
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&amp;/g, '&')
        .trim();

/** Optional namespace prefix (`<gpx:trkpt>`), as written by some exporters. */
const NS = '(?:[\\w.-]+:)?';

const attr = (attrs: string, name: string) => Number(new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(attrs)?.[1]);
const child = (body: string, name: string) => new RegExp(`<${NS}${name}\\b[^>]*>([\\s\\S]*?)</${NS}${name}>`, 'i').exec(body)?.[1];

/**
 * Minimal GPX reader (track points, falling back to route points).
 * String based on purpose: works the same in the browser, workers and Node.
 * All tracks and segments are joined into one line. Coordinates are only checked for being
 * numbers here; `buildFlightPlan` drops impossible ones and GPS glitches.
 */
export function parseGpx(xml: string): ParsedGpx {
    xml = xml.replace(/<!--[\s\S]*?-->/g, '');

    // Track name: the <name> that belongs to <trk> itself, not to a point inside it.
    const header = (tag: string) => {
        const m = new RegExp(`<${NS}${tag}\\b[^>]*>([\\s\\S]*?)(?:<${NS}(?:trkseg|trkpt|rtept)\\b|</${NS}${tag}>)`, 'i').exec(xml);
        const name = m && child(m[1], 'name');
        return name ? decodeEntities(name) : null;
    };
    const name = header('trk') || header('metadata') || header('rte') || null;

    const each = (tag: string, fn: (attrs: string, body: string) => void) => {
        const re = new RegExp(`<${NS}${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${NS}${tag}>)`, 'gi');
        let m: RegExpExecArray | null;
        while ((m = re.exec(xml))) fn(m[1], m[2] ?? '');
    };

    const points: TrackPoint[] = [];
    const read = (tag: 'trkpt' | 'rtept') =>
        each(tag, (attrs, body) => {
            const lat = attr(attrs, 'lat'), lon = attr(attrs, 'lon');
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
            const eleText = child(body, 'ele')?.trim();
            const ele = eleText ? Number(eleText) : NaN; // Number('') would be 0
            const time = Date.parse((child(body, 'time') ?? '').trim());
            points.push({
                lat,
                lon,
                ele: Number.isFinite(ele) ? ele : null,
                time: Number.isFinite(time) ? time : null,
            });
        });
    read('trkpt');
    if (points.length === 0) read('rtept');

    const waypoints: GpxWaypoint[] = [];
    each('wpt', (attrs, body) => {
        const lat = attr(attrs, 'lat'), lon = attr(attrs, 'lon');
        const wname = child(body, 'name');
        if (Number.isFinite(lat) && Number.isFinite(lon) && wname) waypoints.push({ lat, lon, name: decodeEntities(wname) });
    });

    return { name, points, waypoints };
}
