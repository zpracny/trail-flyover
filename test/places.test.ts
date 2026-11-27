import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readMvtPoints } from '../src/extras/mvt.ts';
import { fetchPlaceLabels, fetchVectorPlaceLabels, PlaceLabelsError, tilesAlongTrack } from '../src/extras/places.ts';

// --- A tiny MVT encoder, enough to build test tiles ---------------------------------------
type Val = string | number | boolean;
const varint = (n: number): number[] => {
    const out: number[] = [];
    while (n >= 0x80) { out.push((n % 0x80) | 0x80); n = Math.floor(n / 0x80); }
    out.push(n);
    return out;
};
const zz = (n: number) => (n < 0 ? -2 * n - 1 : 2 * n);
const field = (num: number, wire: number) => varint(num * 8 + wire);
const bytesField = (num: number, b: number[]) => [...field(num, 2), ...varint(b.length), ...b];
const str = (s: string) => [...new TextEncoder().encode(s)];
const value = (v: Val) =>
    typeof v === 'string' ? bytesField(1, str(v))
        : typeof v === 'boolean' ? [...field(7, 0), v ? 1 : 0]
            : Number.isInteger(v) ? [...field(4, 0), ...varint(v)]
                : (() => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); return [...field(3, 1), ...b]; })();

interface F { x: number; y: number; props: Record<string, Val>; type?: number }
function layer(name: string, features: F[], extent = 4096): number[] {
    const keys: string[] = [], vals: Val[] = [];
    const feats = features.map(f => {
        const tags: number[] = [];
        for (const [k, v] of Object.entries(f.props)) {
            let ki = keys.indexOf(k); if (ki < 0) { ki = keys.length; keys.push(k); }
            let vi = vals.indexOf(v); if (vi < 0) { vi = vals.length; vals.push(v); }
            tags.push(ki, vi);
        }
        const geom = [9, zz(Math.round(f.x * extent)), zz(Math.round(f.y * extent))];
        return bytesField(2, [
            ...bytesField(2, tags.flatMap(varint)),
            ...field(3, 0), f.type ?? 1,
            ...bytesField(4, geom.flatMap(varint)),
        ]);
    });
    return bytesField(3, [
        ...field(15, 0), 2,
        ...bytesField(1, str(name)),
        ...feats.flat(),
        ...keys.flatMap(k => bytesField(3, str(k))),
        ...vals.flatMap(v => bytesField(4, value(v))),
        ...field(5, 0), ...varint(extent),
    ]);
}
const tile = (...layers: number[][]) => new Uint8Array(layers.flat());

// --- Geography helpers -------------------------------------------------------------------
const Z = 12, N = 2 ** Z;
const tileXY = (lon: number, lat: number) => {
    const x = ((lon + 180) / 360) * N;
    const r = (lat * Math.PI) / 180;
    const y = ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * N;
    return { tx: Math.floor(x), ty: Math.floor(y), fx: x - Math.floor(x), fy: y - Math.floor(y) };
};
/** A short track west→east through Blatná (≈ 2.4 km). */
const track = Array.from({ length: 50 }, (_, i) => ({ lon: 13.865 + i * 0.0007, lat: 49.4247 }));
const blatna = { lon: 13.8818, lat: 49.4247 };

// --- fetch stub --------------------------------------------------------------------------
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
function stubFetch(handler: (url: string, signal?: AbortSignal) => Response | Promise<Response>) {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        calls.push(url);
        return handler(url, init?.signal ?? undefined);
    }) as typeof fetch;
    return calls;
}
const TEMPLATE = 'https://tiles.test/{z}/{x}/{y}.pbf';

test('readMvtPoints: decodes points with string, int, float and bool properties', () => {
    const t = tile(
        layer('place', [
            { x: 0.25, y: 0.5, props: { name: 'Blatná', class: 'town', rank: 11, capital: false } },
            { x: 0.75, y: 0.125, props: { name: 'Mačkov', class: 'village', ele: 451.5 } },
        ]),
        layer('water', [{ x: 0.1, y: 0.1, props: { class: 'lake' } }]),
    );
    const m = readMvtPoints(t, ['place']);
    assert.equal(m.has('water'), false);
    const pl = m.get('place')!;
    assert.equal(pl.length, 2);
    assert.deepEqual(pl[0], { x: 0.25, y: 0.5, props: { name: 'Blatná', class: 'town', rank: 11, capital: false } });
    assert.equal(pl[1].props.ele, 451.5);
    assert.equal(pl[1].x, 0.75);
});

test('readMvtPoints: skips lines and polygons, rejects truncated data', () => {
    const t = tile(layer('place', [{ x: 0.5, y: 0.5, props: { name: 'Line' }, type: 2 }]));
    assert.deepEqual(readMvtPoints(t, ['place']).get('place'), []);
    assert.throws(() => readMvtPoints(t.subarray(0, t.length - 5), ['place']), /MVT/);
});

test('tilesAlongTrack: covers the padding around the track, also across tile edges', () => {
    const one = tilesAlongTrack([{ lon: 13.88, lat: 49.42 }, { lon: 13.8801, lat: 49.42 }], Z, 10);
    assert.equal(one.size, 1);
    const { tx, ty } = tileXY(13.88, 49.42);
    assert.ok(one.has(`${tx}/${ty}`));
    // 2 km padding around a point reaches at least one neighbour of a ~6 km tile only near its edge.
    const wide = tilesAlongTrack(track, Z, 6000);
    assert.ok(wide.size >= 4);
});

test('fetchVectorPlaceLabels: places near the track, with kinds, peaks and dedupe across tiles', async () => {
    const b = tileXY(blatna.lon, blatna.lat);
    const far = tileXY(13.95, 49.4247); // ~5 km east: beyond maxOffTrack
    const calls = stubFetch(url => {
        const [, x, y] = url.match(/\/12\/(\d+)\/(\d+)\.pbf$/)!.map(Number);
        if (x === b.tx && y === b.ty) {
            return new Response(tile(
                layer('place', [
                    { x: b.fx, y: b.fy, props: { name: 'Blatná', 'name:en': 'Blatna', class: 'town' } },
                    { x: b.fx + 0.0001, y: b.fy, props: { name: 'Blatná', 'name:en': 'Blatna', class: 'town' } }, // repeated from a neighbour's edge
                    { x: b.fx + 0.01, y: b.fy, props: { name: 'Nová Ves', class: 'suburb' } },
                    { x: far.fx + (far.tx - b.tx), y: far.fy, props: { name: 'Daleko', class: 'village' } },
                ]),
                layer('mountain_peak', [
                    { x: b.fx + 0.02, y: b.fy, props: { name: 'Vrch', class: 'peak', ele: 520 } },
                    { x: b.fx + 0.02, y: b.fy, props: { name: 'Sedlo', class: 'saddle' } },
                ]),
            ));
        }
        return new Response(null, { status: 204 });
    });
    const labels = await fetchVectorPlaceLabels(track, { tiles: TEMPLATE });
    assert.ok(calls.length >= 1 && calls.every(u => u.startsWith('https://tiles.test/12/')));
    const names = labels.map(l => `${l.kind}:${l.name}`).sort();
    assert.deepEqual(names, ['peak:Vrch', 'town:Blatná']);
    const bl = labels.find(l => l.name === 'Blatná')!;
    assert.ok(Math.abs(bl.lon - blatna.lon) < 1e-4 && Math.abs(bl.lat - blatna.lat) < 1e-4);

    const en = await fetchVectorPlaceLabels(track, { tiles: TEMPLATE, language: 'en', peaks: false });
    assert.deepEqual(en.map(l => l.name), ['Blatna']);
});

test('fetchVectorPlaceLabels: reads the tile URL from TileJSON', async () => {
    const calls = stubFetch(url => url === 'https://tj.test/planet'
        ? Response.json({ tiles: [TEMPLATE] })
        : new Response(null, { status: 404 }));
    assert.deepEqual(await fetchVectorPlaceLabels(track, { tileJson: 'https://tj.test/planet' }), []);
    assert.equal(calls[0], 'https://tj.test/planet');
    assert.ok(calls.slice(1).every(u => u.startsWith('https://tiles.test/12/')));
});

test('fetchVectorPlaceLabels: a failing tile is retried once, then reported with partial results', async () => {
    const b = tileXY(blatna.lon, blatna.lat);
    let flaky = 0;
    stubFetch(url => {
        if (url.endsWith(`/12/${b.tx}/${b.ty}.pbf`)) {
            return new Response(tile(layer('place', [{ x: b.fx, y: b.fy, props: { name: 'Blatná', class: 'town' } }])));
        }
        flaky++;
        return new Response('busy', { status: 503 });
    });
    const tiles = tilesAlongTrack(track, Z, 2000).size;
    await assert.rejects(fetchVectorPlaceLabels(track, { tiles: TEMPLATE }), (err: unknown) => {
        assert.ok(err instanceof PlaceLabelsError);
        assert.equal(err.failedTiles, tiles - 1);
        assert.equal(err.totalTiles, tiles);
        assert.deepEqual(err.labels.map(l => l.name), ['Blatná']);
        assert.match(err.message, /HTTP 503/);
        return true;
    });
    assert.equal(flaky, (tiles - 1) * 2);

    // Retry succeeds the second time → no error.
    const seen = new Set<string>();
    stubFetch(url => {
        if (!seen.has(url)) { seen.add(url); return new Response('busy', { status: 503 }); }
        return new Response(null, { status: 204 });
    });
    assert.deepEqual(await fetchVectorPlaceLabels(track, { tiles: TEMPLATE }), []);
});

test('fetchVectorPlaceLabels: long tracks step down in zoom to stay within maxTiles', async () => {
    const long = Array.from({ length: 400 }, (_, i) => ({ lon: 13 + i * 0.01, lat: 49.4 })); // ~290 km
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    await fetchVectorPlaceLabels(long, { tiles: TEMPLATE, maxTiles: 60 });
    assert.ok(calls.length <= 60);
    assert.ok(calls.every(u => !u.includes('/12/')));
});

test('fetchVectorPlaceLabels: bad template and aborts', async () => {
    await assert.rejects(fetchVectorPlaceLabels(track, { tiles: 'https://tiles.test/tile.pbf' }), /\{z\}/);
    stubFetch((_url, signal) => new Promise((_res, rej) => {
        if (signal?.aborted) rej(signal.reason);
        signal?.addEventListener('abort', () => rej(signal.reason));
    }));
    const ac = new AbortController();
    const p = fetchVectorPlaceLabels(track, { tiles: TEMPLATE, signal: ac.signal });
    ac.abort();
    await assert.rejects(p);
});

test('fetchPlaceLabels: vector tiles by default, Overpass on request', async () => {
    const calls = stubFetch(url => url.includes('overpass')
        ? Response.json({ elements: [{ lat: blatna.lat, lon: blatna.lon, tags: { name: 'Blatná', place: 'town' } }] })
        : new Response(null, { status: 204 }));
    assert.deepEqual(await fetchPlaceLabels(track, { tiles: TEMPLATE }), []);
    assert.ok(calls.every(u => u.startsWith('https://tiles.test/')));
    const op = await fetchPlaceLabels(track, { source: 'overpass', endpoints: ['https://overpass.test/api'] });
    assert.deepEqual(op.map(l => l.name), ['Blatná']);
});
