/**
 * Robustness of the flight plan: framing during the flight, odd inputs, option extremes
 * and seeded random tracks. Real recordings are covered in flightPlan.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFlightPlan, CAMERA_PRESETS, type FlightOptions, type FlightPlan, type PresetId } from '../src/core/flightPlan.ts';
import { angleDiff, haversine, type TrackPoint } from '../src/core/geo.ts';
import { FPS, frames, yawStats, smoothness, projector } from './helpers/camera.ts';
import { REAL_TRACKS } from './helpers/tracks.ts';

const FIXTURES = REAL_TRACKS;

/** Seeded PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function line(n: number, dLon: number, dLat: number, lon0 = 14, lat0 = 49, extra: Partial<TrackPoint> = {}): TrackPoint[] {
    return Array.from({ length: n }, (_, i) => ({ lon: lon0 + i * dLon, lat: lat0 + i * dLat, ...extra }));
}

function assertFinitePlan(plan: FlightPlan, label: string) {
    assert.ok(Number.isFinite(plan.duration) && plan.duration > 0, `${label}: duration`);
    let prevS = -1;
    for (let i = 0; i <= Math.round(plan.duration * 30); i++) {
        const t = i / 30;
        const p = plan.poseAt(t);
        const nums = [p.camera.lon, p.camera.lat, p.camera.alt, p.target.lon, p.target.lat, p.target.alt, p.bearing, p.pitch, p.range];
        assert.ok(nums.every(Number.isFinite), `${label}: non-finite pose at t=${t.toFixed(2)}: ${JSON.stringify(p)}`);
        assert.ok(p.pitch >= 0 && p.pitch <= 85, `${label}: pitch ${p.pitch}`);
        assert.ok(p.range > 0, `${label}: range ${p.range}`);
        assert.ok(p.bearing >= 0 && p.bearing < 360, `${label}: bearing ${p.bearing}`);
        assert.ok(p.camera.alt >= p.target.alt - 1e-6, `${label}: camera below its target at t=${t.toFixed(2)}`);
        const s = plan.distanceAt(t);
        assert.ok(s >= prevS - 1e-9, `${label}: tip goes backwards at t=${t.toFixed(2)}`);
        prevS = s;
        const st = plan.statsAt(t);
        assert.ok(Number.isFinite(st.distance) && Number.isFinite(st.ascent), `${label}: stats at t=${t.toFixed(2)}`);
        const tip = plan.tipAt(t);
        assert.ok(Number.isFinite(tip.lon) && Number.isFinite(tip.lat) && Number.isFinite(tip.ele), `${label}: tip`);
    }
}

// ---------------------------------------------------------------- framing during the flight

test('trail tip stays inside the frame for the whole flight (all tracks, presets, aspect ratios)', () => {
    for (const [name, pts] of FIXTURES) {
        for (const preset of Object.keys(CAMERA_PRESETS) as PresetId[]) {
            for (const aspect of [9 / 16, 4 / 5, 16 / 9]) {
                for (const duration of [20, 60]) {
                    const ex = preset === 'topdown' ? 0 : 1.4;
                    const plan = buildFlightPlan(pts, { duration, preset, aspect, exaggeration: ex, northUp: preset === 'topdown' });
                    let xmax = 0, ymin = Infinity, ymax = -Infinity, wide = 0, count = 0;
                    for (let t = plan.meta.intro; t <= plan.duration - plan.meta.outro; t += 1 / 15) {
                        const tip = plan.tipAt(t);
                        const p = projector(plan.poseAt(t), aspect)(tip.lon, tip.lat, tip.ele * ex);
                        assert.ok(p.zc > 0, `${name} ${preset}: tip behind the camera at t=${t.toFixed(1)}`);
                        xmax = Math.max(xmax, Math.abs(p.x)); ymin = Math.min(ymin, p.y); ymax = Math.max(ymax, p.y);
                        count++;
                        if (Math.abs(p.x) > 0.62) wide++;
                    }
                    const label = `${name} ${preset} ${aspect.toFixed(2)} ${duration}s: tip x ±${xmax.toFixed(2)} (${((100 * wide) / count).toFixed(1)} % beyond 0.62), y ${ymin.toFixed(2)}…${ymax.toFixed(2)}`;
                    // Before the keep-in-frame pass the tip left the picture (|x| up to 1.22) in 9:16.
                    // Now it stays in the middle 62 % practically always; a fast zigzag in the narrowest
                    // frame may swing wider for a moment, but never near the edge.
                    assert.ok(xmax <= 0.88, label);
                    assert.ok(wide / count <= 0.05, label);
                    // Clear of the title (top) and the stats panel (bottom).
                    assert.ok(ymin >= -0.6 && ymax <= 0.65, label);
                }
            }
        }
    }
});

test('camera never dips under the recorded trail elevation it is looking at', () => {
    for (const [name, pts] of FIXTURES) {
        const plan = buildFlightPlan(pts, { duration: 40, preset: 'low', exaggeration: 1.4 });
        for (let t = 0; t <= plan.duration; t += 0.1) {
            const p = plan.poseAt(t);
            const height = p.camera.alt - p.target.alt;
            // 'low' preset: pitch 73° → the camera is still ≥ cos(73°) ≈ 0.29 ranges above its target.
            assert.ok(height > 0.25 * p.range, `${name} t=${t.toFixed(1)}: only ${height.toFixed(0)} m above target at range ${p.range.toFixed(0)}`);
        }
    }
});

test('the picture does not jump between intro, follow and outro (pose continuity at the seams)', () => {
    for (const [name, pts] of FIXTURES) {
        const plan = buildFlightPlan(pts, { duration: 30 });
        for (const seam of [plan.meta.intro, plan.duration - plan.meta.outro]) {
            const a = plan.poseAt(seam - 1 / FPS), b = plan.poseAt(seam + 1 / FPS);
            const moved = haversine(a.target.lat, a.target.lon, b.target.lat, b.target.lon);
            assert.ok(moved < 0.01 * b.range, `${name}: target jumps ${moved.toFixed(0)} m at ${seam.toFixed(2)} s`);
            assert.ok(Math.abs(Math.log(a.range / b.range)) < 0.01, `${name}: range jumps at ${seam.toFixed(2)} s`);
            assert.ok(Math.abs(a.pitch - b.pitch) < 0.5, `${name}: pitch jumps at ${seam.toFixed(2)} s`);
            assert.ok(Math.abs(angleDiff(a.bearing, b.bearing)) < 1.5, `${name}: bearing jumps at ${seam.toFixed(2)} s`);
        }
    }
});

// ---------------------------------------------------------------- stats

test('distance counter matches the recording exactly; all counters only go up', () => {
    for (const [name, pts] of FIXTURES) {
        let raw = 0;
        for (let i = 1; i < pts.length; i++) raw += haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
        const plan = buildFlightPlan(pts, { duration: 20 });
        const end = plan.statsAt(plan.duration);
        assert.ok(Math.abs(end.distance - raw) < raw * 0.002, `${name}: ${(end.distance / 1000).toFixed(2)} km vs recorded ${(raw / 1000).toFixed(2)} km`);
        assert.ok(Math.abs(plan.length - raw) < raw * 0.002, `${name}: plan.length ${(plan.length / 1000).toFixed(2)} km`);
        let prev = plan.statsAt(0);
        for (let t = 0; t <= plan.duration; t += 0.05) {
            const s = plan.statsAt(t);
            assert.ok(s.distance >= prev.distance - 1e-6 && s.ascent >= prev.ascent - 1e-6, `${name}: counter went down at ${t}`);
            assert.ok(s.elapsed! >= prev.elapsed! - 1e-6 && s.moving! >= prev.moving! - 1e-6, `${name}: time went down at ${t}`);
            prev = s;
        }
    }
});

test('moving time leaves out the stops (Tolmin–Koper: 9 h 08 min recorded, long breaks)', () => {
    const pts = FIXTURES[1][1];
    const plan = buildFlightPlan(pts, { duration: 20 });
    const end = plan.statsAt(plan.duration);
    assert.ok(Math.abs(end.elapsed! - 32881) < 5, `elapsed ${end.elapsed}`);
    // The recording has breaks of 42, 21, 9 and 8 minutes plus many short ones.
    assert.ok(end.moving! < end.elapsed! - 80 * 60, `moving ${end.moving} s`);
    assert.ok(end.moving! > 5.5 * 3600, `moving ${end.moving} s`);
    // Average moving speed of a bike ride, not of a walk or a car.
    const kmh = end.distance / end.moving! * 3.6;
    assert.ok(kmh > 14 && kmh < 30, `${kmh.toFixed(1)} km/h`);
    // Tracks without timestamps have no time at all.
    const noTime = buildFlightPlan(pts.map(p => ({ lon: p.lon, lat: p.lat, ele: p.ele })), { duration: 20 }).statsAt(20);
    assert.equal(noTime.elapsed, null);
    assert.equal(noTime.moving, null);
});

// ---------------------------------------------------------------- odd inputs

test('GPS glitches are dropped: teleport spikes, null island, coordinates out of range', () => {
    const t0 = Date.UTC(2026, 0, 1);
    const clean = line(600, 0.0002, 0.0001).map((p, i) => ({ ...p, ele: 300, time: t0 + i * 1000 }));
    const dirty = clean.map(p => ({ ...p }));
    dirty[200] = { ...dirty[200], lon: 14.9, lat: 49.6 };   // 85 km away for one second
    dirty[300] = { ...dirty[300], lon: 0, lat: 0 };          // "null island"
    dirty[400] = { ...dirty[400], lat: 123 };                // impossible latitude
    dirty[401] = { ...dirty[401], lon: NaN };
    const a = buildFlightPlan(clean, { duration: 12 });
    const b = buildFlightPlan(dirty, { duration: 12 });
    assert.ok(Math.abs(a.length - b.length) < 60, `length ${a.length.toFixed(0)} vs ${b.length.toFixed(0)} m`);
    assert.ok(Math.abs(Math.log(a.poseAt(0).range / b.poseAt(0).range)) < 0.05, `overview ${a.poseAt(0).range.toFixed(0)} vs ${b.poseAt(0).range.toFixed(0)} m`);
    assertFinitePlan(b, 'glitches');
});

test('a real fast leg is kept: only isolated out-and-back spikes are treated as glitches', () => {
    const t0 = Date.UTC(2026, 0, 1);
    // Recording paused on a train: the next point is 20 km away, and the track continues from there.
    const a = line(300, 0.0002, 0).map((p, i) => ({ ...p, time: t0 + i * 1000 }));
    const b = line(300, 0.0002, 0, 14.33, 49).map((p, i) => ({ ...p, time: t0 + (300 + i) * 1000 }));
    const plan = buildFlightPlan([...a, ...b], { duration: 12 });
    const end = plan.tipAt(plan.duration);
    assert.ok(Math.abs(end.lon - b.at(-1)!.lon) < 1e-6, 'the second half of the track is still there');
    assert.ok(plan.length > 25000, `length ${plan.length.toFixed(0)} m`);
    // Sparse planned route without timestamps: a single-point detour must survive.
    const route: TrackPoint[] = [{ lon: 14, lat: 49 }, { lon: 14.01, lat: 49 }, { lon: 14.01, lat: 49.01 }, { lon: 14.01, lat: 49 }, { lon: 14.02, lat: 49 }];
    assert.ok(buildFlightPlan(route).length > 3600, 'detour of a sparse route kept');
});

test('missing data: no elevation, no time, gaps in both, duplicate points', () => {
    const base = line(400, 0.0003, 0.0002);
    const cases: Record<string, TrackPoint[]> = {
        'no ele, no time': base,
        'ele null': base.map(p => ({ ...p, ele: null, time: null })),
        'ele gaps': base.map((p, i) => ({ ...p, ele: i % 7 === 0 ? 400 + i : null })),
        'ele only at the end': base.map((p, i) => ({ ...p, ele: i > 390 ? 500 : undefined })),
        'time gaps': base.map((p, i) => ({ ...p, time: i % 5 === 0 ? 1e12 + i * 1000 : null })),
        'time only at the start': base.map((p, i) => ({ ...p, time: i < 3 ? 1e12 + i * 1000 : null })),
        'duplicates': base.flatMap(p => [p, p, p]),
        'long stop at the start': [...Array.from({ length: 500 }, () => base[0]), ...base],
        'long stop at the end': [...base, ...Array.from({ length: 500 }, () => base.at(-1)!)],
    };
    for (const [label, pts] of Object.entries(cases)) {
        const plan = buildFlightPlan(pts, { duration: 10 });
        assertFinitePlan(plan, label);
        const end = plan.tipAt(plan.duration);
        assert.ok(Math.abs(end.lon - base.at(-1)!.lon) < 1e-6 && Math.abs(end.lat - base.at(-1)!.lat) < 1e-6, `${label}: ends at the finish`);
    }
    assert.equal(buildFlightPlan(cases['no ele, no time']).statsAt(999).ascent, 0);
    assert.equal(buildFlightPlan(cases['time only at the start']).statsAt(999).elapsed, null);
});

test('track shapes: out-and-back, closed loop, hairpins, zigzag, single long straight', () => {
    const out = line(300, 0.0004, 0.0001);
    const hairpins: TrackPoint[] = [];
    for (let row = 0; row < 8; row++) for (let i = 0; i < 60; i++) hairpins.push({ lon: 14 + (row % 2 ? 59 - i : i) * 0.0003, lat: 49 + row * 0.0004 });
    const loop = Array.from({ length: 500 }, (_, i) => ({ lon: 14 + 0.03 * Math.cos((i / 499) * 2 * Math.PI), lat: 49 + 0.02 * Math.sin((i / 499) * 2 * Math.PI) }));
    const zigzag = Array.from({ length: 400 }, (_, i) => ({ lon: 14 + i * 0.0003, lat: 49 + (i % 2) * 0.0003 }));
    const shapes: Record<string, TrackPoint[]> = {
        'out-and-back': [...out, ...out.slice(0, -1).reverse()],
        'closed loop': loop,
        'hairpins': hairpins,
        'zigzag every point': zigzag,
        'straight': line(200, 0.001, 0),
    };
    for (const [label, pts] of Object.entries(shapes)) {
        for (const duration of [6, 8, 12, 30]) {
            const plan = buildFlightPlan(pts, { duration, exaggeration: 1.4 });
            assertFinitePlan(plan, `${label} ${duration}s`);
            const { maxRate, maxAcc } = yawStats(plan);
            assert.ok(maxRate <= 33, `${label} ${duration}s: yaw rate ${maxRate.toFixed(1)} °/s`);
            assert.ok(maxAcc < 60, `${label} ${duration}s: yaw acceleration ${maxAcc.toFixed(0)} °/s²`);
            // The intro never zooms out: the overview is at least as far as the follow camera.
            assert.ok(plan.poseAt(0).range >= plan.meta.range - 1e-6, `${label} ${duration}s: overview closer than the follow camera`);
            // 12 s is the shortest automatic video. Shorter ones (chosen by hand) have to move faster.
            if (duration < 12) continue;
            const m = smoothness(plan);
            assert.ok(m.pan < 1 && m.zoom < 1 && m.follow < 1, `${label} ${duration}s: ${JSON.stringify(m)}`);
        }
    }
});

test('works anywhere on Earth: southern/western hemispheres, high latitude, across the antimeridian', () => {
    const places: Record<string, TrackPoint[]> = {
        'Patagonia': line(400, 0.0003, -0.0002, -72.9, -50.9),
        'Lofoten 68°N': line(400, 0.0006, 0.0001, 14.5, 68.2),
        'equator': line(400, 0.0003, 0.0003, -78.5, -0.1),
        'Fiji across 180°': Array.from({ length: 400 }, (_, i) => {
            const lon = 179.94 + i * 0.0003;
            return { lon: lon > 180 ? lon - 360 : lon, lat: -16.8 + i * 0.0001 };
        }),
    };
    for (const [label, pts] of Object.entries(places)) {
        const plan = buildFlightPlan(pts, { duration: 12 });
        assertFinitePlan(plan, label);
        let raw = 0;
        for (let i = 1; i < pts.length; i++) raw += haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
        assert.ok(Math.abs(plan.length - raw) < raw * 0.01, `${label}: length ${plan.length.toFixed(0)} m vs ${raw.toFixed(0)} m`);
        // Overview distance must match the size of the track (≈ 14–30 km long), not half the planet.
        assert.ok(plan.poseAt(0).range < 150000, `${label}: overview from ${plan.poseAt(0).range.toFixed(0)} m`);
        // The camera stays near the track at all times.
        const mid = pts[200];
        for (let t = 0; t <= plan.duration; t += 0.5) {
            const p = plan.poseAt(t);
            const d = haversine(mid.lat, mid.lon, p.target.lat, ((p.target.lon + 540) % 360) - 180);
            assert.ok(d < 60000, `${label}: target ${Math.round(d / 1000)} km from the track at t=${t}`);
        }
    }
});

// ---------------------------------------------------------------- options

test('option extremes: duration, intro/outro longer than the video, pitch, range, sample rate', () => {
    const pts = FIXTURES[0][1];
    const cases: Array<[string, FlightOptions]> = [
        ['duration below minimum', { duration: 1 }],
        ['5 minute video', { duration: 300 }],
        ['intro + outro longer than the video', { duration: 10, intro: 8, outro: 9 }],
        ['no intro/outro', { duration: 10, intro: 0, outro: 0 }],
        ['pitch 0', { pitch: 0 }],
        ['pitch 90 (clamped)', { pitch: 90 }],
        ['range 100 m', { range: 100, duration: 60 }],
        ['range 80 km', { range: 80000 }],
        ['30 Hz internal', { sampleRate: 30 }],
        ['240 Hz internal', { sampleRate: 240, duration: 12 }],
        ['tall 9:21', { aspect: 9 / 21 }],
        ['ultrawide 32:9', { aspect: 32 / 9 }],
        ['exaggeration 3', { exaggeration: 3 }],
        ['orbit 360°', { outroOrbit: 360 }],
    ];
    for (const [label, o] of cases) {
        const plan = buildFlightPlan(pts, o);
        assertFinitePlan(plan, label);
        assert.ok(plan.meta.intro + plan.meta.outro <= plan.duration - 0.99, `${label}: intro ${plan.meta.intro} + outro ${plan.meta.outro} > duration ${plan.duration}`);
        assert.ok(Math.abs(plan.distanceAt(plan.duration) - plan.track.s.at(-1)!) < 1e-6, `${label}: the tip reaches the finish`);
    }
    assert.equal(buildFlightPlan(pts, { duration: 1 }).duration, 3);
    assert.equal(buildFlightPlan(pts, { pitch: 90 }).meta.pitch, 82);
});

test('poseAt clamps time outside the video and the internal sample rate does not change the flight', () => {
    const pts = FIXTURES[1][1];
    const plan = buildFlightPlan(pts, { duration: 20 });
    assert.deepEqual(plan.poseAt(-5), plan.poseAt(0));
    assert.deepEqual(plan.poseAt(1e9), plan.poseAt(plan.duration));
    assert.deepEqual(plan.poseAt(NaN as number), plan.poseAt(0));
    const fine = buildFlightPlan(pts, { duration: 20, sampleRate: 120 });
    for (let t = 0; t <= 20; t += 0.37) {
        const a = plan.poseAt(t), b = fine.poseAt(t);
        const d = haversine(a.camera.lat, a.camera.lon, b.camera.lat, b.camera.lon);
        assert.ok(d < 0.01 * a.range, `camera differs by ${d.toFixed(0)} m at t=${t.toFixed(2)} (range ${a.range.toFixed(0)})`);
        assert.ok(Math.abs(angleDiff(a.bearing, b.bearing)) < 1.5, `bearing differs at t=${t.toFixed(2)}`);
    }
});

test('reversed track is the same flight backwards: same length, same stats', () => {
    for (const [name, pts] of FIXTURES) {
        const fwd = buildFlightPlan(pts.map(p => ({ lon: p.lon, lat: p.lat, ele: p.ele })), { duration: 20 });
        const rev = buildFlightPlan([...pts].reverse().map(p => ({ lon: p.lon, lat: p.lat, ele: p.ele })), { duration: 20 });
        assert.ok(Math.abs(fwd.length - rev.length) < 1, `${name}: length`);
        assert.ok(Math.abs(fwd.meta.range - rev.meta.range) < 1e-6, `${name}: camera distance`);
        const a = fwd.tipAt(0), b = rev.tipAt(rev.duration);
        assert.ok(Math.abs(a.lon - b.lon) < 1e-9 && Math.abs(a.lat - b.lat) < 1e-9, `${name}: start = reversed finish`);
    }
});

// ---------------------------------------------------------------- random tracks

test('120 seeded random tracks and option sets: always a finite, monotonic, bounded flight', () => {
    const presets = Object.keys(CAMERA_PRESETS) as PresetId[];
    for (let seed = 1; seed <= 120; seed++) {
        const r = rng(seed);
        const n = 2 + Math.floor(r() ** 2 * 3000);
        const stepM = 2 + r() ** 3 * 400;                    // 2 m … 400 m between points
        const wander = r() * 1.2;                            // how fast the direction changes
        const lat0 = -60 + r() * 125, lon0 = -179 + r() * 358;
        const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
        const hasEle = r() < 0.7, hasTime = r() < 0.6;
        let lon = lon0, lat = lat0, dir = r() * 2 * Math.PI, ele = r() * 2500, time = 1.7e12;
        const pts: TrackPoint[] = [];
        for (let i = 0; i < n; i++) {
            pts.push({
                lon, lat,
                ele: hasEle && r() > 0.02 ? ele : null,
                time: hasTime && r() > 0.02 ? time : null,
            });
            dir += (r() - 0.5) * wander;
            if (r() < 0.01) dir += Math.PI;                  // sudden U-turn
            const d = r() < 0.05 ? 0 : stepM * (0.3 + r() * 1.4);   // sometimes standing still
            lon += (Math.sin(dir) * d) / kx;
            lat += (Math.cos(dir) * d) / 111320;
            ele = Math.max(0, ele + (r() - 0.5) * stepM * 0.3);
            time += 1000 + (r() < 0.01 ? 600000 : 0);
        }
        const opts: FlightOptions = {
            preset: presets[Math.floor(r() * presets.length)],
            duration: r() < 0.3 ? undefined : 6 + r() * 70,
            aspect: [9 / 16, 4 / 5, 1, 16 / 9][Math.floor(r() * 4)],
            exaggeration: r() < 0.2 ? 0 : 1 + r() * 1.5,
            northUp: r() < 0.25,
            terrain: r() < 0.4 ? (lo, la) => 600 + 500 * Math.sin(lo * 90) * Math.cos(la * 70) : null,
        };
        const label = `seed ${seed} (${n} pts, ~${stepM.toFixed(0)} m, ${opts.preset}, ${opts.duration?.toFixed(0) ?? 'auto'} s)`;
        let plan: FlightPlan;
        try {
            plan = buildFlightPlan(pts, opts);
        } catch (err) {
            // Only "track too short" is an acceptable rejection.
            assert.match((err as Error).message, /too short|at least 2 points/, `${label}: ${(err as Error).message}`);
            continue;
        }
        assertFinitePlan(plan, label);
        const { maxRate } = yawStats(plan);
        assert.ok(maxRate <= 33.5, `${label}: yaw rate ${maxRate.toFixed(1)} °/s`);
        if (opts.northUp) for (const p of frames(plan)) assert.ok(Math.abs(angleDiff(0, p.bearing)) < 1e-6, `${label}: north-up`);
        const end = plan.tipAt(plan.duration);
        assert.ok(Math.abs(end.lat - pts.at(-1)!.lat) < 1e-6, `${label}: finish`);
    }
});
