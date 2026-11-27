import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseGpx } from '../src/core/gpx.ts';
import { sanitizeTrack, unwrapLongitudes } from '../src/core/clean.ts';
import type { TrackPoint } from '../src/core/geo.ts';

const wrap = (body: string) => `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">${body}</gpx>`;

test('GPX: the real recordings parse completely', () => {
    const cases: Array<[string, number, string]> = [
        ['tolmin-koper.gpx', 26122, 'Alps - See, Tolmin - Gorica  - Koper'],
    ];
    for (const [file, minPoints, name] of cases) {
        const text = readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8');
        const g = parseGpx(text);
        assert.equal(g.points.length, (text.match(/<trkpt\b/g) ?? []).length, `${file}: every <trkpt> read`);
        assert.ok(g.points.length >= minPoints, `${file}: ${g.points.length} points`);
        if (name) assert.equal(g.name, name);
        assert.ok(g.points.every(p => Number.isFinite(p.lat) && Number.isFinite(p.lon)), file);
        assert.ok(g.points.every(p => p.ele != null && p.time != null), `${file}: elevation and time on every point`);
        for (let i = 1; i < g.points.length; i++) assert.ok(g.points[i].time! >= g.points[i - 1].time!, `${file}: time goes forward`);
    }
});

test('GPX: attribute order, quotes, self-closing points, whitespace, empty and missing children', () => {
    const g = parseGpx(wrap(`<trk><name> Ranní  kolo </name><trkseg>
        <trkpt lon="14.5" lat="49.5"><ele>312.4</ele><time>2026-05-01T08:00:00Z</time></trkpt>
        <trkpt lat='49.6' lon='14.6'/>
        <trkpt
            lat = "49.7"
            lon = "14.7" >
            <ele>
              320
            </ele>
        </trkpt>
        <trkpt lat="49.8" lon="14.8"><ele></ele><time>neplatný čas</time></trkpt>
        <trkpt lat="abc" lon="14.9"><ele>1</ele></trkpt>
        <trkpt lon="15.0"><ele>1</ele></trkpt>
        <trkpt lat="-33.9" lon="-70.6"><ele>-12.5</ele><time>2026-05-01T08:00:04.250+02:00</time></trkpt>
    </trkseg></trk>`));
    assert.equal(g.name, 'Ranní  kolo');
    assert.deepEqual(g.points.map(p => [p.lat, p.lon]), [[49.5, 14.5], [49.6, 14.6], [49.7, 14.7], [49.8, 14.8], [-33.9, -70.6]]);
    assert.deepEqual(g.points.map(p => p.ele), [312.4, null, 320, null, -12.5]);
    assert.equal(g.points[0].time, Date.UTC(2026, 4, 1, 8, 0, 0));
    assert.equal(g.points[3].time, null);
    assert.equal(g.points[4].time, Date.UTC(2026, 4, 1, 6, 0, 4, 250));
});

test('GPX: several tracks and segments are joined in order; route points are the fallback', () => {
    const multi = parseGpx(wrap(`
        <trk><name>Den 1</name><trkseg><trkpt lat="1" lon="1"/><trkpt lat="2" lon="2"/></trkseg>
             <trkseg><trkpt lat="3" lon="3"/></trkseg></trk>
        <trk><name>Den 2</name><trkseg><trkpt lat="4" lon="4"/></trkseg></trk>
        <rte><rtept lat="9" lon="9"/></rte>`));
    assert.deepEqual(multi.points.map(p => p.lat), [1, 2, 3, 4]);
    assert.equal(multi.name, 'Den 1');
    const route = parseGpx(wrap(`<rte><name>Plán</name><rtept lat="50" lon="14"><ele>200</ele></rtept><rtept lat="50.1" lon="14.1"/></rte>`));
    assert.equal(route.points.length, 2);
    assert.equal(route.name, 'Plán');
    assert.equal(route.points[0].ele, 200);
});

test('GPX: names — entities, CDATA, metadata fallback, and never the name of a point', () => {
    assert.equal(parseGpx(wrap(`<trk><name>T&#225;bor &amp; okol&#xED; &lt;2026&gt;</name><trkseg><trkpt lat="1" lon="1"/></trkseg></trk>`)).name, 'Tábor & okolí <2026>');
    assert.equal(parseGpx(wrap(`<trk><name><![CDATA[Šumava & <Špičák>]]></name><trkseg><trkpt lat="1" lon="1"/></trkseg></trk>`)).name, 'Šumava & <Špičák>');
    assert.equal(parseGpx(wrap(`<metadata><name>Z metadat</name></metadata><trk><trkseg><trkpt lat="1" lon="1"/></trkseg></trk>`)).name, 'Z metadat');
    // The track has no name of its own; a named point inside it must not become the title.
    const g = parseGpx(wrap(`<trk><trkseg><trkpt lat="1" lon="1"><name>Bod 17</name></trkpt><trkpt lat="2" lon="2"/></trkseg></trk>`));
    assert.equal(g.name, null);
    assert.equal(parseGpx(wrap(`<trk><name></name><trkseg><trkpt lat="1" lon="1"/></trkseg></trk>`)).name, null);
});

test('GPX: namespace prefixes, comments, extensions and waypoints', () => {
    const g = parseGpx(`<?xml version="1.0"?><gpx:gpx xmlns:gpx="http://www.topografix.com/GPX/1/1">
        <gpx:wpt lat="49.1" lon="13.2"><gpx:name>Špičák</gpx:name></gpx:wpt>
        <gpx:wpt lat="49.2" lon="13.3"/>
        <gpx:trk><gpx:name>S prefixem</gpx:name><gpx:trkseg>
            <!-- <gpx:trkpt lat="0" lon="0"/> zakomentovaný bod -->
            <gpx:trkpt lat="49.10" lon="13.20"><gpx:ele>1202</gpx:ele>
                <gpx:extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>141</gpxtpx:hr></gpxtpx:TrackPointExtension></gpx:extensions>
            </gpx:trkpt>
            <gpx:trkpt lat="49.11" lon="13.21"><gpx:ele>1190</gpx:ele></gpx:trkpt>
        </gpx:trkseg></gpx:trk></gpx:gpx>`);
    assert.equal(g.name, 'S prefixem');
    assert.deepEqual(g.points.map(p => p.ele), [1202, 1190]);
    assert.deepEqual(g.waypoints, [{ lat: 49.1, lon: 13.2, name: 'Špičák' }]);
});

test('GPX: garbage in → empty result, never an exception', () => {
    for (const text of ['', 'not xml at all', '<gpx>', '<gpx><trk><trkseg><trkpt lat="1"', '{"json": true}', '<html><body>404</body></html>']) {
        const g = parseGpx(text);
        assert.deepEqual(g.points, [], JSON.stringify(text));
        assert.equal(g.name, null);
    }
});

test('GPX: a 26 000-point file parses in well under a second', () => {
    const text = readFileSync(new URL('./fixtures/tolmin-koper.gpx', import.meta.url), 'utf8');
    const t0 = performance.now();
    parseGpx(text);
    const ms = performance.now() - t0;
    assert.ok(ms < 1000, `${ms.toFixed(0)} ms`);
});

// ---------------------------------------------------------------- clean.ts

const T0 = Date.UTC(2026, 0, 1);
const walk = (n: number): TrackPoint[] => Array.from({ length: n }, (_, i) => ({ lon: 14 + i * 0.0001, lat: 49, time: T0 + i * 1000 }));

test('sanitizeTrack: removes single and multi-point teleports, keeps everything else untouched', () => {
    const clean = walk(100);
    assert.deepEqual(sanitizeTrack(clean), clean);

    const single = walk(100);
    single[50] = { ...single[50], lat: 49.5 };
    assert.equal(sanitizeTrack(single).length, 99);

    const triple = walk(100);
    for (const i of [50, 51, 52]) triple[i] = { ...triple[i], lon: 15 + i * 0.0001, lat: 48 };
    const out = sanitizeTrack(triple);
    assert.equal(out.length, 97);
    assert.ok(out.every(p => p.lat === 49));

    // Cold start: the first fix is 40 km off, then the receiver finds itself. Same at the end.
    const first = walk(100);
    first[0] = { ...first[0], lat: 49.36 };
    const f = sanitizeTrack(first);
    assert.equal(f.length, 99);
    assert.equal(f[0], first[1]);
    const last = walk(100);
    last[99] = { ...last[99], lat: 48.7 };
    const l = sanitizeTrack(last);
    assert.equal(l.length, 99);
    assert.equal(l.at(-1), last[98]);
    // Two points only: nothing to compare against, both stay.
    assert.equal(sanitizeTrack([first[0], first[1]]).length, 2);
});

test('sanitizeTrack: a jump that does not come back is a real move, not a glitch', () => {
    const a = walk(50);
    const b = walk(50).map((p, i) => ({ ...p, lon: 15 + i * 0.0001, time: T0 + (50 + i) * 1000 }));
    assert.equal(sanitizeTrack([...a, ...b]).length, 100);
    // Slow far-away detour (10 km in an hour) is plausible movement.
    const slow = walk(100);
    slow[50] = { ...slow[50], lat: 49.09, time: T0 + 3600e3 };
    for (let i = 51; i < 100; i++) slow[i] = { ...slow[i], time: T0 + 7200e3 + i * 1000 };
    assert.equal(sanitizeTrack(slow).length, 100);
    // No timestamps → cannot judge speed → keep.
    const untimed = walk(100).map(p => ({ lon: p.lon, lat: p.lat }));
    untimed[50] = { lon: 14.005, lat: 49.5 };
    assert.equal(sanitizeTrack(untimed).length, 100);
});

test('sanitizeTrack: impossible coordinates are dropped', () => {
    const bad: TrackPoint[] = [
        { lon: 14, lat: 49 }, { lon: NaN, lat: 49 }, { lon: 14, lat: Infinity }, { lon: 14, lat: 91 }, { lon: 14, lat: -90.5 },
        { lon: 400, lat: 49 }, { lon: 0, lat: 0 }, { lon: 14.001, lat: 49 },
        // Legit points on the equator / prime meridian stay.
        { lon: 0, lat: 51.5 }, { lon: -78.5, lat: 0 },
    ];
    assert.deepEqual(sanitizeTrack(bad), [bad[0], bad[7], bad[8], bad[9]]);
});

test('unwrapLongitudes: continuous across ±180°, identical object when nothing crosses', () => {
    const normal = walk(10);
    assert.equal(unwrapLongitudes(normal), normal);
    const east = [179.8, 179.9, -179.95, -179.8].map(lon => ({ lon, lat: -17 }));
    assert.deepEqual(unwrapLongitudes(east).map(p => +p.lon.toFixed(6)), [179.8, 179.9, 180.05, 180.2]);
    const west = [-179.9, 179.95, 179.8, -179.99].map(lon => ({ lon, lat: 65 }));
    assert.deepEqual(unwrapLongitudes(west).map(p => +p.lon.toFixed(6)), [-179.9, -180.05, -180.2, -179.99]);
});
