import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    gaussianSmooth, unwrapDegrees, angleDiff, resampleUniform, fillGaps, haversine, localProjection, sampleAt,
} from '../src/core/geo.ts';
import { parseGpx } from '../src/core/gpx.ts';

test('gaussianSmooth keeps constants and straight lines exactly (no end bias)', () => {
    const c = gaussianSmooth(new Array(50).fill(7), 6);
    for (const v of c) assert.ok(Math.abs(v - 7) < 1e-9);
    const line = Array.from({ length: 80 }, (_, i) => 3 * i - 20);
    const s = gaussianSmooth(line, 10);
    for (let i = 0; i < line.length; i++) assert.ok(Math.abs(s[i] - line[i]) < 1e-6, `index ${i}`);
});

test('gaussianSmooth removes noise and survives a window wider than the data', () => {
    const noisy = Array.from({ length: 400 }, (_, i) => (i % 2 ? 1 : -1));
    const s = gaussianSmooth(noisy, 5);
    for (let i = 20; i < 380; i++) assert.ok(Math.abs(s[i]) < 0.01);
    const short = gaussianSmooth([1, 2, 3, 4], 50);
    assert.equal(short.length, 4);
    for (const v of short) assert.ok(Number.isFinite(v));
});

test('angles: shortest difference and unwrapping across north', () => {
    assert.equal(angleDiff(350, 10), 20);
    assert.equal(angleDiff(10, 350), -20);
    assert.deepEqual([...unwrapDegrees([350, 355, 2, 8])], [350, 355, 362, 368]);
});

test('resampleUniform produces equal spacing and keeps both ends', () => {
    const xs = [0, 10, 10, 100];
    const ys = [0, 0, 0, 0]; // includes a zero-length segment (GPS stop)
    const r = resampleUniform(xs, ys, [100, 110, 110, 200], [0, NaN, NaN, 1000], 7);
    assert.equal(r.x[0], 0);
    assert.equal(r.x[r.x.length - 1], 100);
    for (let i = 1; i < r.x.length; i++) assert.ok(Math.abs(r.x[i] - r.x[i - 1] - r.step) < 1e-9);
    assert.ok(Math.abs(r.ele[r.ele.length - 1] - 200) < 1e-9);
});

test('fillGaps interpolates holes and returns null when nothing is known', () => {
    assert.deepEqual([...fillGaps(new Float64Array([NaN, 2, NaN, 4, NaN]))!], [2, 2, 3, 4, 4]);
    assert.equal(fillGaps(new Float64Array([NaN, NaN])), null);
});

test('local projection round-trips and matches haversine within 0.5 %', () => {
    const p = localProjection(13.9, 49.5);
    const [x, y] = p.toXY(14.1, 49.6);
    const [lon, lat] = p.toLonLat(x, y);
    assert.ok(Math.abs(lon - 14.1) < 1e-9 && Math.abs(lat - 49.6) < 1e-9);
    const d = haversine(49.5, 13.9, 49.6, 14.1);
    assert.ok(Math.abs(Math.hypot(x, y) - d) / d < 0.005);
});

test('sampleAt clamps and interpolates', () => {
    assert.equal(sampleAt([0, 10, 20], -1), 0);
    assert.equal(sampleAt([0, 10, 20], 1.5), 15);
    assert.equal(sampleAt([0, 10, 20], 9), 20);
});

test('parseGpx reads name, elevation and time; falls back to route points', () => {
    const gpx = `<?xml version="1.0"?><gpx><metadata><name>Meta</name></metadata><trk><name>Tr &amp; ek</name><trkseg>
      <trkpt lat="49.1" lon="13.1"><ele>500.5</ele><time>2026-11-22T11:26:38Z</time></trkpt>
      <trkpt lat="49.2" lon="13.2"/></trkseg></trk></gpx>`;
    const r = parseGpx(gpx);
    assert.equal(r.name, 'Tr & ek');
    assert.equal(r.points.length, 2);
    assert.equal(r.points[0].ele, 500.5);
    assert.equal(r.points[0].time, Date.parse('2026-11-22T11:26:38Z'));
    assert.equal(r.points[1].ele, null);
    const rte = parseGpx(`<gpx><rte><name>R</name><rtept lat='1' lon='2'></rtept><rtept lat='1.1' lon='2.1'></rtept></rte></gpx>`);
    assert.equal(rte.points.length, 2);
    assert.equal(rte.name, 'R');
});

test('gaussianSmooth: the fast path for wide kernels matches the direct convolution', () => {
    // Direct O(n·sigma) reference, same odd reflection at the ends.
    const direct = (v: Float64Array, sigma: number) => {
        const n = v.length, radius = Math.ceil(sigma * 3), out = new Float64Array(n);
        const at = (i: number) => (i < 0 ? 2 * v[0] - v[Math.min(-i, n - 1)] : i > n - 1 ? 2 * v[n - 1] - v[Math.max(2 * (n - 1) - i, 0)] : v[i]);
        const w = (k: number) => Math.exp(-(k * k) / (2 * sigma * sigma));
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += w(k);
        for (let i = 0; i < n; i++) {
            let a = 0;
            for (let k = -radius; k <= radius; k++) a += w(k) * at(i + k);
            out[i] = a / sum;
        }
        return out;
    };
    let seed = 7;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    // 71 is the last sigma on the direct path, 72 the first on the fast one.
    for (const [n, sigma] of [[4000, 71], [4000, 72], [4000, 100], [2500, 500], [600, 2000], [40, 400]] as const) {
        const v = new Float64Array(n);
        for (let i = 0, x = 0; i < n; i++) { x += (rnd() - 0.5) * 20; v[i] = x + (rnd() - 0.5) * 30 + 300 * Math.sin(i / 180); }
        const a = gaussianSmooth(v, sigma), b = direct(v, sigma);
        let diff = 0, lo = Infinity, hi = -Infinity, jitter = 0;
        for (let i = 0; i < n; i++) {
            diff = Math.max(diff, Math.abs(a[i] - b[i]));
            lo = Math.min(lo, v[i]); hi = Math.max(hi, v[i]);
            // sample-to-sample roughness must not grow either (it would show as camera shake)
            if (i > 1) jitter = Math.max(jitter, Math.abs(a[i] - 2 * a[i - 1] + a[i - 2] - (b[i] - 2 * b[i - 1] + b[i - 2])));
        }
        assert.ok(diff < 5e-4 * (hi - lo), `n=${n} σ=${sigma}: differs by ${diff.toFixed(3)} of ${(hi - lo).toFixed(0)}`);
        assert.ok(jitter < 0.01, `n=${n} σ=${sigma}: roughness ${jitter.toExponential(2)}`);
    }
});
