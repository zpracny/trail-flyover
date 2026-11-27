/**
 * trail-flyover — smooth 3D fly-over of a GPS track with MP4/WebM export.
 *
 * Core (no DOM, no renderer): buildFlightPlan, parseGpx, geo helpers.
 * MapLibre player: TrailFlyover. HUD helpers for custom overlays.
 */
export { buildFlightPlan, CAMERA_PRESETS } from './core/flightPlan.ts';
export type { FlightPlan, FlightOptions, CameraPose, PresetId, CameraPreset, TrackStats, ElevationSampler } from './core/flightPlan.ts';
export { parseGpx } from './core/gpx.ts';
export type { ParsedGpx, GpxWaypoint } from './core/gpx.ts';
export { sanitizeTrack, unwrapLongitudes } from './core/clean.ts';
export { redactUrls } from './core/urls.ts';
export type { TrackPoint } from './core/geo.ts';
export { loadTerrariumSampler, expandBBox, TERRARIUM_URL } from './core/terrarium.ts';
export { TrailFlyover } from './maplibre/player.ts';
export type { TrailFlyoverOptions, LoadMeta, ExportOptions, HudRenderer } from './maplibre/player.ts';
export { BASEMAPS, resolveBasemap } from './maplibre/basemaps.ts';
export type { BasemapDef } from './maplibre/basemaps.ts';
export { drawDefaultHud, drawLabels, drawTip, placeLabelsOnTrack, thinLabels, LABEL_REACH, withAlpha, fitText, wrapText, formatDistance, formatDuration } from './hud/hud.ts';
export type { HudFrame, FlyoverLabel, PlacedLabel, LabelReach, LabelDrawOptions, ScreenPoint } from './hud/hud.ts';
export { encodeVideo, canEncode } from './export/encode.ts';
export type { VideoFormat, EncodedVideo } from './export/encode.ts';
export { fetchPlaceLabels } from './extras/places.ts';
export { snowifyPixels, registerSnowProtocol, snowTileUrl } from './effects/snow.ts';
export type { SnowOptions } from './effects/snow.ts';
