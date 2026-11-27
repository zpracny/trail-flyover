/**
 * Minimal Mapbox Vector Tile reader: just enough to pull point features (with their properties)
 * out of chosen layers. No dependencies; lines and polygons are skipped.
 * Spec: https://github.com/mapbox/vector-tile-spec/tree/master/2.1
 */

export type MvtValue = string | number | boolean;

export interface MvtPoint {
    /** Position inside the tile, 0..1 from the top-left corner. */
    x: number;
    y: number;
    props: Record<string, MvtValue>;
}

class Reader {
    pos = 0;
    readonly buf: Uint8Array;
    readonly end: number;
    constructor(buf: Uint8Array, end = buf.length) {
        this.buf = buf;
        this.end = end;
    }

    varint(): number {
        let result = 0, shift = 0, b: number;
        do {
            if (this.pos >= this.end) throw new Error('MVT: truncated varint');
            b = this.buf[this.pos++];
            // Past 28 bits shifts overflow 32-bit ints; multiply instead (values stay < 2^53).
            result += shift < 28 ? (b & 0x7f) << shift : (b & 0x7f) * 2 ** shift;
            shift += 7;
        } while (b & 0x80 && shift < 70);
        return result;
    }

    /** Sub-reader over a length-delimited field; advances past it. */
    sub(): Reader {
        const len = this.varint();
        const start = this.pos;
        if (start + len > this.end) throw new Error('MVT: field runs past the end');
        this.pos += len;
        const r = new Reader(this.buf, start + len);
        r.pos = start;
        return r;
    }

    skip(wire: number) {
        if (wire === 0) this.varint();
        else if (wire === 1) this.pos += 8;
        else if (wire === 2) this.pos += this.varint();
        else if (wire === 5) this.pos += 4;
        else throw new Error(`MVT: unsupported wire type ${wire}`);
        if (this.pos > this.end) throw new Error('MVT: field runs past the end');
    }

    packed(): number[] {
        const r = this.sub();
        const out: number[] = [];
        while (r.pos < r.end) out.push(r.varint());
        return out;
    }
}

const zigzag = (n: number) => (n % 2 === 1 ? -(n + 1) / 2 : n / 2);
const utf8 = new TextDecoder();

function readValue(r: Reader): MvtValue | undefined {
    let v: MvtValue | undefined;
    while (r.pos < r.end) {
        const tag = r.varint(), field = tag >> 3, wire = tag & 7;
        if (field === 1 && wire === 2) {
            const s = r.sub();
            v = utf8.decode(r.buf.subarray(s.pos, s.end));
        } else if (field === 2 && wire === 5) {
            v = new DataView(r.buf.buffer, r.buf.byteOffset + r.pos, 4).getFloat32(0, true);
            r.pos += 4;
        } else if (field === 3 && wire === 1) {
            v = new DataView(r.buf.buffer, r.buf.byteOffset + r.pos, 8).getFloat64(0, true);
            r.pos += 8;
        } else if ((field === 4 || field === 5) && wire === 0) v = r.varint();
        else if (field === 6 && wire === 0) v = zigzag(r.varint());
        else if (field === 7 && wire === 0) v = r.varint() !== 0;
        else r.skip(wire);
    }
    return v;
}

/** Point features of the given layers, keyed by layer name. Throws on a malformed tile. */
export function readMvtPoints(data: Uint8Array, layers: string[]): Map<string, MvtPoint[]> {
    const out = new Map<string, MvtPoint[]>();
    const tile = new Reader(data);
    while (tile.pos < tile.end) {
        const tag = tile.varint();
        if (tag >> 3 !== 3 || (tag & 7) !== 2) { tile.skip(tag & 7); continue; }
        const layer = tile.sub();
        let name = '';
        let extent = 4096;
        const keys: string[] = [];
        const values: (MvtValue | undefined)[] = [];
        const features: { type: number; tags: number[]; geom: number[] }[] = [];
        while (layer.pos < layer.end) {
            const t = layer.varint(), field = t >> 3, wire = t & 7;
            if (field === 1 && wire === 2) { const s = layer.sub(); name = utf8.decode(layer.buf.subarray(s.pos, s.end)); }
            else if (field === 3 && wire === 2) { const s = layer.sub(); keys.push(utf8.decode(layer.buf.subarray(s.pos, s.end))); }
            else if (field === 4 && wire === 2) values.push(readValue(layer.sub()));
            else if (field === 5 && wire === 0) extent = layer.varint() || 4096;
            else if (field === 2 && wire === 2) {
                const f = layer.sub();
                const feat = { type: 0, tags: [] as number[], geom: [] as number[] };
                while (f.pos < f.end) {
                    const ft = f.varint(), ff = ft >> 3, fw = ft & 7;
                    if (ff === 2 && fw === 2) feat.tags = f.packed();
                    else if (ff === 3 && fw === 0) feat.type = f.varint();
                    else if (ff === 4 && fw === 2) feat.geom = f.packed();
                    else f.skip(fw);
                }
                features.push(feat);
            } else layer.skip(wire);
        }
        if (!layers.includes(name)) continue;
        const list = out.get(name) ?? [];
        for (const feat of features) {
            // type 1 = POINT; geometry starts with MoveTo(count) and zigzag dx, dy.
            if (feat.type !== 1 || feat.geom.length < 3 || (feat.geom[0] & 7) !== 1) continue;
            const props: Record<string, MvtValue> = {};
            for (let i = 0; i + 1 < feat.tags.length; i += 2) {
                const k = keys[feat.tags[i]], v = values[feat.tags[i + 1]];
                if (k !== undefined && v !== undefined) props[k] = v;
            }
            list.push({ x: zigzag(feat.geom[1]) / extent, y: zigzag(feat.geom[2]) / extent, props });
        }
        out.set(name, list);
    }
    return out;
}
