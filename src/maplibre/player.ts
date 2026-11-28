/**
 * TrailFlyover — framework-agnostic 3D fly-over player on MapLibre GL.
 *
 *   const fly = new TrailFlyover(container, { maplibregl });
 *   await fly.load(points, { title: 'Šindlov – Nové Hutě' });
 *   fly.play();
 *   const video = await fly.exportVideo({ format: 'mp4' });
 *
 * Render model: one requestAnimationFrame loop owned by the player. Each frame
 * it sets the camera from the precomputed flight plan, updates the trail via
 * feature-state (synchronous, no worker round trip) and calls `map.redraw()`,
 * which paints immediately. The HUD is drawn right after, from the same camera,
 * so map and overlay can never drift apart.
 */
import type * as MapLibre from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import { buildFlightPlan, type FlightOptions, type FlightPlan, type CameraPose } from '../core/flightPlan.ts';
import { loadTerrariumSampler, expandBBox, TERRARIUM_URL } from '../core/terrarium.ts';
import type { TrackPoint } from '../core/geo.ts';
import { resolveBasemap, BASEMAPS, type BasemapDef } from './basemaps.ts';
import {
    drawDefaultHud, drawLabels, drawTip, placeLabelsOnTrack, thinLabels, markEndpointLabels,
    type HudFrame, type FlyoverLabel, type LabelReach, type PlacedLabel, type ScreenPoint,
} from '../hud/hud.ts';
import { encodeVideo, type VideoFormat, type EncodedVideo } from '../export/encode.ts';
import { registerSnowProtocol, snowTileUrl, type SnowOptions } from '../effects/snow.ts';
import { errorText } from '../core/urls.ts';
import { resolveStrings, type Locale, type Strings } from '../core/i18n.ts';

type MapLibreGL = typeof MapLibre;

export type HudRenderer = (ctx: CanvasRenderingContext2D, frame: HudFrame) => void;

export interface TrailFlyoverOptions {
    /** The app's own maplibre-gl module (avoids bundling a second copy). */
    maplibregl: MapLibreGL;
    /** Output video size in pixels. Default 1080×1350 (4:5 feed). */
    output?: { width: number; height: number };
    /** CSS px → output px. The map is laid out at output / pixelRatio. Default 1.5. */
    pixelRatio?: number;
    basemap?: string | BasemapDef;
    apiKeys?: Record<string, string | undefined>;
    /**
     * '3d' = terrain, sky and tilted camera (default).
     * '2d' = flat map seen from above (north-up by default); same smooth camera and export.
     */
    mode?: '3d' | '2d';
    /** Terrain exaggeration (3D). Default 1.4. */
    exaggeration?: number;
    /** Winter filter: snow-covered look on any basemap. false/undefined = off. */
    snow?: false | SnowOptions;
    /** Hillshade 0–1; null = basemap default. */
    hillshade?: number | null;
    flight?: Omit<FlightOptions, 'terrain' | 'aspect' | 'exaggeration'>;
    /**
     * Place names. Only places the track really passes are shown (see `labelReach`), and each
     * appears at the moment the trail reaches it.
     */
    labels?: FlyoverLabel[];
    /**
     * How close (m) the track must come to a place for its name to be shown: one number for all,
     * or per kind, e.g. `{ village: 800 }`. Default LABEL_REACH: town 1000, village 400, hamlet 250, peak 250…
     */
    labelReach?: LabelReach;
    /**
     * Shortest time (s of video) between two names appearing; where places come faster, the less
     * important ones are left out (towns always stay). Default 0.6, 0 = show all.
     */
    labelMinGap?: number;
    /**
     * Always show the places the ride starts and ends in — in the overviews too, even when they are
     * villages or hamlets: the nearest settlement within `endpointRadius` (m, default 3000) of
     * each end of the track. Default true.
     */
    keepEndpointLabels?: boolean;
    /**
     * Seconds before the trail reaches a place that its name starts to appear (following camera).
     * The camera leaves a passed place behind within a fraction of a second, so a name is read
     * while the place is still ahead. Default 1.2: at least about 1.2 s to read every name, also
     * with a tall bottom panel; 0 = appear exactly as the trail arrives.
     */
    labelLead?: number;
    /**
     * Size of the place-name pills relative to the default (32 px bold text at 1080 px output
     * width, readable when the video plays on a phone). Default 1.
     */
    labelSize?: number;
    endpointRadius?: number;
    colors?: { trail?: string; casing?: string; ghost?: string; accent?: string };
    /** Show the remaining route faintly ahead of the tip. Default true. */
    ghostTrail?: boolean;
    /**
     * Elevation profile in the built-in panel, above the stats. Default false. With your own
     * `hud`, draw it yourself with `drawElevationProfile(ctx, f, rect)`.
     */
    elevationProfile?: boolean;
    /** Language of the built-in panel and of status messages: 'en' (default) or 'cs'. */
    locale?: Locale;
    /** Your own texts, on top of the locale's (see `Strings`). */
    strings?: Partial<Strings>;
    /** Overlay panel (title, stats). false = none, function = your own. Default built-in. */
    hud?: false | HudRenderer;
    terrainUrl?: string;
    /**
     * Pixel ratio for on-screen preview. Default: just enough for the size the stage is
     * displayed at (it is usually scaled down), so the preview renders far fewer pixels.
     * Export always renders at full output resolution.
     */
    previewPixelRatio?: number | 'auto';
    /**
     * While a video or image is exported, or tiles are prefetched, the map underneath has to jump
     * from frame to frame (waiting for tiles), which looks jerky. By default the picture from the
     * moment the job started is shown instead, still, until it finishes. `false` shows the work live.
     */
    stillWhileBusy?: boolean;
    /** Max tiles kept per source in MapLibre's cache (prefetch reuses them). ~256 kB GPU memory each. Default 350 + 8 per km, max 1500. */
    maxTileCacheSize?: number;
}

export interface LoadMeta {
    title?: string;
    subtitle?: string;
}

export interface ExportOptions {
    format?: VideoFormat;
    fps?: number;
    onProgress?(fraction: number): void;
    signal?: AbortSignal;
    bitrate?: number;
}

/**
 * Where the time of an export went (all in ms, summed over frames). Useful to tell a slow
 * network from a slow encoder: `tiles` large → waiting for tiles; `encode` large → the video
 * encoder is the limit (e.g. no hardware encoding).
 */
export interface ExportStats {
    frames: number;
    /** Wall-clock time of the whole export. */
    total: number;
    /** Waiting for map tiles (network and tile decoding in MapLibre's workers). */
    tiles: number;
    /** Rendering the map (synchronous redraws). */
    render: number;
    /** Drawing the overlay and copying the picture into the video frame. */
    overlay: number;
    /** Waiting for the video encoder (backpressure) and finishing the file. */
    encode: number;
    /** Map tiles that arrived during the export. */
    tilesLoaded: number;
    /** Frames that gave up waiting for tiles (drawn with whatever had arrived). */
    timeouts: number;
}

/** Accumulates the time of one export (see ExportStats). */
interface SettleStats { tiles: number; render: number; }

type EventMap = {
    time: number;
    state: 'idle' | 'playing' | 'paused' | 'ended' | 'busy';
    status: string;
};

const DEFAULT_COLORS = { trail: '#ff7a1a', casing: '#4a2200', ghost: '#ffffff', accent: '#ff7a1a' };

/**
 * setTimeout started from a fresh task (a MessageChannel message), not from inside the previous
 * timer: browsers throttle *chained* timers in background tabs to once a minute after a few
 * minutes; a plain timer is throttled to about once a second only.
 */
function unchainedTimeout(ms: number, cb: () => void, started: (t: ReturnType<typeof setTimeout>) => void) {
    if (typeof MessageChannel === 'undefined') return started(setTimeout(cb, ms));
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); started(setTimeout(cb, ms)); };
    ch.port2.postMessage(null);
}

export class TrailFlyover {
    readonly output: { width: number; height: number };
    readonly pixelRatio: number;
    private readonly ml: MapLibreGL;
    private opts: TrailFlyoverOptions;
    private container: HTMLElement;
    private stage: HTMLDivElement;
    private mapDiv: HTMLDivElement;
    private hudCanvas: HTMLCanvasElement;
    private hudCtx: CanvasRenderingContext2D;
    private resizeObs: ResizeObserver;
    /** Still picture over the map while an export or prefetch runs (see `stillWhileBusy`). */
    private still: HTMLCanvasElement | null = null;
    private map: MapLibre.Map | null = null;
    private basemap: BasemapDef;
    private plan: FlightPlan | null = null;
    private points: TrackPoint[] = [];
    private meta: Required<LoadMeta> = { title: '', subtitle: '' };
    private labels: PlacedLabel[] = [];
    private segEnd: Float64Array = new Float64Array(0);
    private segStartIdx: Int32Array = new Int32Array(0);
    private segOn = 0;
    private t = 0;
    private playing = false;
    private busy = false;
    private raf = 0;
    private playWall = 0;
    private displayScale = 1;
    private playT = 0;
    private destroyed = false;
    /** Bumped by every load/update that rebuilds the plan; a rebuild that is no longer the latest stops. */
    private gen = 0;
    /** load() and update() run one after another, never interleaved. */
    private queue: Promise<void> = Promise.resolve();
    private loadAbort: AbortController | null = null;
    private listeners: { [K in keyof EventMap]?: Set<(v: EventMap[K]) => void> } = {};

    constructor(container: HTMLElement, opts: TrailFlyoverOptions) {
        this.ml = opts.maplibregl;
        this.opts = opts;
        this.container = container;
        this.output = opts.output ?? { width: 1080, height: 1350 };
        this.pixelRatio = opts.pixelRatio ?? 1.5;
        this.basemap = resolveBasemap(opts.basemap ?? 'esri-satellite', opts.apiKeys);
        registerSnowProtocol(this.ml);

        const cssW = Math.round(this.output.width / this.pixelRatio);
        const cssH = Math.round(this.output.height / this.pixelRatio);
        if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
        container.style.overflow = 'hidden';
        this.stage = document.createElement('div');
        Object.assign(this.stage.style, {
            position: 'absolute', left: '0', top: '0', width: `${cssW}px`, height: `${cssH}px`, transformOrigin: '0 0',
        });
        this.mapDiv = document.createElement('div');
        Object.assign(this.mapDiv.style, { position: 'absolute', inset: '0' });
        this.hudCanvas = document.createElement('canvas');
        this.hudCanvas.width = this.output.width;
        this.hudCanvas.height = this.output.height;
        Object.assign(this.hudCanvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' });
        this.hudCtx = this.hudCanvas.getContext('2d')!;
        this.stage.append(this.mapDiv, this.hudCanvas);
        container.append(this.stage);

        // Fit the fixed-size stage into the container (preview = exact output framing).
        this.resizeObs = new ResizeObserver(() => this.fitStage());
        this.resizeObs.observe(container);
        this.fitStage();
    }

    // ---------------------------------------------------------------- public

    get duration() {
        return this.plan?.duration ?? 0;
    }

    get currentTime() {
        return this.t;
    }

    get isPlaying() {
        return this.playing;
    }

    get flightPlan() {
        return this.plan;
    }

    on<K extends keyof EventMap>(type: K, fn: (v: EventMap[K]) => void): () => void {
        const all = this.listeners as Record<string, Set<(v: unknown) => void> | undefined>;
        all[type] ??= new Set();
        const set = all[type];
        set.add(fn as (v: unknown) => void);
        return () => set.delete(fn as (v: unknown) => void);
    }

    /**
     * Loads a track, builds the flight plan (incl. DEM) and shows the first frame.
     * Calls may overlap (fast UI, React effects): they run in order and only the latest
     * track is built; an older call resolves without doing the work.
     */
    async load(points: TrackPoint[], meta: LoadMeta = {}) {
        this.assertIdle();
        this.pause();
        this.points = points;
        this.meta = { title: meta.title ?? '', subtitle: meta.subtitle ?? '' };
        const gen = ++this.gen;
        await this.enqueue(() => this.rebuild(gen));
    }

    /** Changes options (basemap, camera, labels…) and re-renders. Safe to call while load() is still running. */
    async update(patch: Partial<Omit<TrailFlyoverOptions, 'maplibregl' | 'output' | 'pixelRatio'>>) {
        this.assertIdle();
        const next = { ...this.opts, ...patch, flight: { ...this.opts.flight, ...patch.flight } };
        const styleChanged = patch.basemap !== undefined || patch.apiKeys !== undefined || patch.snow !== undefined;
        // Validate first (unknown basemap, missing API key) so a rejected update changes nothing.
        const basemap = styleChanged ? resolveBasemap(next.basemap ?? 'esri-satellite', next.apiKeys) : this.basemap;
        this.opts = next;
        this.basemap = basemap;
        const needsPlan = patch.flight !== undefined || patch.exaggeration !== undefined || patch.mode !== undefined
            || 'elevationProfile' in patch || 'hud' in patch;
        // `in`, not `!== undefined`: passing undefined resets the option to its default.
        const needsLabels = 'labels' in patch || 'labelReach' in patch || 'labelMinGap' in patch
            || 'keepEndpointLabels' in patch || 'endpointRadius' in patch;
        const gen = needsPlan && this.points.length ? ++this.gen : this.gen;
        await this.enqueue(async () => {
            if (this.destroyed) return;
            if (this.map) {
                if (styleChanged) {
                    this.swapBasemap();
                    this.map.setSky(this.sky());
                }
                if (patch.hillshade !== undefined || patch.basemap !== undefined) this.applyHillshade();
                if (patch.colors !== undefined || patch.ghostTrail !== undefined) this.applyTrailPaint();
                if (patch.mode !== undefined) this.applyMode();
            }
            if (needsPlan && this.points.length) {
                const wasPlaying = this.playing;
                const frac = this.duration ? this.t / this.duration : 0;
                this.pause();
                await this.rebuild(gen, frac);
                if (wasPlaying && gen === this.gen && !this.destroyed) this.play();
            } else if (needsLabels) {
                this.placeLabels();
                this.renderFrame(this.t);
            } else {
                this.renderFrame(this.t);
            }
        });
    }

    play() {
        if (!this.plan || !this.map || this.busy || this.destroyed) return;
        if (this.t >= this.duration - 1e-3) this.seek(0);
        this.playing = true;
        this.playWall = performance.now();
        this.playT = this.t;
        this.emit('state', 'playing');
        cancelAnimationFrame(this.raf);
        this.raf = requestAnimationFrame(this.loop);
    }

    pause() {
        if (!this.playing) return;
        this.playing = false;
        cancelAnimationFrame(this.raf);
        this.emit('state', 'paused');
    }

    toggle() {
        if (this.playing) this.pause();
        else this.play();
    }

    seek(t: number) {
        // Not during export/prefetch: they own the camera until they finish.
        if (!this.plan || this.busy || this.destroyed) return;
        this.t = Math.max(0, Math.min(this.duration, t));
        if (this.playing) {
            this.playWall = performance.now();
            this.playT = this.t;
        }
        this.renderFrame(this.t);
        this.emit('time', this.t);
    }

    /**
     * Flies through the whole route once (without drawing) and waits for tiles,
     * so real-time playback afterwards runs from the tile cache without holes.
     */
    async prefetch(onProgress?: (f: number) => void, signal?: AbortSignal) {
        this.claim();
        let back = this.t;
        try {
            await this.queue;
            const plan = this.requirePlan();
            this.pause();
            back = this.t;
            this.showStill();
            this.setBusy(true, this.strings().statusTiles);
            const dt = Math.min(1, Math.max(0.2, (plan.meta.range * 0.45) / plan.meta.followSpeed));
            const times: number[] = [];
            // A static camera sees the same tiles the whole time.
            if (plan.meta.camera === 'follow') for (let t = 0; t < plan.duration; t += dt) times.push(t);
            times.push(plan.duration);
            for (let i = 0; i < times.length; i++) {
                if (signal?.aborted || this.destroyed) throw new DOMException('Cancelled', 'AbortError');
                this.applyCamera(times[i]);
                await this.settle(5000);
                onProgress?.((i + 1) / times.length);
            }
        } finally {
            this.release(back);
        }
    }

    /** Renders the fly-over frame by frame (waiting for all tiles) and encodes MP4/WebM. */
    async exportVideo(o: ExportOptions = {}): Promise<EncodedVideo & { stats: ExportStats }> {
        this.claim();
        let back = this.t;
        try {
            await this.queue;
            const plan = this.requirePlan();
            this.pause();
            const fps = o.fps ?? 30;
            if (!(fps >= 1 && fps <= 120)) throw new Error(`Invalid frame rate: ${fps} (allowed 1–120)`);
            back = this.t;
            this.showStill();
            this.setBusy(true, this.strings().statusVideo, true);
            const t0 = performance.now();
            const st = { tiles: 0, render: 0, overlay: 0, tilesLoaded: 0, timeouts: 0 };
            const map = this.map!;
            const onData = (e: object) => { if ('tile' in e && e.tile) st.tilesLoaded++; };
            map.on('data', onData);
            let slowFrames = 0;
            try {
                const video = await encodeVideo({
                    format: o.format ?? 'mp4',
                    width: this.output.width,
                    height: this.output.height,
                    fps,
                    frameCount: Math.round(plan.duration * fps) + 1,
                    bitrate: o.bitrate,
                    signal: o.signal,
                    onProgress: o.onProgress,
                    drawFrame: async (i, ctx) => {
                        if (this.destroyed) throw new DOMException('The player was destroyed', 'AbortError');
                        const t = Math.min(plan.duration, i / fps);
                        this.t = t;
                        const pose = this.applyCamera(t);
                        this.updateSegments(plan.distanceAt(t));
                        // Budget like a render farm: patient at first, faster if the network is slow.
                        // settle() ends with a fresh redraw of exactly this camera.
                        const ok = await this.settle(slowFrames > 3 ? 1500 : 6000, st);
                        if (!ok) { slowFrames++; st.timeouts++; }
                        if (this.destroyed) throw new DOMException('The player was destroyed', 'AbortError');
                        const d0 = performance.now();
                        this.drawHud(t, pose);
                        ctx.drawImage(map.getCanvas(), 0, 0, this.output.width, this.output.height);
                        ctx.drawImage(this.hudCanvas, 0, 0);
                        st.overlay += performance.now() - d0;
                        this.emit('time', t);
                    },
                });
                const r = (x: number) => Math.round(x);
                const stats: ExportStats = {
                    frames: video.frames,
                    total: r(performance.now() - t0),
                    tiles: r(st.tiles),
                    render: r(st.render),
                    overlay: r(st.overlay),
                    encode: r(video.encodeWait),
                    tilesLoaded: st.tilesLoaded,
                    timeouts: st.timeouts,
                };
                return { blob: video.blob, mimeType: video.mimeType, extension: video.extension, codec: video.codec, stats };
            } finally {
                map.off('data', onData);
            }
        } finally {
            this.release(back);
        }
    }

    /** PNG of the current frame (or time t), with all tiles loaded. */
    async exportImage(t?: number): Promise<Blob> {
        this.claim();
        let at = this.t;
        try {
            await this.queue;
            const plan = this.requirePlan();
            this.pause();
            at = Math.max(0, Math.min(plan.duration, t ?? this.t));
            this.showStill();
            this.setBusy(true, this.strings().statusImage, true);
            this.t = at;
            const pose = this.applyCamera(at);
            this.updateSegments(plan.distanceAt(at));
            await this.settle(8000);
            if (this.destroyed) throw new DOMException('The player was destroyed', 'AbortError');
            this.drawHud(at, pose);
            const c = document.createElement('canvas');
            c.width = this.output.width;
            c.height = this.output.height;
            const ctx = c.getContext('2d')!;
            ctx.drawImage(this.map!.getCanvas(), 0, 0, c.width, c.height);
            ctx.drawImage(this.hudCanvas, 0, 0);
            return await new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('PNG export failed'))), 'image/png'));
        } finally {
            this.release(at);
        }
    }

    /** Stops everything and frees the map (WebGL context). A load() still in flight is abandoned. */
    destroy() {
        if (this.destroyed) return;
        this.pause();
        this.destroyed = true;
        this.gen++;
        this.loadAbort?.abort();
        this.resizeObs.disconnect();
        this.map?.remove();
        this.map = null;
        this.stage.remove();
    }

    // ---------------------------------------------------------------- internals

    private emit<K extends keyof EventMap>(type: K, v: EventMap[K]) {
        for (const fn of this.listeners[type] ?? []) (fn as (x: EventMap[K]) => void)(v);
    }

    private setBusy(b: boolean, status = '', exportRes = false) {
        this.busy = b;
        if (this.destroyed) return;
        if (b && exportRes) this.useExportResolution();
        if (!b) this.usePreviewResolution();
        this.emit('state', b ? 'busy' : 'idle');
        this.emit('status', status);
    }

    private requirePlan(): FlightPlan {
        if (this.destroyed) throw new Error('The player was destroyed.');
        if (!this.plan || !this.map) throw new Error('Call load() first.');
        return this.plan;
    }

    private assertIdle() {
        if (this.destroyed) throw new Error('The player was destroyed.');
        if (this.busy) throw new Error('An export or prefetch is in progress. Wait for it to finish, or cancel it.');
    }

    /** Runs jobs strictly one after another, whatever the previous one's outcome. */
    private enqueue<T>(job: () => Promise<T>): Promise<T> {
        const run = this.queue.then(job, job);
        this.queue = run.then(() => undefined, () => undefined);
        return run;
    }

    /** Takes the export/prefetch lock synchronously, so two exports can never interleave. */
    private claim() {
        this.assertIdle();
        this.busy = true;
    }

    private release(seekTo: number) {
        this.setBusy(false);
        if (this.destroyed) return this.hideStill();
        this.seek(seekTo);
        // Keep the still until the map has drawn the frame it returns to, so nothing flashes —
        // at most half a second, in case nothing needs redrawing.
        const still = this.still, map = this.map;
        if (!still || !map) return this.hideStill();
        const done = () => { if (this.still === still) this.hideStill(); };
        map.once('render', () => requestAnimationFrame(done));
        setTimeout(done, 500);
    }

    /** Covers the map with what it shows right now (map + overlay), for the duration of a job. */
    private showStill() {
        if (this.opts.stillWhileBusy === false || !this.map || this.destroyed) return;
        this.hideStill();
        const c = document.createElement('canvas');
        c.width = this.output.width;
        c.height = this.output.height;
        Object.assign(c.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' });
        const ctx = c.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(this.map.getCanvas(), 0, 0, c.width, c.height);
        ctx.drawImage(this.hudCanvas, 0, 0);
        this.stage.append(c);
        this.still = c;
    }

    private hideStill() {
        this.still?.remove();
        this.still = null;
    }

    private fitStage() {
        const cw = this.container.clientWidth, ch = this.container.clientHeight;
        const sw = this.output.width / this.pixelRatio, sh = this.output.height / this.pixelRatio;
        if (!cw || !ch) return;
        const k = Math.min(cw / sw, ch / sh);
        this.stage.style.transform = `translate(${(cw - sw * k) / 2}px, ${(ch - sh * k) / 2}px) scale(${k})`;
        this.displayScale = k;
        if (!this.busy) this.usePreviewResolution();
    }

    private previewRatio() {
        const o = this.opts.previewPixelRatio ?? 'auto';
        if (typeof o === 'number') return o;
        const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
        return Math.min(this.pixelRatio, Math.max(0.5, Math.ceil(this.displayScale * dpr * 4) / 4));
    }

    private usePreviewResolution() {
        const r = this.previewRatio();
        if (this.map && Math.abs(this.map.getPixelRatio() - r) > 1e-3) {
            this.map.setPixelRatio(r);
            if (this.plan) this.renderFrame(this.t);
        }
    }

    private useExportResolution() {
        if (this.map && this.map.getPixelRatio() !== this.pixelRatio) this.map.setPixelRatio(this.pixelRatio);
    }

    private is2d() {
        return this.opts.mode === '2d';
    }

    /** Flight options after applying the mode (2D = top-down, north-up, flat; `flight.camera` picks follow or static). */
    private flightOptions(): Omit<FlightOptions, 'terrain' | 'aspect' | 'exaggeration'> {
        const f = { ...this.opts.flight, margins: this.margins() };
        if (!this.is2d()) return f;
        return { ...f, preset: 'topdown', pitch: f.pitch ?? 0, northUp: f.northUp ?? true };
    }

    /** Space kept free of the track in whole-route shots; the built-in profile needs a taller bottom panel. */
    private margins() {
        const m = this.opts.flight?.margins ?? {};
        const builtInProfile = this.opts.elevationProfile === true && typeof this.opts.hud !== 'function' && this.opts.hud !== false;
        return { top: m.top ?? 0.14, bottom: m.bottom ?? (builtInProfile ? 0.3 : 0.19), side: m.side ?? 0.07 };
    }

    private strings(): Strings {
        return resolveStrings(this.opts.locale, this.opts.strings);
    }

    private async rebuild(gen: number, keepFraction = 0) {
        const stale = () => gen !== this.gen || this.destroyed;
        if (stale()) return;
        const points = this.points;
        const exaggeration = this.is2d() ? 0 : this.opts.exaggeration ?? 1.4;
        const aspect = this.output.width / this.output.height;
        this.emit('status', this.strings().statusPlanning);
        // 1) quick plan without DEM → camera distance → how much terrain around the track we need
        const flight = this.flightOptions();
        const rough = buildFlightPlan(points, { ...flight, aspect, exaggeration });
        let terrain = null;
        this.loadAbort?.abort();
        const abort = new AbortController();
        this.loadAbort = abort;
        try {
            this.emit('status', this.strings().statusElevation);
            const lon = rough.track.lon, lat = rough.track.lat;
            let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
            for (let i = 0; i < lon.length; i++) {
                west = Math.min(west, lon[i]); east = Math.max(east, lon[i]);
                south = Math.min(south, lat[i]); north = Math.max(north, lat[i]);
            }
            // A flying camera needs the ground under its whole path; a static one only under the track.
            const around = rough.meta.camera === 'static' ? 1000 : rough.meta.range * 2 + 1000;
            terrain = await loadTerrariumSampler(expandBBox({ west, east, south, north }, around), {
                url: this.opts.terrainUrl,
                signal: abort.signal,
            });
        } catch (err) {
            if (!stale()) console.warn('[TrailFlyover] DEM unavailable, using GPS elevations:', errorText(err));
        }
        if (stale()) return;
        // 2) final plan with ground heights for camera clearance
        const plan = buildFlightPlan(points, { ...flight, aspect, exaggeration, terrain });
        await this.ensureMap(plan);
        if (stale()) return;
        this.plan = plan;
        this.setTrailData();
        this.placeLabels();
        this.applyMode();
        this.emit('status', '');
        this.t = keepFraction * this.plan.duration;
        this.renderFrame(this.t);
        this.emit('time', this.t);
        this.emit('state', 'idle');
    }

    private buildStyle(): MapLibre.StyleSpecification {
        const b = this.basemap;
        const terrainUrl = this.opts.terrainUrl ?? TERRARIUM_URL;
        const tiles = this.baseTiles();
        const dem = { type: 'raster-dem' as const, tiles: [terrainUrl], tileSize: 256, maxzoom: 14, encoding: 'terrarium' as const };
        return {
            version: 8,
            sources: {
                base: { type: 'raster', tiles, tileSize: b.tileSize, maxzoom: b.maxzoom, attribution: b.attribution },
                ...this.fallbackSource(),
                'dem-terrain': dem,
                'dem-hillshade': dem,
            },
            layers: [
                { id: 'background', type: 'background', paint: { 'background-color': this.backgroundColor() } },
                ...this.fallbackLayer(),
                { id: 'base', type: 'raster', source: 'base', paint: { 'raster-fade-duration': 0, ...(b.paint ?? {}) } },
            ],
            ...(this.is2d() ? {} : { terrain: { source: 'dem-terrain', exaggeration: this.opts.exaggeration ?? 1.4 } }),
            sky: this.sky(),
        };
    }

    private baseTiles(def: BasemapDef = this.basemap): string[] {
        const snow = this.opts.snow;
        return snow ? def.tiles.map(t => snowTileUrl(t, snow, this.opts.terrainUrl)) : def.tiles;
    }

    private fallbackDef(): BasemapDef | null {
        const id = this.basemap.fallback;
        return id && BASEMAPS[id] && !BASEMAPS[id].requiresKey ? BASEMAPS[id] : null;
    }

    private fallbackSource(): Record<string, MapLibre.SourceSpecification> {
        const f = this.fallbackDef();
        return f ? { 'base-fallback': { type: 'raster', tiles: this.baseTiles(f), tileSize: f.tileSize, maxzoom: f.maxzoom, attribution: f.attribution } } : {};
    }

    private fallbackLayer(): MapLibre.LayerSpecification[] {
        const f = this.fallbackDef();
        return f ? [{ id: 'base-fallback', type: 'raster', source: 'base-fallback', paint: { 'raster-fade-duration': 0, ...(f.paint ?? {}) } } as MapLibre.LayerSpecification] : [];
    }

    private sky(): MapLibre.SkySpecification {
        const winter = !!this.opts.snow;
        return {
            'sky-color': winter ? '#8fb0cf' : '#6fa5dc',
            'horizon-color': winter ? '#e7edf2' : '#dce7ef',
            'fog-color': winter ? '#e7edf2' : '#dce7ef',
            'sky-horizon-blend': 0.6,
            'horizon-fog-blend': 0.75,
            'fog-ground-blend': winter ? 0.75 : 0.82,
            'atmosphere-blend': 0,
        };
    }

    private attribution() {
        const parts = [this.basemap.attribution];
        const fb = this.fallbackDef();
        if (fb) parts.push(fb.attribution);
        if (!this.is2d() || (this.opts.snow && this.opts.snow.snowline != null)) parts.push(this.strings().terrainCredit);
        return parts.join(' · ');
    }

    private applyMode() {
        const map = this.map;
        if (!map) return;
        if (this.is2d()) map.setTerrain(null);
        else map.setTerrain({ source: 'dem-terrain', exaggeration: this.opts.exaggeration ?? 1.4 });
    }

    private async ensureMap(plan: FlightPlan) {
        if (this.map) return;
        const map = new this.ml.Map({
            container: this.mapDiv,
            style: this.buildStyle(),
            center: [plan.track.lon[0], plan.track.lat[0]],
            zoom: 11,
            interactive: false,
            attributionControl: false,
            pixelRatio: this.previewRatio(),
            fadeDuration: 0,
            maxPitch: 85,
            centerClampedToGround: false,
            // MapLibre caps the cache at min(maxTileCacheSize, tilesInView × maxTileCacheZoomLevels),
            // only ~85 tiles for a 720×900 view. Lift the view-based cap so maxTileCacheSize rules.
            // Measured on Iris Xe: 51 km track steadiest at ~350–900; 3000 was slower; 128 km track needed ~1500.
            // Long fast flights see many more distinct tiles: 51 km → ~760, 128 km+ → 1500 (measured).
            maxTileCacheSize: this.opts.maxTileCacheSize ?? Math.round(Math.min(1500, 350 + (plan.length / 1000) * 8)),
            maxTileCacheZoomLevels: 1000,
            canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
        });
        // Wait for the style only. The 'load' event also waits for every tile of the first view,
        // and a single failed tile (slow server, no coverage) must not fail the whole load.
        try {
            await new Promise<void>((resolve, reject) => {
                // 20 s of time in which the page actually renders. MapLibre needs animation frames
                // to load; a background tab or a covered / minimised window gets none, and failing
                // after 20 s there broke apps whose users had switched away while the map loaded.
                // Such time does not count: the load finishes once the page renders again.
                let active = 0, lastFrame = 0, lastCheck = performance.now(), raf = 0;
                const onFrame = (now: number) => { lastFrame = now; raf = requestAnimationFrame(onFrame); };
                raf = requestAnimationFrame(onFrame);
                const finish = () => { clearInterval(timer); cancelAnimationFrame(raf); };
                const timer = setInterval(() => {
                    // Destroyed meanwhile: stop waiting; the code below removes the map (a dropped load, as documented).
                    if (this.destroyed) { finish(); resolve(); return; }
                    const now = performance.now();
                    if (now - lastFrame < 1500) active += now - lastCheck;
                    lastCheck = now;
                    if (active > 20000) { finish(); reject(new Error('The map did not load (20 s timeout).')); }
                }, 500);
                const done = () => { finish(); resolve(); };
                map.once('style.load', done);
                map.once('load', done);
                map.on('error', e => {
                    const ev = e as unknown as { sourceId?: string; tile?: unknown; error?: Error };
                    if (ev.sourceId || ev.tile) return; // tile/source problem, the style itself is fine
                    if (!map.isStyleLoaded()) { finish(); reject(ev.error ?? new Error('The map could not be created.')); }
                });
            });
        } catch (err) {
            map.remove();
            throw err;
        }
        if (this.destroyed) {
            map.remove();
            return;
        }
        // Only the message, with URLs cut at the query string: tile URLs may carry an API key.
        map.on('error', e => console.warn('[TrailFlyover] map error:', errorText(e.error ?? e)));
        map.on('webglcontextlost', () => this.emit('status', this.strings().statusContextLost));
        map.on('webglcontextrestored', () => {
            this.emit('status', '');
            this.renderFrame(this.t);
        });
        this.map = map;
        this.applyHillshade();
    }

    /** What shows through where a tile has not arrived yet (see BasemapDef.background). */
    private backgroundColor() {
        return this.opts.snow ? '#dfe5ea' : (this.basemap.background ?? '#c9d3d9');
    }

    private swapBasemap() {
        const map = this.map;
        if (!map) return;
        const b = this.basemap;
        if (map.getLayer('background')) map.setPaintProperty('background', 'background-color', this.backgroundColor());
        for (const id of ['base', 'base-fallback']) {
            if (map.getLayer(id)) map.removeLayer(id);
            if (map.getSource(id)) map.removeSource(id);
        }
        const fb = this.fallbackDef();
        const firstAbove = map.getLayer('hillshade') ? 'hillshade' : map.getLayer('trail-ghost') ? 'trail-ghost' : undefined;
        if (fb) {
            for (const [id, src] of Object.entries(this.fallbackSource())) map.addSource(id, src);
            for (const layer of this.fallbackLayer()) map.addLayer(layer, firstAbove);
        }
        map.addSource('base', { type: 'raster', tiles: this.baseTiles(), tileSize: b.tileSize, maxzoom: b.maxzoom, attribution: b.attribution });
        const before = map.getLayer('hillshade') ? 'hillshade' : map.getLayer('trail-ghost') ? 'trail-ghost' : undefined;
        map.addLayer({ id: 'base', type: 'raster', source: 'base', paint: { 'raster-fade-duration': 0, ...(b.paint ?? {}) } } as MapLibre.LayerSpecification, before);
    }

    private applyHillshade() {
        const map = this.map;
        if (!map) return;
        const strength = this.opts.hillshade ?? this.basemap.hillshade;
        if (map.getLayer('hillshade')) map.removeLayer('hillshade');
        if (strength <= 0) return;
        map.addLayer(
            {
                id: 'hillshade',
                type: 'hillshade',
                source: 'dem-hillshade',
                paint: {
                    'hillshade-exaggeration': Math.min(1, strength),
                    'hillshade-shadow-color': '#1c2830',
                    'hillshade-highlight-color': '#ffffff',
                    'hillshade-accent-color': '#2a3a44',
                },
            },
            map.getLayer('trail-ghost') ? 'trail-ghost' : undefined,
        );
    }

    private colors() {
        return { ...DEFAULT_COLORS, ...this.opts.colors };
    }

    /** Trail split into short segments; feature-state "on" reveals them as the tip passes. */
    private setTrailData() {
        const map = this.map!;
        const plan = this.plan!;
        const { lon, lat, s } = plan.track;
        const n = lon.length;
        const segLen = Math.max(plan.meta.step, Math.min(60, Math.max(5, plan.meta.range / 80)));
        const k = Math.max(1, Math.round(segLen / plan.meta.step));
        const features: Feature[] = [];
        const ends: number[] = [];
        const starts: number[] = [];
        for (let i = 0, id = 0; i < n - 1; i += k, id++) {
            const j = Math.min(n - 1, i + k);
            const coords: number[][] = [];
            for (let q = i; q <= j; q++) coords.push([lon[q], lat[q]]);
            features.push({ type: 'Feature', id, properties: {}, geometry: { type: 'LineString', coordinates: coords } });
            ends.push(s[j]);
            starts.push(i);
        }
        this.segEnd = Float64Array.from(ends);
        this.segStartIdx = Int32Array.from(starts);
        this.segOn = 0;

        const full: Feature = {
            type: 'Feature', properties: {},
            geometry: { type: 'LineString', coordinates: Array.from(lon, (x, i) => [x, lat[i]]) },
        };
        const segData: FeatureCollection = { type: 'FeatureCollection', features };
        for (const id of ['trail-active', 'trail-casing', 'trail-ghost']) if (map.getLayer(id)) map.removeLayer(id);
        for (const id of ['trail-full', 'trail-seg']) if (map.getSource(id)) map.removeSource(id);
        map.addSource('trail-full', { type: 'geojson', data: full, tolerance: 0.2 });
        map.addSource('trail-seg', { type: 'geojson', data: segData, tolerance: 0.2 });
        const on: MapLibre.ExpressionSpecification = ['boolean', ['feature-state', 'on'], false];
        map.addLayer({ id: 'trail-ghost', type: 'line', source: 'trail-full', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: {} });
        map.addLayer({ id: 'trail-casing', type: 'line', source: 'trail-seg', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-opacity': ['case', on, 1, 0] } } as MapLibre.LayerSpecification);
        map.addLayer({ id: 'trail-active', type: 'line', source: 'trail-seg', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-opacity': ['case', on, 1, 0] } } as MapLibre.LayerSpecification);
        this.applyTrailPaint();
    }

    private applyTrailPaint() {
        const map = this.map;
        if (!map?.getLayer('trail-active')) return;
        const c = this.colors();
        map.setPaintProperty('trail-ghost', 'line-color', c.ghost);
        map.setPaintProperty('trail-ghost', 'line-width', 2.5);
        map.setPaintProperty('trail-ghost', 'line-opacity', this.opts.ghostTrail === false ? 0 : 0.6);
        map.setPaintProperty('trail-casing', 'line-color', c.casing);
        map.setPaintProperty('trail-casing', 'line-width', 8);
        map.setPaintProperty('trail-active', 'line-color', c.trail);
        map.setPaintProperty('trail-active', 'line-width', 5);
    }

    private updateSegments(tipS: number) {
        const map = this.map!;
        const ends = this.segEnd;
        while (this.segOn < ends.length && ends[this.segOn] <= tipS + 1e-6) {
            map.setFeatureState({ source: 'trail-seg', id: this.segOn }, { on: true });
            this.segOn++;
        }
        while (this.segOn > 0 && ends[this.segOn - 1] > tipS + 1e-6) {
            this.segOn--;
            map.setFeatureState({ source: 'trail-seg', id: this.segOn }, { on: false });
        }
    }

    /** How many of the given labels lie on the track (within `labelReach`) and will be shown. */
    get labelCount() {
        return this.labels.length;
    }

    private placeLabels() {
        const plan = this.plan;
        if (!plan) return;
        let placed = placeLabelsOnTrack(this.opts.labels ?? [], plan.track, this.opts.labelReach)
            .map(l => ({ ...l, t: plan.timeAt(l.s) }));
        if (this.opts.keepEndpointLabels !== false) placed = markEndpointLabels(placed, plan.track, this.opts.endpointRadius);
        this.labels = thinLabels(placed, this.opts.labelMinGap ?? 0.6);
    }

    private applyCamera(t: number): CameraPose {
        const pose = this.plan!.poseAt(t);
        const { LngLat } = this.ml;
        const camPos = new LngLat(pose.camera.lon, pose.camera.lat);
        // Looking (almost) straight down the camera→target vector carries no heading,
        // so top-down views are set from position + rotation instead.
        const cam = pose.pitch < 3
            ? this.map!.calculateCameraOptionsFromCameraLngLatAltRotation(camPos, pose.camera.alt, pose.bearing, pose.pitch)
            : this.map!.calculateCameraOptionsFromTo(camPos, pose.camera.alt, new LngLat(pose.target.lon, pose.target.lat), pose.target.alt);
        this.map!.jumpTo(cam);
        return pose;
    }

    private renderFrame(t: number) {
        if (!this.plan || !this.map) return;
        const pose = this.applyCamera(t);
        this.updateSegments(this.plan.distanceAt(t));
        this.map.redraw();
        this.drawHud(t, pose);
    }

    private loop = (now: number) => {
        if (!this.playing) return;
        this.t = Math.min(this.duration, this.playT + (now - this.playWall) / 1000);
        this.renderFrame(this.t);
        this.emit('time', this.t);
        if (this.t >= this.duration) {
            this.playing = false;
            this.emit('state', 'ended');
            return;
        }
        this.raf = requestAnimationFrame(this.loop);
    };

    /**
     * Waits until every visible tile (imagery + terrain) is loaded. Returns false on timeout.
     * `areTilesLoaded()` alone is vacuously true right after a source is swapped (it has not
     * requested any tile yet), so sources must be loaded too, and at least two frames rendered.
     */
    private async settle(timeoutMs: number, stats?: SettleStats): Promise<boolean> {
        const map = this.map!;
        const t0 = performance.now();
        const ready = () => map.loaded() && map.areTilesLoaded();
        const redraw = () => {
            const r0 = performance.now();
            map.redraw();
            if (stats) stats.render += performance.now() - r0;
        };
        // redraw() renders synchronously and asks for the tiles the new camera needs; no tile can
        // arrive between it and the check right after it (JS runs one task at a time). So when
        // everything is loaded right after a redraw, that redraw already showed it all: done in
        // one render.
        redraw();
        if (ready()) return true;
        for (;;) {
            const w0 = performance.now();
            // Wake on MapLibre's 'data' event (a tile arrived), with a short timer as a fallback.
            // Not on the timer alone: in a background tab browsers run timers at most once a
            // second (after a few minutes once a minute), which stalled exports for many minutes.
            // Events from the tile workers are not throttled.
            await new Promise<void>(resolve => {
                let timer: ReturnType<typeof setTimeout> | undefined;
                let finished = false;
                const done = () => {
                    if (finished) return;
                    finished = true;
                    clearTimeout(timer);
                    map.off('data', done);
                    resolve();
                };
                map.on('data', done);
                unchainedTimeout(50, done, t => { timer = t; });
            });
            if (stats) stats.tiles += performance.now() - w0;
            if (this.destroyed) return false;
            const late = performance.now() - t0 > timeoutMs;
            // Redraw only once the tiles are in (or time is up): the redraw may ask for more tiles
            // (terrain heights change what is visible), then wait again. Not `ready()` here:
            // `loaded()` stays false until the next render after any change, so it would wait for
            // MapLibre's own render loop.
            if (map.areTilesLoaded() || late) {
                redraw();
                if (ready()) return true;
                if (late) return false;
            }
        }
    }

    private makeProjector(pose: CameraPose) {
        const map = this.map!;
        const pr = this.pixelRatio;
        const kx = 111320 * Math.cos((pose.camera.lat * Math.PI) / 180);
        const fx = (pose.target.lon - pose.camera.lon) * kx;
        const fy = (pose.target.lat - pose.camera.lat) * 111320;
        const fz = pose.target.alt - pose.camera.alt;
        const fl = Math.hypot(fx, fy, fz);
        return (lon: number, lat: number): ScreenPoint | null => {
            const dx = (lon - pose.camera.lon) * kx, dy = (lat - pose.camera.lat) * 111320;
            const dz = pose.target.alt - pose.camera.alt; // assume roughly target height
            if ((dx * fx + dy * fy + dz * fz) / fl < 50) return null; // behind / too close to the camera
            const p = map.project([lon, lat]);
            return { x: p.x * pr, y: p.y * pr };
        };
    }

    private drawHud(t: number, pose: CameraPose) {
        const plan = this.plan!;
        const ctx = this.hudCtx;
        const W = this.output.width, H = this.output.height;
        ctx.clearRect(0, 0, W, H);
        const project = this.makeProjector(pose);
        const tipS = plan.distanceAt(t);
        const tipGeo = plan.tipAt(t);
        const c = this.colors();
        const scale = Math.min(W, H) / 1080;

        // Partial segment between the last revealed segment and the exact tip
        if (tipS > 0) {
            const startIdx = this.segOn < this.segStartIdx.length ? this.segStartIdx[this.segOn] : plan.track.lon.length - 1;
            const tipIdx = tipS / plan.meta.step;
            const pts: ScreenPoint[] = [];
            for (let i = startIdx; i < tipIdx; i++) {
                const p = project(plan.track.lon[i], plan.track.lat[i]);
                if (p) pts.push(p);
            }
            const tp = project(tipGeo.lon, tipGeo.lat);
            if (tp) pts.push(tp);
            if (pts.length >= 2) {
                ctx.save();
                ctx.lineJoin = 'round';
                ctx.lineCap = 'round';
                for (const [color, width] of [[c.casing, 8], [c.trail, 5]] as const) {
                    ctx.strokeStyle = color;
                    ctx.lineWidth = width * this.pixelRatio;
                    ctx.beginPath();
                    ctx.moveTo(pts[0].x, pts[0].y);
                    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
                    ctx.stroke();
                }
                ctx.restore();
            }
        }

        const tip = tipS > 0 && tipS < plan.track.s[plan.track.s.length - 1] ? project(tipGeo.lon, tipGeo.lat) : null;
        const frame: HudFrame = {
            width: W, height: H, scale, t, duration: plan.duration,
            progress: tipS / plan.track.s[plan.track.s.length - 1],
            stats: plan.statsAt(t),
            total: plan.statsAt(plan.duration),
            pose, project, tip,
            title: this.meta.title,
            subtitle: this.meta.subtitle,
            attribution: this.attribution(),
            accent: c.accent,
            stop: plan.stopAt(t),
            profile: plan.profile,
            showProfile: this.opts.elevationProfile === true,
            strings: this.strings(),
        };
        // The tip goes under the labels: it passes right through the places, and drawn on top it
        // covered letters of the name (a pill is opaque enough to keep the tip faintly visible).
        if (tip) drawTip(ctx, tip, scale, c.accent);
        // Labels keep clear of the panels: a little inside the margins the track itself respects.
        const mg = this.margins();
        const bands = { top: Math.max(0, mg.top - 0.02), bottom: Math.max(0, mg.bottom - 0.05) };
        // With a static camera nothing ever leaves the picture: small places fade out again after a
        // while, towns stay as landmarks. A flying camera shows small places only at flight distance,
        // not in the overview shots at both ends.
        drawLabels(ctx, this.labels, frame, tipS, plan.meta.camera === 'static'
            ? { maxLabels: 12, hold: 3.5, bands, size: this.opts.labelSize }
            : { detailRange: plan.meta.range, bands, lead: this.opts.labelLead ?? 1.2, size: this.opts.labelSize });
        if (this.opts.hud !== false) (this.opts.hud ?? drawDefaultHud)(ctx, frame);
    }
}
