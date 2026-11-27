import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snowifyPixels } from '../src/effects/snow.ts';

const px = (...rgb: number[][]) => new Uint8ClampedArray(rgb.flatMap(([r, g, b]) => [r, g, b, 255]));
const luma = (a: Uint8ClampedArray, i: number) => 0.299 * a[i * 4] + 0.587 * a[i * 4 + 1] + 0.114 * a[i * 4 + 2];

const MEADOW = [120, 150, 70];
const FIELD = [180, 160, 120];
const FOREST = [30, 52, 30];
const WATER = [20, 35, 60];

test('open land turns to snow, forest stays dark, water stays water', () => {
    const a = px(MEADOW, FIELD, FOREST, WATER);
    snowifyPixels(a, null);
    assert.ok(luma(a, 0) > 215, `meadow luma ${luma(a, 0)}`);
    assert.ok(luma(a, 1) > 215, `field luma ${luma(a, 1)}`);
    assert.ok(a[4 + 2] > a[4], 'snow is slightly blue (B > R)');
    assert.ok(luma(a, 2) < 90, `forest luma ${luma(a, 2)}`);
    assert.ok(luma(a, 3) < 70, `water luma ${luma(a, 3)}`);
    assert.equal(a[3], 255, 'alpha untouched');
});

test('amount 0 leaves pixels unchanged, partial amount blends', () => {
    const a = px(MEADOW);
    snowifyPixels(a, null, { amount: 0 });
    assert.deepEqual([...a], [...px(MEADOW)]);
    const half = px(MEADOW);
    snowifyPixels(half, null, { amount: 0.5 });
    const l = luma(half, 0);
    assert.ok(l > 150 && l < 210, `half snow luma ${l}`);
});

test('snow line: valleys keep summer colours, mountains get snow', () => {
    const a = px(MEADOW, MEADOW, MEADOW);
    const heights = [500, 900, 1300];
    snowifyPixels(a, i => heights[i], { snowline: 900 });
    assert.ok(luma(a, 0) < 140, `500 m stays green (${luma(a, 0)})`);
    assert.ok(luma(a, 1) > 160 && luma(a, 1) < 215, `snow line is a soft blend (${luma(a, 1)})`);
    assert.ok(luma(a, 2) > 215, `1300 m snowy (${luma(a, 2)})`);
});

test('unknown elevation (NaN) falls back to full snow', () => {
    const a = px(MEADOW);
    snowifyPixels(a, () => NaN, { snowline: 900 });
    assert.ok(luma(a, 0) > 215);
});
