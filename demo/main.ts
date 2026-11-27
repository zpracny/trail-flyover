import * as maplibregl from 'maplibre-gl';
import {
    TrailFlyover, parseGpx, BASEMAPS, LABEL_REACH, fetchPlaceLabels, formatDistance,
    type TrackPoint, type FlyoverLabel, type PresetId, type VideoFormat,
} from '../src/index.ts';

const OUTPUTS = {
    story: { width: 1080, height: 1920 },
    feed: { width: 1080, height: 1350 },
    wide: { width: 1920, height: 1080 },
} as const;
type Aspect = keyof typeof OUTPUTS;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $('stage');

const state = {
    aspect: 'feed' as Aspect,
    mode: '3d' as '3d' | '2d',
    camera: 'follow' as 'follow' | 'static',
    /** Multiplier of the default per-kind distance a place may be from the track. */
    reach: 1,
    snow: false,
    snowline: 0,
    basemap: 'esri-satellite',
    preset: 'drone' as PresetId,
    duration: 0,
    exaggeration: 1.4,
    labelsOn: true,
    ghost: true,
    points: [] as TrackPoint[],
    name: '',
    subtitle: '',
    labels: [] as FlyoverLabel[],
    /** Named waypoints from the GPX itself — always available, no network. */
    waypoints: [] as FlyoverLabel[],
    gpxUrl: '' as string,
};

let fly: TrailFlyover | null = null;
let abort: AbortController | null = null;

// ---------------------------------------------------------------- UI helpers

function status(msg: string, progress?: number) {
    $('status').textContent = msg;
    if (progress !== undefined) $('progress').style.width = `${Math.round(progress * 100)}%`;
}

function setPressed(groupId: string, value: string) {
    for (const b of $(groupId).querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === value));
}

/** During export/prefetch every control is locked (the player rejects changes then); only Cancel works. */
function setBusy(b: boolean) {
    for (const el of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('aside select, aside input, aside button, .bar button, .bar input')) {
        el.disabled = el.id === 'cancel' ? !b : b;
    }
}

/** Applies an option change; problems (missing API key, export running) go to the status line. */
async function apply(patch: Parameters<TrailFlyover['update']>[0]) {
    try {
        await fly?.update(patch);
        renderMeta();
    } catch (err) {
        status(`Chyba: ${(err as Error).message}`);
    }
}

function snowOptions() {
    return state.snow ? { snowline: state.snowline || null } : false;
}

function flightOptions() {
    return { preset: state.preset, duration: state.duration || undefined, camera: state.camera };
}

function labelReach() {
    return Object.fromEntries(Object.entries(LABEL_REACH).map(([kind, m]) => [kind, m * state.reach]));
}

function renderMeta() {
    const plan = fly?.flightPlan;
    if (!plan) return;
    const m = plan.meta;
    const rows: Array<[string, string, string?]> = [
        ['Délka trasy', formatDistance(plan.length)],
        ['Video', `${plan.duration.toFixed(1)} s (úvod ${m.intro.toFixed(1)} s, závěr ${m.outro.toFixed(1)} s)`],
        ['Kamera', `${m.camera === 'static' ? 'stojí, ' : ''}${(m.range / 1000).toFixed(1)} km od cíle, náklon ${Math.round(m.pitch)}°`],
        ['Rychlost', `${Math.round(m.followSpeed * 3.6).toLocaleString('cs-CZ')} km/h nad terénem`],
        ['Názvy míst', `${fly!.labelCount} na trase`],
        ['Výstup', `${fly!.output.width}×${fly!.output.height}`],
        ['Plynulost', '— (přehraj)', 'fps'],
    ];
    // Built as elements with textContent: nothing here is ever parsed as HTML.
    $('meta').replaceChildren(...rows.flatMap(([k, v, id]) => {
        const key = document.createElement('span');
        key.textContent = k;
        const value = document.createElement('span');
        value.textContent = v;
        if (id) value.id = id;
        return [key, value];
    }));
}

// ---------------------------------------------------------------- frame pacing meter

const pacing = { last: 0, deltas: [] as number[] };
function recordFrame() {
    const now = performance.now();
    if (pacing.last) pacing.deltas.push(now - pacing.last);
    pacing.last = now;
}
function reportPacing() {
    const d = pacing.deltas.slice(5); // skip warm-up
    if (d.length < 10) return;
    const sorted = [...d].sort((a, b) => a - b);
    const avg = d.reduce((a, b) => a + b, 0) / d.length;
    const p95 = sorted[Math.floor(d.length * 0.95)];
    const long = d.filter(x => x > 25).length;
    const text = `${(1000 / avg).toFixed(0)} fps · p95 ${p95.toFixed(1)} ms · záseky ${long}/${d.length}`;
    const el = document.getElementById('fps');
    if (el) el.textContent = text;
    (window as unknown as { __pacing: unknown }).__pacing = { avgFps: 1000 / avg, p95, long, frames: d.length };
}

// ---------------------------------------------------------------- player lifecycle

async function createPlayer() {
    abort?.abort();
    fly?.destroy();
    stage.replaceChildren();
    status('Připravuji…', 0);
    const player = new TrailFlyover(stage, {
        maplibregl,
        output: OUTPUTS[state.aspect],
        basemap: state.basemap,
        exaggeration: state.exaggeration,
        flight: flightOptions(),
        labels: state.labelsOn ? state.labels : [],
        labelReach: labelReach(),
        ghostTrail: state.ghost,
        mode: state.mode,
        snow: snowOptions(),
        maxTileCacheSize: Number(new URLSearchParams(location.search).get('cache')) || undefined,
    });
    fly = player;
    (window as unknown as { __fly: TrailFlyover }).__fly = player;
    player.on('time', t => {
        const d = player.duration;
        $('time').textContent = `${t.toFixed(1)} / ${d.toFixed(1)} s`;
        ($('scrub') as HTMLInputElement).value = String(d ? Math.round((t / d) * 1000) : 0);
        if (player.isPlaying) recordFrame();
    });
    player.on('state', s => {
        $('play').textContent = s === 'playing' ? '⏸ Pauza' : '▶ Přehrát';
        if (s === 'playing') { pacing.last = 0; pacing.deltas = []; }
        if (s === 'paused' || s === 'ended') reportPacing();
    });
    player.on('status', s => status(s));
    await player.load(state.points, { title: state.name, subtitle: state.subtitle });
    if (player !== fly) return; // replaced by a newer player while loading (aspect switched, new GPX)
    renderMeta();
    status('Připraveno. Tip: „Přednačíst“ před přehráním = bez děr v mapě.', 0);
}

async function loadGpxText(text: string, fallbackName: string) {
    const gpx = parseGpx(text);
    if (gpx.points.length < 2) throw new Error('GPX neobsahuje trasu.');
    state.points = gpx.points;
    state.waypoints = gpx.waypoints.map(w => ({ ...w, kind: 'waypoint' }));
    state.name = gpx.name ?? fallbackName;
    const t0 = gpx.points.find(p => p.time)?.time;
    state.subtitle = t0 ? new Date(t0).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    $('trackInfo').textContent = `${state.name} · ${gpx.points.length.toLocaleString('cs-CZ')} bodů`;
    state.labels = state.waypoints;
    await createPlayer();
    if (state.labelsOn) void loadLabels();
}

let labelRun = 0;
async function loadLabels() {
    const run = ++labelRun; // a newer track or request wins; late answers for an old track are dropped
    try {
        status('Hledám názvy obcí…');
        // Precomputed labels next to the GPX (e.g. tolmin.places.json), otherwise OpenStreetMap/Overpass.
        const local = state.gpxUrl ? await fetch(state.gpxUrl.replace(/\.gpx$/i, '.places.json')).catch(() => null) : null;
        const places: FlyoverLabel[] = local?.ok ? await local.json() : await fetchPlaceLabels(state.points);
        if (run !== labelRun) return;
        state.labels = [...state.waypoints, ...places];
        await apply({ labels: state.labelsOn ? state.labels : [] });
        status(`Názvy míst: ${fly?.labelCount ?? 0} na trase (z ${state.labels.length} v okolí)`);
    } catch (err) {
        if (run === labelRun) status(`Názvy míst se nepodařilo načíst (${(err as Error).message}).`);
    }
}

// ---------------------------------------------------------------- export

async function saveBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.textContent = `⬇ ${filename} (${(blob.size / 1e6).toFixed(1)} MB)`;
    $('downloads').prepend(a);
    // Dev server (scripts/devserver.py) can store results next to the project.
    if (new URLSearchParams(location.search).has('save')) {
        await fetch(`/save/${encodeURIComponent(filename)}`, { method: 'PUT', body: blob });
    }
}

function slug() {
    return (state.name || 'trasa').normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'trasa';
}

async function runExport(kind: VideoFormat | 'png') {
    if (!fly) return;
    abort = new AbortController();
    setBusy(true);
    const started = performance.now();
    try {
        if (kind === 'png') {
            status('Renderuji fotku…');
            await saveBlob(await fly.exportImage(), `${slug()}-${state.aspect}.png`);
            status('Fotka hotová.', 1);
        } else {
            const video = await fly.exportVideo({
                format: kind,
                signal: abort.signal,
                onProgress: f => status(`Renderuji video… ${Math.round(f * 100)} %`, f),
            });
            await saveBlob(video.blob, `${slug()}-${state.aspect}.${video.extension}`);
            const secs = ((performance.now() - started) / 1000).toFixed(0);
            status(`Video hotové za ${secs} s (${video.codec.toUpperCase()}).`, 1);
            (window as unknown as { __lastExport: unknown }).__lastExport = { size: video.blob.size, codec: video.codec, secs };
        }
    } catch (err) {
        status((err as Error).name === 'AbortError' ? 'Zrušeno.' : `Chyba: ${(err as Error).message}`, 0);
        console.error(err);
    } finally {
        setBusy(false);
        abort = null;
    }
}

// ---------------------------------------------------------------- wiring

const bmSelect = $('basemap') as HTMLSelectElement;
for (const b of Object.values(BASEMAPS)) bmSelect.add(new Option(b.label, b.id));
bmSelect.value = state.basemap;
const showBasemapHint = () => {
    const b = BASEMAPS[state.basemap];
    const sharing = {
        open: 'Sdílení videa: volná licence, stačí uvést zdroj (je ve videu).',
        personal: 'Sdílení videa: pro osobní, nevýdělečné příspěvky v pořádku (zdroj je ve videu).',
        no: '⚠️ Podmínky poskytovatele nedovolují mapu exportovat a sdílet mimo aplikaci.',
    }[b.sharing ?? 'personal'];
    $('basemapHint').textContent = `${b.coverage ? `Pokrytí: ${b.coverage}. ` : ''}${sharing}`;
};
showBasemapHint();

bmSelect.onchange = async () => {
    state.basemap = bmSelect.value;
    showBasemapHint();
    await apply({ basemap: state.basemap });
};

$('aspect').onclick = async e => {
    const v = (e.target as HTMLElement).closest('button')?.dataset.v as Aspect | undefined;
    if (!v || v === state.aspect) return;
    state.aspect = v;
    setPressed('aspect', v);
    await createPlayer();
};
$('mode').onclick = async e => {
    const v = (e.target as HTMLElement).closest('button')?.dataset.v as '3d' | '2d' | undefined;
    if (!v || v === state.mode) return;
    state.mode = v;
    setPressed('mode', v);
    dimPreset();
    await apply({ mode: v });
};
/** Camera style presets only apply to a flying 3D camera. */
function dimPreset() {
    ($('preset') as HTMLElement).style.opacity = state.mode === '2d' || state.camera === 'static' ? '0.4' : '1';
}
$('camera').onclick = async e => {
    const v = (e.target as HTMLElement).closest('button')?.dataset.v as 'follow' | 'static' | undefined;
    if (!v || v === state.camera) return;
    state.camera = v;
    setPressed('camera', v);
    dimPreset();
    await apply({ flight: flightOptions() });
};
($('reach') as HTMLInputElement).oninput = e => {
    state.reach = Number((e.target as HTMLInputElement).value) / 100;
    $('reachLabel').textContent = `vesnice do ${Math.round(LABEL_REACH.village * state.reach)} m`;
};
($('reach') as HTMLInputElement).onchange = async () => {
    await apply({ labelReach: labelReach() });
    status(`Názvy míst: ${fly?.labelCount ?? 0} na trase (z ${state.labels.length} v okolí)`);
};
($('snow') as HTMLInputElement).onchange = async e => {
    state.snow = (e.target as HTMLInputElement).checked;
    $('snowBox').hidden = !state.snow;
    await apply({ snow: snowOptions() });
};
($('snowline') as HTMLInputElement).oninput = e => {
    state.snowline = Number((e.target as HTMLInputElement).value);
    $('snowlineLabel').textContent = state.snowline ? `${state.snowline} m n. m.` : 'všude';
};
($('snowline') as HTMLInputElement).onchange = async () => {
    await apply({ snow: snowOptions() });
};
($('sample') as HTMLSelectElement).onchange = e => loadSample((e.target as HTMLSelectElement).value);
$('preset').onclick = async e => {
    const v = (e.target as HTMLElement).closest('button')?.dataset.v as PresetId | undefined;
    if (!v) return;
    state.preset = v;
    setPressed('preset', v);
    await apply({ flight: flightOptions() });
};
($('duration') as HTMLInputElement).oninput = e => {
    state.duration = Number((e.target as HTMLInputElement).value);
    $('durLabel').textContent = state.duration ? `${state.duration} s` : 'auto';
};
($('duration') as HTMLInputElement).onchange = async () => {
    await apply({ flight: flightOptions() });
};
($('exaggeration') as HTMLInputElement).oninput = e => {
    state.exaggeration = Number((e.target as HTMLInputElement).value);
    $('exLabel').textContent = `${state.exaggeration.toFixed(1)}×`;
};
($('exaggeration') as HTMLInputElement).onchange = async () => {
    await apply({ exaggeration: state.exaggeration });
};
($('labels') as HTMLInputElement).onchange = async e => {
    state.labelsOn = (e.target as HTMLInputElement).checked;
    if (state.labelsOn && state.labels.length === state.waypoints.length) await loadLabels();
    else await apply({ labels: state.labelsOn ? state.labels : [] });
};
($('ghost') as HTMLInputElement).onchange = async e => {
    state.ghost = (e.target as HTMLInputElement).checked;
    await apply({ ghostTrail: state.ghost });
};

$('play').onclick = () => fly?.toggle();
($('scrub') as HTMLInputElement).oninput = e => {
    if (!fly) return;
    fly.pause();
    fly.seek((Number((e.target as HTMLInputElement).value) / 1000) * fly.duration);
};
$('openGpx').onclick = () => $('gpx').click();
($('gpx') as HTMLInputElement).onchange = async e => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    state.gpxUrl = '';
    await loadGpxText(await f.text(), f.name.replace(/\.gpx$/i, '')).catch(err => status(`Chyba: ${err.message}`));
};
$('prefetch').onclick = async () => {
    if (!fly) return;
    abort = new AbortController();
    setBusy(true);
    try {
        await fly.prefetch(f => status(`Přednačítám dlaždice… ${Math.round(f * 100)} %`, f), abort.signal);
        status('Dlaždice načtené — přehrávání poběží z mezipaměti.', 1);
    } catch (err) {
        status((err as Error).name === 'AbortError' ? 'Zrušeno.' : `Chyba: ${(err as Error).message}`);
    } finally {
        setBusy(false);
    }
};
$('exportMp4').onclick = () => runExport('mp4');
$('exportWebm').onclick = () => runExport('webm');
$('exportPng').onclick = () => runExport('png');
$('cancel').onclick = () => abort?.abort();
addEventListener('keydown', e => {
    if (e.code === 'Space' && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); fly?.toggle(); }
});

// Default track (?gpx=… or the sample selector)
/**
 * Only files from this demo's own server: `?gpx=` must not make the page fetch from elsewhere
 * (a link could otherwise load someone else's file and its place names into the demo).
 */
function sameOriginPath(value: string | null): string | null {
    if (!value) return null;
    try {
        const u = new URL(value, location.href);
        return u.origin === location.origin && /\.gpx$/i.test(u.pathname) ? u.pathname.replace(/^\//, '') : null;
    } catch {
        return null;
    }
}

function loadSample(url: string) {
    return fetch(url)
        .then(r => (r.ok ? r.text() : Promise.reject(new Error(`${url}: HTTP ${r.status}`))))
        .then(t => { state.gpxUrl = url; return loadGpxText(t, 'Trasa'); })
        .catch(err => status(`Chyba: ${err.message}`));
}
const requested = new URLSearchParams(location.search).get('gpx');
const gpxParam = sameOriginPath(requested) ?? 'tolmin.gpx';
if (requested && !sameOriginPath(requested)) status('Parametr ?gpx= přijímá jen soubory .gpx z tohoto serveru.');
($('sample') as HTMLSelectElement).value = gpxParam;
void loadSample(gpxParam);
