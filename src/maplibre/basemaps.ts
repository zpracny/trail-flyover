/**
 * Raster basemaps. Each entry is plain data, so host apps can add their own
 * (a keyed commercial service, a custom WMTS) without touching the player.
 */
export interface BasemapDef {
    id: string;
    label: string;
    /** Tile URL templates. `{apikey}` is replaced from `apiKeys[requiresKey]`. */
    tiles: string[];
    tileSize: number;
    maxzoom: number;
    attribution: string;
    /** Name of the key in `apiKeys` this basemap needs. */
    requiresKey?: string;
    /** MapLibre raster paint overrides (saturation, contrast, …). */
    paint?: Record<string, unknown>;
    /** Default hillshade strength 0–1 (0 = off). Satellite already has real shadows. */
    hillshade: number;
    /**
     * Colour shown where a tile has not arrived yet (fast flights, first frames of the preview).
     * Close to the basemap's average colour, so a gap looks like haze rather than a bright patch.
     * Default a light grey-blue.
     */
    background?: string;
    /** Human-readable coverage note, shown in UIs. */
    coverage?: string;
    /** Basemap drawn underneath, visible where this one has no coverage (e.g. ČÚZK outside Czechia). */
    fallback?: string;
    /**
     * What the provider's terms say about exporting a video/image and sharing it outside the app
     * (checked 2026-11; see README). 'open' = open licence, attribution is enough;
     * 'personal' = fine for personal, non-monetised posts with attribution;
     * 'no' = terms forbid exporting/sharing without the provider's written permission (none of the
     * built-in basemaps; Mapy.com was left out for this reason).
     * Informational only — the player does not block anything.
     */
    sharing?: 'open' | 'personal' | 'no';
}

export const BASEMAPS: Record<string, BasemapDef> = {
    'esri-satellite': {
        id: 'esri-satellite',
        label: 'Satellite (Esri)',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 19,
        // Credits as the services declare them (MapServer copyrightText, checked 2026-11).
        attribution: '© Esri, Vantor, Earthstar Geographics, GIS User Community',
        paint: { 'raster-saturation': -0.1, 'raster-contrast': 0.08 },
        sharing: 'personal',
        hillshade: 0,
        background: '#3c4637',
        coverage: 'worldwide',
    },
    'esri-wayback-2022': {
        id: 'esri-wayback-2022',
        label: 'Satellite, Esri archive 2022 (winter in places)',
        // Esri World Imagery Wayback release 2022-04-06: winter capture over parts of Šumava (e.g. Špičák).
        tiles: ['https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/48232/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© Esri World Imagery Wayback (2022), Maxar, Earthstar Geographics',
        sharing: 'personal',
        hillshade: 0,
        background: '#3c4637',
        coverage: 'worldwide; snow only in places (Šumava: Špičák, Železná Ruda)',
    },
    'cuzk-ortofoto': {
        id: 'cuzk-ortofoto',
        label: 'Orthophoto of Czechia (ČÚZK)',
        tiles: ['https://ags.cuzk.gov.cz/arcgis1/rest/services/ORTOFOTO_WM/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 20,
        attribution: '© ČÚZK',
        paint: { 'raster-saturation': -0.05 },
        sharing: 'open',
        hillshade: 0,
        background: '#3c4637',
        coverage: 'Czechia (the sharpest detail), Esri beyond the border',
        fallback: 'esri-satellite',
    },
    'esri-satellite-bw': {
        id: 'esri-satellite-bw',
        label: 'Satellite, black and white (Esri)',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 19,
        // Credits as the services declare them (MapServer copyrightText, checked 2026-11).
        attribution: '© Esri, Vantor, Earthstar Geographics, GIS User Community',
        // Same imagery, fully desaturated; a little more contrast so the coloured trail stands out.
        paint: { 'raster-saturation': -1, 'raster-contrast': 0.18, 'raster-brightness-max': 0.92 },
        sharing: 'personal',
        hillshade: 0,
        background: '#474747',
        coverage: 'worldwide',
    },
    'opentopomap': {
        id: 'opentopomap',
        label: 'Topographic (OpenTopoMap)',
        tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://b.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://c.tile.opentopomap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 17,
        attribution: '© OpenStreetMap, SRTM | © OpenTopoMap (CC-BY-SA)',
        sharing: 'open',
        hillshade: 0.25,
        background: '#e4e2d8',
        coverage: 'worldwide; slow server (a tile can take seconds)',
    },
    'esri-topo': {
        id: 'esri-topo',
        label: 'Topographic (Esri Topo)',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 19,
        attribution: 'Sources: Esri, HERE, Garmin, Intermap, increment P Corp., GEBCO, USGS, FAO, NPS, NRCAN, GeoBase, IGN, Kadaster NL, Ordnance Survey, Esri Japan, METI, Esri China (Hong Kong), © OpenStreetMap contributors, GIS User Community',
        sharing: 'personal',
        hillshade: 0.15,
        background: '#e4e2d8',
        coverage: 'worldwide, fast server',
    },
    'esri-light': {
        id: 'esri-light',
        label: 'Light grey (Esri)',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 16,
        attribution: '© Esri, HERE, Garmin, © OpenStreetMap contributors, GIS User Community',
        sharing: 'personal',
        hillshade: 0.45,
        background: '#dcdcd8',
        coverage: 'worldwide; black-and-white map without labels, terrain as hillshade',
    },
    'esri-dark': {
        id: 'esri-dark',
        label: 'Dark (Esri)',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 16,
        attribution: '© Esri, HERE, Garmin, © OpenStreetMap contributors, GIS User Community',
        sharing: 'personal',
        hillshade: 0.55,
        background: '#262626',
        coverage: 'worldwide',
    },
};

export function resolveBasemap(b: string | BasemapDef, apiKeys: Record<string, string | undefined> = {}): BasemapDef {
    const def = typeof b === 'string' ? BASEMAPS[b] : b;
    if (!def) throw new Error(`Unknown basemap: ${String(b)}`);
    if (!def.requiresKey) return def;
    const key = apiKeys[def.requiresKey];
    if (!key) throw new Error(`Basemap "${def.label}" needs an API key (apiKeys.${def.requiresKey}).`);
    return { ...def, tiles: def.tiles.map(t => t.replace('{apikey}', encodeURIComponent(key))) };
}
