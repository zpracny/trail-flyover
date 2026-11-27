/**
 * Input hygiene for recorded tracks. Real GPX files contain the odd broken fix; a single
 * point 80 km away would ruin the overview shot and send the camera on a detour.
 */
import { type TrackPoint, haversine } from './geo.ts';

/** Implied speed above which an out-and-back excursion cannot be real (m/s ≈ 180 km/h). */
const SPIKE_SPEED = 50;
/** Excursions shorter than this are left to the smoothing (m). */
const SPIKE_MIN = 200;
/** A glitch may last a few fixes; look this far ahead for the track coming back. */
const SPIKE_LOOKAHEAD = 5;

const valid = (p: TrackPoint) =>
    Number.isFinite(p.lon) && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 360 &&
    !(Math.abs(p.lat) < 1e-9 && Math.abs(p.lon) < 1e-9); // "null island": receiver without a fix

/**
 * Drops unusable points:
 * - non-finite or impossible coordinates and the 0°/0° placeholder,
 * - teleport spikes: the track jumps away faster than 180 km/h and is back near the last good
 *   point within a few fixes. Needs timestamps; without them a far point may be a legitimate
 *   sparse route node, so it is kept. A jump that does *not* come back (paused recording,
 *   train, ferry) is kept too,
 * - a lone first or last fix that is such a jump away from the rest (receiver cold start).
 */
export function sanitizeTrack(input: TrackPoint[]): TrackPoint[] {
    const pts = input.filter(valid);
    const out: TrackPoint[] = [];
    for (let i = 0; i < pts.length; i++) {
        const prev = out[out.length - 1];
        const p = pts[i];
        if (prev && fastJump(prev, p)) {
            const jump = haversine(prev.lat, prev.lon, p.lat, p.lon);
            // A lone first fix far from everything that follows (receiver cold start): the jump is
            // the fix settling. "Far" = out of proportion with the movement right after it, so a
            // fast vehicle sampled sparsely is not mistaken for it.
            if (out.length === 1 && i < pts.length - 1 && jump > 10 * haversine(p.lat, p.lon, pts[i + 1].lat, pts[i + 1].lon)) {
                out[0] = p;
                continue;
            }
            // Same for a lone last fix.
            const before = out[out.length - 2];
            if (i === pts.length - 1 && before && jump > 10 * haversine(before.lat, before.lon, prev.lat, prev.lon)) continue;
            // A spike in the middle that comes back.
            if (returns(prev, pts, i)) continue;
        }
        out.push(p);
    }
    return out;
}

/** Further than a GPS wobble and faster than anything on the ground. Needs both timestamps. */
function fastJump(prev: TrackPoint, p: TrackPoint): boolean {
    const d = haversine(prev.lat, prev.lon, p.lat, p.lon);
    if (d < SPIKE_MIN) return false;
    if (prev.time == null || p.time == null) return false;
    const dt = Math.abs(p.time - prev.time) / 1000;
    return d / Math.max(dt, 1e-3) >= SPIKE_SPEED;
}

function returns(prev: TrackPoint, pts: TrackPoint[], i: number): boolean {
    const p = pts[i];
    const d = haversine(prev.lat, prev.lon, p.lat, p.lon);
    // Fast jump away — a glitch only if the track returns to where it was.
    for (let k = i + 1; k <= Math.min(pts.length - 1, i + SPIKE_LOOKAHEAD); k++) {
        if (haversine(prev.lat, prev.lon, pts[k].lat, pts[k].lon) < 0.3 * d) return true;
    }
    return false;
}

/**
 * Makes longitudes continuous across the antimeridian (179.9° → 180.1° instead of −179.9°),
 * so the local projection and bounding boxes work for tracks in Fiji, Chukotka or the Aleutians.
 * Tracks that do not cross ±180° are returned unchanged (bit for bit).
 */
export function unwrapLongitudes(pts: TrackPoint[]): TrackPoint[] {
    let turns = 0;
    let crossed = false;
    const out = pts.map((p, i) => {
        if (i > 0) {
            const d = p.lon - pts[i - 1].lon;
            if (d > 180) turns--;
            else if (d < -180) turns++;
        }
        if (turns === 0) return p;
        crossed = true;
        return { ...p, lon: p.lon + 360 * turns };
    });
    return crossed ? out : pts;
}
