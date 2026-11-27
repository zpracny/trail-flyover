/**
 * Optional helper: place names (towns, villages, peaks) along a track from OpenStreetMap
 * via the Overpass API. Host apps with their own POI data (NaBrdy, TrailMetrics peaks)
 * can pass labels directly to the player instead.
 */
import type { TrackPoint } from '../core/geo.ts';
import type { FlyoverLabel } from '../hud/hud.ts';
import { redactUrls } from '../core/urls.ts';

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

export async function fetchPlaceLabels(points: TrackPoint[], o: PlaceLabelOptions = {}): Promise<FlyoverLabel[]> {
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
    if (!elements) throw lastErr ?? new Error('Overpass nedostupný');

    // Keep only places close to the track (cheap planar distance on a decimated track).
    const maxOff = o.maxOffTrack ?? 2000;
    const stride = Math.max(1, Math.floor(points.length / 2000));
    const near = (lon: number, lat: number) => {
        const kx = 111320 * Math.cos((lat * Math.PI) / 180);
        for (let i = 0; i < points.length; i += stride) {
            if (Math.hypot((points[i].lon - lon) * kx, (points[i].lat - lat) * 111320) <= maxOff) return true;
        }
        return false;
    };
    return elements
        .filter(el => el.tags?.name && near(el.lon, el.lat))
        .map(el => ({
            lon: el.lon,
            lat: el.lat,
            name: el.tags.name,
            kind: el.tags.place ?? (el.tags.natural === 'peak' ? 'peak' : undefined),
        }));
}
