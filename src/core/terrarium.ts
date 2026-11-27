/**
 * Synchronous DEM sampler backed by Terrarium-encoded PNG tiles (AWS Open Data, free, no key).
 *
 * The flight plan needs ground heights for the camera *before* rendering and
 * independent of what the map has loaded, otherwise the camera height would
 * change as better terrain tiles arrive (vertical bobbing).
 */
import type { ElevationSampler } from './flightPlan.ts';

export const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

export interface BBox {
    west: number;
    south: number;
    east: number;
    north: number;
}

export interface TerrariumOptions {
    url?: string;
    /** Highest zoom to use (≈ 38 m/px at z12 in central Europe). */
    maxZoom?: number;
    /** Upper bound of tiles to download; zoom is lowered until the bbox fits. */
    maxTiles?: number;
    signal?: AbortSignal;
    /** Per-tile timeout in ms. Default 15000. */
    tileTimeoutMs?: number;
}

const TILE = 256;

/** Continuous tile X (not wrapped): longitudes past ±180° map past the edge of the world grid. */
const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const latToY = (lat: number, z: number) => {
    const r = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

/** Expands a bbox by a distance in metres. */
export function expandBBox(b: BBox, metres: number): BBox {
    const dLat = metres / 111320;
    const dLon = metres / (111320 * Math.cos((((b.south + b.north) / 2) * Math.PI) / 180));
    return { west: b.west - dLon, south: b.south - dLat, east: b.east + dLon, north: b.north + dLat };
}

export async function loadTerrariumSampler(bbox: BBox, opts: TerrariumOptions = {}): Promise<ElevationSampler> {
    const url = opts.url ?? TERRARIUM_URL;
    const maxTiles = opts.maxTiles ?? 80;
    let z = opts.maxZoom ?? 12;
    let x0 = 0, x1 = 0, y0 = 0, y1 = 0;
    for (; z >= 4; z--) {
        x0 = Math.floor(lonToX(bbox.west, z));
        x1 = Math.floor(lonToX(bbox.east, z));
        y0 = Math.floor(latToY(bbox.north, z));
        y1 = Math.floor(latToY(bbox.south, z));
        if ((x1 - x0 + 1) * (y1 - y0 + 1) <= maxTiles) break;
    }

    const tiles = new Map<string, Float32Array>();
    const jobs: Array<[number, number]> = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push([x, y]);

    const canvas = new OffscreenCanvas(TILE, TILE);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

    const fetchTile = async ([x, y]: [number, number]) => {
        // Tracks across the antimeridian have x outside the grid → wrap for the request only.
        const wx = ((x % 2 ** z) + 2 ** z) % 2 ** z;
        // One stuck request must not hang the whole load; a missing tile only costs DEM detail.
        const timeout = AbortSignal.timeout(opts.tileTimeoutMs ?? 15000);
        const res = await fetch(url.replace('{z}', String(z)).replace('{x}', String(wx)).replace('{y}', String(y)), {
            signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
        });
        if (!res.ok) return; // missing tile → NaN there, the plan falls back to GPS heights
        const bmp = await createImageBitmap(await res.blob());
        ctx.clearRect(0, 0, TILE, TILE);
        ctx.drawImage(bmp, 0, 0);
        bmp.close();
        const px = ctx.getImageData(0, 0, TILE, TILE).data;
        const h = new Float32Array(TILE * TILE);
        for (let i = 0; i < h.length; i++) h[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
        tiles.set(`${x}/${y}`, h);
    };

    // A few parallel downloads; decoding shares one canvas so it is sequential anyway.
    let next = 0;
    await Promise.all(
        Array.from({ length: 6 }, async () => {
            while (next < jobs.length) await fetchTile(jobs[next++]).catch(err => {
                if (opts.signal?.aborted) throw err;
            });
        }),
    );

    const heightAt = (gx: number, gy: number): number => {
        const tx = Math.floor(gx / TILE), ty = Math.floor(gy / TILE);
        const t = tiles.get(`${tx}/${ty}`);
        if (!t) return NaN;
        return t[(gy - ty * TILE) * TILE + (gx - tx * TILE)];
    };

    return (lon: number, lat: number) => {
        const fx = lonToX(lon, z) * TILE - 0.5;
        const fy = latToY(lat, z) * TILE - 0.5;
        const ix = Math.floor(fx), iy = Math.floor(fy);
        const ax = fx - ix, ay = fy - iy;
        const h00 = heightAt(ix, iy), h10 = heightAt(ix + 1, iy);
        const h01 = heightAt(ix, iy + 1), h11 = heightAt(ix + 1, iy + 1);
        return (h00 * (1 - ax) + h10 * ax) * (1 - ay) + (h01 * (1 - ax) + h11 * ax) * ay;
    };
}
