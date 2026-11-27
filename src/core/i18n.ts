/**
 * Texts the library itself shows to the viewer: the default stats panel and the player's status
 * messages. English by default; pass `locale: 'cs'` or your own `strings` to the player.
 * Errors thrown to the developer are always in English.
 */
export interface Strings {
    distance: string;
    ascent: string;
    movingTime: string;
    time: string;
    elevation: string;
    /** Unit after an elevation, e.g. "512 m a.s.l.". */
    aboveSeaLevel: string;
    /** Decimal separator for distances. */
    decimal: string;
    /** Credit for the elevation model, e.g. "terrain: AWS Terrain Tiles". */
    terrainCredit: string;
    statusPlanning: string;
    statusElevation: string;
    statusTiles: string;
    statusVideo: string;
    statusImage: string;
    statusContextLost: string;
}

export type Locale = 'en' | 'cs';

export const STRINGS: Record<Locale, Strings> = {
    en: {
        distance: 'distance',
        ascent: 'ascent',
        movingTime: 'moving time',
        time: 'time',
        elevation: 'elevation',
        aboveSeaLevel: 'm a.s.l.',
        decimal: '.',
        terrainCredit: 'terrain: AWS Terrain Tiles',
        statusPlanning: 'Planning the camera path…',
        statusElevation: 'Loading the elevation model…',
        statusTiles: 'Loading map tiles…',
        statusVideo: 'Rendering the video…',
        statusImage: 'Rendering the image…',
        statusContextLost: 'The graphics card interrupted rendering, recovering…',
    },
    cs: {
        distance: 'vzdálenost',
        ascent: 'stoupání',
        movingTime: 'čas v pohybu',
        time: 'čas',
        elevation: 'výška',
        aboveSeaLevel: 'm n. m.',
        decimal: ',',
        terrainCredit: 'terén: AWS Terrain Tiles',
        statusPlanning: 'Počítám dráhu kamery…',
        statusElevation: 'Načítám výškový model…',
        statusTiles: 'Načítám mapové dlaždice…',
        statusVideo: 'Renderuji video…',
        statusImage: 'Renderuji fotku…',
        statusContextLost: 'Grafická karta přerušila vykreslování, obnovuji…',
    },
};

/** Strings for a locale with the app's own overrides on top. */
export function resolveStrings(locale: Locale | undefined, overrides?: Partial<Strings>): Strings {
    return { ...(STRINGS[locale ?? 'en'] ?? STRINGS.en), ...overrides };
}
