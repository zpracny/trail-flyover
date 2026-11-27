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

/** A character reference to a code point that cannot exist (> U+10FFFF, surrogates) becomes U+FFFD. */
const codePoint = (n: number) => (n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '�');

const decodeEntities = (s: string) =>
    s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d{1,8});/g, (_, d) => codePoint(Number(d)))
        .replace(/&#x([0-9a-f]{1,8});/gi, (_, h) => codePoint(parseInt(h, 16)))
        .replace(/&amp;/g, '&');

/** Value of a numeric attribute (`lat="49.5"`, `lat = '49.5'`), NaN when missing. The tag text is short. */
const attr = (attrs: string, name: string) => Number(new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(attrs)?.[1]);

/**
 * Minimal GPX reader (track points, falling back to route points).
 *
 * A single forward pass over the text with `indexOf` — linear time whatever the input, so a
 * malformed or hostile file (thousands of unclosed tags) cannot freeze the page. No DOMParser:
 * works the same in the browser, workers and Node. Namespace prefixes (`<gpx:trkpt>`) and tag
 * case are ignored. All tracks and segments are joined into one line. Coordinates are only
 * checked for being numbers here; `buildFlightPlan` drops impossible ones and GPS glitches.
 */
export function parseGpx(xml: string): ParsedGpx {
    const trkpts: TrackPoint[] = [];
    const rtepts: TrackPoint[] = [];
    const waypoints: GpxWaypoint[] = [];
    const names: { trk?: string; metadata?: string; rte?: string } = {};

    /** Open elements, local names in lower case. */
    const stack: string[] = [];
    /** Point being read (trkpt / rtept / wpt) and the depth of its element in the stack. */
    let point: { kind: string; depth: number; lat: number; lon: number; ele?: string; time?: string; name?: string } | null = null;
    /** Text collected for the element at `capture.depth` (ele, time or name). */
    let capture: { depth: number; text: string } | null = null;

    const finishPoint = () => {
        const p = point!;
        point = null;
        if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return;
        if (p.kind === 'wpt') {
            if (p.name) waypoints.push({ lat: p.lat, lon: p.lon, name: p.name });
            return;
        }
        const eleText = p.ele?.trim();
        const ele = eleText ? Number(eleText) : NaN; // Number('') would be 0
        const time = Date.parse((p.time ?? '').trim());
        (p.kind === 'trkpt' ? trkpts : rtepts).push({
            lat: p.lat,
            lon: p.lon,
            ele: Number.isFinite(ele) ? ele : null,
            time: Number.isFinite(time) ? time : null,
        });
    };

    // Only the text of <ele>, <time> and <name> matters; everything else is skipped undecoded.
    const text = (from: number, to: number) => {
        if (!capture) return;
        const raw = xml.slice(from, to);
        capture.text += raw.includes('&') ? decodeEntities(raw) : raw;
    };
    /** GPX is ~6 levels deep (10 with extensions). Deeper elements are not tracked, which keeps
     * every step O(1) even for a file of thousands of nested tags. */
    const MAX_DEPTH = 32;

    let i = 0;
    const n = xml.length;
    while (i < n) {
        const lt = xml.indexOf('<', i);
        if (lt < 0) {
            text(i, n);
            break;
        }
        if (lt > i) text(i, lt);

        // Comments, CDATA, declarations and processing instructions.
        if (xml.startsWith('<!--', lt)) {
            const end = xml.indexOf('-->', lt + 4);
            if (end < 0) break;
            i = end + 3;
            continue;
        }
        if (xml.startsWith('<![CDATA[', lt)) {
            const end = xml.indexOf(']]>', lt + 9);
            if (end < 0) break;
            if (capture) capture.text += xml.slice(lt + 9, end); // CDATA is literal text: no entity decoding
            i = end + 3;
            continue;
        }
        const gt = xml.indexOf('>', lt + 1);
        if (gt < 0) break; // truncated tag at the end of the file
        i = gt + 1;
        const c = xml.charCodeAt(lt + 1);
        if (c === 33 /* ! */ || c === 63 /* ? */) continue;

        const closing = c === 47; /* / */
        const inner = xml.slice(lt + (closing ? 2 : 1), xml.charCodeAt(gt - 1) === 47 ? gt - 1 : gt);
        const selfClosing = !closing && xml.charCodeAt(gt - 1) === 47;
        const m = /^\s*([\w.:-]+)/.exec(inner);
        if (!m) continue;
        const local = m[1].slice(m[1].lastIndexOf(':') + 1).toLowerCase();

        if (closing) {
            // Pop to the matching element; a stray closing tag is ignored.
            const at = stack.lastIndexOf(local);
            if (at < 0) continue;
            if (capture && capture.depth >= at) {
                const value = capture.text;
                const depth = capture.depth;
                const owner = stack[depth];
                const parent = stack[depth - 1];
                capture = null;
                if (point && point.depth === depth - 1) {
                    if (owner === 'ele') point.ele ??= value;
                    else if (owner === 'time') point.time ??= value;
                    else if (owner === 'name') point.name ??= value.trim();
                } else if (owner === 'name' && (parent === 'trk' || parent === 'metadata' || parent === 'rte')) {
                    // The <name> of the track itself, not one inside a point; the first one wins.
                    names[parent] ??= value.trim();
                }
            }
            if (point && point.depth >= at) finishPoint();
            stack.length = at;
            continue;
        }

        const attrs = inner.slice(m[0].length);
        if (local === 'trkpt' || local === 'rtept' || local === 'wpt') {
            if (point) {
                // The previous point was never closed: treat the new one as its sibling.
                const depth = point.depth;
                finishPoint();
                stack.length = depth;
                capture = null;
            }
            point = { kind: local, depth: stack.length, lat: attr(attrs, 'lat'), lon: attr(attrs, 'lon') };
            if (selfClosing) {
                finishPoint();
                continue;
            }
        } else if (!selfClosing && !capture && stack.length < MAX_DEPTH && (local === 'ele' || local === 'time' || local === 'name')) {
            capture = { depth: stack.length, text: '' };
        }
        if (!selfClosing && stack.length < MAX_DEPTH) stack.push(local);
        else if (!selfClosing && point?.depth === stack.length) point = null; // a point too deep to track
    }
    // A point still open at the end of the file is incomplete: dropped.

    return {
        name: names.trk || names.metadata || names.rte || null,
        points: trkpts.length ? trkpts : rtepts,
        waypoints,
    };
}
