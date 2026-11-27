/**
 * 2D overlay drawn on a canvas on top of the map, in output pixels.
 * Everything here is part of the exported video too.
 */
import type { CameraPose, TrackStats } from '../core/flightPlan.ts';
import { smoothstep } from '../core/geo.ts';

export interface ScreenPoint {
    x: number;
    y: number;
}

export interface HudFrame {
    /** Output size in pixels. */
    width: number;
    height: number;
    /** min(width, height) / 1080 — multiply font sizes etc. by this. */
    scale: number;
    t: number;
    duration: number;
    /** 0–1 distance progress of the trail tip. */
    progress: number;
    stats: TrackStats;
    total: TrackStats;
    pose: CameraPose;
    /** Projects a point to output pixels; null when it is behind the camera. */
    project(lon: number, lat: number): ScreenPoint | null;
    tip: ScreenPoint | null;
    title: string;
    subtitle: string;
    attribution: string;
    accent: string;
}

export interface FlyoverLabel {
    lon: number;
    lat: number;
    name: string;
    /** town / village / hamlet / peak / … — used for priority. */
    kind?: string;
    /** Higher wins label collisions. Defaults from `kind`. */
    priority?: number;
}

/** Label enriched with its position along the track (set by the player). */
export interface PlacedLabel extends FlyoverLabel {
    /** Distance along track (m) where the trail first passes the place. */
    s: number;
    /** Distance from the track (m). */
    offTrack: number;
    /** Video time (s) when the trail tip gets there. Without it the label appears as soon as the tip is past `s`. */
    t?: number;
}

const KIND_PRIORITY: Record<string, number> = { city: 5, town: 4, waypoint: 4, peak: 3, village: 3, hamlet: 1, locality: 1 };

/** How close (m) the track must come to a place for its name to be shown: one number, or per `kind`. */
export type LabelReach = number | Record<string, number>;

/**
 * Default reach per kind — "the track really goes there". The point of a town is its centre and
 * the track may cross it at the edge, hence the larger radius; a peak counts only when the track
 * goes (almost) over the top. `default` covers kinds without a value of their own; `waypoint` is
 * for the user's own points.
 */
export const LABEL_REACH: Record<string, number> = {
    city: 2000, town: 1000, village: 400, hamlet: 250, locality: 250, peak: 250, waypoint: 1500, default: 400,
};

function reachOf(reach: LabelReach | undefined, kind: string | undefined): number {
    if (typeof reach === 'number') return reach;
    // The caller's value for this kind, else the built-in one for it, else the catch-all.
    return reach?.[kind ?? ''] ?? LABEL_REACH[kind ?? ''] ?? reach?.default ?? LABEL_REACH.default;
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
}

/** Distance in metres between two lon/lat points (fast, local). */
function approxDist(aLon: number, aLat: number, bLon: number, bLat: number) {
    const kx = 111320 * Math.cos((aLat * Math.PI) / 180);
    return Math.hypot((bLon - aLon) * kx, (bLat - aLat) * 111320);
}

/**
 * Keeps the places the track really passes (within `reach` metres, by default per kind — see
 * LABEL_REACH) and assigns each the spot along the track where the trail *first* comes close.
 * On an out-and-back or a loop the closest pass may be the second one; the name should appear
 * the first time the trail gets there. A place the track starts in is placed at the very start,
 * so its name is there from the first frame.
 */
export function placeLabelsOnTrack(
    labels: FlyoverLabel[],
    track: { lon: ArrayLike<number>; lat: ArrayLike<number>; s: ArrayLike<number> },
    reach?: LabelReach,
): PlacedLabel[] {
    const { lon, lat, s } = track;
    const n = lon.length;
    const stride = Math.max(1, Math.floor(n / 3000));
    const out: PlacedLabel[] = [];
    for (const l of labels) {
        if (!Number.isFinite(l.lon) || !Number.isFinite(l.lat) || !l.name) continue;
        const kx = 111320 * Math.cos((l.lat * Math.PI) / 180);
        const dist = (i: number) => Math.hypot((lon[i] - l.lon) * kx, (lat[i] - l.lat) * 111320);
        const maxOff = reachOf(reach, l.kind);
        let best = Infinity;
        for (let i = 0; i < n; i += stride) best = Math.min(best, dist(i));
        if (!(best <= maxOff)) continue;
        if (dist(0) <= maxOff) {
            out.push({ ...l, s: s[0], offTrack: dist(0) });
            continue;
        }
        // First pass that is about as close as the closest one (and within reach), then its local minimum.
        const near = Math.min(maxOff, Math.max(best * 1.4, best + 150));
        let i = 0;
        while (i < n && dist(i) > near) i += stride;
        let at = Math.min(i, n - 1), d = dist(at);
        for (let k = at + stride; k < n; k += stride) {
            const dk = dist(k);
            if (dk > near) break;
            if (dk < d) { d = dk; at = k; }
        }
        out.push({ ...l, s: s[at], offTrack: d });
    }
    return out;
}

/**
 * Keeps the pace of appearing names calm: when places come faster than one per `minGap` seconds
 * (a fast flight through a cluster of hamlets), the less important ones are left out — towns
 * first, then villages and peaks, then hamlets; among equals the one closer to the track wins.
 * Labels need `t` (the moment the trail reaches them). Order of the result follows the input.
 */
export function thinLabels<T extends PlacedLabel>(labels: T[], minGap = 0.6): T[] {
    if (!(minGap > 0)) return labels;
    const pr = (l: PlacedLabel) => l.priority ?? KIND_PRIORITY[l.kind ?? ''] ?? 2;
    const order = labels.map((_, i) => i).sort((a, b) => pr(labels[b]) - pr(labels[a]) || labels[a].offTrack - labels[b].offTrack || a - b);
    const taken: number[] = [];
    const keep = new Set<number>();
    for (const i of order) {
        const t = labels[i].t;
        // Towns and the user's own points are landmarks: always kept.
        if (t === undefined || pr(labels[i]) >= 4 || taken.every(u => Math.abs(u - t) >= minGap)) {
            keep.add(i);
            if (t !== undefined) taken.push(t);
        }
    }
    return labels.filter((_, i) => keep.has(i));
}

/** CSS colour with alpha for any colour syntax (#rgb, #rrggbb, names, rgb(), hsl()…). */
export function withAlpha(color: string, alpha: number): string {
    const a = Math.min(1, Math.max(0, alpha));
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
    if (hex) {
        const h = hex[1].length === 3 ? [...hex[1]].map(c => c + c).join('') : hex[1];
        return `#${h}${Math.round(a * 255).toString(16).padStart(2, '0')}`;
    }
    return `color-mix(in srgb, ${color} ${Math.round(a * 100)}%, transparent)`;
}

/** Shortens text with an ellipsis until it fits `maxWidth` (uses the current ctx.font). */
export function fitText(ctx: Pick<CanvasRenderingContext2D, 'measureText'>, text: string, maxWidth: number): string {
    if (ctx.measureText(text).width <= maxWidth) return text;
    const chars = [...text];
    let lo = 0, hi = chars.length;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (ctx.measureText(chars.slice(0, mid).join('').trimEnd() + '…').width <= maxWidth) lo = mid;
        else hi = mid - 1;
    }
    return chars.slice(0, lo).join('').trimEnd() + '…';
}

export function drawTip(ctx: CanvasRenderingContext2D, p: ScreenPoint, scale: number, accent: string) {
    const r = 9 * scale;
    ctx.save();
    try {
        const g = ctx.createRadialGradient(p.x, p.y, r * 0.5, p.x, p.y, r * 3.2);
        g.addColorStop(0, withAlpha(accent, 0.67));
        g.addColorStop(1, withAlpha(accent, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 3.2, 0, Math.PI * 2);
        ctx.fill();
    } catch {
        // Unparseable colour (old browser without color-mix): skip the glow, keep the dot.
    }
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.lineWidth = 3 * scale;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.restore();
}

export interface LabelDrawOptions {
    /** Most labels on screen at once. Default 6. */
    maxLabels?: number;
    /**
     * Seconds a small place stays after it appeared, then it fades out again. Towns, the user's
     * own waypoints (priority ≥ 4) and the place the track starts in always stay.
     * Default: no limit — a flying camera leaves the label behind anyway.
     */
    hold?: number;
    /**
     * Camera distance (m) of the follow flight. When the camera pulls back well beyond it (the
     * overview shots at both ends), small places fade out and only towns and the user's own
     * points remain — a village name means little on a map of the whole route.
     */
    detailRange?: number;
}

/**
 * Place-name pills like in a documentary: each appears at the moment the trail reaches the place,
 * fades with distance from the camera target, and never sits on top of another.
 */
export function drawLabels(
    ctx: CanvasRenderingContext2D, labels: PlacedLabel[], f: HudFrame, distanceAlong: number, options: LabelDrawOptions | number = {},
) {
    if (labels.length === 0) return;
    const o = typeof options === 'number' ? { maxLabels: options } : options;
    const hold = o.hold ?? Infinity;
    const range = f.pose.range;
    // 1 while the camera is at flight distance, 0 from 3× further away.
    const detail = o.detailRange ? 1 - smoothstep((range / o.detailRange - 1.5) / 1.5) : 1;
    const s = f.scale;
    const margin = 40 * s, soft = 36 * s, top = f.height * 0.12, bottom = f.height * 0.86;
    const candidates: Array<{ l: PlacedLabel; p: ScreenPoint; a: number; pr: number; reveal: number }> = [];
    for (const l of labels) {
        // Seconds since the trail tip got there (without a time: just "passed or not").
        const age = l.t !== undefined ? f.t - l.t : distanceAlong >= l.s ? Infinity : -Infinity;
        // A quick fade-in that starts as the tip arrives; the starting place is there from frame one.
        const reveal = l.t !== undefined && l.t <= 0 ? 1 : smoothstep((age + 0.1) / 0.45);
        if (reveal <= 0.01) continue;
        const pr = l.priority ?? KIND_PRIORITY[l.kind ?? ''] ?? 2;
        const stays = pr >= 4 || l.s <= 0;
        const kept = stays ? 1 : detail * (hold === Infinity || age < hold ? 1 : 1 - smoothstep((age - hold) / 0.8));
        const d = approxDist(f.pose.target.lon, f.pose.target.lat, l.lon, l.lat);
        const near = 1 - smoothstep((d - range * 0.9) / (range * 0.9));
        const p = f.project(l.lon, l.lat);
        if (!p) continue;
        // Fades out towards the picture edges and the title / stats bands instead of popping.
        const inside = smoothstep((p.x - margin) / soft) * smoothstep((f.width - margin - p.x) / soft)
            * smoothstep((p.y - top) / soft) * smoothstep((bottom - p.y) / soft);
        const a = reveal * kept * near * inside;
        if (a <= 0.02) continue;
        candidates.push({ l, p, a, pr, reveal });
    }
    // Important places first; among equals the one the trail reached first keeps its spot, so a
    // label never jumps in front of one that is already on screen.
    candidates.sort((x, y) => y.pr - x.pr || x.l.s - y.l.s);

    const boxes: Array<[number, number, number, number, number]> = [];
    const fontSize = Math.round(26 * s);
    ctx.save();
    ctx.font = `600 ${fontSize}px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    let budget = o.maxLabels ?? 6;
    for (const c of candidates) {
        if (budget <= 0.02) break;
        const padX = 16 * s, h = fontSize + 18 * s, stem = 22 * s;
        const w = ctx.measureText(c.l.name).width + padX * 2;
        // The pill stays fully inside the picture; near an edge it slides sideways and the stem
        // still points at the place.
        const edge = 14 * s;
        const bx = Math.min(Math.max(c.p.x - w / 2, edge), Math.max(edge, f.width - w - edge));
        const by = c.p.y - stem - h;
        // Where pills would overlap, the one placed earlier wins and this one gets only what the
        // winner leaves — so as one fades out its neighbour fades in (a cross-fade, not a swap).
        let covered = 0;
        for (const [x, y, bw, bh, ba] of boxes) {
            if (bx < x + bw + 8 * s && bx + w + 8 * s > x && by < y + bh + 6 * s && by + h + 6 * s > y) covered = Math.max(covered, ba);
        }
        const alpha = Math.min(c.a * (1 - covered), budget);
        if (alpha <= 0.02) continue;
        boxes.push([bx, by, w, h, alpha]);
        budget -= alpha;
        // The pill rises a little into place while it fades in.
        const rise = (1 - c.reveal) * 10 * s;
        ctx.globalAlpha = alpha;
        // stem + anchor dot
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 2 * s;
        ctx.beginPath();
        ctx.moveTo(c.p.x, c.p.y);
        ctx.lineTo(c.p.x, by + h + rise);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(c.p.x, c.p.y, 6 * s, 0, Math.PI * 2);
        ctx.fillStyle = f.accent;
        ctx.fill();
        ctx.lineWidth = 2 * s;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
        // pill
        ctx.shadowColor = 'rgba(0,0,0,0.35)';
        ctx.shadowBlur = 10 * s;
        roundRect(ctx, bx, by + rise, w, h, h / 2);
        ctx.fillStyle = 'rgba(18,18,20,0.82)';
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#fff';
        ctx.fillText(c.l.name, bx + w / 2, by + rise + h / 2 + 1 * s);
    }
    ctx.restore();
}

export function formatDistance(m: number) {
    // Thresholds sit where the rounded text changes width, so 9 999 m reads "10.0 km", not "10.00 km".
    return m >= 9995 ? `${(m / 1000).toFixed(1)} km` : m >= 999.5 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

export function formatDuration(sec: number) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

/**
 * Splits text into lines no wider than `maxWidth` (current ctx.font), breaking at spaces.
 * A single word longer than the line stays whole on its own line.
 */
export function wrapText(ctx: Pick<CanvasRenderingContext2D, 'measureText'>, text: string, maxWidth: number): string[] {
    const words = text.split(/ +/).filter(Boolean);
    const lines: string[] = [];
    let line = '';
    for (const w of words) {
        const next = line ? `${line} ${w}` : w;
        if (line && ctx.measureText(next).width > maxWidth) {
            lines.push(line);
            line = w;
        } else {
            line = next;
        }
    }
    if (line) lines.push(line);
    return lines;
}

/** Title that always fits: first a smaller font (down to 70 %), then an ellipsis. */
function drawFitted(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, weight: number, size: number) {
    let px = size;
    ctx.font = `${weight} ${Math.round(px)}px ${FONT}`;
    const w = ctx.measureText(text).width;
    if (w > maxWidth) {
        px = Math.max(size * 0.7, (size * maxWidth) / w);
        ctx.font = `${weight} ${Math.round(px)}px ${FONT}`;
    }
    ctx.fillText(fitText(ctx, text, maxWidth), x, y);
}

/**
 * Default overlay: small title, compact live stats and a progress line.
 * Deliberately light — the landscape is the content. Apps with their own
 * branding pass a custom `hud` function instead.
 */
export function drawDefaultHud(ctx: CanvasRenderingContext2D, f: HudFrame) {
    const { width: W, height: H, scale: s } = f;
    ctx.save();

    // Soft vignettes for legibility
    let g = ctx.createLinearGradient(0, 0, 0, H * 0.2);
    g.addColorStop(0, 'rgba(0,0,0,0.45)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H * 0.2);
    g = ctx.createLinearGradient(0, H * 0.78, 0, H);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = g;
    ctx.fillRect(0, H * 0.78, W, H * 0.22);

    const m = 44 * s;
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 8 * s;
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'top';
    drawFitted(ctx, f.title, m, m, W - 2 * m, 700, 40 * s);
    if (f.subtitle) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        drawFitted(ctx, f.subtitle, m, m + 52 * s, W - 2 * m, 500, 24 * s);
    }

    // Stats row
    const cells: Array<[string, string]> = [
        [formatDistance(f.stats.distance), 'vzdálenost'],
        [`${Math.round(f.stats.ascent)} m`, 'stoupání'],
    ];
    // Moving time (stops left out) is what sport apps show; fall back to the recorded time.
    if (f.stats.moving !== null) cells.push([formatDuration(f.stats.moving), 'čas v pohybu']);
    else if (f.stats.elapsed !== null) cells.push([formatDuration(f.stats.elapsed), 'čas']);
    else if (Number.isFinite(f.stats.elevation)) cells.push([`${Math.round(f.stats.elevation)} m n. m.`, 'výška']);
    const baseY = H - m - 34 * s;
    const cellW = (W - 2 * m) / cells.length;
    cells.forEach(([value, label], i) => {
        const x = m + i * cellW;
        ctx.fillStyle = '#fff';
        ctx.font = `700 ${Math.round(38 * s)}px ${FONT}`;
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(value, x, baseY);
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.font = `500 ${Math.round(20 * s)}px ${FONT}`;
        ctx.fillText(label, x, baseY + 28 * s);
    });

    // Progress line
    ctx.shadowBlur = 0;
    const barY = H - m + 8 * s;
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    roundRect(ctx, m, barY, W - 2 * m, 4 * s, 2 * s);
    ctx.fill();
    ctx.fillStyle = f.accent;
    roundRect(ctx, m, barY, Math.max(4 * s, (W - 2 * m) * f.progress), 4 * s, 2 * s);
    ctx.fill();

    // Attribution (required by tile providers): always complete — wrapped, never cut off.
    ctx.font = `400 ${Math.round(14 * s)}px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    const lines = wrapText(ctx, f.attribution, W - 24 * s);
    lines.forEach((line, i) => {
        ctx.fillText(line, W - 12 * s, H - 8 * s - (lines.length - 1 - i) * 17 * s);
    });
    ctx.restore();
}
