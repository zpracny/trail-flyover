/**
 * Real recordings for the tests. One file — a 121 km ride from the Julian Alps to the Adriatic,
 * 1 Hz, with long stops — and a shorter ride cut out of it, so that tests cover two lengths
 * without shipping more of anyone's GPS history. For privacy the file starts and ends 1 km away
 * from where the ride really did, and its date is shifted (times of day are real).
 */
import { readFileSync } from 'node:fs';
import { parseGpx } from '../../src/core/gpx.ts';
import { haversine, type TrackPoint } from '../../src/core/geo.ts';

export const loadGpx = (f: string) => parseGpx(readFileSync(new URL(`../fixtures/${f}`, import.meta.url), 'utf8'));

/** Points of a recording between two distances along it (km). */
export function section(points: TrackPoint[], fromKm: number, toKm: number): TrackPoint[] {
    const out: TrackPoint[] = [];
    let d = 0;
    for (let i = 0; i < points.length; i++) {
        if (i > 0) d += haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
        if (d >= fromKm * 1000 && d <= toKm * 1000) out.push(points[i]);
    }
    return out;
}

/** Tolmin → Koper, 120.7 km: long, narrow north–south track (73 × 22 km), sea-level finish. */
export const TOLMIN_KOPER = loadGpx('tolmin-koper.gpx').points;
/** Its first part down the winding Soča valley to Nova Gorica, as a ride of its own. */
export const SOCA_VALLEY = section(TOLMIN_KOPER, 0, 46);

/** [name, points] — the shorter track first. */
export const REAL_TRACKS: Array<[string, TrackPoint[]]> = [
    ['46 km Soča valley', SOCA_VALLEY],
    ['121 km Tolmin–Koper', TOLMIN_KOPER],
];
