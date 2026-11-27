import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFlightPlan, zoomPanPath, CAMERA_PRESETS, type PresetId } from '../src/core/flightPlan.ts';
import { angleDiff, type TrackPoint } from '../src/core/geo.ts';
import { FPS, frames, yawStats, assertSmooth, projector } from './helpers/camera.ts';
import { SOCA_VALLEY, TOLMIN_KOPER } from './helpers/tracks.ts';

const real = { points: SOCA_VALLEY };
/** Real recordings (see helpers/tracks.ts): a 46 km ride down a winding valley and the whole 121 km to the sea. */
const FIXTURES = [
    { name: '46 km Soča valley', gpx: real, km: 46.0, ascent: [350, 900] },
    // Julian Alps → Adriatic: long, narrow north–south track (73 × 22 km), sea-level finish, 1 Hz recording with long stops.
    { name: '121 km Tolmin–Koper', gpx: { points: TOLMIN_KOPER }, km: 120.7, ascent: [900, 1900] },
];
for (const fx of FIXTURES) {
    test(`${fx.name}: camera turns smoothly (no jerks, bounded yaw rate)`, () => {
        for (const duration of [20, 30, 60]) {
            const plan = buildFlightPlan(fx.gpx.points, { duration });
            const { maxRate, maxAcc } = yawStats(plan);
            assert.ok(maxRate <= 33, `${duration}s: yaw rate ${maxRate.toFixed(1)} °/s`);
            // A keyframe camera with smoothstep headings peaks at several hundred °/s² on such tracks.
            assert.ok(maxAcc < 40, `${duration}s: yaw acceleration ${maxAcc.toFixed(0)} °/s²`);
        }
    });

    test(`${fx.name}: camera position has no kinks or jumps (all presets)`, () => {
        for (const preset of Object.keys(CAMERA_PRESETS) as PresetId[]) {
            for (const duration of [20, 45]) {
                assertSmooth(buildFlightPlan(fx.gpx.points, { duration, preset, northUp: preset === 'topdown' }), `${preset} ${duration}s`);
            }
        }
    });

    test(`${fx.name}: trail tip starts after intro, ends at finish, never goes backwards, no speed jumps`, () => {
        const plan = buildFlightPlan(fx.gpx.points, { duration: 25 });
        const L = plan.track.s[plan.track.s.length - 1];
        assert.equal(plan.distanceAt(0), 0);
        assert.equal(plan.distanceAt(plan.meta.intro * 0.99), 0);
        assert.ok(Math.abs(plan.distanceAt(plan.duration) - L) < 1e-6);
        let prev = 0, prevV = 0, maxDv = 0;
        for (let i = 1; i <= plan.duration * FPS; i++) {
            const s = plan.distanceAt(i / FPS);
            assert.ok(s >= prev - 1e-9);
            const v = (s - prev) * FPS;
            maxDv = Math.max(maxDv, Math.abs(v - prevV));
            prev = s; prevV = v;
        }
        // Velocity changes by at most ~3 % of the cruise speed per frame (smooth ramps).
        assert.ok(maxDv < plan.meta.followSpeed * 0.03, `max Δv/frame ${maxDv.toFixed(1)} m/s`);
        const end = plan.tipAt(plan.duration);
        const last = fx.gpx.points[fx.gpx.points.length - 1];
        assert.ok(Math.abs(end.lon - last.lon) < 1e-6 && Math.abs(end.lat - last.lat) < 1e-6);
    });

    test(`${fx.name}: deterministic — same input gives identical poses (preview == export)`, () => {
        const a = buildFlightPlan(fx.gpx.points, { duration: 20 });
        const b = buildFlightPlan(fx.gpx.points, { duration: 20 });
        for (const t of [0, 1.234, 7.5, 19.99]) assert.deepEqual(a.poseAt(t), b.poseAt(t));
    });

    test(`${fx.name}: final stats match the recording (distance, ascent, elapsed time)`, () => {
        const plan = buildFlightPlan(fx.gpx.points, { duration: 20 });
        const s = plan.statsAt(plan.duration);
        // Small differences to apps that sum raw points come from GPS jitter during stops.
        assert.ok(Math.abs(s.distance / 1000 - fx.km) < fx.km * 0.012, `distance ${(s.distance / 1000).toFixed(2)} km`);
        const recorded = (fx.gpx.points.at(-1)!.time! - fx.gpx.points[0].time!) / 1000;
        assert.ok(Math.abs(s.elapsed! - recorded) < 10, `elapsed ${s.elapsed} vs ${recorded}`);
        assert.ok(s.ascent > fx.ascent[0] && s.ascent < fx.ascent[1], `ascent ${s.ascent}`);
        assert.equal(plan.statsAt(0).distance, 0);
    });

    test(`${fx.name}: 2D top-down north-up — no rotation, no tilt, still smooth`, () => {
        const plan = buildFlightPlan(fx.gpx.points, { duration: 30, preset: 'topdown', northUp: true, exaggeration: 0 });
        for (const p of frames(plan)) {
            assert.ok(Math.abs(angleDiff(0, p.bearing)) < 1e-9, `bearing ${p.bearing}`);
            assert.equal(p.pitch, 0);
        }
        assertSmooth(plan, '2D');
    });
}

test('auto duration grows with track length and stays within 12–60 s', () => {
    const short = buildFlightPlan([{ lon: 14, lat: 49 }, { lon: 14.001, lat: 49 }]);
    assert.ok(short.duration >= 12 && short.duration < 12.1, `${short.duration}`);
    assert.ok(Math.abs(buildFlightPlan(real.points).duration - (12 + 46.0 * 0.4)) < 0.1);
    assert.equal(buildFlightPlan(FIXTURES[1].gpx.points).duration, 60);
});

test('camera stays above a steep synthetic ridge between camera and trail', () => {
    // Flat track at 500 m, ridge of 2000 m running parallel 1–2 km to the side.
    const pts: TrackPoint[] = [];
    for (let i = 0; i <= 200; i++) pts.push({ lon: 14 + i * 0.0006, lat: 49, ele: 500 });
    const ridge = (_lon: number, lat: number) => (lat < 48.99 && lat > 48.975 ? 2000 : 500);
    const plan = buildFlightPlan(pts, { duration: 15, terrain: ridge, exaggeration: 1.5, preset: 'low' });
    for (const p of frames(plan)) {
        const g = ridge(p.camera.lon, p.camera.lat) * 1.5;
        assert.ok(p.camera.alt > g + 40, `camera ${p.camera.alt.toFixed(0)} m vs ground ${g} m`);
    }
});

test('GPS jitter during a long stop does not spin the camera', () => {
    const pts: TrackPoint[] = [];
    let seed = 1;
    const rnd = () => {
        seed = (seed * 16807) % 2147483647;
        return seed / 2147483647 - 0.5;
    };
    for (let i = 0; i < 300; i++) pts.push({ lon: 14 + i * 0.0001, lat: 49 });
    for (let i = 0; i < 400; i++) pts.push({ lon: 14.03 + rnd() * 0.0003, lat: 49 + rnd() * 0.0003 });
    for (let i = 0; i < 300; i++) pts.push({ lon: 14.03 + i * 0.0001, lat: 49 + i * 0.00005 });
    const plan = buildFlightPlan(pts, { duration: 12 });
    const { maxRate, maxAcc } = yawStats(plan);
    assert.ok(maxRate <= 33 && maxAcc < 80, `rate ${maxRate.toFixed(1)}, acc ${maxAcc.toFixed(0)}`);
});

test('handles tiny tracks and rejects unusable input', () => {
    const tiny = buildFlightPlan([{ lon: 14, lat: 49 }, { lon: 14.004, lat: 49 }], {});
    for (const t of [0, tiny.duration / 2, tiny.duration]) {
        const p = tiny.poseAt(t);
        assert.ok([p.camera.lon, p.camera.lat, p.camera.alt, p.target.alt].every(Number.isFinite));
    }
    assert.throws(() => buildFlightPlan([{ lon: 14, lat: 49 }]));
    assert.throws(() => buildFlightPlan([{ lon: 14, lat: 49 }, { lon: 14, lat: 49 }]));
});

test('intro and outro overview shots contain the whole track (all aspect ratios)', () => {
    for (const [fx, aspect, preset] of FIXTURES.flatMap(f => [9 / 16, 4 / 5, 16 / 9].flatMap(a => (['drone', 'topdown'] as const).map(p => [f, a, p] as const)))) {
        const ex = preset === 'topdown' ? 0 : 1.4;
        const plan = buildFlightPlan(fx.gpx.points, { duration: 30, aspect, exaggeration: ex, preset, northUp: preset === 'topdown' });
        for (const t of [0, plan.duration]) {
            const project = projector(plan.poseAt(t), aspect);
            const { lon, lat, ele } = plan.track;
            for (let i = 0; i < lon.length; i += 20) {
                const p = project(lon[i], lat[i], ele[i] * ex);
                assert.ok(p.zc > 0, 'point behind camera');
                assert.ok(Math.abs(p.x) <= 0.9 && p.y <= 0.8 && p.y >= -0.7,
                    `${fx.name} ${preset} aspect ${aspect.toFixed(2)} t=${t}: point ${i} at (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`);
            }
        }
    }
});

test('zoomPanPath: hits both ends exactly, pans while zoomed out', () => {
    for (const [w0, w1, u1] of [[50000, 5000, 60000], [5000, 40000, 20000], [3000, 3000, 10000], [8000, 2000, 0]]) {
        const f = zoomPanPath(w0, w1, u1);
        const a = f(0), b = f(1);
        assert.ok(Math.abs(a.u) < 1e-9 && Math.abs(a.w - 1) < 1e-9);
        assert.ok(Math.abs(b.u - 1) < 1e-6 && Math.abs(b.w - w1 / w0) < 1e-6, `${w0}->${w1}: ${JSON.stringify(b)}`);
        for (let e = 0; e < 1; e += 0.05) assert.ok(f(e + 0.05).u >= f(e).u - 1e-9, 'pan is monotonic');
    }
    // Zooming in from far away: most of the pan is done in the first half, while still far.
    const intro = zoomPanPath(50000, 5000, 60000);
    assert.ok(intro(0.5).u > 0.6, `u(0.5) = ${intro(0.5).u.toFixed(2)}`);
});
