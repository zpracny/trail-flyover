/**
 * 1:1 port of the current TrailMetrics 3D fly-over camera
 * (github.com/zpracny/TrailMetrics, components/StoryGenerator/story3DCamera.ts)
 * with CAMERA_3D_DEFAULTS inlined. Used only as a baseline for smoothness comparison.
 */
const CAMERA_3D_DEFAULTS = {
    lookaheadFraction: 0.12,
    smoothingWindow: 15,
    smoothingPasses: 3,
    maxBearingRatePerKeyframe: 8,
    keyframeCount: 150,
};
export interface CameraKeyframe {
    center: [number, number]; // [lng, lat]
    bearing: number;          // degrees 0-360
    progress: number;         // 0-1 along trail
}

export interface CameraState {
    center: [number, number];
    bearing: number;
    pitch: number;
    zoom: number;
}

/**
 * Compute bearing (degrees) from point A to point B.
 * Returns 0-360 where 0=North, 90=East.
 */
export function computeBearing(from: [number, number], to: [number, number]): number {
    const [lat1, lng1] = from;
    const [lat2, lng2] = to;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const lat1R = lat1 * Math.PI / 180;
    const lat2R = lat2 * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(lat2R);
    const x = Math.cos(lat1R) * Math.sin(lat2R) - Math.sin(lat1R) * Math.cos(lat2R) * Math.cos(dLng);
    const bearing = Math.atan2(y, x) * 180 / Math.PI;
    return (bearing + 360) % 360;
}

/**
 * Compute zoom level that fits a bounding box into the given canvas size.
 */
function computeZoomForBbox(
    bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number },
    canvasW: number,
    canvasH: number,
    pitch: number
): number {
    const latSpan = bbox.maxLat - bbox.minLat;
    const lngSpan = bbox.maxLng - bbox.minLng;
    if (latSpan === 0 && lngSpan === 0) return 14;

    const pitchFactor = Math.cos(pitch * Math.PI / 180);
    const effectiveH = canvasH * pitchFactor;

    const zoomLat = Math.log2(effectiveH / (latSpan * 512 / 360)) - 0.5;
    const zoomLng = Math.log2(canvasW / (lngSpan * 512 / 360)) - 0.5;

    return Math.max(8, Math.min(16, Math.min(zoomLat, zoomLng)));
}

/**
 * Compute cumulative haversine distances along a trail (meters).
 */
export function buildCumDists(latlngs: [number, number][]): number[] {
    const R = 6371000;
    const d = [0];
    for (let i = 1; i < latlngs.length; i++) {
        const [lat1, lng1] = latlngs[i - 1];
        const [lat2, lng2] = latlngs[i];
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
        d.push(d[i - 1] + 2 * R * Math.asin(Math.sqrt(a)));
    }
    return d;
}

/**
 * Return the interpolated [lat, lng] position at exactly targetDist meters along the trail.
 * Interpolates linearly between the two surrounding GPS points — no snapping.
 */
function interpolateAtDist(
    latlngs: [number, number][],
    cumDists: number[],
    targetDist: number,
): [number, number] {
    const n = latlngs.length;
    if (targetDist <= 0) return latlngs[0];
    if (targetDist >= cumDists[n - 1]) return latlngs[n - 1];

    let lo = 0, hi = n - 1;
    while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (cumDists[mid] <= targetDist) lo = mid; else hi = mid;
    }
    const segLen = cumDists[hi] - cumDists[lo];
    const t = segLen > 0 ? (targetDist - cumDists[lo]) / segLen : 0;
    return [
        latlngs[lo][0] + (latlngs[hi][0] - latlngs[lo][0]) * t,
        latlngs[lo][1] + (latlngs[hi][1] - latlngs[lo][1]) * t,
    ];
}

/**
 * Smooth bearing values with a circular moving average (handles 0↔360 wraparound).
 */
function smoothBearings(bearings: number[], window: number): number[] {
    const half = Math.floor(window / 2);
    const result: number[] = [];
    for (let i = 0; i < bearings.length; i++) {
        let sinSum = 0;
        let cosSum = 0;
        let count = 0;
        for (let j = Math.max(0, i - half); j <= Math.min(bearings.length - 1, i + half); j++) {
            const rad = bearings[j] * Math.PI / 180;
            sinSum += Math.sin(rad);
            cosSum += Math.cos(rad);
            count++;
        }
        const avgRad = Math.atan2(sinSum / count, cosSum / count);
        result.push((avgRad * 180 / Math.PI + 360) % 360);
    }
    return result;
}

/**
 * Clamp bearing rate of change — no more than maxRate degrees between consecutive keyframes.
 * This prevents sudden whip-around when the trail does a U-turn.
 */
function clampBearingRate(bearings: number[], maxRate: number): number[] {
    const result = [bearings[0]];
    for (let i = 1; i < bearings.length; i++) {
        let delta = bearings[i] - result[i - 1];
        // Shortest arc
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        // Clamp
        if (delta > maxRate) delta = maxRate;
        if (delta < -maxRate) delta = -maxRate;
        result.push((result[i - 1] + delta + 360) % 360);
    }
    return result;
}

/**
 * Compute camera keyframes along a trail.
 *
 * Keyframes are placed at equal DISTANCE intervals (not equal index intervals),
 * with positions interpolated between GPS points. This gives constant ground-speed
 * playback regardless of GPS point density (which varies with activity speed).
 *
 * Multi-pass smoothing + rate limiting for buttery smooth camera rotation.
 */
export function computeCameraPath(
    latlngs: [number, number][],
    options?: {
        keyframeCount?: number;
        lookaheadFraction?: number;
        smoothingWindow?: number;
        smoothingPasses?: number;
        maxBearingRate?: number;
    }
): CameraKeyframe[] {
    const count = options?.keyframeCount ?? CAMERA_3D_DEFAULTS.keyframeCount;
    const lookahead = options?.lookaheadFraction ?? CAMERA_3D_DEFAULTS.lookaheadFraction;
    const smoothWindow = options?.smoothingWindow ?? CAMERA_3D_DEFAULTS.smoothingWindow;
    const passes = options?.smoothingPasses ?? CAMERA_3D_DEFAULTS.smoothingPasses;
    const maxRate = options?.maxBearingRate ?? CAMERA_3D_DEFAULTS.maxBearingRatePerKeyframe;

    if (latlngs.length < 2) {
        return [{ center: [latlngs[0]?.[1] ?? 0, latlngs[0]?.[0] ?? 0], bearing: 0, progress: 0 }];
    }

    // Cumulative distances — used for all distance-based lookups
    const cumDists = buildCumDists(latlngs);
    const totalDist = cumDists[latlngs.length - 1];
    const lookaheadDist = lookahead * totalDist;

    // Pre-compute keyframe positions + lookahead points at exact distances.
    // interpolateAtDist() returns a linearly interpolated point between GPS samples,
    // so consecutive keyframes always have distinct positions even in GPS-sparse sections.
    const kfPoints: [number, number][] = [];
    const laPoints: [number, number][] = [];   // full lookahead (for bearing)
    const halfLaPoints: [number, number][] = []; // half lookahead (for center offset)

    for (let i = 0; i < count; i++) {
        const dist = (i / (count - 1)) * totalDist;
        kfPoints.push(interpolateAtDist(latlngs, cumDists, dist));
        laPoints.push(interpolateAtDist(latlngs, cumDists, Math.min(totalDist, dist + lookaheadDist)));
        halfLaPoints.push(interpolateAtDist(latlngs, cumDists, Math.min(totalDist, dist + lookaheadDist * 0.5)));
    }

    // Raw bearings: current → lookahead (distance-based)
    let bearings = kfPoints.map((pt, i) => computeBearing(pt, laPoints[i]));

    // Multi-pass circular smoothing + rate-clamping
    for (let p = 0; p < passes; p++) {
        bearings = smoothBearings(bearings, smoothWindow);
    }
    bearings = clampBearingRate(bearings, maxRate);
    bearings = smoothBearings(bearings, Math.max(5, Math.floor(smoothWindow / 2)));

    // Build keyframes — center is midpoint(current, halfLookahead) for a slight forward lean
    return kfPoints.map((pt, i) => ({
        center: [
            (pt[1] + halfLaPoints[i][1]) / 2,  // lng average ([lng, lat] for MapLibre)
            (pt[0] + halfLaPoints[i][0]) / 2,  // lat average
        ],
        bearing: bearings[i],
        progress: i / (count - 1),
    }));
}

/**
 * Interpolate camera state at a given progress (0-1) between keyframes.
 * Uses shortest-arc bearing interpolation with smooth easing.
 */
export function interpolateCamera(
    keyframes: CameraKeyframe[],
    progress: number,
    pitch: number,
    zoom: number
): CameraState {
    if (keyframes.length === 0) {
        return { center: [0, 0], bearing: 0, pitch, zoom };
    }
    if (keyframes.length === 1 || progress <= 0) {
        return { center: keyframes[0].center, bearing: keyframes[0].bearing, pitch, zoom };
    }
    if (progress >= 1) {
        const last = keyframes[keyframes.length - 1];
        return { center: last.center, bearing: last.bearing, pitch, zoom };
    }

    // Find surrounding keyframes
    let lo = 0;
    let hi = keyframes.length - 1;
    for (let i = 0; i < keyframes.length - 1; i++) {
        if (keyframes[i].progress <= progress && keyframes[i + 1].progress >= progress) {
            lo = i;
            hi = i + 1;
            break;
        }
    }

    const kfLo = keyframes[lo];
    const kfHi = keyframes[hi];
    const span = kfHi.progress - kfLo.progress;
    const t = span > 0 ? (progress - kfLo.progress) / span : 0;

    // Smooth easing (smoothstep) for bearing transitions
    const tSmooth = t * t * (3 - 2 * t);

    // Linear interpolation of center
    const lng = kfLo.center[0] + (kfHi.center[0] - kfLo.center[0]) * t;
    const lat = kfLo.center[1] + (kfHi.center[1] - kfLo.center[1]) * t;

    // Shortest-arc bearing interpolation with smoothstep
    let dBearing = kfHi.bearing - kfLo.bearing;
    if (dBearing > 180) dBearing -= 360;
    if (dBearing < -180) dBearing += 360;
    const bearing = (kfLo.bearing + dBearing * tSmooth + 360) % 360;

    return { center: [lng, lat], bearing, pitch, zoom };
}

/** progress (0–1, linear in time as in Story3DEngine) → camera center [lng, lat] + bearing */
export function trailMetricsCamera(latlngs: [number, number][]) {
    const keyframes = computeCameraPath(latlngs);
    return (progress: number) => interpolateCamera(keyframes, progress, 55, 12);
}
