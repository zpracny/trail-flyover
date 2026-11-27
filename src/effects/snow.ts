/**
 * Winter filter: turns any summer aerial/satellite basemap into a snow-covered landscape.
 *
 * Real snow-covered imagery with full coverage and good resolution is not freely available
 * (Esri/ČÚZK are summer captures, winter Sentinel-2 is 10 m/px). This recolours imagery
 * tiles on the fly: open land (fields, meadows, roofs) turns to snow, dark forest stays dark
 * with a light frost, water stays. An optional snow line uses the DEM so valleys can stay green.
 *
 * Works as a MapLibre custom protocol, so it wraps any raster source (Esri, ČÚZK, your own…).
 */
import type * as MapLibre from 'maplibre-gl';
import { TERRARIUM_URL } from '../core/terrarium.ts';
import { redactUrls } from '../core/urls.ts';

export interface SnowOptions {
    /** 0–1, how much open land turns white. Default 1. */
    amount?: number;
    /**
     * Elevation (m) of the snow line. Below it the landscape fades back to the original.
     * null / undefined = snow everywhere (no DEM download).
     */
    snowline?: number | null;
}

const PROTOCOL = 'flyover-snow';

const sstep = (e0: number, e1: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
};

/**
 * Pure pixel transform (RGBA in place). `heightAt(i)` gives elevation for pixel i, or NaN.
 * Kept free of DOM so it can be unit-tested in Node.
 */
export function snowifyPixels(
    rgba: Uint8ClampedArray,
    heightAt: ((pixelIndex: number) => number) | null,
    opts: SnowOptions = {},
) {
    const amount = Math.min(1, Math.max(0, opts.amount ?? 1));
    const snowline = opts.snowline ?? null;
    for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
        const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        let k = amount;
        if (snowline !== null && heightAt) {
            const h = heightAt(p);
            if (Number.isFinite(h)) k *= sstep(snowline - 120, snowline + 120, h);
        }
        if (k <= 0.001) continue;

        // Water: bluish and dark → keep (frozen lakes would be white, but dark reads better as water).
        const isWater = b > g + 4 && b > r + 4 && luma < 95 ? 1 : 0;
        // Forest: dark and greenish. Snow does not cover canopies much from above.
        const green = g - (r + b) / 2;
        const dark = 1 - sstep(55, 105, luma);
        const forest = Math.max(isWater, dark * (green > -6 ? 1 : 0.55));

        // Snow on open land: bright, slightly blue, keeps a hint of the field texture.
        const tex = (luma - 125) * 0.16;
        const sv = Math.min(252, Math.max(205, 236 + tex));
        const snowR = sv - 7, snowG = sv - 3, snowB = sv + 4;
        // Frosted forest: desaturated, a bit lighter, cold tint.
        const fg = luma * 0.82 + 22;
        const frostR = fg * 0.94, frostG = fg * 0.98, frostB = fg * 1.06;

        const kSnow = k * (1 - forest);
        const kFrost = k * forest * (isWater ? 0.15 : 0.55);
        let nr = r + (frostR - r) * kFrost;
        let ng = g + (frostG - g) * kFrost;
        let nb = b + (frostB - b) * kFrost;
        nr += (snowR - nr) * kSnow;
        ng += (snowG - ng) * kSnow;
        nb += (snowB - nb) * kSnow;
        rgba[i] = nr;
        rgba[i + 1] = ng;
        rgba[i + 2] = nb;
    }
}

// ---------------------------------------------------------------- MapLibre protocol

interface SnowParams {
    t: string; // tile URL template
    d: string; // DEM template
    s: number | null; // snow line
    a: number; // amount
}

const demCache = new Map<string, Promise<Float32Array | null>>();
const DEM_CACHE_MAX = 300;
const DEM_TIMEOUT_MS = 15000;

async function fetchBitmap(url: string, signal: AbortSignal): Promise<ImageBitmap> {
    const res = await fetch(url, { signal });
    // MapLibre treats a 404 as "no tile here" (quietly) when the error carries the status.
    // Without the query string: it may hold the basemap's API key.
    if (!res.ok) throw Object.assign(new Error(`Tile ${res.status}: ${redactUrls(url)}`), { status: res.status });
    return createImageBitmap(await res.blob());
}

function demTile(template: string, z: number, x: number, y: number): Promise<Float32Array | null> {
    const key = `${template}|${z}/${x}/${y}`;
    let p = demCache.get(key);
    if (!p) {
        p = (async () => {
            try {
                // A stuck DEM request must not hold the tile forever: without heights it is snow everywhere.
                const bmp = await fetchBitmap(template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)), AbortSignal.timeout(DEM_TIMEOUT_MS));
                const c = new OffscreenCanvas(bmp.width, bmp.height);
                const ctx = c.getContext('2d', { willReadFrequently: true })!;
                ctx.drawImage(bmp, 0, 0);
                bmp.close();
                const px = ctx.getImageData(0, 0, c.width, c.height).data;
                const h = new Float32Array(c.width * c.height);
                for (let i = 0; i < h.length; i++) h[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
                return h;
            } catch {
                return null;
            }
        })();
        demCache.set(key, p);
        if (demCache.size > DEM_CACHE_MAX) demCache.delete(demCache.keys().next().value!);
    }
    return p;
}

const registered = new WeakSet<object>();

/** Registers the protocol on the given maplibre-gl module (idempotent). */
export function registerSnowProtocol(ml: typeof MapLibre) {
    if (registered.has(ml)) return;
    registered.add(ml);
    ml.addProtocol(PROTOCOL, async (params, abort) => {
        const m = /^flyover-snow:\/\/(\d+)\/(\d+)\/(\d+)\?p=(.+)$/.exec(params.url);
        if (!m) throw new Error(`Bad snow tile URL: ${redactUrls(params.url)}`);
        const z = Number(m[1]), x = Number(m[2]), y = Number(m[3]);
        const p: SnowParams = JSON.parse(decodeURIComponent(m[4]));
        const url = p.t.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));

        const DEM_MAX_Z = 14;
        const dz = Math.max(0, z - DEM_MAX_Z);
        const demZ = z - dz;
        const scale = 2 ** dz;
        const ax = x >> dz, ay = y >> dz;
        const [bmp, dem] = await Promise.all([
            fetchBitmap(url, abort.signal),
            p.s !== null ? demTile(p.d, demZ, ax, ay) : Promise.resolve(null),
        ]);

        const W = bmp.width, H = bmp.height;
        const canvas = new OffscreenCanvas(W, H);
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(bmp, 0, 0);
        bmp.close();
        const img = ctx.getImageData(0, 0, W, H);
        let heightAt: ((i: number) => number) | null = null;
        if (dem) {
            const DW = 256;
            const offX = ((x - ax * scale) / scale) * DW, offY = ((y - ay * scale) / scale) * DW;
            const k = DW / scale / W;
            heightAt = (i: number) => {
                const px = Math.min(DW - 1, Math.floor(offX + (i % W) * k));
                const py = Math.min(DW - 1, Math.floor(offY + Math.floor(i / W) * k));
                return dem[py * DW + px];
            };
        }
        snowifyPixels(img.data, heightAt, { amount: p.a, snowline: p.s });
        ctx.putImageData(img, 0, 0);
        return { data: canvas.transferToImageBitmap() };
    });
}

/** Wraps a raster tile URL template so tiles go through the winter filter. */
export function snowTileUrl(template: string, opts: SnowOptions = {}, demTemplate = TERRARIUM_URL): string {
    const p: SnowParams = { t: template, d: demTemplate, s: opts.snowline ?? null, a: opts.amount ?? 1 };
    // {z}/{x}/{y} in the path are filled in by MapLibre; the encoded template keeps its own placeholders.
    return `${PROTOCOL}://{z}/{x}/{y}?p=${encodeURIComponent(JSON.stringify(p))}`;
}
