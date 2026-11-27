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
        label: 'Satelit (Esri)',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© Esri, Maxar, Earthstar Geographics',
        paint: { 'raster-saturation': -0.1, 'raster-contrast': 0.08 },
        sharing: 'personal',
        hillshade: 0,
        coverage: 'celý svět',
    },
    'esri-wayback-2022': {
        id: 'esri-wayback-2022',
        label: 'Satelit Esri – archiv 2022 (místy zima)',
        // Esri World Imagery Wayback release 2022-04-06: winter capture over parts of Šumava (e.g. Špičák).
        tiles: ['https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/48232/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© Esri World Imagery Wayback (2022), Maxar, Earthstar Geographics',
        sharing: 'personal',
        hillshade: 0,
        coverage: 'celý svět; sníh jen místy (Šumava – Špičák, Železná Ruda)',
    },
    'cuzk-ortofoto': {
        id: 'cuzk-ortofoto',
        label: 'Ortofoto ČR (ČÚZK)',
        tiles: ['https://ags.cuzk.gov.cz/arcgis1/rest/services/ORTOFOTO_WM/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 20,
        attribution: '© ČÚZK',
        paint: { 'raster-saturation': -0.05 },
        sharing: 'open',
        hillshade: 0,
        coverage: 'Česko (nejostřejší detail), za hranicí Esri',
        fallback: 'esri-satellite',
    },
    'esri-satellite-bw': {
        id: 'esri-satellite-bw',
        label: 'Satelit černobílý (Esri)',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© Esri, Maxar, Earthstar Geographics',
        // Same imagery, fully desaturated; a little more contrast so the coloured trail stands out.
        paint: { 'raster-saturation': -1, 'raster-contrast': 0.18, 'raster-brightness-max': 0.92 },
        sharing: 'personal',
        hillshade: 0,
        coverage: 'celý svět',
    },
    'opentopomap': {
        id: 'opentopomap',
        label: 'Turistická (OpenTopoMap)',
        tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://b.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://c.tile.opentopomap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 17,
        attribution: '© OpenStreetMap, SRTM | © OpenTopoMap (CC-BY-SA)',
        sharing: 'open',
        hillshade: 0.25,
        coverage: 'celý svět; pomalý server (dlaždice i několik sekund)',
    },
    'esri-topo': {
        id: 'esri-topo',
        label: 'Turistická (Esri Topo)',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© Esri, HERE, Garmin, Intermap, © OpenStreetMap',
        sharing: 'personal',
        hillshade: 0.15,
        coverage: 'celý svět, rychlý server',
    },
    'esri-light': {
        id: 'esri-light',
        label: 'Světlá šedá (Esri)',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 16,
        attribution: '© Esri, HERE, Garmin, © OpenStreetMap',
        sharing: 'personal',
        hillshade: 0.45,
        coverage: 'celý svět; černobílá mapa bez popisků, terén jen stínováním',
    },
    'esri-dark': {
        id: 'esri-dark',
        label: 'Tmavá (Esri)',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 16,
        attribution: '© Esri, HERE, Garmin, © OpenStreetMap',
        sharing: 'personal',
        hillshade: 0.55,
        coverage: 'celý svět',
    },
};

export function resolveBasemap(b: string | BasemapDef, apiKeys: Record<string, string | undefined> = {}): BasemapDef {
    const def = typeof b === 'string' ? BASEMAPS[b] : b;
    if (!def) throw new Error(`Neznámý mapový podklad: ${String(b)}`);
    if (!def.requiresKey) return def;
    const key = apiKeys[def.requiresKey];
    if (!key) throw new Error(`Podklad „${def.label}“ potřebuje API klíč (${def.requiresKey}).`);
    return { ...def, tiles: def.tiles.map(t => t.replace('{apikey}', encodeURIComponent(key))) };
}
