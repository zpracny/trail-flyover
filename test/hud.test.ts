import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    placeLabelsOnTrack, thinLabels, markEndpointLabels, drawLabels, drawDefaultHud, drawElevationProfile, drawTip, withAlpha, fitText, wrapText, formatDistance, formatDuration, LABEL_REACH,
    type HudFrame, type PlacedLabel, type FlyoverLabel,
} from '../src/hud/hud.ts';
import { readFileSync } from 'node:fs';
import { parseGpx } from '../src/core/gpx.ts';
import { buildFlightPlan } from '../src/core/flightPlan.ts';
import { BASEMAPS, resolveBasemap } from '../src/maplibre/basemaps.ts';
import { snowTileUrl } from '../src/effects/snow.ts';
import { STRINGS, resolveStrings } from '../src/core/i18n.ts';

/** Canvas stand-in: records calls; text is 10 px per character at any font. */
function fakeCtx() {
    const calls: Array<[string, ...unknown[]]> = [];
    const gradient = { addColorStop: (o: number, c: string) => { calls.push(['addColorStop', o, c]); } };
    const target: Record<string, unknown> = {
        measureText: (t: string) => ({ width: [...t].length * 10 }),
        createLinearGradient: () => gradient,
        createRadialGradient: () => gradient,
    };
    const ctx = new Proxy(target, {
        get(t, k: string) {
            if (k in t) return t[k];
            return (...args: unknown[]) => { calls.push([k, ...args]); };
        },
        set(t, k: string, v) { t[k] = v; calls.push([`set:${k}`, v]); return true; },
    }) as unknown as CanvasRenderingContext2D;
    return { ctx, calls, texts: () => calls.filter(c => c[0] === 'fillText').map(c => c[1] as string) };
}

const line = (n: number, f: (i: number) => [number, number]) => {
    const lon = new Float64Array(n), lat = new Float64Array(n), s = new Float64Array(n);
    for (let i = 0; i < n; i++) { [lon[i], lat[i]] = f(i); s[i] = i * 10; }
    return { lon, lat, s };
};

test('labels: placed where the trail first passes, dropped when too far, bad input ignored', () => {
    // 10 km east along lat 49 and back the same way.
    const track = line(2001, i => [14 + (i <= 1000 ? i : 2000 - i) * 0.000137, 49]);
    const village = { lon: 14 + 300 * 0.000137, lat: 49.002, name: 'Ves', kind: 'village' };
    const [placed] = placeLabelsOnTrack([village], track);
    assert.ok(Math.abs(placed.s - 3000) < 60, `first pass at ${placed.s} m (closest overall is also at 17 000 m)`);
    assert.ok(placed.offTrack > 150 && placed.offTrack < 300, `${placed.offTrack} m off`);

    const far = { lon: 14.05, lat: 49.05, name: 'Daleko' };
    assert.deepEqual(placeLabelsOnTrack([far], track), []);
    assert.equal(placeLabelsOnTrack([far], track, 10000).length, 1);
    const junk = [{ lon: NaN, lat: 49, name: 'x' }, { lon: 14, lat: 49, name: '' }] as PlacedLabel[];
    assert.deepEqual(placeLabelsOnTrack(junk, track), []);
    assert.deepEqual(placeLabelsOnTrack([], track), []);
});

test('labels: a loop that returns to its start keeps the start label at the beginning', () => {
    const track = line(1000, i => [14 + 0.02 * Math.cos((i / 999) * 2 * Math.PI), 49 + 0.012 * Math.sin((i / 999) * 2 * Math.PI)]);
    const [start] = placeLabelsOnTrack([{ lon: 14.0201, lat: 49.0001, name: 'Start' }], track);
    assert.ok(start.s < 500, `placed at ${start.s} m of ${track.s[999]} m`);
});

function frame(over: Partial<HudFrame> = {}): HudFrame {
    return {
        width: 1080, height: 1350, scale: 1, t: 5, duration: 20, progress: 0.4,
        stats: { distance: 12345, ascent: 321, elapsed: 4000, moving: 3600, elevation: 512 },
        total: { distance: 30000, ascent: 800, elapsed: 9000, moving: 8000, elevation: 400 },
        pose: { camera: { lon: 14, lat: 48.99, alt: 3000 }, target: { lon: 14, lat: 49, alt: 500 }, bearing: 0, pitch: 60, range: 3000 },
        project: (lon, lat) => ({ x: 540 + (lon - 14) * 20000, y: 675 - (lat - 49) * 20000 }),
        tip: { x: 540, y: 700 }, title: 'Test', subtitle: '1. ledna 2026', attribution: '© Test', accent: '#ff7a1a',
        stop: null, profile: null, showProfile: false, strings: STRINGS.en,
        ...over,
    };
}
const label = (name: string, lon: number, lat: number, s = 0, kind = 'village'): PlacedLabel => ({ name, lon, lat, s, kind, offTrack: 0 });

test('labels: overlapping pills are never drawn on top of each other; towns win over hamlets', () => {
    const { ctx, texts } = fakeCtx();
    // Three places within a few pixels of each other, one clearly apart.
    drawLabels(ctx, [label('Samota', 14, 49, 0, 'hamlet'), label('Město', 14.0005, 49, 0, 'town'), label('Vesnice', 14.001, 49.0002), label('Jinde', 14.012, 49.008)], frame(), 5000);
    assert.deepEqual(texts().sort(), ['Jinde', 'Město']);
});

test('labels: not shown before the trail gets near, behind the camera, or under the title/stats', () => {
    const run = (l: PlacedLabel, f = frame(), tipS = 5000) => { const c = fakeCtx(); drawLabels(c.ctx, [l], f, tipS); return c.texts(); };
    assert.deepEqual(run(label('Před námi', 14, 49, 20000)), [], 'trail has not reached it yet');
    assert.deepEqual(run(label('Tady', 14, 49, 5000)), ['Tady']);
    assert.deepEqual(run(label('Za kamerou', 14, 49), frame({ project: () => null })), []);
    assert.deepEqual(run(label('Pod titulkem', 14, 49.03)), [], 'y = 75 px is in the title band');
    assert.deepEqual(run(label('Pod statistikou', 14, 48.97)), [], 'y = 1275 px is in the stats band');
    assert.deepEqual(run(label('Daleko od cíle', 14.1, 49)), [], 'far from the camera target → faded out');
    // At most six at once, however many are in view.
    const many = Array.from({ length: 40 }, (_, i) => label(`M${i}`, 14 - 0.02 + (i % 8) * 0.006, 49 - 0.02 + Math.floor(i / 8) * 0.009));
    const c = fakeCtx();
    drawLabels(c.ctx, many, frame({ pose: { ...frame().pose, range: 50000 } }), 5000);
    assert.equal(c.texts().length, 6);
});

/** Draws labels and returns name → alpha it was drawn with. */
function drawn(labels: PlacedLabel[], f: HudFrame, tipS: number, options?: Parameters<typeof drawLabels>[4]) {
    const { ctx, calls } = fakeCtx();
    drawLabels(ctx, labels, f, tipS, options);
    const out: Record<string, number> = {};
    let alpha = 1;
    for (const c of calls) {
        if (c[0] === 'set:globalAlpha') alpha = c[1] as number;
        if (c[0] === 'fillText') out[c[1] as string] = alpha;
    }
    return out;
}

test('labels: only places the track really passes — reach depends on the kind of place', () => {
    // 10 km due east along lat 49; 0.001° of latitude = 111 m.
    const track = line(1001, i => [14 + i * 0.000137, 49]);
    const at = (name: string, kind: string | undefined, metresNorth: number, i = 500) =>
        ({ name, kind, lon: 14 + i * 0.000137, lat: 49 + metresNorth / 111320 });
    const names = (ls: FlyoverLabel[], reach?: Parameters<typeof placeLabelsOnTrack>[2]) => new Set(placeLabelsOnTrack(ls, track, reach).map(l => l.name));
    const set = (...n: string[]) => new Set(n);
    const all = [
        at('Ves u trasy', 'village', 300), at('Ves opodál', 'village', 500),
        at('Město', 'town', 900), at('Město daleko', 'town', 1200),
        at('Samota', 'hamlet', 200), at('Samota dál', 'hamlet', 300),
        at('Vrchol', 'peak', 200), at('Vrchol vedle', 'peak', 300),
        at('Velkoměsto', 'city', 1900), at('Můj bod', 'waypoint', 1400),
        at('Neznámý druh', 'viewpoint', 350), at('Bez druhu', undefined, 450),
    ];
    assert.deepEqual(names(all), set('Můj bod', 'Město', 'Neznámý druh', 'Samota', 'Velkoměsto', 'Ves u trasy', 'Vrchol'));
    // One number for everything, or per kind with the defaults for the rest.
    assert.equal(names(all, 5000).size, all.length);
    assert.deepEqual(names(all, 250), set('Samota', 'Vrchol'));
    assert.deepEqual(names(all, { village: 800 }), set('Můj bod', 'Město', 'Neznámý druh', 'Samota', 'Velkoměsto', 'Ves opodál', 'Ves u trasy', 'Vrchol'));
    assert.deepEqual(names(all, { default: 100, town: 100 }), set('Můj bod', 'Samota', 'Velkoměsto', 'Ves u trasy', 'Vrchol'), 'default covers only kinds without their own value');
    assert.deepEqual(names(all, 0), set());

    // The place the track starts in is placed at the very start (its name is there from frame one).
    const [start, later] = placeLabelsOnTrack([at('Start', 'town', 600, 5), at('Cestou', 'village', 100, 300)], track);
    assert.equal(start.s, 0);
    assert.ok(Math.abs(later.s - 3000) < 30);
});

test('labels on a real track: towns and villages on the route stay, the surroundings go', () => {
    // [file, on the route, beside the route, place the track starts in]
    const cases: Array<[string, string[], string[], string | null]> = [
        // The file starts next to the village of Dolje (within its 400 m reach).
        // The file ends 1 km before the real finish, outside the reach of Koper's centre.
        ['tolmin-koper', ['Tolmin', 'Nova Gorica', 'Sežana', 'Kanal', 'Most na Soči', 'Spodnje Škofije'], ['Dornberk', 'Kozmerice', 'Koper / Capodistria'], 'Dolje'],
    ];
    for (const [file, expected, dropped, startPlace] of cases) {
        const pts = parseGpx(readFileSync(new URL(`./fixtures/${file}.gpx`, import.meta.url), 'utf8')).points;
        const places: FlyoverLabel[] = JSON.parse(readFileSync(new URL(`./fixtures/${file}.places.json`, import.meta.url), 'utf8'));
        const plan = buildFlightPlan(pts, { aspect: 0.8 });
        const placed = placeLabelsOnTrack(places, plan.track);
        const names = new Set(placed.map(l => l.name));
        for (const n of expected) assert.ok(names.has(n), `${file}: ${n} is on the route`);
        for (const n of dropped) assert.ok(!names.has(n), `${file}: ${n} is beside the route`);
        assert.ok(placed.length >= 5 && placed.length <= places.length * 0.6, `${file}: ${placed.length} of ${places.length} kept`);
        for (const l of placed) {
            assert.ok(l.offTrack <= (LABEL_REACH[l.kind ?? ''] ?? LABEL_REACH.default) + 1e-6, `${file}: ${l.name} ${Math.round(l.offTrack)} m off`);
            // The time it appears is when the tip is really next to it.
            const t = plan.timeAt(l.s);
            const tip = plan.tipAt(t);
            const d = Math.hypot((tip.lon - l.lon) * 111320 * Math.cos((l.lat * Math.PI) / 180), (tip.lat - l.lat) * 111320);
            assert.ok(l.s === 0 || d <= l.offTrack + 60, `${file}: ${l.name} appears with the tip ${Math.round(d)} m away (place is ${Math.round(l.offTrack)} m off the track)`);
        }
        // The town the ride starts in is there from the first frame; everything else comes later, in order.
        const atStart = placed.filter(l => plan.timeAt(l.s) === 0).map(l => l.name);
        assert.deepEqual(atStart, startPlace ? [startPlace] : [], `${file}: labels at t = 0`);
        assert.ok(placed.every(l => l.s === 0 || plan.timeAt(l.s) > plan.meta.intro), `${file}: nothing else before the trail starts moving`);
    }
});

test('labels: when names come too fast the less important ones are left out, towns never', () => {
    const mk = (name: string, t: number, kind: string, offTrack = 100): PlacedLabel => ({ name, lon: 14, lat: 49, s: t * 1000, offTrack, kind, t });
    const cluster = [
        mk('Samota A', 10.0, 'hamlet'), mk('Ves', 10.2, 'village'), mk('Samota B', 10.4, 'hamlet'), mk('Vrchol', 10.5, 'peak', 50),
        mk('Město', 10.6, 'town'), mk('Město 2', 10.7, 'town'), mk('Samota C', 11.4, 'hamlet'), mk('Samota D', 11.5, 'hamlet', 20),
        mk('Daleko', 30, 'hamlet'),
    ];
    const names = (minGap?: number) => thinLabels(cluster, minGap).map(l => l.name);
    // Both towns stay although 0.1 s apart; the peak is too close to them in time, the village is not
    // (0.4 s is under the gap → dropped too); of C and D the one nearer the track stays.
    assert.deepEqual(names(), ['Město', 'Město 2', 'Samota D', 'Daleko']);
    assert.deepEqual(names(0.3), ['Ves', 'Město', 'Město 2', 'Samota D', 'Daleko']);
    assert.deepEqual(names(0), cluster.map(l => l.name), '0 switches thinning off');
    assert.deepEqual(thinLabels([], 1), []);
    // Labels without a time (custom callers) are never dropped.
    assert.equal(thinLabels([label('A', 14, 49), label('B', 14, 49)], 5).length, 2);

    // Real data: Tolmin–Koper flown in 60 s has clusters of hamlets a tenth of a second apart.
    const pts = parseGpx(readFileSync(new URL('./fixtures/tolmin-koper.gpx', import.meta.url), 'utf8')).points;
    const places: FlyoverLabel[] = JSON.parse(readFileSync(new URL('./fixtures/tolmin-koper.places.json', import.meta.url), 'utf8'));
    for (const o of [{}, { camera: 'static', pitch: 0, northUp: true }] as const) {
        const plan = buildFlightPlan(pts, { aspect: 0.8, ...o });
        const all = placeLabelsOnTrack(places, plan.track).map(l => ({ ...l, t: plan.timeAt(l.s) }));
        const kept = thinLabels(all);
        const towns = (ls: PlacedLabel[]) => ls.filter(l => l.kind === 'town').map(l => l.name);
        assert.deepEqual(towns(kept), towns(all));
        assert.ok(kept.length < all.length && kept.length >= 15, `${plan.meta.camera}: ${kept.length} of ${all.length}`);
        const minor = kept.filter(l => l.kind !== 'town').map(l => l.t).sort((a, b) => a - b);
        for (let i = 1; i < minor.length; i++) assert.ok(minor[i] - minor[i - 1] >= 0.6 - 1e-9, `${plan.meta.camera}: ${minor[i - 1]} → ${minor[i]}`);
    }
});

test('labels: appear at the moment the trail gets there (not before), fully visible half a second later', () => {
    const l: PlacedLabel = { ...label('Ves', 14, 49, 5000), t: 8 };
    const alphaAt = (t: number) => drawn([l], frame({ t }), 0).Ves;
    assert.equal(alphaAt(0), undefined);
    assert.equal(alphaAt(7.8), undefined, 'not yet — the tip is still on its way');
    const arriving = alphaAt(8.05);
    assert.ok(arriving > 0.05 && arriving < 0.6, `fading in at arrival: ${arriving}`);
    assert.ok(alphaAt(8.2) > arriving);
    assert.equal(alphaAt(8.5), 1);
    assert.equal(alphaAt(15), 1, 'stays while the camera is near');
    // The place the track starts in is fully there on the very first frame (video thumbnail).
    assert.equal(drawn([{ ...label('Start', 14, 49, 0), t: 0 }], frame({ t: 0 }), 0).Start, 1);
    // Without a time (custom callers): simply "passed or not".
    assert.deepEqual(drawn([label('A', 14, 49, 100), label('B', 14.01, 49, 9000)], frame(), 5000), { A: 1 });
});

test('labels: lead shows a name before the trail arrives, so a fast flight leaves time to read it', () => {
    const l: PlacedLabel = { ...label('Ves', 14, 49, 5000), t: 8 };
    const alphaAt = (t: number, lead?: number) => drawn([l], frame({ t }), 0, { lead }).Ves;
    assert.equal(alphaAt(7.5), undefined, 'no lead: nothing before arrival');
    assert.equal(alphaAt(6.7, 1.2), undefined, 'not earlier than the lead');
    const early = alphaAt(6.95, 1.2);
    assert.ok(early > 0.05 && early < 0.6, `fading in 1.2 s ahead: ${early}`);
    assert.equal(alphaAt(7.4, 1.2), 1, 'fully readable before the tip gets there');
    assert.equal(alphaAt(9, 1.2), 1);
    // The place the track starts in is unaffected; a negative lead counts as none.
    assert.equal(drawn([{ ...label('Start', 14, 49, 0), t: 0 }], frame({ t: 0 }), 0, { lead: 1.2 }).Start, 1);
    assert.equal(alphaAt(7.5, -3), undefined);
});

test('labels with a static camera: small places fade out again, towns and the start stay', () => {
    const ls: PlacedLabel[] = [
        { ...label('Ves', 14, 49, 5000), t: 2 },
        { ...label('Město', 14.01, 49, 6000, 'town'), t: 2 },
        { ...label('Start', 13.99, 49, 0, 'hamlet'), t: 0 },
        { ...label('Můj bod', 14, 49.01, 7000, 'waypoint'), t: 2 },
    ];
    const at = (t: number, hold?: number) => drawn(ls, frame({ t }), 0, { hold });
    assert.deepEqual(at(4, 3.5), { Ves: 1, 'Město': 1, Start: 1, 'Můj bod': 1 });
    const fading = at(5.9, 3.5).Ves;
    assert.ok(fading > 0 && fading < 1, `fading out: ${fading}`);
    assert.deepEqual(at(7, 3.5), { 'Město': 1, Start: 1, 'Můj bod': 1 });
    assert.equal(at(60).Ves, 1, 'no hold limit by default');
});

test('labels in the overview shots of a flight: only towns, own points and the start remain', () => {
    const ls: PlacedLabel[] = [
        { ...label('Ves', 14, 49, 5000), t: 2 },
        { ...label('Město', 14.01, 49, 6000, 'town'), t: 2 },
        { ...label('Start', 13.99, 49, 0, 'hamlet'), t: 0 },
        { ...label('Můj bod', 14, 49.01, 7000, 'waypoint'), t: 2 },
    ];
    const at = (range: number) => drawn(ls, frame({ t: 10, pose: { ...frame().pose, range } }), 0, { detailRange: 3000 });
    assert.deepEqual(at(3000), { Ves: 1, 'Město': 1, Start: 1, 'Můj bod': 1 });
    assert.equal(at(4400).Ves, 1, 'small changes of distance during the flight do not matter');
    const fading = at(6500).Ves;
    assert.ok(fading > 0 && fading < 1, `fading as the camera pulls back: ${fading}`);
    assert.deepEqual(at(9000), { 'Město': 1, Start: 1, 'Můj bod': 1 });
    assert.deepEqual(at(150000), { 'Město': 1, Start: 1, 'Můj bod': 1 });
});

test('labels: start and finish villages are marked by distance to the ends of the track', () => {
    // West→east 10 km, then back 4 km west: the ride ends 6 km from the start, not at the far end.
    const out = line(1401, i => [14 + (i <= 1000 ? i : 2000 - i) * 0.0001376, 49]);
    const placed = [
        label('Začátek', 14.001, 49.012, 0, 'hamlet'), // 1.3 km from the first point
        label('Město', 14.04, 49, 4000, 'town'),
        label('Obrátka', 14.1376, 49, 10000), // the turnaround: far end, not the finish
        label('Cíl', 14.0826, 49.003, 6000), // 300 m from the last point
        label('Kopec', 14.0826, 49.0005, 6000, 'peak'), // closer, but not a settlement
    ];
    const marked = markEndpointLabels(placed, out);
    const ends = Object.fromEntries(marked.filter(l => l.endpoint).map(l => [l.name, l.endpoint]));
    assert.deepEqual(ends, { 'Začátek': 'start', 'Cíl': 'end' });
    assert.notEqual(marked, placed, 'returns new objects');
    assert.equal(placed.some(l => l.endpoint), false, 'input untouched');

    // Too far from either end (radius) → nothing marked; a town is a landmark already.
    assert.equal(markEndpointLabels(placed, out, 200).some(l => l.endpoint), false);
    assert.equal(markEndpointLabels([label('Město', 14, 49, 0, 'town')], out)[0].endpoint, undefined);

    // A loop: the same village at both ends is one label, marked as the start.
    const loop = line(629, i => [14 + 0.01 * Math.sin(i / 100), 49 + 0.01 * (1 - Math.cos(i / 100))]);
    const one = markEndpointLabels([label('Domov', 14.0005, 49, 0), label('Jinde', 14.01, 49.01, 3000)], loop);
    assert.deepEqual(one.map(l => l.endpoint), ['start', undefined]);
    assert.deepEqual(markEndpointLabels([], loop), []);
});

test('labels: start and finish stay in the overviews and are never thinned out', () => {
    const ls: PlacedLabel[] = [
        { ...label('Ves', 14, 49, 5000), t: 2 },
        { ...label('Start', 13.99, 49, 1500, 'hamlet'), t: 1, endpoint: 'start' }, // not at s = 0
        { ...label('Cíl', 14.01, 49, 9000), t: 2, endpoint: 'end' },
    ];
    const overview = drawn(ls, frame({ t: 19, pose: { ...frame().pose, range: 150000 } }), 9000, { detailRange: 3000 });
    assert.deepEqual(overview, { Start: 1, 'Cíl': 1 });
    assert.deepEqual(drawn(ls, frame({ t: 19 }), 9000, { hold: 3.5 }), { Start: 1, 'Cíl': 1 }, 'static camera keeps them too');
    // The start is there from the first frame (intro overview), although the trail reaches it only
    // at t = 1; the finish appears only when the trail gets there.
    const intro = drawn(ls, frame({ t: 0, pose: { ...frame().pose, range: 150000 } }), 0, { detailRange: 3000, lead: 1.2 });
    assert.deepEqual(intro, { Start: 1 });
    // Three names at the same moment: the finish wins although it is a hamlet and furthest away,
    // and like a town it takes its moment, so the villages give way.
    const burst: PlacedLabel[] = [
        { ...label('A', 14, 49, 100), t: 5, offTrack: 10 },
        { ...label('B', 14, 49, 100, 'hamlet'), t: 5, offTrack: 300, endpoint: 'end' },
        { ...label('C', 14, 49, 100), t: 5, offTrack: 50 },
    ];
    assert.deepEqual(thinLabels(burst, 0.6).map(l => l.name), ['B']);
});

test('labels: a neighbour takes over by cross-fading, never by a sudden swap; edges fade too', () => {
    // Two villages whose pills overlap; "První" was reached first.
    const first: PlacedLabel = { ...label('První', 14, 49, 1000), t: 1 };
    const second: PlacedLabel = { ...label('Druhá', 14.0005, 49, 2000), t: 3 };
    assert.deepEqual(drawn([second, first], frame({ t: 10 }), 0), { 'První': 1 }, 'the earlier one keeps the spot, whatever the input order');
    // With a hold the first fades out and the second fades in by exactly what the first gives up.
    for (const t of [4.6, 4.8, 5.0, 5.2]) {
        const a = drawn([first, second], frame({ t }), 0, { hold: 3.5 });
        assert.ok(a['První'] > 0 && a['První'] < 1 && Math.abs(a['První'] + a['Druhá'] - 1) < 1e-9, `t=${t}: ${JSON.stringify(a)}`);
    }
    assert.deepEqual(drawn([first, second], frame({ t: 6 }), 0, { hold: 3.5 }), { 'Druhá': 1 });
    // A town still wins over a village that was there first.
    const town: PlacedLabel = { ...label('Město', 14.0005, 49, 2000, 'town'), t: 3 };
    assert.deepEqual(drawn([first, town], frame({ t: 10 }), 0), { 'Město': 1 });

    // Approaching the picture edge or the title band a label fades instead of popping out.
    const x = (px: number) => drawn([label('Kraj', 14 + (px - 540) / 20000, 49)], frame(), 5000).Kraj;
    assert.equal(x(30), undefined);
    assert.ok(x(55) > 0 && x(55) < 1);
    assert.equal(x(80), 1);
    assert.ok(x(1025) > 0 && x(1025) < 1);
    const y = (py: number) => drawn([label('Kraj', 14, 49 - (py - 675) / 20000)], frame(), 5000).Kraj;
    assert.equal(y(160), undefined);
    assert.ok(y(180) > 0 && y(180) < 1);
    assert.equal(y(400), 1);
    assert.ok(y(1145) > 0 && y(1145) < 1);
    assert.equal(y(1165), undefined);
});

test('labels: the limit on how many are shown at once is soft (alpha-weighted), default six', () => {
    const many = Array.from({ length: 40 }, (_, i) => label(`M${i}`, 14 - 0.02 + (i % 8) * 0.006, 49 - 0.02 + Math.floor(i / 8) * 0.009, i));
    const far = frame({ pose: { ...frame().pose, range: 50000 } });
    const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
    assert.equal(sum(drawn(many, far, 5000)), 6);
    assert.equal(sum(drawn(many, far, 5000, { maxLabels: 12 })), 12);
    assert.equal(sum(drawn(many, far, 5000, 3)), 3, 'a plain number still works');
    assert.deepEqual(drawn(many, far, 5000, { maxLabels: 0 }), {});
});

test('default HUD: long titles are shortened to fit, stats show moving time, nothing throws', () => {
    const { ctx, texts } = fakeCtx();
    const title = 'Alps - See, Tolmin - Gorica - Koper a ještě hodně dlouhý dovětek, který se do obrázku nevejde ani náhodou, protože je moc dlouhý';
    drawDefaultHud(ctx, frame({ title }));
    const drawn = texts();
    const shown = drawn.find(t => t.startsWith('Alps'))!;
    assert.ok(shown.endsWith('…') && shown.length < title.length, shown);
    assert.ok([...shown].length * 10 <= 1080 - 88, 'fits between the margins');
    assert.ok(drawn.includes('12.3 km') && drawn.includes('321 m') && drawn.includes('1 h 00 min') && drawn.includes('moving time'), drawn.join(' | '));
    // No timestamps → elevation instead of time; no elevation either → two cells only.
    const b = fakeCtx();
    drawDefaultHud(b.ctx, frame({ stats: { distance: 900, ascent: 0, elapsed: null, moving: null, elevation: 512 } }));
    assert.ok(b.texts().includes('900 m') && b.texts().includes('512 m a.s.l.'));
    const c = fakeCtx();
    drawDefaultHud(c.ctx, frame({ title: '', subtitle: '', stats: { distance: 0, ascent: 0, elapsed: null, moving: null, elevation: NaN } }));
    assert.ok(!c.texts().some(t => t.includes('NaN')));
});

test('attribution: a long credit line is wrapped, never cut off or wider than the picture', () => {
    const credit = 'Sources: Esri, HERE, Garmin, Intermap, increment P Corp., GEBCO, USGS, FAO, NPS, NRCAN, GeoBase, IGN, Kadaster NL, Ordnance Survey, Esri Japan, METI, Esri China (Hong Kong), © OpenStreetMap contributors, GIS User Community · terén: AWS Terrain Tiles';
    for (const width of [1080, 1920]) {
        const { ctx, calls } = fakeCtx();
        drawDefaultHud(ctx, frame({ width, attribution: credit }));
        const drawn = calls.filter(c => c[0] === 'fillText' && credit.includes(c[1] as string) && (c[1] as string).length > 20).map(c => c[1] as string);
        assert.equal(drawn.join(' '), credit, `${width}: every word is shown, in order`);
        assert.ok(drawn.every(l => [...l].length * 10 <= width - 24), `${width}: ${drawn.map(l => l.length).join(', ')} chars`);
        assert.ok(width === 1080 ? drawn.length >= 2 : drawn.length >= 1);
    }
    const m = { measureText: (t: string) => ({ width: [...t].length * 10 }) as TextMetrics };
    assert.deepEqual(wrapText(m, 'krátké', 100), ['krátké']);
    assert.deepEqual(wrapText(m, 'a b c d e f', 30), ['a b', 'c d', 'e f']);
    assert.deepEqual(wrapText(m, 'nerozdělitelnéslovo x', 50), ['nerozdělitelnéslovo', 'x']);
    assert.deepEqual(wrapText(m, '', 50), []);
});

test('colours: any CSS colour works for the tip glow (hex, short hex, names, rgb)', () => {
    assert.equal(withAlpha('#ff7a1a', 0.5), '#ff7a1a80');
    assert.equal(withAlpha('#F80', 1), '#FF8800ff');
    assert.equal(withAlpha('#ff7a1a', 0), '#ff7a1a00');
    assert.equal(withAlpha('red', 0.25), 'color-mix(in srgb, red 25%, transparent)');
    assert.equal(withAlpha('rgb(10, 20, 30)', 2), 'color-mix(in srgb, rgb(10, 20, 30) 100%, transparent)');
    for (const accent of ['#ff7a1a', '#f80', 'tomato', 'hsl(20 100% 50%)']) {
        const { ctx, calls } = fakeCtx();
        drawTip(ctx, { x: 10, y: 10 }, 1, accent);
        const stops = calls.filter(c => c[0] === 'addColorStop').map(c => c[2] as string);
        assert.equal(stops.length, 2);
        assert.ok(stops.every(s => /^#[0-9a-f]{8}$/i.test(s) || s.startsWith('color-mix(')), stops.join(', '));
    }
});

test('text helpers: ellipsis fitting and number formats', () => {
    const m = { measureText: (t: string) => ({ width: [...t].length * 10 }) as TextMetrics };
    assert.equal(fitText(m, 'krátký', 100), 'krátký');
    assert.equal(fitText(m, 'Železná Ruda – Špičák', 100), 'Železná R…');
    assert.equal(fitText(m, 'slovo a mezera', 70), 'slovo…');
    assert.equal(fitText(m, 'abc', 5), '…');
    assert.equal(fitText(m, '🏔️🏔️🏔️🏔️🏔️🏔️🏔️🏔️', 60).endsWith('…'), true);
    assert.equal(formatDistance(0), '0 m');
    assert.equal(formatDistance(999.4), '999 m');
    assert.equal(formatDistance(1000), '1.00 km');
    assert.equal(formatDistance(999.6), '1.00 km');
    assert.equal(formatDistance(9994), '9.99 km');
    assert.equal(formatDistance(9999), '10.0 km');
    assert.equal(formatDistance(124020), '124.0 km');
    assert.equal(formatDuration(59), '0 min');
    assert.equal(formatDuration(3599), '59 min');
    assert.equal(formatDuration(3600), '1 h 00 min');
    assert.equal(formatDuration(33704), '9 h 21 min');
});

// ---------------------------------------------------------------- basemaps & snow URLs

test('basemaps: every definition is complete and consistent', () => {
    for (const [id, b] of Object.entries(BASEMAPS)) {
        assert.equal(b.id, id);
        assert.ok(b.label && b.attribution, `${id}: label and attribution (shown in the video)`);
        assert.ok(b.tiles.length > 0);
        for (const t of b.tiles) {
            assert.ok(t.startsWith('https://'), `${id}: https only`);
            for (const ph of ['{z}', '{x}', '{y}']) assert.ok(t.includes(ph), `${id}: ${ph} in ${t}`);
            assert.equal(t.includes('{apikey}'), !!b.requiresKey, `${id}: {apikey} iff requiresKey`);
        }
        assert.ok([256, 512].includes(b.tileSize) && b.maxzoom >= 10 && b.maxzoom <= 22);
        assert.ok(b.hillshade >= 0 && b.hillshade <= 1);
        assert.ok(['open', 'personal', 'no'].includes(b.sharing!), `${id}: sharing terms are stated`);
        assert.notEqual(b.sharing, 'no', `${id}: built-in basemaps may be exported and shared`);
        assert.ok(!b.requiresKey, `${id}: built-in basemaps work without an API key`);
        // A colour close to the imagery, so a tile still loading looks like haze, not a bright patch.
        assert.match(b.background ?? '', /^#[0-9a-f]{6}$/, `${id}: background colour for gaps`);
        const lum = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).reduce((a, c) => a + c, 0) / 3;
        if (id.includes('satellite') || id.includes('ortofoto') || id.includes('wayback') || id === 'esri-dark') {
            assert.ok(lum(b.background!) < 90, `${id}: dark gaps on dark imagery`);
        } else assert.ok(lum(b.background!) > 180, `${id}: light gaps on a light map`);
        if (b.fallback) {
            assert.ok(BASEMAPS[b.fallback], `${id}: fallback ${b.fallback} exists`);
            assert.ok(!BASEMAPS[b.fallback].requiresKey && !BASEMAPS[b.fallback].fallback, `${id}: fallback needs no key and no chain`);
        }
    }
});

test('basemaps: API keys are inserted (URL-encoded), missing ones give a clear error', () => {
    assert.equal(resolveBasemap('esri-satellite'), BASEMAPS['esri-satellite']);
    assert.throws(() => resolveBasemap('nope'), /Unknown basemap/);
    // A host app's own keyed basemap.
    const keyed = { id: 'k', label: 'S klíčem', tiles: ['https://tiles.example/{z}/{x}/{y}?apikey={apikey}'], tileSize: 256, maxzoom: 18, attribution: '©', hillshade: 0, requiresKey: 'example' };
    assert.throws(() => resolveBasemap(keyed), /needs an API key \(apiKeys\.example\)/);
    assert.throws(() => resolveBasemap(keyed, { example: '' }), /needs an API key/);
    const b = resolveBasemap(keyed, { example: 'a b&c=d' });
    assert.ok(b.tiles[0].endsWith('?apikey=a%20b%26c%3Dd'), b.tiles[0]);
    assert.ok(keyed.tiles[0].includes('{apikey}'), 'the definition passed in is not modified');
    assert.equal(BASEMAPS['mapy-winter'], undefined, 'Mapy.com is not offered: its terms forbid exporting the map');
    for (const id of ['esri-satellite-bw', 'esri-light', 'esri-dark']) assert.ok(BASEMAPS[id], `${id}: black-and-white options`);
    const custom = { id: 'x', label: 'X', tiles: ['https://t/{z}/{x}/{y}'], tileSize: 256, maxzoom: 18, attribution: '©', hillshade: 0 };
    assert.equal(resolveBasemap(custom), custom);
});

test('snow tile URL: survives MapLibre placeholder substitution and round-trips its parameters', () => {
    const src = 'https://tiles.example/v1/aerial/256/{z}/{x}/{y}?apikey=k%26y&lang=cs';
    const url = snowTileUrl(src, { snowline: 900, amount: 0.8 }, 'https://dem/{z}/{x}/{y}.png');
    // MapLibre fills in the outer placeholders; the wrapped template must keep its own.
    const filled = url.replace('{z}', '13').replace('{x}', '4411').replace('{y}', '2800');
    const m = /^flyover-snow:\/\/(\d+)\/(\d+)\/(\d+)\?p=(.+)$/.exec(filled)!;
    assert.deepEqual([m[1], m[2], m[3]], ['13', '4411', '2800']);
    assert.deepEqual(JSON.parse(decodeURIComponent(m[4])), { t: src, d: 'https://dem/{z}/{x}/{y}.png', s: 900, a: 0.8 });
    assert.equal((url.match(/\{[zxy]\}/g) ?? []).length, 3, 'exactly one set of placeholders is visible to MapLibre');
    const everywhere = JSON.parse(decodeURIComponent(/p=(.+)$/.exec(snowTileUrl(src))![1]));
    assert.deepEqual([everywhere.s, everywhere.a], [null, 1]);
});

// ---------------------------------------------------------------- v0.2: profile, marker styles, language

const PROFILE = (() => {
    const n = 50;
    const distance = Float64Array.from({ length: n }, (_, i) => i * 200), elevation = Float64Array.from({ length: n }, (_, i) => 300 + 200 * Math.sin(i / 8));
    return { distance, elevation, min: Math.min(...elevation), max: Math.max(...elevation) };
})();

test('elevation profile: whole route faintly, travelled part filled, a dot at the current position', () => {
    const rect = { x: 100, y: 1000, width: 800, height: 100 };
    const run = (distance: number, profile: HudFrame['profile'] = PROFILE) => {
        const c = fakeCtx();
        drawElevationProfile(c.ctx, frame({ profile, stats: { ...frame().stats, distance } }), rect);
        const dot = c.calls.find(x => x[0] === 'arc') as [string, number, number, number] | undefined;
        const xs = c.calls.filter(x => x[0] === 'lineTo' || x[0] === 'moveTo').map(x => x[1] as number);
        const ys = c.calls.filter(x => x[0] === 'lineTo' || x[0] === 'moveTo').map(x => x[2] as number);
        return { fills: c.calls.filter(x => x[0] === 'fill').length, strokes: c.calls.filter(x => x[0] === 'stroke').length, dot, xs, ys, calls: c.calls.length };
    };
    const mid = run(4900); // half of 9 800 m
    assert.equal(mid.fills, 3, 'ghost, travelled part, dot');
    assert.equal(mid.strokes, 1);
    assert.ok(Math.abs(mid.dot![1] - 500) < 1, `dot at x = ${mid.dot![1]}`);
    assert.ok(mid.xs.every(x => x >= 100 - 1e-9 && x <= 900 + 1e-9) && mid.ys.every(y => y >= 1000 - 1e-9 && y <= 1100 + 1e-9), 'everything inside the rectangle');
    assert.ok(Math.abs(run(0).dot![1] - 100) < 1e-9 && run(0).fills === 2, 'at the start: no travelled part yet');
    assert.ok(Math.abs(run(1e9).dot![1] - 900) < 1e-9, 'past the end: clamped to the finish');
    assert.equal(run(4900, null).calls, 0, 'no elevations → draws nothing');
    assert.equal(run(4900, { ...PROFILE, distance: new Float64Array(1), elevation: new Float64Array(1) }).calls, 0);
    // A flat route still draws (no division by zero).
    const flat = run(4900, { distance: PROFILE.distance, elevation: new Float64Array(50).fill(200), min: 200, max: 200 });
    assert.ok(flat.ys.every(Number.isFinite) && flat.fills === 3);
});

test('built-in panel: profile on request, texts in the chosen language, decimal comma in Czech', () => {
    const texts = (over: Partial<HudFrame>) => { const c = fakeCtx(); drawDefaultHud(c.ctx, frame(over)); return { t: c.texts(), arcs: c.calls.filter(x => x[0] === 'arc').length }; };
    const en = texts({});
    assert.ok(en.t.includes('12.3 km') && en.t.includes('distance') && en.t.includes('ascent') && en.t.includes('moving time'), en.t.join(' | '));
    const cs = texts({ strings: STRINGS.cs });
    assert.ok(cs.t.includes('12,3 km') && cs.t.includes('vzdálenost') && cs.t.includes('stoupání') && cs.t.includes('čas v pohybu'), cs.t.join(' | '));
    const custom = texts({ strings: resolveStrings('en', { distance: 'Strecke', decimal: ',' }) });
    assert.ok(custom.t.includes('Strecke') && custom.t.includes('12,3 km') && custom.t.includes('ascent'));
    assert.equal(texts({ showProfile: false, profile: PROFILE }).arcs, 0);
    assert.equal(texts({ showProfile: true, profile: PROFILE }).arcs, 1, 'profile drawn (its position dot)');
    assert.equal(texts({ showProfile: true, profile: null }).arcs, 0, 'asked for, but the track has no elevations');
    assert.equal(formatDistance(12345, ','), '12,3 km');
    assert.equal(formatDistance(850, ','), '850 m');
    assert.equal(formatDistance(1234), '1.23 km');
});

test('labels: own colour and icon per label; label-free bands follow the app\'s panels', () => {
    const { ctx, calls } = fakeCtx();
    drawLabels(ctx, [
        { ...label('Sněžka', 14, 49, 100, 'peak'), color: '#f97316', icon: '▲', priority: 5 },
        { ...label('Den 1', 14.02, 49, 200), color: 'rgb(99, 102, 241)', icon: '⛺' },
        label('Obyčejná', 13.98, 49.01, 300),
    ], frame(), 5000);
    const texts = calls.filter(c => c[0] === 'fillText').map(c => c[1]);
    assert.deepEqual(texts, ['▲ Sněžka', '⛺ Den 1', 'Obyčejná']);
    const fills = calls.filter(c => c[0] === 'set:fillStyle').map(c => c[1]);
    for (const colour of ['#f97316', 'rgb(99, 102, 241)', '#ff7a1a']) assert.ok(fills.includes(colour), `${colour} used for a dot`);
    // A place 300 px from the bottom is fine with the default panel, hidden when the app's panel is taller.
    const low = [label('Dole', 14, 49 - (1050 - 675) / 20000, 100)];
    assert.deepEqual(Object.keys(drawn(low, frame(), 5000)), ['Dole']);
    assert.deepEqual(Object.keys(drawn(low, frame(), 5000, { bands: { bottom: 0.3 } })), []);
    const high = [label('Nahoře', 14, 49 + (675 - 200) / 20000, 100)];
    assert.deepEqual(Object.keys(drawn(high, frame(), 5000)), ['Nahoře']);
    assert.deepEqual(Object.keys(drawn(high, frame(), 5000, { bands: { top: 0.2 } })), []);
});
