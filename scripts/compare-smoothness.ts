/**
 * Compares camera smoothness of the current TrailMetrics 3D fly-over camera
 * (ported 1:1 from components/StoryGenerator/story3DCamera.ts) with the new flight plan.
 *
 *   node scripts/compare-smoothness.ts [file.gpx] [durationSeconds]
 */
import { readFileSync } from 'node:fs';
import { parseGpx } from '../src/core/gpx.ts';
import { buildFlightPlan } from '../src/core/flightPlan.ts';
import { localProjection, angleDiff } from '../src/core/geo.ts';
import { trailMetricsCamera } from '../test/helpers/trailMetricsCamera.ts';

const file = process.argv[2] ?? 'test/fixtures/tolmin-koper.gpx';
const duration = Number(process.argv[3] ?? 30);
const { points } = parseGpx(readFileSync(file, 'utf8'));
const FPS = 60;

interface Sample { x: number; y: number; heading: number; range: number }

function metrics(samples: Sample[]) {
    const dt = 1 / FPS;
    const yawRate: number[] = [];
    for (let i = 1; i < samples.length; i++) yawRate.push(angleDiff(samples[i - 1].heading, samples[i].heading) / dt);
    const yawAcc: number[] = [];
    for (let i = 1; i < yawRate.length; i++) yawAcc.push((yawRate[i] - yawRate[i - 1]) / dt);
    // Direction change of the ground velocity per frame ("kinks" in the path)
    const kinks: number[] = [];
    for (let i = 2; i < samples.length; i++) {
        const ax = samples[i - 1].x - samples[i - 2].x, ay = samples[i - 1].y - samples[i - 2].y;
        const bx = samples[i].x - samples[i - 1].x, by = samples[i].y - samples[i - 1].y;
        // Ignore direction changes while the view is (almost) still — invisible on screen
        // (e.g. the camera hovering while the trail goes up a dead end and back).
        if (Math.hypot(bx, by) * FPS < samples[i].range * 0.02 || Math.hypot(ax, ay) < 0.5) continue;
        kinks.push(Math.abs(angleDiff(Math.atan2(ax, ay) * 180 / Math.PI, Math.atan2(bx, by) * 180 / Math.PI)));
    }
    const max = (a: number[]) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const rms = (a: number[]) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / Math.max(1, a.length));
    const p99 = (a: number[]) => [...a].map(Math.abs).sort((p, q) => p - q)[Math.floor(a.length * 0.99)] ?? 0;
    return {
        'yaw rate max [°/s]': max(yawRate).toFixed(1),
        'yaw accel max [°/s²]': max(yawAcc).toFixed(0),
        'yaw accel RMS [°/s²]': rms(yawAcc).toFixed(1),
        'path kink p99 [°/frame]': p99(kinks).toFixed(2),
        'path kink max [°/frame]': max(kinks).toFixed(2),
    };
}

const proj = localProjection(points[0].lon, points[0].lat);

// --- TrailMetrics (current) ---
const tm = trailMetricsCamera(points.map(p => [p.lat, p.lon] as [number, number]));
const tmSamples: Sample[] = [];
for (let i = 0; i <= duration * FPS; i++) {
    const c = tm(i / (duration * FPS));
    const [x, y] = proj.toXY(c.center[0], c.center[1]);
    tmSamples.push({ x, y, heading: c.bearing, range: 3000 });
}

// --- New flight plan ---
const plan = buildFlightPlan(points, { duration });
const newSamples: Sample[] = [];
for (let i = 0; i <= plan.duration * FPS; i++) {
    const p = plan.poseAt(i / FPS);
    const [x, y] = proj.toXY(p.target.lon, p.target.lat);
    newSamples.push({ x, y, heading: p.bearing, range: p.range });
}

console.log(`Trasa: ${(plan.length / 1000).toFixed(1)} km, video ${duration} s, ${FPS} fps\n`);
console.table({ 'TrailMetrics (nyní)': metrics(tmSamples), 'Nový plán letu': metrics(newSamples) });
console.log(`\nNový plán: kamera ${Math.round(plan.meta.range)} m od cíle, náklon ${plan.meta.pitch}°, rychlost ${Math.round(plan.meta.followSpeed)} m/s`);
