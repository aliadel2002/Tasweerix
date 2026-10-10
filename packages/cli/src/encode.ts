import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { FFMPEG } from '@tasweerix/media/node';

export type Codec = 'h264' | 'h265' | 'vp9' | 'av1' | 'prores' | 'gif' | 'png' | 'webp' | 'apng' | 'mjpeg';

export interface EncodeOptions {
  width: number;
  height: number;
  fps: number;
  codec: Codec;
  crf?: number;
  /** Keep alpha (prores 4444, vp9 yuva420p, png, webp). */
  alpha?: boolean;
  preset?: string;
  output: string;
  /** Input frame depth: 8 → rgba, 16 → rgba64le. Default 8. */
  depth?: 8 | 16;
  /**
   * With 16-bit input, store more than 8 bits where the codec can (16-bit PNG, 10-bit ProRes /
   * h265 / av1 / vp9). Default true; false always writes 8 bits (dithered).
   */
  keepDepth?: boolean;
}

/** Codecs that can store more than 8 bits per channel. h264 stays 8-bit (10-bit decoders are rare). */
export const HIGH_DEPTH_CODECS: ReadonlySet<Codec> = new Set<Codec>(['png', 'prores', 'h265', 'av1', 'vp9']);

/** Bits per channel the encoder actually stores for these options (8 or 16 input to ffmpeg). */
export function storedDepth(o: Pick<EncodeOptions, 'codec' | 'depth' | 'keepDepth' | 'alpha'>): 8 | 16 {
  // vp9 has no 10-bit alpha format.
  return o.depth === 16 && o.keepDepth !== false && HIGH_DEPTH_CODECS.has(o.codec) && !(o.codec === 'vp9' && o.alpha) ? 16 : 8;
}

/**
 * rgba64le → rgba with deterministic triangular (TPDF) dither of ±1 level on color channels; alpha
 * and exact black/white are rounded. ffmpeg truncates 16 → 8-bit RGB without dither, which bands.
 */
export function dither16to8(src: Uint8Array): Buffer {
  const n = src.length >> 1;
  const v16 = new Uint16Array(src.buffer, src.byteOffset, n);
  const out = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) {
    const v = v16[i]!;
    const x = (v * 255) / 65535;
    if ((i & 3) === 3 || v === 0 || v === 65535) out[i] = Math.round(x);
    else {
      const r = Math.round(x + (hash32(i) - hash32(i ^ 0x9e3779b9)) / 4294967296);
      out[i] = r < 0 ? 0 : r > 255 ? 255 : r;
    }
  }
  return out;
}

function hash32(n: number): number {
  n ^= n >>> 16;
  n = Math.imul(n, 0x7feb352d);
  n ^= n >>> 15;
  n = Math.imul(n, 0x846ca68b);
  n ^= n >>> 16;
  return n >>> 0;
}

export function defaultExtension(codec: Codec, alpha = false): string {
  switch (codec) {
    case 'h264':
    case 'h265':
    case 'av1':
      return alpha ? 'mov' : 'mp4';
    case 'vp9':
      return 'webm';
    case 'prores':
      return 'mov';
    case 'gif':
      return 'gif';
    case 'png':
      return 'png';
    case 'webp':
      return 'webp';
    case 'apng':
      return 'apng';
    case 'mjpeg':
      return 'avi';
  }
}

export function codecFromPath(path: string): Codec | undefined {
  const ext = path.split('.').pop()?.toLowerCase();
  return ({ mp4: 'h264', m4v: 'h264', mkv: 'h264', mov: 'prores', webm: 'vp9', gif: 'gif', png: 'png', webp: 'webp', apng: 'apng' } as Record<string, Codec>)[ext ?? ''];
}

function codecArgs(o: EncodeOptions): string[] {
  const crf = o.crf;
  const hi = storedDepth(o) === 16;
  switch (o.codec) {
    case 'h264':
      return ['-c:v', 'libx264', '-preset', o.preset ?? 'medium', '-crf', String(crf ?? 18), '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
    case 'h265':
      return ['-c:v', 'libx265', '-preset', o.preset ?? 'medium', '-crf', String(crf ?? 22), '-pix_fmt', hi ? 'yuv420p10le' : 'yuv420p', '-tag:v', 'hvc1', '-x265-params', 'log-level=error'];
    case 'av1':
      return ['-c:v', 'libsvtav1', '-crf', String(crf ?? 32), '-preset', o.preset ?? '8', '-pix_fmt', hi ? 'yuv420p10le' : 'yuv420p'];
    case 'vp9':
      return ['-c:v', 'libvpx-vp9', '-crf', String(crf ?? 30), '-b:v', '0', '-row-mt', '1', '-pix_fmt', o.alpha ? 'yuva420p' : hi ? 'yuv420p10le' : 'yuv420p'];
    case 'prores':
      return ['-c:v', 'prores_ks', '-profile:v', o.alpha ? '4444' : '3', '-pix_fmt', o.alpha ? 'yuva444p10le' : 'yuv422p10le', '-vendor', 'apl0'];
    case 'gif':
      return ['-vf', 'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a', '-loop', '0'];
    case 'webp':
      return ['-c:v', 'libwebp_anim', '-lossless', '0', '-q:v', '85', '-loop', '0'];
    case 'apng':
      return ['-c:v', 'apng', '-plays', '0'];
    case 'png':
      return ['-c:v', 'png'];
    case 'mjpeg':
      return ['-c:v', 'mjpeg', '-q:v', '2'];
  }
}

/** Streams raw RGBA frames into ffmpeg. */
export class FrameEncoder {
  private proc: ChildProcessWithoutNullStreams;
  private stderr: string[] = [];
  private done: Promise<void>;
  frames = 0;
  /** 16-bit frames are dithered down here when the output stores 8 bits. */
  private readonly dither: boolean;

  constructor(readonly opts: EncodeOptions) {
    const stored = storedDepth(opts);
    this.dither = opts.depth === 16 && stored === 8;
    const args = [
      '-y', '-v', 'error',
      '-f', 'rawvideo', '-pix_fmt', stored === 16 ? 'rgba64le' : 'rgba', '-s', `${opts.width}x${opts.height}`, '-r', String(opts.fps),
      '-i', '-',
      ...codecArgs(opts),
      ...(opts.codec === 'png' ? ['-f', 'image2'] : []),
      opts.output,
    ];
    this.proc = spawn(FFMPEG, args);
    this.proc.stderr.on('data', (d: Buffer) => this.stderr.push(d.toString()));
    this.done = new Promise((resolve, reject) => {
      this.proc.on('error', reject);
      this.proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${this.stderr.join('').slice(-2000)}`))));
    });
    this.proc.stdin.on('error', () => {});
  }

  async write(rgba: Buffer | Uint8Array): Promise<void> {
    this.frames++;
    if (this.dither) rgba = dither16to8(rgba);
    if (!this.proc.stdin.write(rgba)) await new Promise<void>((r) => this.proc.stdin.once('drain', () => r()));
  }

  async finish(): Promise<void> {
    this.proc.stdin.end();
    await this.done;
  }

  abort(): void {
    this.proc.kill('SIGKILL');
  }
}
