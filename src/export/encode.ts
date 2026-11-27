/**
 * Frame-by-frame video encoding with WebCodecs (via mediabunny).
 *
 * Each frame gets an exact timestamp, so the video plays at a constant frame
 * rate no matter how long a frame took to render (waiting for tiles etc.).
 * Screen recording (MediaRecorder) cannot guarantee that.
 */
import {
    Output, Mp4OutputFormat, WebMOutputFormat, BufferTarget, CanvasSource, getFirstEncodableVideoCodec,
    type VideoCodec,
} from 'mediabunny';

export type VideoFormat = 'mp4' | 'webm';

export interface EncodeOptions {
    format: VideoFormat;
    width: number;
    height: number;
    fps: number;
    frameCount: number;
    /** Draw frame i into ctx (output size). May be async (wait for map tiles). */
    drawFrame(i: number, ctx: OffscreenCanvasRenderingContext2D): Promise<void> | void;
    onProgress?(fraction: number): void;
    signal?: AbortSignal;
    /** Bits per second. Default ≈ 0.2 bit per pixel per frame (aerial imagery is detailed). */
    bitrate?: number;
}

export interface EncodedVideo {
    blob: Blob;
    mimeType: string;
    extension: string;
    codec: VideoCodec;
}

/** What `encodeVideo` returns: the video plus how long it waited for the encoder. */
export interface EncodeResult extends EncodedVideo {
    frames: number;
    /** ms spent waiting for the encoder (backpressure) and finishing the file. */
    encodeWait: number;
}

/** Codec preference: H.264 in MP4 is what every social network accepts. */
const CODECS: Record<VideoFormat, VideoCodec[]> = {
    mp4: ['avc', 'hevc', 'av1', 'vp9'],
    webm: ['vp9', 'av1', 'vp8'],
};

export async function canEncode(format: VideoFormat, width: number, height: number): Promise<VideoCodec | null> {
    if (typeof VideoEncoder === 'undefined') return null;
    return getFirstEncodableVideoCodec(CODECS[format], { width, height });
}

export async function encodeVideo(o: EncodeOptions): Promise<EncodeResult> {
    const codec = await canEncode(o.format, o.width, o.height);
    if (!codec) throw new Error(`This browser cannot encode ${o.format.toUpperCase()} ${o.width}×${o.height} (WebCodecs).`);

    const canvas = new OffscreenCanvas(o.width, o.height);
    const ctx = canvas.getContext('2d')!;
    const output = new Output({
        format: o.format === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
        target: new BufferTarget(),
    });
    const bitrate = o.bitrate ?? Math.round(Math.min(24e6, Math.max(6e6, o.width * o.height * o.fps * 0.2)));
    const source = new CanvasSource(canvas, { codec, bitrate, keyFrameInterval: 2 });
    output.addVideoTrack(source, { frameRate: o.fps });
    await output.start();

    let encodeWait = 0;
    try {
        // add() captures the canvas at once and encodes in the background, so the next frame is
        // drawn while the previous one is being encoded. Waiting for the previous add() before
        // the next one keeps the encoder's backpressure (at most one frame in flight).
        let pending: Promise<void> | null = null;
        for (let i = 0; i < o.frameCount; i++) {
            if (o.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
            await o.drawFrame(i, ctx);
            const w0 = performance.now();
            await pending;
            encodeWait += performance.now() - w0;
            const added = source.add(i / o.fps, 1 / o.fps);
            added.catch(() => {}); // surfaced by the await above or below, never unhandled
            pending = added;
            o.onProgress?.((i + 1) / o.frameCount);
        }
        const w0 = performance.now();
        await pending;
        await output.finalize();
        encodeWait += performance.now() - w0;
    } catch (err) {
        if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => {});
        throw err;
    }

    const mimeType = output.format.mimeType;
    return {
        blob: new Blob([output.target.buffer!], { type: mimeType }),
        mimeType,
        extension: o.format,
        codec,
        frames: o.frameCount,
        encodeWait,
    };
}
