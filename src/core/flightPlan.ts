/**
 * Flight plan: a deterministic function time → camera pose, computed up front.
 *
 * Preview playback and video export both call `poseAt(t)`, so the exported
 * video is frame-for-frame what the preview shows. Nothing here depends on the
 * map renderer, which keeps it testable in Node and reusable with other engines.
 *
 * Why it is smooth:
 * - the track is resampled to uniform spacing, then the camera target and the
 *   heading are Gaussian-smoothed with a window proportional to the camera
 *   distance (zoomed out = smoother path), with zero phase lag;
 * - the camera moves along the track with a velocity profile that ramps up and
 *   down smoothly (no sudden start/stop), intro and outro use quintic easing;
 * - the heading is smoothed again in time and its angular velocity is limited,
 *   so U-turns at high playback speed turn into a gentle pan;
 * - camera altitude comes from a smoothed DEM, not from whatever terrain tile
 *   the renderer happens to have loaded — no vertical bobbing.
 */
import {
    type TrackPoint, localProjection, resampleUniform, gaussianSmooth, unwrapDegrees, fillGaps,
    sampleAt, clamp, lerp, smoothstep, smootherstep, slidingMax, haversine, angleDiff,
} from './geo.ts';
import { sanitizeTrack, unwrapLongitudes } from './clean.ts';

const DEG = Math.PI / 180;
/** Shortest video the planner makes (s). Below ~8 s a fly-over is more of a flash than a flight. */
const MIN_DURATION = 3;

/** Returns ground elevation in metres for a point, or NaN when unknown. */
export type ElevationSampler = (lon: number, lat: number) => number;

export type PresetId = 'drone' | 'low' | 'overview' | 'topdown';

export interface CameraPreset {
    label: string;
    /** MapLibre pitch in degrees (0 = straight down) during the follow phase. */
    pitch: number;
    /**
     * Ground distance travelled per second, as a fraction of the camera distance.
     * Lower = calmer (camera further away for the same playback speed).
     */
    screenRate: number;
    /** How far ahead of the trail tip the camera looks, as a fraction of camera distance. */
    lead: number;
}

export const CAMERA_PRESETS: Record<PresetId, CameraPreset> = {
    // lead is tuned so the trail tip sits at ~60–65 % of the frame height
    drone: { label: 'Drone', pitch: 62, screenRate: 0.36, lead: 0.12 },
    low: { label: 'Low flight', pitch: 73, screenRate: 0.45, lead: 0.2 },
    overview: { label: 'Overview', pitch: 45, screenRate: 0.18, lead: 0.05 },
    // 2D map: camera straight down, the same smoothing and timing as the 3D presets.
    topdown: { label: '2D top-down', pitch: 0, screenRate: 0.3, lead: 0.12 },
};

export interface FlightOptions {
    /**
     * Video length in seconds, not counting stops (min. 3). Default scales with track length:
     * 12 s + 0.4 s/km, at most 60 s (static camera: 8 s + 0.15 s/km, at most 24 s).
     */
    duration?: number;
    /**
     * 'follow' (default) = the camera flies along the track.
     * 'static' = the camera stands still with the whole track in view and only the line runs.
     */
    camera?: 'follow' | 'static';
    preset?: PresetId;
    /** Overrides the preset pitch (degrees, 0 = top-down). */
    pitch?: number;
    /** Overrides the automatic camera distance in metres. */
    range?: number;
    /**
     * Multiplies the automatic camera distance: 0.5 = twice as close, 2 = twice as far. For a
     * "camera height" slider that keeps adapting to the track length and video duration.
     * Closer means more motion on screen at the same ground speed: below about 0.6 the flight
     * gets noticeably livelier.
     */
    rangeScale?: number;
    /** Terrain exaggeration used by the renderer (camera altitude must match). */
    exaggeration?: number;
    /** DEM sampler. Without it the GPX elevations are used. */
    terrain?: ElevationSampler | null;
    /** Output width / height (for framing the overview shots). */
    aspect?: number;
    /** Vertical field of view in degrees. MapLibre default is ~36.87°. */
    fovDeg?: number;
    /**
     * Seconds of the opening overview → start flight. Default depends on the zoom ratio. Shortened if it does not fit.
     * Static camera: how long the empty map is shown before the line starts.
     */
    intro?: number;
    /** Seconds of the closing pull-back to the overview. Static camera: how long the finished line stays. */
    outro?: number;
    /** Degrees the camera orbits during the outro. */
    outroOrbit?: number;
    /** Keep north up (no rotation) — typical for 2D maps. */
    northUp?: boolean;
    /** Internal sample rate of the precomputed camera path. */
    sampleRate?: number;
    /**
     * Places where the flight stands still for a while — to show a photo, a note, a split time.
     * The trail and the camera slow down smoothly, wait, and set off again. Stops add to the
     * video length: total = `duration` + the sum of the stops. See `FlightPlan.stops` / `stopAt`.
     */
    stops?: FlightStop[];
    /** A stop given by lon/lat further than this from the track is ignored (m). Default 500. */
    stopMaxOffTrack?: number;
    /**
     * Parts of the picture the track should stay clear of in whole-route shots (overview,
     * static camera), as fractions of the picture: `top` and `bottom` of its height, `side` of
     * its width on each side. Defaults fit the built-in title and stats panel:
     * top 0.14, bottom 0.19, side 0.07. Raise them for bigger panels or social-media safe zones.
     */
    margins?: { top?: number; bottom?: number; side?: number };
}

/** Where a stop is: one of `distance`, `time` or `lon`+`lat` (tried in this order). */
export interface FlightStop {
    /** Metres along the recorded track. */
    distance?: number;
    /** Timestamp in ms, matched against the times of the track points. */
    time?: number;
    /** A place; the first time the track passes near it is used. */
    lon?: number;
    lat?: number;
    /** Seconds the flight stands still. */
    duration: number;
    /** Anything the app wants back with the stop (photo ids, a caption…). */
    data?: unknown;
}

/** A stop placed on the timeline of the video. */
export interface PlannedStop {
    /** Index in the `stops` option this came from. */
    input: number;
    /** Metres along the recorded track (same scale as `TrackStats.distance`). */
    distance: number;
    lon: number;
    lat: number;
    /** Video time (s) when the trail arrives and stands still, and when it sets off again. */
    start: number;
    end: number;
    duration: number;
    data: unknown;
}

/** The stop the video is standing at, with how far through it we are. */
export interface ActiveStop {
    stop: PlannedStop;
    /** Order of the stop along the track (0 = first). */
    index: number;
    /** Seconds since the trail stopped, and until it sets off again. */
    elapsed: number;
    remaining: number;
    /** 0–1 through the stop. */
    progress: number;
}

/** Elevation along the track, ready for drawing a profile (a few hundred points). */
export interface ElevationProfile {
    /** Metres along the recorded track. */
    distance: Float64Array;
    /** Metres above sea level (real, not exaggerated). */
    elevation: Float64Array;
    min: number;
    max: number;
}

export interface Vec3Geo {
    lon: number;
    lat: number;
    /** Metres above sea level, already multiplied by terrain exaggeration. */
    alt: number;
}

export interface CameraPose {
    camera: Vec3Geo;
    target: Vec3Geo;
    /** Heading in degrees (0 = north), for HUD / debugging. */
    bearing: number;
    pitch: number;
    range: number;
}

export interface TrackStats {
    /** Distance travelled along the recorded track in metres (geodesic sum of the original points). */
    distance: number;
    /** Cumulative ascent in metres. */
    ascent: number;
    /** Elapsed recorded time in seconds (stops included), or null when the GPX has no times. */
    elapsed: number | null;
    /** Moving time in seconds (stops left out), or null when the GPX has no times. */
    moving: number | null;
    /** Elevation at the tip (metres, real — not exaggerated), NaN if unknown. */
    elevation: number;
}

export interface FlightPlan {
    duration: number;
    /** Geodesic track length in metres (sum over the original points, GPS glitches removed). */
    length: number;
    meta: {
        camera: 'follow' | 'static';
        /** Seconds the trail is moving: `duration` minus intro, outro and stops. */
        moving: number;
        preset: PresetId;
        pitch: number;
        range: number;
        /** Ground speed of the trail tip during the follow phase, m/s. */
        followSpeed: number;
        intro: number;
        outro: number;
        step: number;
        exaggeration: number;
    };
    /** Uniformly resampled track used for drawing. */
    track: {
        lon: Float64Array;
        lat: Float64Array;
        /** Real ground/GPS elevation in metres (not exaggerated). */
        ele: Float64Array;
        /** Distance along track in metres (planar, matches distanceAt). */
        s: Float64Array;
    };
    poseAt(t: number): CameraPose;
    /** Distance of the trail tip along `track.s` at time t. */
    distanceAt(t: number): number;
    /** Inverse of distanceAt: the first moment the trail tip reaches distance s (0 for the start, also during the intro). */
    timeAt(s: number): number;
    /** Stops in the order the trail reaches them (those that could not be placed are left out). */
    stops: PlannedStop[];
    /** The stop the video is standing at at time t, or null while the trail is moving. */
    stopAt(t: number): ActiveStop | null;
    /** Elevation profile for drawing, or null when the track has no elevations. */
    profile: ElevationProfile | null;
    tipAt(t: number): { lon: number; lat: number; ele: number };
    statsAt(t: number): TrackStats;
}

interface PoseParams {
    x: number;
    y: number;
    z: number;
    heading: number;
    pitch: number;
    range: number;
}

export function buildFlightPlan(input: TrackPoint[], opts: FlightOptions = {}): FlightPlan {
    // Broken fixes out, longitudes continuous across ±180° (see clean.ts).
    const pts = unwrapLongitudes(sanitizeTrack(input));
    if (pts.length < 2) throw new Error('The track needs at least 2 points.');

    // --- Local frame -------------------------------------------------------
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const p of pts) {
        minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
        minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    }
    const proj = localProjection((minLon + maxLon) / 2, (minLat + maxLat) / 2);
    const xs = new Float64Array(pts.length);
    const ys = new Float64Array(pts.length);
    const es = new Float64Array(pts.length);
    const ts = new Float64Array(pts.length);
    pts.forEach((p, i) => {
        [xs[i], ys[i]] = proj.toXY(p.lon, p.lat);
        es[i] = p.ele ?? NaN;
        ts[i] = p.time ?? NaN;
    });
    let rawLen = 0;
    for (let i = 1; i < pts.length; i++) rawLen += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    if (rawLen < 1) throw new Error('The track is too short.');

    // Per-point channels carried through the resampling: exact recorded distance and moving time.
    const rawDist = new Float64Array(pts.length);
    for (let i = 1; i < pts.length; i++) rawDist[i] = rawDist[i - 1] + haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
    const rawTime = Number.isFinite(ts[0]) && Number.isFinite(ts[pts.length - 1]) ? fillGaps(ts) : null;
    const rawMoving = rawTime ? movingTime(pts, rawTime) : null;

    const rs = resampleUniform(xs, ys, es, ts, clamp(rawLen / 4000, 4, 30), rawMoving ? [rawDist, rawMoving] : [rawDist]);
    const n = rs.x.length;
    const step = rs.step;
    const L = rs.length;

    const trackLon = new Float64Array(n);
    const trackLat = new Float64Array(n);
    const trackS = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        [trackLon[i], trackLat[i]] = proj.toLonLat(rs.x[i], rs.y[i]);
        trackS[i] = i * step;
    }

    // --- Elevation ---------------------------------------------------------
    const exag = opts.exaggeration ?? 1;
    const terrain = opts.terrain ?? null;
    const gps = fillGaps(rs.ele);
    let dem: Float64Array | null = null;
    if (terrain) {
        const d = new Float64Array(n);
        for (let i = 0; i < n; i++) d[i] = terrain(trackLon[i], trackLat[i]);
        dem = fillGaps(d);
    }
    const groundTrack = dem ?? (gps ? gaussianSmooth(gps, 30 / step) : new Float64Array(n));
    const displayEle = gps ? gaussianSmooth(gps, 15 / step) : groundTrack;

    // Stats along the resampled track
    const geoCum = rs.extra[0];
    const movingCum = rawMoving ? rs.extra[1] : null;
    const ascent = new Float64Array(n);
    const ascentSrc = gps ? gaussianSmooth(gps, 40 / step) : groundTrack;
    for (let i = 1; i < n; i++) {
        ascent[i] = ascent[i - 1] + Math.max(0, ascentSrc[i] - ascentSrc[i - 1]);
    }
    const timeFilled = rawTime ? fillGaps(rs.time) : null;

    // --- Timing & camera parameters -----------------------------------------
    const lengthKm = geoCum[n - 1] / 1000;
    const isStatic = opts.camera === 'static';
    const autoDuration = isStatic ? clamp(8 + lengthKm * 0.15, 8, 24) : clamp(12 + lengthKm * 0.4, 12, 60);
    /** Length of the flight itself; stops are added on top (see `duration` below). */
    const flightDuration = Math.max(MIN_DURATION, opts.duration ?? autoDuration);
    const presetId: PresetId = opts.preset ?? 'drone';
    const preset = CAMERA_PRESETS[presetId];
    const northUp = opts.northUp ?? false;
    const fov = (opts.fovDeg ?? 36.87) * DEG;
    const aspect = opts.aspect ?? 1;
    // Tall frames (stories) show a lot of distant land when tilted — keep overviews steeper there.
    const overviewPitch = aspect < 0.8 ? 28 : aspect < 1.2 ? 36 : 44;
    const pitch = clamp(opts.pitch ?? (isStatic ? Math.min(preset.pitch, overviewPitch) : preset.pitch), 0, 82);

    // Rough distance from which the whole track is visible (the exact fit comes later).
    let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
    for (let i = 0; i < n; i++) {
        bx0 = Math.min(bx0, rs.x[i]); bx1 = Math.max(bx1, rs.x[i]);
        by0 = Math.min(by0, rs.y[i]); by1 = Math.max(by1, rs.y[i]);
    }
    const tanVHalf = Math.tan(fov / 2);
    const overviewEstimate = Math.max(((bx1 - bx0) / 2) / (tanVHalf * Math.min(aspect, 1)), ((by1 - by0) / 2) / tanVHalf, 700) * 1.35;

    // Narrow frames (9:16 story) see a strip only ~0.38 × range wide, less than the side-to-side
    // wander of a typical trail, so the tip would sweep across the whole picture. Step back most
    // of the way to the strip width of a 4:5 frame (9:16 → camera 1.3× further).
    const narrow = clamp(0.8 / aspect, 1, 1.6) ** 0.75;
    // --- Stops: where along the track, in the order the trail reaches them -----
    const holds: Array<{ input: number; s: number; duration: number; data: unknown }> = [];
    {
        const centreLon = (minLon + maxLon) / 2;
        const maxOff = opts.stopMaxOffTrack ?? 500;
        (opts.stops ?? []).forEach((stop, input) => {
            if (!stop || !Number.isFinite(stop.duration) || !(stop.duration > 0)) return;
            let idx = NaN;
            if (Number.isFinite(stop.distance)) {
                idx = indexOfValue(geoCum, stop.distance as number);
            } else if (timeFilled && Number.isFinite(stop.time) && (stop.time as number) >= timeFilled[0] - 60000 && (stop.time as number) <= timeFilled[n - 1] + 60000) {
                idx = indexOfValue(timeFilled, stop.time as number);
            } else if (Number.isFinite(stop.lon) && Number.isFinite(stop.lat)) {
                // Same turn of the globe as the (unwrapped) track.
                const lon = (stop.lon as number) + 360 * Math.round((centreLon - (stop.lon as number)) / 360);
                const [x, y] = proj.toXY(lon, stop.lat as number);
                const d = (i: number) => Math.hypot(rs.x[i] - x, rs.y[i] - y);
                let best = Infinity;
                for (let i = 0; i < n; i++) best = Math.min(best, d(i));
                if (!(best <= maxOff)) return;
                // The first pass about as close as the closest one, then its local minimum.
                const near = Math.min(maxOff, Math.max(best * 1.4, best + 150));
                let i = 0;
                while (i < n - 1 && d(i) > near) i++;
                let at = i;
                for (let k = i + 1; k < n && d(k) <= near; k++) if (d(k) < d(at)) at = k;
                idx = at;
            }
            if (!Number.isFinite(idx)) return;
            holds.push({ input, s: clamp(idx * step, 0, L), duration: stop.duration, data: stop.data });
        });
        holds.sort((a, b) => a.s - b.s || a.input - b.input);
    }
    const holdTotal = holds.reduce((sum, h) => sum + h.duration, 0);
    /** Lengths of the legs between start, stops and finish. */
    const legs: number[] = [];
    for (let k = 0; k <= holds.length; k++) legs.push((k < holds.length ? holds[k].s : L) - (k ? holds[k - 1].s : 0));
    const movingLegs = Math.max(1, legs.filter(l => l > 1e-6).length);
    /**
     * Time a leg takes at cruise speed v with ramps of `ramp` seconds at both ends. A leg too
     * short to reach cruise speed uses the same acceleration and a lower top speed.
     */
    const legTime = (len: number, v: number, ramp: number) =>
        len <= 1e-6 ? 0 : len >= v * ramp ? len / v + ramp : 2 * ramp * Math.sqrt(len / (v * ramp));

    const timing = (introIn: number, outroIn: number) => {
        // Intro and outro must leave at least a second for the flight itself.
        const fit = Math.min(1, Math.max(0, flightDuration - 1) / Math.max(1e-9, introIn + outroIn));
        const intro = introIn * fit, outro = outroIn * fit;
        const follow = flightDuration - intro - outro;
        let ramp = Math.min(2.2, follow * 0.2);
        let v = L / (follow - ramp);
        if (holds.length) {
            // Every leg starts and ends at rest: shorter ramps, and the cruise speed at which
            // all legs together take exactly the time available.
            ramp = Math.min(ramp, (0.4 * follow) / movingLegs);
            const total = (speed: number) => legs.reduce((sum, len) => sum + legTime(len, speed, ramp), 0);
            let lo = L / follow, hi = lo * 2;
            while (total(hi) > follow && hi < lo * 1e9) hi *= 2;
            for (let k = 0; k < 60; k++) {
                const mid = Math.sqrt(lo * hi);
                if (total(mid) > follow) lo = mid; else hi = mid;
            }
            v = hi;
        }
        const scale = Number.isFinite(opts.rangeScale) && (opts.rangeScale as number) > 0 ? (opts.rangeScale as number) : 1;
        const range = opts.range ?? clamp((v / preset.screenRate) * narrow * scale, 350, 30000);
        return { intro, outro, follow, ramp, v, range };
    };
    // Very short videos (under 8 s) get proportionally shorter overview shots.
    const minIntro = Math.min(1.6, flightDuration * 0.2), minOutro = Math.min(2, flightDuration * 0.25);
    let tm = isStatic
        // Static camera: a short look at the empty map, then the line, then the finished line stays.
        ? timing(Math.max(0, opts.intro ?? clamp(flightDuration * 0.05, 0.4, 1)), Math.max(0, opts.outro ?? clamp(flightDuration * 0.12, 1.2, 3)))
        : timing(Math.max(0, opts.intro ?? clamp(flightDuration * 0.12, minIntro, 4)), Math.max(0, opts.outro ?? clamp(flightDuration * 0.14, minOutro, 5)));
    if (!isStatic && (opts.intro === undefined || opts.outro === undefined)) {
        // Zooming from the whole-track overview to the follow distance is perceived logarithmically.
        // Give big zoom ratios (long tracks) more time: keep d²(ln range)/dt² ≤ 0.6 /s²
        // (quintic easing peaks at 5.77·Δ/T²). The overview estimate is rough, hence the 0.45 target.
        const need = Math.sqrt((5.77 * Math.abs(Math.log(overviewEstimate / tm.range))) / 0.45);
        const cap = Math.min(6, flightDuration * 0.25);
        tm = timing(
            Math.max(0, opts.intro ?? clamp(Math.max(tm.intro, need), minIntro, Math.max(minIntro, cap))),
            Math.max(0, opts.outro ?? clamp(Math.max(tm.outro, need), minOutro, Math.max(minOutro, cap))),
        );
    }
    const { intro, outro, follow, ramp, v, range } = tm;
    const lead = preset.lead * range;

    /** Total video length: the flight plus the time spent standing at stops. */
    const duration = flightDuration + holdTotal;
    /** The follow phase on the clock: moving legs and stops, in order. */
    const followSpan = follow + holdTotal;
    interface Segment { t0: number; T: number; s0: number; len: number; v: number; r: number; hold: number }
    const segments: Segment[] = [];
    {
        let t0 = 0, s0 = 0;
        legs.forEach((len, k) => {
            if (len > 1e-6) {
                // Short leg: same acceleration, lower top speed (see legTime).
                const f = len >= v * ramp ? 1 : Math.sqrt(len / (v * ramp));
                const T = legTime(len, v, ramp);
                segments.push({ t0, T, s0, len, v: v * f, r: ramp * f, hold: -1 });
                t0 += T;
                s0 += len;
            }
            if (k < holds.length) {
                segments.push({ t0, T: holds[k].duration, s0: holds[k].s, len: 0, v: 0, r: 0, hold: k });
                t0 += holds[k].duration;
                s0 = holds[k].s;
            }
        });
    }
    /** Distance of the trail tip at time tau of the follow phase: smooth start and stop on every leg. */
    const sOf = (tau: number): number => {
        if (tau <= 0) return 0;
        if (tau >= followSpan) return L;
        for (const g of segments) {
            const x = tau - g.t0;
            if (x >= g.T) continue;
            if (g.hold >= 0) return g.s0;
            if (x < g.r) {
                const u = x / g.r;
                return g.s0 + g.v * g.r * (u ** 3 - u ** 4 / 2);
            }
            if (x > g.T - g.r) {
                const u = (g.T - x) / g.r;
                return g.s0 + g.len - g.v * g.r * (u ** 3 - u ** 4 / 2);
            }
            return g.s0 + (g.v * g.r) / 2 + g.v * (x - g.r);
        }
        return L;
    };

    // --- Smoothed camera path (extended past both ends) ---------------------
    const pad = Math.ceil((lead + range * 1.5 + 200) / step);
    const m = Math.max(1, Math.min(n - 1, Math.round(Math.min(300, L / 4) / step)));
    const dir = (ax: number, ay: number, bx: number, by: number): [number, number] => {
        const d = Math.hypot(bx - ax, by - ay) || 1;
        return [(bx - ax) / d, (by - ay) / d];
    };
    const d0 = dir(rs.x[m], rs.y[m], rs.x[0], rs.y[0]); // points backwards from start
    const d1 = dir(rs.x[n - 1 - m], rs.y[n - 1 - m], rs.x[n - 1], rs.y[n - 1]);
    const N = n + 2 * pad;
    const ex = new Float64Array(N);
    const ey = new Float64Array(N);
    const ez = new Float64Array(N);
    for (let i = 0; i < N; i++) {
        if (i < pad) {
            const k = pad - i;
            ex[i] = rs.x[0] + d0[0] * k * step;
            ey[i] = rs.y[0] + d0[1] * k * step;
            ez[i] = groundTrack[0];
        } else if (i >= pad + n) {
            const k = i - (pad + n - 1);
            ex[i] = rs.x[n - 1] + d1[0] * k * step;
            ey[i] = rs.y[n - 1] + d1[1] * k * step;
            ez[i] = groundTrack[n - 1];
        } else {
            ex[i] = rs.x[i - pad];
            ey[i] = rs.y[i - pad];
            ez[i] = groundTrack[i - pad];
        }
    }
    const sigTarget = (0.22 * range) / step;
    const tx = gaussianSmooth(ex, sigTarget);
    const ty = gaussianSmooth(ey, sigTarget);
    const tz = gaussianSmooth(ez, (0.6 * range) / step);
    const sigHeading = (0.55 * range) / step;
    const hx = gaussianSmooth(ex, sigHeading);
    const hy = gaussianSmooth(ey, sigHeading);
    const kd = Math.max(1, Math.round((0.25 * range) / step));
    const rawHeading = new Float64Array(N);
    let lastH = 0;
    for (let i = 0; i < N; i++) {
        const a = Math.max(0, i - kd);
        const b = Math.min(N - 1, i + kd);
        const dx = hx[b] - hx[a];
        const dy = hy[b] - hy[a];
        if (Math.hypot(dx, dy) > 1e-6) lastH = Math.atan2(dx, dy) / DEG;
        rawHeading[i] = lastH;
    }
    const heading = gaussianSmooth(unwrapDegrees(rawHeading), (0.3 * range) / step);

    const idx = (s: number) => pad + s / step;
    const followPose = (s: number): PoseParams => {
        const fi = idx(s + lead);
        return {
            x: sampleAt(tx, fi),
            y: sampleAt(ty, fi),
            z: sampleAt(tz, fi) * exag,
            heading: northUp ? 0 : sampleAt(heading, idx(s + lead * 0.5)),
            pitch,
            range,
        };
    };

    const meanGround = groundTrack.reduce((a, b) => a + b, 0) / n;
    const overviewPose = (h: number, p: number, minRange = range): PoseParams => {
        const fx = Math.sin(h * DEG), fy = Math.cos(h * DEG);
        const rx = Math.cos(h * DEG), ry = -Math.sin(h * DEG);
        let umin = Infinity, umax = -Infinity, wmin = Infinity, wmax = -Infinity;
        const stride = Math.max(1, Math.floor(n / 800));
        for (let i = 0; i < n; i += stride) {
            const u = rs.x[i] * rx + rs.y[i] * ry;
            const w = rs.x[i] * fx + rs.y[i] * fy;
            umin = Math.min(umin, u); umax = Math.max(umax, u);
            wmin = Math.min(wmin, w); wmax = Math.max(wmax, w);
        }
        const cu = (umin + umax) / 2;
        let cw = (wmin + wmax) / 2;
        const tanV = Math.tan(fov / 2);
        const tanH = tanV * aspect;
        const sp = Math.sin(p * DEG), cp = Math.cos(p * DEG);
        const tz0 = meanGround * exag;
        // Exact fit with a pinhole camera: every track point must land inside the safe area
        // (horizontal ±0.86, vertical between the bottom stats panel and the title).
        const mg = opts.margins ?? {};
        const SAFE_X = 1 - 2 * clamp(mg.side ?? 0.07, 0, 0.45);
        const SAFE_TOP = 1 - 2 * clamp(mg.top ?? 0.14, 0, 0.45);
        const SAFE_BOTTOM = -(1 - 2 * clamp(mg.bottom ?? 0.19, 0, 0.45));
        const bounds = (w: number, r: number) => {
            // camera frame in (u = right, w = forward, z = up) coordinates
            const camW = w - r * sp, camZ = tz0 + r * cp;
            const Fw = sp, Fz = -cp; // forward (looking down at pitch p)
            const Uw = cp, Uz = sp; // screen up
            let xmax = 0, ymin = Infinity, ymax = -Infinity, behind = false;
            for (let i = 0; i < n; i += stride) {
                const du = rs.x[i] * rx + rs.y[i] * ry - cu;
                const dw = rs.x[i] * fx + rs.y[i] * fy - camW;
                const dz = groundTrack[i] * exag - camZ;
                const zc = dw * Fw + dz * Fz;
                if (zc <= 1) { behind = true; break; }
                xmax = Math.max(xmax, Math.abs(du / (zc * tanH)));
                const y = (dw * Uw + dz * Uz) / (zc * tanV);
                ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
            }
            return { xmax, ymin, ymax, behind };
        };
        const fits = (w: number, r: number) => {
            const b = bounds(w, r);
            return !b.behind && b.xmax <= SAFE_X && b.ymax <= SAFE_TOP && b.ymin >= SAFE_BOTTOM;
        };
        let r = 700;
        for (let pass = 0; pass < 3; pass++) {
            let lo = 300, hi = 400000;
            while (hi / lo > 1.01) {
                const mid = Math.sqrt(lo * hi);
                if (fits(cw, mid)) hi = mid; else lo = mid;
            }
            // Never closer than the follow camera: a short track flown fast is followed from further
            // away than it takes to see all of it, and the intro should not have to zoom *out*.
            r = Math.max(700, hi, minRange);
            if (pass === 2) break;
            // Re-centre vertically inside the safe band, then fit again.
            const b = bounds(cw, r);
            const off = (b.ymax + b.ymin) / 2 - (SAFE_TOP + SAFE_BOTTOM) / 2;
            cw += (off * r * tanV) / Math.max(0.2, cp);
        }
        return { x: rx * cu + fx * cw, y: ry * cu + fy * cw, z: tz0, heading: h, pitch: p, range: r };
    };

    const startFollow = followPose(0);
    const endFollow = followPose(L);
    // Overview heading: normally the direction of travel (no rotation while zooming). But an
    // elongated track seen across a narrow frame ends up tiny — e.g. a north–south ride in a
    // 9:16 story viewed from the side. If turning by up to 90° brings the camera at least 20 %
    // closer, take that heading; the turn is spread over the whole intro/outro.
    const bestOverview = (h0: number, p: number, turnTime: number, minRange = range): PoseParams => {
        const base = overviewPose(h0, p, minRange);
        if (northUp) return base;
        let best = base, bestCost = base.range;
        // Keep the turn within what the yaw limit allows in the time available.
        const maxTurn = Math.min(90, turnTime * 18);
        for (let d = 15; d <= maxTurn + 1e-9; d += 15) {
            for (const sign of [1, -1]) {
                const cand = overviewPose(h0 + sign * d, p, minRange);
                const cost = cand.range * (1 + 0.1 * (d / 90)); // prefer the smaller turn when equal
                if (cost < bestCost) { best = cand; bestCost = cost; }
            }
        }
        return best.range < 0.8 * base.range ? best : base;
    };
    const introFrom = bestOverview(startFollow.heading, Math.min(pitch, overviewPitch - 4), intro);
    // The closing shot orbits a little (outroOrbit, default 25°) unless a better-fitting heading was chosen.
    const outroPitch = Math.min(pitch, overviewPitch);
    const outroFit = opts.outroOrbit === undefined ? bestOverview(endFollow.heading, outroPitch, outro) : null;
    const outroTo = outroFit && Math.abs(angleDiff(endFollow.heading, outroFit.heading)) > 1
        ? outroFit
        : overviewPose(endFollow.heading + (northUp ? 0 : opts.outroOrbit ?? 25), outroPitch);

    const blend = (a: PoseParams, b: PoseParams, e: number): PoseParams => ({
        x: lerp(a.x, b.x, e),
        y: lerp(a.y, b.y, e),
        z: lerp(a.z, b.z, e),
        heading: a.heading + angleDiff(a.heading, b.heading) * e,
        pitch: lerp(a.pitch, b.pitch, e),
        range: Math.exp(lerp(Math.log(a.range), Math.log(b.range), e)),
    });

    // Intro/outro: pan + zoom along a van Wijk–Nuij path, so a long pan happens while the
    // camera is far away (slow on screen) instead of a fast linear slide at low altitude.
    const flight = (a: PoseParams, b: PoseParams) => {
        const path = zoomPanPath(a.range, b.range, Math.hypot(b.x - a.x, b.y - a.y));
        return (e: number): PoseParams => {
            const { u, w } = path(e);
            return { ...blend(a, b, e), x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), range: a.range * w };
        };
    };
    const introFlight = flight(introFrom, startFollow);
    const outroFlight = flight(endFollow, outroTo);
    // Static camera: one pose for the whole video — north up, or turned so the track fills the frame.
    const staticPose = isStatic ? bestOverview(0, pitch, 5, 0) : null;

    // --- Sample the whole timeline -----------------------------------------
    const rate = opts.sampleRate ?? 60;
    const S = Math.ceil(duration * rate) + 1;
    const px = new Float64Array(S), py = new Float64Array(S), pz = new Float64Array(S);
    const ph = new Float64Array(S), pp = new Float64Array(S), pr = new Float64Array(S);
    const sAt = new Float64Array(S);
    for (let j = 0; j < S; j++) {
        const t = Math.min(duration, j / rate);
        let pose: PoseParams;
        if (staticPose) {
            pose = staticPose;
            sAt[j] = t < intro ? 0 : t <= intro + followSpan ? sOf(t - intro) : L;
        } else if (t < intro) {
            pose = introFlight(smootherstep(t / intro));
            sAt[j] = 0;
        } else if (t <= intro + followSpan || outro <= 0) {
            const s = sOf(t - intro);
            pose = followPose(s);
            sAt[j] = s;
        } else {
            pose = outroFlight(smootherstep((t - intro - followSpan) / outro));
            sAt[j] = L;
        }
        px[j] = pose.x; py[j] = pose.y; pz[j] = pose.z;
        ph[j] = pose.heading; pp[j] = pose.pitch; pr[j] = pose.range;
    }

    // Heading: time-domain smoothing + angular velocity limit (deg/s).
    const MAX_YAW_RATE = 32;
    let hs = gaussianSmooth(unwrapDegrees(ph), 0.25 * rate);
    for (let iter = 0, sigma = 0.25 * rate; iter < 8; iter++) {
        let maxRate = 0;
        for (let j = 1; j < S; j++) maxRate = Math.max(maxRate, Math.abs(hs[j] - hs[j - 1]) * rate);
        if (maxRate <= MAX_YAW_RATE) break;
        sigma *= 1.6;
        hs = gaussianSmooth(unwrapDegrees(ph), sigma);
    }

    // Keep the trail tip inside the frame. The smoothed path cuts corners by up to ~0.2 × range,
    // which is more than half the picture width in a 9:16 story. Where the tip would leave the
    // safe band, slide camera and target sideways — with a dilated, smoothed correction so the
    // slide itself is gentle — and fade it out towards the overview shots at both ends.
    if (!staticPose) {
        const tanH = Math.tan(fov / 2) * aspect;
        const LIMIT = 0.58;
        const over = new Float64Array(S), under = new Float64Array(S);
        let any = false;
        for (let j = 0; j < S; j++) {
            const t = Math.min(duration, j / rate);
            if (t < intro || t > intro + followSpan) continue;
            const h = hs[j] * DEG, p = pp[j] * DEG;
            const fi = clamp(sAt[j] / step, 0, n - 1);
            const dx = sampleAt(rs.x, fi) - px[j], dy = sampleAt(rs.y, fi) - py[j];
            const dz = sampleAt(groundTrack, fi) * exag - pz[j];
            const lateral = dx * Math.cos(h) - dy * Math.sin(h);
            const forward = dx * Math.sin(h) + dy * Math.cos(h);
            // Depth of the tip along the view axis (camera sits `range` behind the target).
            const depth = pr[j] + forward * Math.sin(p) - dz * Math.cos(p);
            const allowed = LIMIT * Math.max(1, depth) * tanH;
            if (lateral > allowed) { over[j] = lateral - allowed; any = true; }
            else if (lateral < -allowed) { under[j] = -lateral - allowed; any = true; }
        }
        if (any) {
            const r = Math.round(0.9 * rate), sigma = 0.4 * rate;
            const a = gaussianSmooth(slidingMax(over, r), sigma);
            const b = gaussianSmooth(slidingMax(under, r), sigma);
            for (let j = 0; j < S; j++) {
                const t = Math.min(duration, j / rate);
                const fade = (intro > 0 ? smoothstep(t / intro) : 1) * (outro > 0 ? smoothstep((duration - t) / outro) : 1);
                const shift = (Math.max(0, a[j]) - Math.max(0, b[j])) * fade;
                const h = hs[j] * DEG;
                px[j] += shift * Math.cos(h);
                py[j] -= shift * Math.sin(h);
            }
        }
    }

    // Camera positions
    const cx = new Float64Array(S), cy = new Float64Array(S), cz = new Float64Array(S);
    for (let j = 0; j < S; j++) {
        const h = hs[j] * DEG, p = pp[j] * DEG;
        const back = pr[j] * Math.sin(p);
        cx[j] = px[j] - Math.sin(h) * back;
        cy[j] = py[j] - Math.cos(h) * back;
        cz[j] = pz[j] + pr[j] * Math.cos(p);
    }

    // Terrain clearance: lift the camera where it (or its line of sight) would hit a hill.
    if (terrain) {
        const lift = new Float64Array(S);
        for (let j = 0; j < S; j++) {
            const clearance = Math.max(80, 0.06 * pr[j]);
            let need = 0;
            for (const f of [0, 0.2, 0.4, 0.6]) {
                const x = lerp(cx[j], px[j], f), y = lerp(cy[j], py[j], f);
                const [lon, lat] = proj.toLonLat(x, y);
                const g = terrain(lon, lat);
                if (!Number.isFinite(g)) continue;
                const lineZ = lerp(cz[j], pz[j], f);
                need = Math.max(need, (g * exag + clearance * (1 - f) - lineZ) / (1 - f));
            }
            lift[j] = need;
        }
        const smoothLift = gaussianSmooth(slidingMax(lift, Math.round(0.8 * rate)), 0.35 * rate);
        for (let j = 0; j < S; j++) cz[j] += Math.max(0, smoothLift[j]);
    }

    // Convert to geographic arrays once.
    const camLon = new Float64Array(S), camLat = new Float64Array(S);
    const tgtLon = new Float64Array(S), tgtLat = new Float64Array(S);
    for (let j = 0; j < S; j++) {
        [camLon[j], camLat[j]] = proj.toLonLat(cx[j], cy[j]);
        [tgtLon[j], tgtLat[j]] = proj.toLonLat(px[j], py[j]);
    }

    const fj = (t: number) => (t > 0 ? Math.min(t, duration) * rate : 0); // NaN and negatives → 0
    const distanceAt = (t: number) => sampleAt(sAt, fj(t));
    const timeAt = (s: number) => {
        if (!(s > 0)) return 0;
        if (s >= L) s = L;
        // sAt never decreases: binary search for the first sample at or past s, then interpolate.
        let lo = 0, hi = S - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (sAt[mid] >= s) hi = mid; else lo = mid + 1;
        }
        if (lo === 0) return 0;
        const a = sAt[lo - 1], b = sAt[lo];
        return Math.min(duration, (lo - 1 + (b > a ? (s - a) / (b - a) : 1)) / rate);
    };
    const trackIdx = (s: number) => clamp(s / step, 0, n - 1);

    const stops: PlannedStop[] = segments.filter(g => g.hold >= 0).map(g => {
        const h = holds[g.hold];
        const i = trackIdx(h.s);
        return {
            input: h.input, distance: sampleAt(geoCum, i), lon: sampleAt(trackLon, i), lat: sampleAt(trackLat, i),
            start: intro + g.t0, end: intro + g.t0 + g.T, duration: g.T, data: h.data,
        };
    });

    // Elevation profile for drawing: a few hundred evenly spaced points are plenty.
    let profile: ElevationProfile | null = null;
    if (gps || dem) {
        const P = Math.min(n, 512);
        const distance = new Float64Array(P), elevation = new Float64Array(P);
        let min = Infinity, max = -Infinity;
        for (let k = 0; k < P; k++) {
            const i = P > 1 ? (k * (n - 1)) / (P - 1) : 0;
            distance[k] = sampleAt(geoCum, i);
            elevation[k] = sampleAt(displayEle, i);
            min = Math.min(min, elevation[k]); max = Math.max(max, elevation[k]);
        }
        profile = { distance, elevation, min, max };
    }

    return {
        duration,
        length: rawDist[pts.length - 1],
        meta: {
            camera: isStatic ? 'static' : 'follow', moving: follow, preset: presetId, pitch,
            range: staticPose ? staticPose.range : range, followSpeed: v, intro, outro, step, exaggeration: exag,
        },
        track: { lon: trackLon, lat: trackLat, ele: displayEle, s: trackS },
        poseAt(t) {
            const f = fj(t);
            return {
                camera: { lon: sampleAt(camLon, f), lat: sampleAt(camLat, f), alt: sampleAt(cz, f) },
                target: { lon: sampleAt(tgtLon, f), lat: sampleAt(tgtLat, f), alt: sampleAt(pz, f) },
                bearing: ((sampleAt(hs, f) % 360) + 360) % 360,
                pitch: sampleAt(pp, f),
                range: sampleAt(pr, f),
            };
        },
        distanceAt,
        timeAt,
        stops,
        stopAt(t) {
            if (!(t >= 0)) return null;
            for (let index = 0; index < stops.length; index++) {
                const stop = stops[index];
                if (t >= stop.start && t < stop.end) {
                    const elapsed = t - stop.start;
                    return { stop, index, elapsed, remaining: stop.end - t, progress: elapsed / stop.duration };
                }
            }
            return null;
        },
        profile,
        tipAt(t) {
            const i = trackIdx(distanceAt(t));
            return { lon: sampleAt(trackLon, i), lat: sampleAt(trackLat, i), ele: sampleAt(groundTrack, i) };
        },
        statsAt(t) {
            const i = trackIdx(distanceAt(t));
            return {
                distance: sampleAt(geoCum, i),
                ascent: sampleAt(ascent, i),
                elapsed: timeFilled ? (sampleAt(timeFilled, i) - timeFilled[0]) / 1000 : null,
                moving: movingCum ? sampleAt(movingCum, i) : null,
                elevation: sampleAt(displayEle, i),
            };
        },
    };
}

/** Fractional index at which a non-decreasing array reaches `value` (clamped to the ends). */
function indexOfValue(arr: ArrayLike<number>, value: number): number {
    const n = arr.length;
    if (!(value > arr[0])) return 0;
    if (value >= arr[n - 1]) return n - 1;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] <= value) lo = mid; else hi = mid;
    }
    return lo + (arr[hi] > arr[lo] ? (value - arr[lo]) / (arr[hi] - arr[lo]) : 0);
}

/**
 * Cumulative moving time (s) per point. A segment counts as moving when the net displacement
 * over a ~8-point window is faster than 0.4 m/s — net, so GPS jitter during a stop cancels out.
 */
function movingTime(pts: TrackPoint[], time: Float64Array): Float64Array {
    const n = pts.length;
    const out = new Float64Array(n);
    for (let i = 1; i < n; i++) {
        const a = Math.max(0, i - 4), b = Math.min(n - 1, i + 3);
        const T = (time[b] - time[a]) / 1000;
        const dt = Math.max(0, (time[i] - time[i - 1]) / 1000);
        const moving = T > 0 && haversine(pts[a].lat, pts[a].lon, pts[b].lat, pts[b].lon) / T > 0.4;
        out[i] = out[i - 1] + (moving ? dt : 0);
    }
    return out;
}

/**
 * Smooth zoom-and-pan path (van Wijk & Nuij 2003 — the same idea as MapLibre/Mapbox flyTo).
 * w0/w1: view widths (here: camera distances), u1: pan distance (same units).
 * Returns e ∈ [0,1] → { u: pan fraction 0–1, w: width relative to w0 }.
 */
export function zoomPanPath(w0: number, w1: number, u1: number, rho = 1.42) {
    if (u1 < 1e-6 * Math.max(w0, w1)) {
        const k = Math.log(w1 / w0);
        return (e: number) => ({ u: e, w: Math.exp(k * e) });
    }
    const b = (i: 0 | 1) => (w1 * w1 - w0 * w0 + (i ? -1 : 1) * rho ** 4 * u1 * u1) / (2 * (i ? w1 : w0) * rho * rho * u1);
    const r = (i: 0 | 1) => {
        const bi = b(i);
        return Math.log(Math.sqrt(bi * bi + 1) - bi);
    };
    const r0 = r(0), r1 = r(1);
    const S = (r1 - r0) / rho;
    return (e: number) => {
        const sr = r0 + rho * S * e;
        return {
            u: (w0 * (Math.cosh(r0) * Math.tanh(sr) - Math.sinh(r0))) / (rho * rho * u1),
            w: Math.cosh(r0) / Math.cosh(sr),
        };
    };
}
