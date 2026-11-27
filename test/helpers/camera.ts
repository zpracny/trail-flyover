import assert from 'node:assert/strict';
import type { FlightPlan } from '../../src/core/flightPlan.ts';
import { angleDiff, localProjection } from '../../src/core/geo.ts';

export const FPS = 60;

export function frames(plan: FlightPlan) {
    const out = [];
    for (let i = 0; i <= Math.round(plan.duration * FPS); i++) out.push(plan.poseAt(i / FPS));
    return out;
}

export function yawStats(plan: FlightPlan) {
    const f = frames(plan);
    const rate: number[] = [];
    for (let i = 1; i < f.length; i++) rate.push(angleDiff(f[i - 1].bearing, f[i].bearing) * FPS);
    let maxRate = 0, maxAcc = 0;
    for (let i = 0; i < rate.length; i++) {
        maxRate = Math.max(maxRate, Math.abs(rate[i]));
        if (i > 0) maxAcc = Math.max(maxAcc, Math.abs(rate[i] - rate[i - 1]) * FPS);
    }
    return { maxRate, maxAcc };
}

/**
 * Perceived camera smoothness, split the way the eye sees it:
 * - pan: acceleration of the look-at point relative to the camera distance (screen widths/s²),
 * - zoom: acceleration of ln(distance) (zoom is perceived logarithmically),
 * - follow: camera position acceleration relative to distance during the follow phase.
 */
export function smoothness(plan: FlightPlan) {
    const f = frames(plan);
    const proj = localProjection(f[0].target.lon, f[0].target.lat);
    const T = f.map(p => proj.toXY(p.target.lon, p.target.lat));
    const C = f.map(p => [...proj.toXY(p.camera.lon, p.camera.lat), p.camera.alt]);
    const followFrom = plan.meta.intro * FPS + 2, followTo = (plan.duration - plan.meta.outro) * FPS - 2;
    let pan = 0, zoom = 0, follow = 0;
    for (let i = 2; i < f.length; i++) {
        pan = Math.max(pan, Math.hypot(T[i][0] - 2 * T[i - 1][0] + T[i - 2][0], T[i][1] - 2 * T[i - 1][1] + T[i - 2][1]) * FPS * FPS / f[i].range);
        zoom = Math.max(zoom, Math.abs(Math.log(f[i].range) - 2 * Math.log(f[i - 1].range) + Math.log(f[i - 2].range)) * FPS * FPS);
        if (i > followFrom && i < followTo) {
            const a = Math.hypot(...[0, 1, 2].map(k => C[i][k] - 2 * C[i - 1][k] + C[i - 2][k])) * FPS * FPS;
            follow = Math.max(follow, a / f[i].range);
        }
    }
    return { pan, zoom, follow };
}

export function assertSmooth(plan: FlightPlan, label: string) {
    const m = smoothness(plan);
    assert.ok(m.pan < 1, `${label}: pan acceleration ${m.pan.toFixed(2)} /s²`);
    assert.ok(m.zoom < 0.75, `${label}: zoom acceleration ${m.zoom.toFixed(2)} /s²`);
    assert.ok(m.follow < 1, `${label}: follow acceleration ${m.follow.toFixed(2)} /s²`);
}

/** Projects lon/lat/alt with a pinhole camera built from a pose (independent of the plan's own math). */
export function projector(pose: ReturnType<FlightPlan['poseAt']>, aspect: number, fovDeg = 36.87) {
    const proj = localProjection(pose.target.lon, pose.target.lat);
    const [cx, cy] = proj.toXY(pose.camera.lon, pose.camera.lat);
    const C = [cx, cy, pose.camera.alt];
    const T = [0, 0, pose.target.alt];
    const F = T.map((v, i) => v - C[i]);
    const fl = Math.hypot(...F);
    const f = F.map(v => v / fl);
    const hz = Math.hypot(f[0], f[1]);
    const b = (pose.bearing * Math.PI) / 180;
    // right = forward × up; looking straight down the heading comes from the bearing
    const r = hz > 1e-6 ? [f[1] / hz, -f[0] / hz, 0] : [Math.cos(b), -Math.sin(b), 0];
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const tanV = Math.tan((fovDeg * Math.PI) / 360), tanH = tanV * aspect;
    return (lon: number, lat: number, alt: number) => {
        const [x, y] = proj.toXY(lon, lat);
        const v = [x - C[0], y - C[1], alt - C[2]];
        const zc = v[0] * f[0] + v[1] * f[1] + v[2] * f[2];
        return {
            x: (v[0] * r[0] + v[1] * r[1] + v[2] * r[2]) / (zc * tanH),
            y: (v[0] * u[0] + v[1] * u[1] + v[2] * u[2]) / (zc * tanV),
            zc,
        };
    };
}

