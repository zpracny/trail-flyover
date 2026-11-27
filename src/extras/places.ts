/**
 * Optional helpers: place names (towns, villages, peaks) along a track from OpenStreetMap.
 * - `fetchVectorPlaceLabels` reads them from vector tiles (OpenFreeMap by default): CDN-served,
 *   fast, no rate limits. Recommended.
 * - `fetchPlaceLabels` asks the Overpass API, which is often overloaded.
 * Host apps with their own POI data (NaBrdy, TrailMetrics peaks) can pass labels directly to
 * the player instead.
 */
import type { TrackPoint } from '../core/geo.ts';
import type { FlyoverLabel } from '../hud/hud.ts';
import { redactUrls } from '../core/urls.ts';
import { readMvtPoints } from './mvt.ts';

/**
 * Public Overpass servers, tried in order until one answers. Each one receives the bounding box
 * of the track (roughly where the ride was) — pass your own `endpoints` to control that.
 * - overpass-api.de: the main instance, run by FOSSGIS (Germany)
 * - overpass.kumi.systems: Kumi Systems (Switzerland)
 * - overpass.private.coffee: private.coffee (Austria)
 */
export const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
];

export interface PlaceLabelOptions {
    /**
     * Places further than this from the track are dropped (m). Default 2000 — a coarse cut to keep
     * the list small; which names are really shown is decided per kind by the player (`labelReach`).
     */
    maxOffTrack?: number;
    /** Include natural=peak. Default true. */
    peaks?: boolean;
    /** Overpass servers to ask, in order. Default OVERPASS_ENDPOINTS. */
    endpoints?: string[];
    /** Per-endpoint timeout in ms (mirrors sometimes hang). Default 12000. */
    timeoutMs?: number;
    signal?: AbortSignal;
}

/**
 * Place names along a track from OpenStreetMap. Default source: vector tiles
 * (`fetchVectorPlaceLabels`); `{ source: 'overpass' }` asks the Overpass API instead.
 */
export function fetchPlaceLabels(
    points: TrackPoint[],
    o: ({ source?: 'vector-tiles' } & VectorPlaceLabelOptions) | ({ source: 'overpass' } & PlaceLabelOptions) = {},
): Promise<FlyoverLabel[]> {
    return o.source === 'overpass' ? fetchOverpassPlaceLabels(points, o) : fetchVectorPlaceLabels(points, o);
}

/** Place names along a track from the Overpass API (often overloaded — see `fetchVectorPlaceLabels`). */
export async function fetchOverpassPlaceLabels(points: TrackPoint[], o: PlaceLabelOptions = {}): Promise<FlyoverLabel[]> {
    if (points.length < 2) return [];
    let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
    for (const p of points) {
        s = Math.min(s, p.lat); n = Math.max(n, p.lat);
        w = Math.min(w, p.lon); e = Math.max(e, p.lon);
    }
    const pad = 0.015;
    const bbox = `${s - pad},${w - pad},${n + pad},${e + pad}`;
    const query = `[out:json][timeout:25];(
      node["place"~"^(city|town|village|hamlet)$"]["name"](${bbox});
      ${o.peaks === false ? '' : `node["natural"="peak"]["name"](${bbox});`}
    );out body;`;

    let elements: Array<{ lat: number; lon: number; tags: Record<string, string> }> | null = null;
    let lastErr: unknown = null;
    for (const url of o.endpoints ?? OVERPASS_ENDPOINTS) {
        try {
            const timeout = AbortSignal.timeout(o.timeoutMs ?? 12000);
            const res = await fetch(url, {
                method: 'POST',
                body: new URLSearchParams({ data: query }),
                signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout,
            });
            if (!res.ok) throw new Error(`${redactUrls(url)}: HTTP ${res.status}`);
            elements = (await res.json()).elements;
            break;
        } catch (err) {
            if (o.signal?.aborted) throw err;
            lastErr = err;
        }
    }
    if (!elements) throw lastErr ?? new Error('No Overpass server answered');

    const near = nearTrack(points, o.maxOffTrack ?? 2000);
    return elements
        .filter(el => el.tags?.name && near(el.lon, el.lat))
        .map(el => ({
            lon: el.lon,
            lat: el.lat,
            name: el.tags.name,
            kind: el.tags.place ?? (el.tags.natural === 'peak' ? 'peak' : undefined),
        }));
}

/** Tests whether a place is within `maxOff` metres of the track (cheap planar distance on a decimated track). */
function nearTrack(points: TrackPoint[], maxOff: number) {
    const stride = Math.max(1, Math.floor(points.length / 2000));
    return (lon: number, lat: number) => {
        const kx = 111320 * Math.cos((lat * Math.PI) / 180);
        for (let i = 0; i < points.length; i += stride) {
            if (Math.hypot((points[i].lon - lon) * kx, (points[i].lat - lat) * 111320) <= maxOff) return true;
        }
        return false;
    };
}

/**
 * OpenFreeMap's TileJSON (OpenMapTiles schema, data © OpenStreetMap contributors). Free, no key;
 * each tile request tells the server roughly where the track is — pass your own `tiles` to control that.
 */
export const OPENFREEMAP_TILEJSON = 'https://tiles.openfreemap.org/planet';

/** Text to show next to the map when names come from OpenFreeMap tiles. */
export const OPENFREEMAP_ATTRIBUTION = 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap';

export interface VectorPlaceLabelOptions {
    /**
     * Vector tile URL template with {z}/{x}/{y} (OpenMapTiles schema: layers `place` and
     * `mountain_peak`), e.g. from MapTiler or your own server. Takes precedence over `tileJson`.
     */
    tiles?: string;
    /** TileJSON to read the tile URL from. Default OPENFREEMAP_TILEJSON. */
    tileJson?: string;
    /**
     * Tile zoom. Default 12: every city, town and village, and hamlets except in the densest areas
     * (tiles drop the least important ones there). 13–14 is complete but needs many more tiles.
     * Long tracks step down automatically to stay within `maxTiles`.
     */
    zoom?: number;
    /** Most tiles to download; past it the zoom steps down (not below 10). Default 200. */
    maxTiles?: number;
    /** Places further than this from the track are dropped (m). Default 2000, as `fetchPlaceLabels`. */
    maxOffTrack?: number;
    /** Kinds of place to keep (OpenMapTiles `class`). Default city, town, village, hamlet. */
    kinds?: string[];
    /** Include peaks (and volcanoes). Default true. */
    peaks?: boolean;
    /**
     * Preferred language of names, e.g. "en" reads `name:en` and falls back to the local name.
     * Default: local names (`name`), as on the ground.
     */
    language?: string;
    /** Parallel downloads. Default 6. */
    concurrency?: number;
    /** Per-tile timeout in ms. Default 10000. Each failed tile is tried once more. */
    timeoutMs?: number;
    signal?: AbortSignal;
}

/**
 * Thrown by `fetchVectorPlaceLabels` when some tiles could not be loaded even after a retry.
 * `labels` holds the places from the tiles that did load, so a caller may still use them.
 */
export class PlaceLabelsError extends Error {
    readonly labels: FlyoverLabel[];
    readonly failedTiles: number;
    readonly totalTiles: number;
    constructor(message: string, labels: FlyoverLabel[], failedTiles: number, totalTiles: number) {
        super(message);
        this.name = 'PlaceLabelsError';
        this.labels = labels;
        this.failedTiles = failedTiles;
        this.totalTiles = totalTiles;
    }
}

const DEFAULT_KINDS = ['city', 'town', 'village', 'hamlet'];
const PEAK_CLASSES = new Set(['peak', 'volcano']);
const tileJsonCache = new Map<string, Promise<string>>();

async function tileTemplate(o: VectorPlaceLabelOptions): Promise<string> {
    if (o.tiles) return o.tiles;
    const url = o.tileJson ?? OPENFREEMAP_TILEJSON;
    let p = tileJsonCache.get(url);
    if (!p) {
        p = (async () => {
            const res = await fetch(url, { signal: AbortSignal.timeout(o.timeoutMs ?? 10000) });
            if (!res.ok) throw new Error(`${redactUrls(url)}: HTTP ${res.status}`);
            const tj = await res.json();
            const t = Array.isArray(tj?.tiles) ? tj.tiles[0] : undefined;
            if (typeof t !== 'string') throw new Error(`${redactUrls(url)}: no tile URL in TileJSON`);
            return t;
        })();
        tileJsonCache.set(url, p);
        // A failure is not cached: the next call asks again.
        p.catch(() => tileJsonCache.delete(url));
    }
    return p;
}

const lonToX = (lon: number, n: number) => ((lon + 180) / 360) * n;
const latToY = (lat: number, n: number) => {
    const r = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
    return ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n;
};
const xToLon = (x: number, n: number) => (x / n) * 360 - 180;
const yToLat = (y: number, n: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;

/** Tiles within `pad` metres of the track at zoom `z`, as "x/y" keys. */
export function tilesAlongTrack(points: TrackPoint[], z: number, pad: number): Set<string> {
    const n = 2 ** z;
    const out = new Set<string>();
    let last: TrackPoint | null = null;
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        // Sample about every quarter of the padding: no tile in reach is skipped.
        if (last && i < points.length - 1) {
            const kx = 111320 * Math.cos((p.lat * Math.PI) / 180);
            if (Math.hypot((p.lon - last.lon) * kx, (p.lat - last.lat) * 111320) < pad / 4) continue;
        }
        last = p;
        const dLat = pad / 111320;
        const dLon = pad / (111320 * Math.max(0.01, Math.cos((p.lat * Math.PI) / 180)));
        const x0 = Math.floor(lonToX(p.lon - dLon, n)), x1 = Math.floor(lonToX(p.lon + dLon, n));
        const y0 = Math.floor(latToY(p.lat + dLat, n)), y1 = Math.floor(latToY(p.lat - dLat, n));
        for (let x = x0; x <= x1; x++) {
            for (let y = Math.max(0, y0); y <= Math.min(n - 1, y1); y++) out.add(`${((x % n) + n) % n}/${y}`);
        }
    }
    return out;
}

/**
 * Place names along a track from vector tiles (OpenFreeMap by default). Only the tiles the track
 * passes are downloaded; works in browsers and in Node (≥ 22). Throws `PlaceLabelsError` (with the
 * places found so far) when some tiles fail, so a failure is never mistaken for "no places here".
 */
export async function fetchVectorPlaceLabels(points: TrackPoint[], o: VectorPlaceLabelOptions = {}): Promise<FlyoverLabel[]> {
    if (points.length < 2) return [];
    const maxOff = o.maxOffTrack ?? 2000;
    const maxTiles = o.maxTiles ?? 200;
    let z = Math.max(0, Math.min(14, Math.round(o.zoom ?? 12)));
    let tiles = tilesAlongTrack(points, z, maxOff);
    while (tiles.size > maxTiles && z > 10) tiles = tilesAlongTrack(points, --z, maxOff);
    if (tiles.size > maxTiles) throw new Error(`Track needs ${tiles.size} tiles even at zoom ${z} (maxTiles ${maxTiles})`);

    const template = await tileTemplate(o);
    if (!/\{z\}/.test(template) || !/\{x\}/.test(template) || !/\{y\}/.test(template)) {
        throw new Error(`${redactUrls(template)}: tile URL needs {z}, {x} and {y}`);
    }
    const kinds = new Set(o.kinds ?? DEFAULT_KINDS);
    const peaks = o.peaks !== false;
    const layers = peaks ? ['place', 'mountain_peak'] : ['place'];
    const nameKey = o.language ? `name:${o.language}` : null;
    const near = nearTrack(points, maxOff);
    const n = 2 ** z;

    const found: FlyoverLabel[] = [];
    const seen = new Map<string, Array<[number, number]>>();
    const add = (label: FlyoverLabel) => {
        // Neighbouring tiles repeat places from their edges; the same name and kind within 100 m is one place.
        const key = `${label.kind}|${label.name}`;
        const kx = 111320 * Math.cos((label.lat * Math.PI) / 180);
        const prev = seen.get(key) ?? [];
        if (prev.some(([lon, lat]) => Math.hypot((lon - label.lon) * kx, (lat - label.lat) * 111320) < 100)) return;
        prev.push([label.lon, label.lat]);
        seen.set(key, prev);
        found.push(label);
    };

    const loadTile = async (key: string) => {
        const [x, y] = key.split('/').map(Number);
        const url = template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
        let lastErr: unknown;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const timeout = AbortSignal.timeout(o.timeoutMs ?? 10000);
                const res = await fetch(url, { signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout });
                // 204 / 404: an empty tile (open sea, outside the data) — no places, not an error.
                if (res.status === 204 || res.status === 404) return;
                if (!res.ok) throw new Error(`${redactUrls(url)}: HTTP ${res.status}`);
                const data = readMvtPoints(new Uint8Array(await res.arrayBuffer()), layers);
                for (const p of data.get('place') ?? []) {
                    const kind = String(p.props.class ?? '');
                    if (!kinds.has(kind)) continue;
                    add(toLabel(p, kind));
                }
                for (const p of data.get('mountain_peak') ?? []) {
                    if (!PEAK_CLASSES.has(String(p.props.class ?? 'peak'))) continue;
                    add(toLabel(p, 'peak'));
                }
                return;
            } catch (err) {
                if (o.signal?.aborted) throw err;
                lastErr = err;
            }
        }
        throw lastErr;
        function toLabel(p: { x: number; y: number; props: Record<string, unknown> }, kind: string): FlyoverLabel {
            const name = String((nameKey && p.props[nameKey]) || p.props.name || '');
            return { lon: xToLon(x + p.x, n), lat: yToLat(y + p.y, n), name, kind };
        }
    };

    const queue = [...tiles];
    let failed = 0;
    let firstErr: unknown = null;
    const worker = async () => {
        for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
            o.signal?.throwIfAborted();
            try {
                await loadTile(key);
            } catch (err) {
                if (o.signal?.aborted) throw err;
                failed++;
                firstErr ??= err;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 6) }, worker));

    const labels = found.filter(l => l.name && near(l.lon, l.lat));
    if (failed > 0) {
        const why = firstErr instanceof Error ? firstErr.message : String(firstErr);
        throw new PlaceLabelsError(`${failed} of ${tiles.size} place tiles failed (${why})`, labels, failed, tiles.size);
    }
    return labels;
}
