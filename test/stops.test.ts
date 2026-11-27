/**
 * Stops (the flight stands still to show a photo), the elevation profile, picture margins,
 * very short videos and the language of the built-in texts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFlightPlan, type FlightOptions, type FlightStop } from '../src/core/flightPlan.ts';
import { angleDiff, haversine, type TrackPoint } from '../src/core/geo.ts';
import { STRINGS, resolveStrings } from '../src/core/i18n.ts';
import { FPS, smoothness, yawStats, projector } from './helpers/camera.ts';
import { SOCA_VALLEY, TOLMIN_KOPER } from './helpers/tracks.ts';

const KM = 1000;

test('stops: the trail arrives, stands still for the given time, and sets off again', () => {
    const stops: FlightStop[] = [
        { distance: 20 * KM, duration: 3, data: 'photo-1' },
        { distance: 60 * KM, duration: 5, data: { ids: [2, 3] } },
        { distance: 100 * KM, duration: 2 },
    ];
    const plain = buildFlightPlan(TOLMIN_KOPER, { duration: 30, aspect: 0.8 });
    const plan = buildFlightPlan(TOLMIN_KOPER, { duration: 30, aspect: 0.8, stops });
    assert.equal(plan.duration, 30 + 3 + 5 + 2, 'stops add to the video length');
    // The 30 s are still split into intro, flight and outro; the 10 s of stops come on top.
    assert.ok(Math.abs(plan.meta.intro + plan.meta.moving + plan.meta.outro - 30) < 1e-9);
    assert.ok(Math.abs(plan.meta.moving - plain.meta.moving) < 2, `moving ${plan.meta.moving} vs ${plain.meta.moving} s without stops`);
    // Every leg starts and ends at rest, so the cruise speed between stops is a little higher.
    assert.ok(plan.meta.followSpeed > plain.meta.followSpeed && plan.meta.followSpeed < plain.meta.followSpeed * 1.5);
    assert.deepEqual(plan.stops.map(s => [s.input, s.duration, s.data]), [[0, 3, 'photo-1'], [1, 5, { ids: [2, 3] }], [2, 2, undefined]]);
    for (const [k, s] of plan.stops.entries()) {
        assert.ok(Math.abs(s.distance - stops[k].distance!) < 40, `stop ${k} at ${s.distance} m`);
        assert.ok(Math.abs(s.end - s.start - s.duration) < 1e-9);
        // Standing still for the whole stop: the trail and the stats do not move at all. The
        // camera only settles (its smoothing takes a moment) and is at rest in the middle.
        const pose = plan.poseAt(s.start);
        for (let t = s.start + 0.02; t < s.end - 0.02; t += 0.1) {
            assert.equal(plan.statsAt(t).distance, plan.statsAt(s.start + 0.02).distance, `stop ${k}: moved at ${t}`);
            const now = plan.poseAt(t);
            const drift = haversine(pose.camera.lat, pose.camera.lon, now.camera.lat, now.camera.lon) / now.range;
            assert.ok(drift < 0.1 && Math.abs(angleDiff(pose.bearing, now.bearing)) < 6, `stop ${k}: camera drifted ${(drift * 100).toFixed(1)} % of its distance at ${t}`);
            const active = plan.stopAt(t)!;
            assert.equal(active.index, k);
            assert.equal(active.stop, s);
            assert.ok(Math.abs(active.elapsed - (t - s.start)) < 1e-9 && Math.abs(active.elapsed + active.remaining - s.duration) < 1e-9);
            assert.ok(active.progress > 0 && active.progress < 1);
        }
        const m0 = plan.poseAt(s.start + s.duration / 2 - 0.2), m1 = plan.poseAt(s.start + s.duration / 2 + 0.2);
        assert.ok(haversine(m0.camera.lat, m0.camera.lon, m1.camera.lat, m1.camera.lon) < 0.5 && Math.abs(angleDiff(m0.bearing, m1.bearing)) < 0.05, `stop ${k}: at rest in the middle`);
        assert.ok(Math.abs(plan.statsAt(s.start + 0.1).distance - s.distance) < 40);
        // The name of a place at the stop appears on arrival, not after the wait.
        assert.ok(Math.abs(plan.timeAt(plan.distanceAt(s.start + 0.1)) - s.start) < 0.1);
    }
    // Between stops nothing is "active"; before, after and at odd times neither.
    for (const t of [0, plan.stops[0].start - 0.01, plan.stops[0].end, plan.stops[1].start - 1, plan.duration, -1, NaN, 1e9]) assert.equal(plan.stopAt(t), null, `t=${t}`);
    // The whole track is still covered, in order.
    let prev = -1;
    for (let i = 0; i <= plan.duration * FPS; i++) {
        const d = plan.distanceAt(i / FPS);
        assert.ok(d >= prev, 'tip never goes back');
        prev = d;
    }
    assert.equal(plan.statsAt(plan.duration).distance, plain.statsAt(plain.duration).distance);
    assert.deepEqual(plain.stops, []);
    assert.equal(plain.stopAt(10), null);
});

test('stops: slowing down and setting off is as smooth as the rest of the flight', () => {
    for (const [name, pts, at] of [['46 km', SOCA_VALLEY, [8, 23, 40]], ['121 km', TOLMIN_KOPER, [15, 55, 90, 110]]] as const) {
        const stops = at.map(km => ({ distance: km * KM, duration: 3 }));
        for (const duration of [20, 45]) {
            const plan = buildFlightPlan(pts, { duration, aspect: 0.8, stops });
            const m = smoothness(plan);
            assert.ok(m.pan < 1 && m.zoom < 0.75 && m.follow < 1, `${name} ${duration}s: pan ${m.pan.toFixed(2)}, zoom ${m.zoom.toFixed(2)}, follow ${m.follow.toFixed(2)}`);
            const { maxRate, maxAcc } = yawStats(plan);
            assert.ok(maxRate <= 33 && maxAcc < 40, `${name} ${duration}s: yaw ${maxRate.toFixed(1)} °/s, ${maxAcc.toFixed(0)} °/s²`);
            // Speed of the tip: no jump from one frame to the next, zero at every stop.
            let prev = plan.distanceAt(0), prevStep = 0, maxStep = 0, maxJerk = 0;
            for (let i = 1; i <= plan.duration * FPS; i++) {
                const d = plan.distanceAt(i / FPS), step = d - prev;
                maxStep = Math.max(maxStep, step);
                maxJerk = Math.max(maxJerk, Math.abs(step - prevStep));
                prev = d; prevStep = step;
            }
            assert.ok(maxJerk < maxStep * 0.08, `${name} ${duration}s: speed changes by ${((maxJerk / maxStep) * 100).toFixed(1)} % of top speed per frame`);
        }
    }
});

test('stops: placed by distance, by timestamp or by place; unusable ones are left out', () => {
    const pts = TOLMIN_KOPER;
    const mid = pts[Math.floor(pts.length * 0.4)];
    const plan = buildFlightPlan(pts, {
        duration: 30,
        stops: [
            { time: mid.time!, duration: 2, data: 'by time' },
            { lon: mid.lon + 0.002, lat: mid.lat, duration: 2, data: 'by place' },       // ~150 m beside the track
            { lon: mid.lon + 0.2, lat: mid.lat + 0.2, duration: 2, data: 'far away' },   // > 500 m off → ignored
            { time: pts[0].time! - 3600e3, duration: 2, data: 'an hour before the start' },
            { time: pts[0].time! - 3600e3, lon: pts[100].lon, lat: pts[100].lat, duration: 2, data: 'bad time, good place' },
            { distance: 5 * KM, duration: 0, data: 'no duration' },
            { distance: 5 * KM, duration: NaN, data: 'NaN duration' },
            { duration: 2, data: 'nowhere' },
            { distance: -50, duration: 1, data: 'before the start' },
            { distance: 1e9, duration: 1, data: 'past the finish' },
        ],
    });
    assert.deepEqual(plan.stops.map(s => s.data), ['before the start', 'bad time, good place', 'by time', 'by place', 'past the finish']);
    assert.equal(plan.duration, 30 + 1 + 2 + 2 + 2 + 1);
    const byTime = plan.stops[2], byPlace = plan.stops[3];
    const near = (a: { lon: number; lat: number }, b: { lon: number; lat: number }) => Math.hypot((a.lon - b.lon) * 77000, (a.lat - b.lat) * 111320);
    assert.ok(near(byTime, mid) < 60, `time stop ${near(byTime, mid).toFixed(0)} m from the point recorded then`);
    assert.ok(near(byPlace, mid) < 250, `place stop ${near(byPlace, mid).toFixed(0)} m from the place`);
    // A stop at the very start waits before the trail moves; one at the finish waits before the outro.
    assert.ok(Math.abs(plan.stops[0].start - plan.meta.intro) < 1e-9);
    assert.equal(plan.distanceAt(plan.stops[0].end - 0.01), 0);
    assert.ok(Math.abs(plan.stops[4].end - (plan.duration - plan.meta.outro)) < 1e-6);
    // `stopMaxOffTrack` widens the catch.
    assert.equal(buildFlightPlan(pts, { duration: 30, stopMaxOffTrack: 50000, stops: [{ lon: mid.lon + 0.2, lat: mid.lat + 0.2, duration: 2 }] }).stops.length, 1);
    // Tracks without timestamps: time stops fall back to their place, or are dropped.
    const noTime = pts.map(p => ({ lon: p.lon, lat: p.lat, ele: p.ele }));
    const p2 = buildFlightPlan(noTime, { duration: 30, stops: [{ time: mid.time!, duration: 2 }, { time: mid.time!, lon: mid.lon, lat: mid.lat, duration: 2 }] });
    assert.equal(p2.stops.length, 1);
    assert.equal(p2.stops[0].input, 1);
});

test('stops: many, close together, at the same spot — still one continuous, finite flight', () => {
    const cases: Array<[string, FlightStop[]]> = [
        ['ten in a 12 s flight', Array.from({ length: 10 }, (_, k) => ({ distance: (5 + k * 10) * KM, duration: 1.5 }))],
        ['two 30 m apart', [{ distance: 50 * KM, duration: 2 }, { distance: 50.03 * KM, duration: 2 }]],
        ['three at the same spot', [{ distance: 50 * KM, duration: 1 }, { distance: 50 * KM, duration: 2 }, { distance: 50 * KM, duration: 3 }]],
        ['given out of order', [{ distance: 90 * KM, duration: 1 }, { distance: 10 * KM, duration: 1 }, { distance: 40 * KM, duration: 1 }]],
        ['one very long', [{ distance: 30 * KM, duration: 120 }]],
    ];
    for (const [name, stops] of cases) {
        for (const base of [{ duration: 12 }, { duration: 12, camera: 'static', pitch: 0, northUp: true }] as FlightOptions[]) {
            const plan = buildFlightPlan(TOLMIN_KOPER, { ...base, aspect: 9 / 16, stops });
            const label = `${name} (${plan.meta.camera})`;
            assert.equal(plan.stops.length, stops.length, label);
            assert.ok(Math.abs(plan.duration - (12 + stops.reduce((a, s) => a + s.duration, 0))) < 1e-9, label);
            let prevEnd = -Infinity, prevD = -1;
            for (const s of plan.stops) {
                assert.ok(s.start >= prevEnd - 1e-9, `${label}: stops overlap in time`);
                prevEnd = s.end;
            }
            for (let i = 0; i <= plan.duration * 30; i++) {
                const t = i / 30, pose = plan.poseAt(t), d = plan.distanceAt(t);
                assert.ok([pose.camera.lon, pose.camera.lat, pose.camera.alt, pose.range, d].every(Number.isFinite), `${label}: not finite at ${t}`);
                assert.ok(d >= prevD - 1e-6, `${label}: tip went back at ${t}`);
                prevD = d;
            }
            assert.ok(Math.abs(plan.distanceAt(plan.duration) - plan.track.s.at(-1)!) < 1e-6, `${label}: reaches the finish`);
        }
    }
    // Stops in input order keep that order when at the same spot.
    const same = buildFlightPlan(TOLMIN_KOPER, { duration: 12, stops: cases[2][1] });
    assert.deepEqual(same.stops.map(s => s.duration), [1, 2, 3]);
    assert.deepEqual(buildFlightPlan(TOLMIN_KOPER, { duration: 12, stops: cases[3][1] }).stops.map(s => s.input), [1, 2, 0]);
});

test('elevation profile: a few hundred points from start to finish with real heights', () => {
    const plan = buildFlightPlan(TOLMIN_KOPER, { aspect: 0.8, exaggeration: 1.4 });
    const p = plan.profile!;
    assert.ok(p.distance.length >= 100 && p.distance.length <= 512);
    assert.equal(p.distance.length, p.elevation.length);
    assert.equal(p.distance[0], 0);
    assert.ok(Math.abs(p.distance.at(-1)! - plan.length) < 1, 'ends at the full recorded distance');
    for (let i = 1; i < p.distance.length; i++) assert.ok(p.distance[i] > p.distance[i - 1]);
    // Real metres, not exaggerated: the ride starts in the Alps foothills and ends at the sea.
    assert.ok(p.elevation[0] > 150 && p.elevation[0] < 300, `start ${p.elevation[0]} m`);
    assert.ok(p.elevation.at(-1)! < 30, `finish ${p.elevation.at(-1)} m`);
    assert.ok(p.max > 350 && p.max < 800 && p.min >= -5 && p.min < 30, `${p.min}…${p.max}`);
    assert.equal(Math.max(...p.elevation), p.max);
    assert.equal(Math.min(...p.elevation), p.min);
    // No elevations in the track and no terrain model → no profile.
    assert.equal(buildFlightPlan(TOLMIN_KOPER.map(q => ({ lon: q.lon, lat: q.lat }))).profile, null);
    // With a terrain model the profile exists even without GPS heights.
    assert.ok(buildFlightPlan([{ lon: 14, lat: 49 }, { lon: 14.05, lat: 49.02 }], { terrain: () => 420 }).profile);
});

test('margins: whole-route shots keep the track clear of bigger panels', () => {
    const fit = (margins: FlightOptions['margins'], aspect: number) => {
        const plan = buildFlightPlan(TOLMIN_KOPER, { camera: 'static', pitch: 0, northUp: true, aspect, margins });
        const project = projector(plan.poseAt(0), aspect);
        let xmax = 0, ymin = Infinity, ymax = -Infinity;
        for (let i = 0; i < plan.track.lon.length; i += 5) {
            const q = project(plan.track.lon[i], plan.track.lat[i], 0);
            xmax = Math.max(xmax, Math.abs(q.x)); ymin = Math.min(ymin, q.y); ymax = Math.max(ymax, q.y);
        }
        return { xmax, ymin, ymax, range: plan.meta.range };
    };
    for (const aspect of [9 / 16, 0.8, 16 / 9]) {
        const std = fit(undefined, aspect);
        // A tall bottom panel (elevation profile, 30 % of the height) and a social-media safe zone on top.
        const tall = fit({ top: 0.2, bottom: 0.3 }, aspect);
        assert.ok(tall.ymin >= -(1 - 2 * 0.3) - 0.03, `aspect ${aspect}: lowest point ${tall.ymin.toFixed(2)} stays above the panel`);
        assert.ok(tall.ymax <= 1 - 2 * 0.2 + 0.03, `aspect ${aspect}: highest point ${tall.ymax.toFixed(2)} stays below the top zone`);
        assert.ok(tall.range > std.range, 'less room → camera further away');
        // No panels at all: the track may use nearly the whole picture.
        const full = fit({ top: 0.02, bottom: 0.02, side: 0.02 }, aspect);
        assert.ok(full.range < std.range * 0.85, `aspect ${aspect}: ${Math.round(full.range)} vs ${Math.round(std.range)} m`);
        assert.ok(full.xmax <= 0.99 && full.ymax <= 0.99 && full.ymin >= -0.99);
        assert.ok(full.xmax > 0.9 || full.ymax > 0.9 || full.ymin < -0.9, 'and it does');
        // Defaults are what the built-in panel needs.
        assert.deepEqual(fit({ top: 0.14, bottom: 0.19, side: 0.07 }, aspect), std);
    }
    // Absurd values are clamped, not NaN.
    assert.ok(Number.isFinite(fit({ top: 5, bottom: -3, side: 0.9 }, 0.8).range));
});

test('very short videos: from 3 s, with proportionally shorter overview shots', () => {
    for (const pts of [SOCA_VALLEY, TOLMIN_KOPER] as TrackPoint[][]) {
        for (const duration of [3, 4, 5, 6, 7.5]) {
            const plan = buildFlightPlan(pts, { duration, aspect: 9 / 16 });
            assert.equal(plan.duration, duration);
            const { intro, outro, moving } = plan.meta;
            assert.ok(Math.abs(intro + outro + moving - duration) < 1e-9);
            assert.ok(moving >= duration * 0.4, `${duration}s: only ${moving.toFixed(2)} s of flight (intro ${intro.toFixed(2)}, outro ${outro.toFixed(2)})`);
            assert.ok(intro > 0.3 && outro > 0.3);
            assert.equal(plan.distanceAt(duration), plan.track.s.at(-1));
            const { maxRate } = yawStats(plan);
            assert.ok(maxRate <= 33, `${duration}s: yaw ${maxRate.toFixed(1)} °/s`);
        }
        assert.equal(buildFlightPlan(pts, { duration: 0.5 }).duration, 3, 'never shorter than 3 s');
        assert.equal(buildFlightPlan(pts, { duration: 4, camera: 'static' }).duration, 4);
    }
    // From 8 s up nothing changed: the overview shots keep their usual minimum.
    const p8 = buildFlightPlan(SOCA_VALLEY, { duration: 8, intro: undefined });
    assert.ok(p8.meta.intro >= 1.6 && p8.meta.outro >= 2);
});

test('language: English by default, Czech built in, single texts can be overridden', () => {
    assert.deepEqual(resolveStrings(undefined), STRINGS.en);
    assert.equal(resolveStrings('cs').distance, 'vzdálenost');
    assert.equal(resolveStrings('cs').decimal, ',');
    assert.deepEqual(resolveStrings('en', { distance: 'Strecke' }), { ...STRINGS.en, distance: 'Strecke' });
    assert.deepEqual(resolveStrings('xx' as 'en'), STRINGS.en, 'unknown locale falls back to English');
    assert.deepEqual(Object.keys(STRINGS.cs).sort(), Object.keys(STRINGS.en).sort(), 'both languages have every text');
    for (const lang of Object.values(STRINGS)) for (const [k, v] of Object.entries(lang)) assert.ok(typeof v === 'string' && v.length > 0, k);
});
