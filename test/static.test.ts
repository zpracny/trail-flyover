/**
 * Static camera ("whole track in view, only the line runs") and timeAt — the moment the
 * trail reaches a place, used to bring up place names.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFlightPlan, type FlightOptions } from '../src/core/flightPlan.ts';
import type { TrackPoint } from '../src/core/geo.ts';
import { projector } from './helpers/camera.ts';
import { REAL_TRACKS } from './helpers/tracks.ts';

const FIXTURES = REAL_TRACKS;
const ASPECTS: Array<[string, number]> = [['story', 9 / 16], ['feed', 4 / 5], ['wide', 16 / 9]];
/** What the player passes for a flat 2D map. */
const FLAT: FlightOptions = { camera: 'static', preset: 'topdown', pitch: 0, northUp: true, exaggeration: 0 };
const TILTED: FlightOptions = { camera: 'static', exaggeration: 1.4 };

test('static camera: one pose for the whole video, with the whole track inside the safe area', () => {
    for (const [name, pts] of FIXTURES) {
        for (const [aName, aspect] of ASPECTS) {
            for (const [mode, base] of [['2D', FLAT], ['3D', TILTED]] as const) {
                const label = `${name} ${aName} ${mode}`;
                const plan = buildFlightPlan(pts, { ...base, aspect });
                assert.equal(plan.meta.camera, 'static');
                const first = plan.poseAt(0);
                for (let t = 0; t <= plan.duration; t += 0.25) assert.deepEqual(plan.poseAt(t), first, `${label}: camera moved at ${t} s`);
                assert.equal(plan.meta.range, first.range);
                if (mode === '2D') {
                    assert.equal(first.pitch, 0);
                    assert.equal(first.bearing, 0, `${label}: north up`);
                } else {
                    assert.ok(first.pitch >= 25 && first.pitch <= 45, `${label}: pitch ${first.pitch}`);
                }
                const project = projector(first, aspect);
                const ex = plan.meta.exaggeration;
                let xmax = 0, ymin = Infinity, ymax = -Infinity;
                for (let i = 0; i < plan.track.lon.length; i += 7) {
                    const p = project(plan.track.lon[i], plan.track.lat[i], plan.track.ele[i] * ex);
                    assert.ok(p.zc > 0, `${label}: point behind the camera`);
                    xmax = Math.max(xmax, Math.abs(p.x)); ymin = Math.min(ymin, p.y); ymax = Math.max(ymax, p.y);
                }
                assert.ok(xmax <= 0.9, `${label}: track reaches ${xmax.toFixed(2)} of the half-width`);
                assert.ok(ymax <= 0.78 && ymin >= -0.68, `${label}: vertical ${ymin.toFixed(2)}…${ymax.toFixed(2)} (title above, stats below)`);
                // …and it is not needlessly small: it touches the safe area in at least one direction.
                assert.ok(xmax > 0.8 || ymax > 0.62 || ymin < -0.52, `${label}: track fills the frame (x ${xmax.toFixed(2)}, y ${ymin.toFixed(2)}…${ymax.toFixed(2)})`);
            }
        }
    }
});

test('static camera: the line starts after a short look at the map, runs smoothly, and the finished line stays', () => {
    for (const [name, pts] of FIXTURES) {
        const plan = buildFlightPlan(pts, { ...FLAT, aspect: 0.8 });
        const L = plan.track.s[plan.track.s.length - 1];
        const { intro, outro } = plan.meta;
        assert.ok(plan.duration >= 8 && plan.duration <= 24, `${name}: ${plan.duration} s`);
        assert.ok(intro >= 0.4 && intro <= 1 && outro >= 1.2 && outro <= 3, `${name}: intro ${intro}, outro ${outro}`);
        assert.equal(plan.distanceAt(intro * 0.9), 0, `${name}: nothing drawn during the first look`);
        assert.ok(Math.abs(plan.distanceAt(plan.duration - outro) - L) < 1, `${name}: line complete before the hold`);
        assert.equal(plan.distanceAt(plan.duration), L);
        // No jump in the speed of the tip: per-frame steps change gradually.
        let prev = 0, prevStep = 0, maxJerk = 0, maxStep = 0;
        for (let i = 1; i <= Math.round(plan.duration * 60); i++) {
            const s = plan.distanceAt(i / 60);
            const step = s - prev;
            assert.ok(step >= 0, `${name}: tip went backwards`);
            maxJerk = Math.max(maxJerk, Math.abs(step - prevStep));
            maxStep = Math.max(maxStep, step);
            prev = s; prevStep = step;
        }
        assert.ok(maxJerk < maxStep * 0.05, `${name}: speed changes by ${(maxJerk / maxStep * 100).toFixed(1)} % of full speed per frame`);
        // Final stats are the same as with a flying camera.
        const flying = buildFlightPlan(pts, { aspect: 0.8 });
        assert.deepEqual(plan.statsAt(plan.duration), flying.statsAt(flying.duration));
        assert.equal(plan.length, flying.length);
    }
});

test('static camera: options — duration, hold times, tilt, and turning an east–west track in a tall frame', () => {
    const pts = FIXTURES[0][1];
    const plan = buildFlightPlan(pts, { ...FLAT, aspect: 0.8, duration: 15, intro: 2, outro: 4 });
    assert.equal(plan.duration, 15);
    assert.equal(plan.meta.intro, 2);
    assert.equal(plan.meta.outro, 4);
    assert.equal(plan.distanceAt(1.9), 0);
    assert.ok(plan.distanceAt(2.5) > 0);
    // No holds at all: the line runs from the first to the last frame.
    const noHold = buildFlightPlan(pts, { ...FLAT, aspect: 0.8, intro: 0, outro: 0 });
    assert.ok(noHold.distanceAt(0.5) > 0 && noHold.distanceAt(noHold.duration - 0.2) < noHold.track.s.at(-1)!);
    // Holds longer than the video are scaled down, the line still gets at least a second.
    const squeezed = buildFlightPlan(pts, { ...FLAT, aspect: 0.8, duration: 6, intro: 30, outro: 30 });
    assert.ok(squeezed.meta.intro + squeezed.meta.outro <= 5 + 1e-9);
    assert.equal(squeezed.distanceAt(6), squeezed.track.s.at(-1));
    assert.equal(buildFlightPlan(pts, { ...TILTED, aspect: 0.8, pitch: 55 }).poseAt(3).pitch, 55);

    // 40 km due east in a 9:16 story: north-up it is a thin line across; unless north-up is
    // required the camera turns so that the track runs up the frame and comes much closer.
    const eastWest: TrackPoint[] = Array.from({ length: 800 }, (_, i) => ({ lon: 14 + i * 0.0007, lat: 49 + 0.002 * Math.sin(i / 40), ele: 400 }));
    const north = buildFlightPlan(eastWest, { camera: 'static', pitch: 0, northUp: true, aspect: 9 / 16 }).poseAt(0);
    const free = buildFlightPlan(eastWest, { camera: 'static', pitch: 0, aspect: 9 / 16 }).poseAt(0);
    assert.equal(north.bearing, 0);
    // (A straight line fits best along the diagonal of the frame, so the turn is 45–90°, not exactly 90°.)
    const turn = Math.abs(((free.bearing + 180) % 360) - 180);
    assert.ok(turn >= 45 && turn <= 90, `turned to ${free.bearing}°`);
    assert.ok(free.range < north.range * 0.75, `${Math.round(free.range)} m vs ${Math.round(north.range)} m north-up`);
    // A north–south track already fits a tall frame: stays north-up on its own.
    const tolmin = buildFlightPlan(FIXTURES[1][1], { camera: 'static', pitch: 0, aspect: 9 / 16 }).poseAt(0);
    assert.equal(tolmin.bearing, 0);
});

test('timeAt: the moment the trail reaches a distance — inverse of distanceAt, for flying and static cameras', () => {
    for (const [name, pts] of FIXTURES) {
        for (const [mode, o] of [['follow', {}], ['static', FLAT], ['follow 30 fps samples', { sampleRate: 30 }]] as const) {
            const label = `${name} ${mode}`;
            const plan = buildFlightPlan(pts, { ...o, aspect: 0.8 });
            const L = plan.track.s[plan.track.s.length - 1];
            const { intro, outro } = plan.meta;
            assert.equal(plan.timeAt(0), 0, `${label}: the start is "reached" from the first frame`);
            assert.equal(plan.timeAt(-5), 0);
            assert.equal(plan.timeAt(NaN), 0);
            assert.ok(Math.abs(plan.timeAt(L) - (plan.duration - outro)) < 0.05, `${label}: end reached at ${plan.timeAt(L)} s`);
            assert.equal(plan.timeAt(L * 2), plan.timeAt(L));
            let prev = 0;
            for (let k = 1; k <= 400; k++) {
                const s = (k / 400) * L;
                const t = plan.timeAt(s);
                assert.ok(t >= prev && t >= intro - 1e-9 && t <= plan.duration, `${label}: timeAt(${s}) = ${t}`);
                assert.ok(Math.abs(plan.distanceAt(t) - s) < Math.max(0.5, L * 1e-6), `${label}: distanceAt(timeAt(${s.toFixed(0)})) = ${plan.distanceAt(t).toFixed(1)}`);
                prev = t;
            }
        }
    }
});

test('static camera: works for odd inputs (tiny, no elevation, antimeridian) and never returns NaN', () => {
    const cases: Array<[string, TrackPoint[]]> = [
        ['two points', [{ lon: 14, lat: 49 }, { lon: 14.001, lat: 49.001 }]],
        ['200 m walk', Array.from({ length: 40 }, (_, i) => ({ lon: 14 + i * 0.00007, lat: 49 }))],
        ['across 180°', Array.from({ length: 300 }, (_, i) => ({ lon: ((179.6 + i * 0.003 + 180) % 360) - 180, lat: -17 + i * 0.0005, ele: 20 }))],
        ['pole-ward', Array.from({ length: 300 }, (_, i) => ({ lon: 20 + i * 0.002, lat: 78 + i * 0.0004 }))],
    ];
    for (const [name, pts] of cases) {
        for (const [aName, aspect] of ASPECTS) {
            const plan = buildFlightPlan(pts, { camera: 'static', pitch: 0, northUp: true, aspect });
            const pose = plan.poseAt(plan.duration / 2);
            for (const v of [pose.camera.lon, pose.camera.lat, pose.camera.alt, pose.target.lon, pose.target.lat, pose.range, plan.timeAt(plan.length / 2)]) {
                assert.ok(Number.isFinite(v), `${name} ${aName}: ${JSON.stringify(pose)}`);
            }
            assert.ok(pose.range >= 700, `${name} ${aName}: range ${pose.range}`);
            assert.ok(pose.camera.alt > pose.target.alt);
        }
    }
});
