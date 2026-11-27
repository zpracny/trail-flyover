/**
 * Pure geometry helpers. No DOM, no MapLibre — runs in Node tests and in the browser.
 */

export const EARTH_RADIUS = 6371008.8;
const DEG = Math.PI / 180;

export interface TrackPoint {
    lon: number;
    lat: number;
    /** Elevation in metres (GPS/barometric). Optional. */
    ele?: number | null;
    /** Timestamp in ms since epoch. Optional. */
    time?: number | null;
}

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLat = (lat2 - lat1) * DEG;
    const dLon = (lon2 - lon1) * DEG;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Local equirectangular projection around a reference point, in metres (x = east, y = north).
 * Accurate enough for smoothing and camera geometry on tracks up to a few hundred km.
 */
export interface LocalProjection {
    lon0: number;
    lat0: number;
    toXY(lon: number, lat: number): [number, number];
    toLonLat(x: number, y: number): [number, number];
}

export function localProjection(lon0: number, lat0: number): LocalProjection {
    const ky = DEG * EARTH_RADIUS;
    const kx = ky * Math.cos(lat0 * DEG);
    return {
        lon0,
        lat0,
        toXY: (lon, lat) => [(lon - lon0) * kx, (lat - lat0) * ky],
        toLonLat: (x, y) => [x / kx + lon0, y / ky + lat0],
    };
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (t: number) => {
    const x = clamp(t, 0, 1);
    return x * x * (3 - 2 * x);
};
export const easeInOutCubic = (t: number) => {
    const x = clamp(t, 0, 1);
    return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};
/** Quintic smootherstep — zero velocity *and* acceleration at both ends. */
export const smootherstep = (t: number) => {
    const x = clamp(t, 0, 1);
    return x * x * x * (x * (x * 6 - 15) + 10);
};

export const wrap360 = (deg: number) => ((deg % 360) + 360) % 360;

/** Shortest signed difference b - a in degrees, in (-180, 180]. */
export function angleDiff(a: number, b: number): number {
    let d = (b - a) % 360;
    if (d > 180) d -= 360;
    if (d <= -180) d += 360;
    return d;
}

/** Makes an angle sequence continuous (no 359 → 0 jumps) so it can be smoothed. */
export function unwrapDegrees(values: ArrayLike<number>): Float64Array {
    const out = new Float64Array(values.length);
    if (values.length === 0) return out;
    out[0] = values[0];
    for (let i = 1; i < values.length; i++) out[i] = out[i - 1] + angleDiff(values[i - 1], values[i]);
    return out;
}

/**
 * Zero-phase Gaussian smoothing (no lag). Ends are padded by odd reflection
 * (2·x0 − x[k]), which keeps the end value and slope instead of pulling the
 * ends towards the interior.
 */
export function gaussianSmooth(values: ArrayLike<number>, sigma: number): Float64Array {
    const n = values.length;
    const out = new Float64Array(n);
    if (n === 0) return out;
    if (!(sigma > 0.3) || n < 3) {
        for (let i = 0; i < n; i++) out[i] = values[i];
        return out;
    }
    const first = values[0];
    const last = values[n - 1];
    const at = (i: number): number => {
        if (i < 0) {
            const j = Math.min(-i, n - 1);
            return 2 * first - values[j];
        }
        if (i > n - 1) {
            const j = Math.max(2 * (n - 1) - i, 0);
            return 2 * last - values[j];
        }
        return values[i];
    };

    // Wide kernels (a short track followed from far away: thousands of samples per sigma) would
    // cost n × 6·sigma. Instead: average the signal twice in boxes of m samples (running sums —
    // together a triangle, i.e. the Gaussian linearly interpolated between taps), then apply the
    // Gaussian to every m-th sample. The same curve to ~0.01 % of the signal, in n × ~150 steps.
    const m = Math.floor(sigma / 24) | 1; // odd, so the boxes are centred
    if (m >= 3) {
        const h = (m - 1) / 2;
        const K = Math.ceil((sigma * 3) / m);
        const R = K * m + 2 * h;
        const E = n + 2 * R;
        let cur = new Float64Array(E);
        for (let j = 0; j < E; j++) cur[j] = at(j - R);
        const sums = new Float64Array(E + 1);
        for (let pass = 0; pass < 2; pass++) {
            for (let j = 0; j < E; j++) sums[j + 1] = sums[j] + cur[j];
            const next = new Float64Array(E);
            for (let j = h; j < E - h; j++) next[j] = (sums[j + h + 1] - sums[j - h]) / m;
            cur = next;
        }
        const taps = new Float64Array(2 * K + 1);
        let tsum = 0;
        for (let k = -K; k <= K; k++) tsum += taps[k + K] = Math.exp(-((k * m) ** 2) / (2 * sigma * sigma));
        for (let k = 0; k < taps.length; k++) taps[k] /= tsum;
        for (let i = 0; i < n; i++) {
            let acc = 0;
            for (let k = 0, c = i + R - K * m; k < taps.length; k++, c += m) acc += taps[k] * cur[c];
            out[i] = acc;
        }
        return out;
    }

    const radius = Math.ceil(sigma * 3);
    const kernel = new Float64Array(radius * 2 + 1);
    let ksum = 0;
    for (let k = -radius; k <= radius; k++) {
        const w = Math.exp(-(k * k) / (2 * sigma * sigma));
        kernel[k + radius] = w;
        ksum += w;
    }
    for (let k = 0; k < kernel.length; k++) kernel[k] /= ksum;
    for (let i = 0; i < n; i++) {
        let acc = 0;
        const lo = i - radius;
        if (lo >= 0 && i + radius < n) {
            for (let k = 0; k < kernel.length; k++) acc += kernel[k] * values[lo + k];
        } else {
            for (let k = 0; k < kernel.length; k++) acc += kernel[k] * at(lo + k);
        }
        out[i] = acc;
    }
    return out;
}

/** Sliding-window maximum (window = 2·radius + 1), O(n·radius) — inputs here are small. */
export function slidingMax(values: ArrayLike<number>, radius: number): Float64Array {
    const n = values.length;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let m = -Infinity;
        for (let k = Math.max(0, i - radius); k <= Math.min(n - 1, i + radius); k++) m = Math.max(m, values[k]);
        out[i] = m;
    }
    return out;
}

export interface ResampledTrack {
    /** Spacing between samples in metres (uniform). */
    step: number;
    /** Total length in metres (local planar). */
    length: number;
    x: Float64Array;
    y: Float64Array;
    /** Elevation (NaN where unknown). */
    ele: Float64Array;
    /** Timestamp ms (NaN where unknown). */
    time: Float64Array;
    /** Extra per-point channels, linearly interpolated (same order as passed in). */
    extra: Float64Array[];
}

/**
 * Resamples a polyline (in local metres) to uniform spacing along its length.
 * GPS density varies with speed and stops; uniform samples make every later
 * filter behave the same along the whole track.
 */
export function resampleUniform(
    xs: ArrayLike<number>,
    ys: ArrayLike<number>,
    eles: ArrayLike<number>,
    times: ArrayLike<number>,
    targetStep: number,
    extras: ArrayLike<number>[] = [],
): ResampledTrack {
    const n = xs.length;
    const cum = new Float64Array(n);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    const length = cum[n - 1] ?? 0;
    const count = Math.max(2, Math.round(length / targetStep) + 1);
    const step = length / (count - 1);
    const x = new Float64Array(count);
    const y = new Float64Array(count);
    const ele = new Float64Array(count);
    const time = new Float64Array(count);
    const extra = extras.map(() => new Float64Array(count));
    let seg = 0;
    for (let k = 0; k < count; k++) {
        const s = k === count - 1 ? length : k * step;
        while (seg < n - 2 && cum[seg + 1] < s) seg++;
        const segLen = cum[seg + 1] - cum[seg];
        const t = segLen > 0 ? clamp((s - cum[seg]) / segLen, 0, 1) : 0;
        const j = Math.min(seg + 1, n - 1);
        x[k] = lerp(xs[seg], xs[j], t);
        y[k] = lerp(ys[seg], ys[j], t);
        ele[k] = interpNaN(eles[seg], eles[j], t);
        time[k] = interpNaN(times[seg], times[j], t);
        for (let c = 0; c < extras.length; c++) extra[c][k] = interpNaN(extras[c][seg], extras[c][j], t);
    }
    return { step, length, x, y, ele, time, extra };
}

function interpNaN(a: number, b: number, t: number): number {
    const fa = Number.isFinite(a);
    const fb = Number.isFinite(b);
    if (fa && fb) return lerp(a, b, t);
    if (fa) return a;
    if (fb) return b;
    return NaN;
}

/** Fills NaN gaps by linear interpolation / nearest value at ends. Returns null when everything is NaN. */
export function fillGaps(values: Float64Array): Float64Array | null {
    const n = values.length;
    const out = new Float64Array(values);
    let prev = -1;
    for (let i = 0; i < n; i++) {
        if (!Number.isFinite(out[i])) continue;
        if (prev === -1) {
            for (let k = 0; k < i; k++) out[k] = out[i];
        } else if (i - prev > 1) {
            for (let k = prev + 1; k < i; k++) out[k] = lerp(out[prev], out[i], (k - prev) / (i - prev));
        }
        prev = i;
    }
    if (prev === -1) return null;
    for (let k = prev + 1; k < n; k++) out[k] = out[prev];
    return out;
}

/** Linear interpolation into a uniformly sampled array at fractional index. */
export function sampleAt(arr: ArrayLike<number>, fi: number): number {
    const n = arr.length;
    if (fi <= 0) return arr[0];
    if (fi >= n - 1) return arr[n - 1];
    const i = Math.floor(fi);
    return lerp(arr[i], arr[i + 1], fi - i);
}
