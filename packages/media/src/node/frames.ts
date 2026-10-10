import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { extendedLinearToSrgb, floatToHalf, gamutMatrix, toneMapLinear, type CanvasGamut, type Gamut } from '@tasweerix/core';
import { FFMPEG, primariesGamut, probe } from './ffmpeg';

const ZSCALE_PRIMARIES: Record<Gamut, string> = { srgb: 'bt709', 'display-p3': 'smpte432', rec2020: 'bt2020' };

/** zscale nominal peak for linearizing HDR: linear 1.0 = SDR reference white (203 nits). */
export const HDR_NPL = 203;

export function isHdrTransfer(transfer: string | undefined): transfer is 'smpte2084' | 'arib-std-b67' {
  return transfer === 'smpte2084' || transfer === 'arib-std-b67';
}

/**
 * Picks the decode for a video's tagged primaries: wide-gamut SDR sources are converted to
 * `target` by zscale, everything else is passed through as sRGB. HDR transfers are left alone.
 */
export function videoGamut(primaries: string | undefined, transfer: string | undefined, target: CanvasGamut): { filter: string; colorSpace: CanvasGamut } {
  const src = primariesGamut(primaries);
  if (!src || src === 'srgb' || transfer === 'smpte2084' || transfer === 'arib-std-b67') return { filter: '', colorSpace: 'srgb' };
  if (src === target) return { filter: '', colorSpace: target };
  return { filter: `zscale=primariesin=${ZSCALE_PRIMARIES[src]}:primaries=${ZSCALE_PRIMARIES[target]}:transferin=bt709:transfer=bt709,`, colorSpace: target };
}

/**
 * Sequential video decoder: keeps an ffmpeg process streaming RGBA frames from a start time, so
 * consecutive frame requests (the common case during export) cost one decode each. Seeking
 * backwards or far ahead restarts the stream at the requested time (accurate seek).
 */
export class SequentialDecoder {
  private proc?: ChildProcessWithoutNullStreams;
  private chunks: Buffer[] = [];
  private buffered = 0;
  private waiters: (() => void)[] = [];
  private ended = false;
  private streamStart = 0;
  private nextIndex = 0;
  private last?: { index: number; data: Buffer };
  private queue: Promise<unknown> = Promise.resolve();
  lastUsed = Date.now();

  constructor(
    readonly file: string,
    readonly width: number,
    readonly height: number,
    readonly fps: number,
    /**
     * 8 → `rgba` (4 bytes/px); 16 → `rgba64le` (8 bytes/px, keeps 10/12/16-bit sources); 32 → planar
     * linear float `gbrapf32le` (16 bytes/px) for HDR (PQ / HLG) sources, 1.0 = reference white.
     */
    readonly depth: 8 | 16 | 32 = 8,
    /** Filters run before scaling, e.g. a gamut conversion from `videoGamut`; for depth 32, the HDR transfer. */
    readonly prefilter = '',
  ) {}

  get frameSize(): number {
    return this.width * this.height * (this.depth === 32 ? 16 : this.depth === 16 ? 8 : 4);
  }

  private get pixFmt(): string {
    return this.depth === 32 ? 'gbrapf32le' : this.depth === 16 ? 'rgba64le' : 'rgba';
  }

  private get filter(): string {
    // Linearize HDR with zscale (which also scales, in float); everything else goes through swscale.
    if (this.depth === 32) return `fps=${this.fps},zscale=w=${this.width}:h=${this.height}:filter=bicubic:${this.prefilter}:transfer=linear:npl=${HDR_NPL},format=${this.pixFmt}`;
    return `${this.prefilter}fps=${this.fps},scale=${this.width}:${this.height}:flags=bicubic,format=${this.pixFmt}`;
  }

  private start(t: number) {
    this.stop();
    this.streamStart = t;
    this.nextIndex = 0;
    this.chunks = [];
    this.buffered = 0;
    this.ended = false;
    this.last = undefined;
    const args = [
      '-v', 'error',
      '-ss', t.toFixed(6),
      '-i', this.file,
      '-an', '-sn', '-dn',
      '-vf', this.filter,
      '-f', 'rawvideo', '-pix_fmt', this.pixFmt, '-',
    ];
    const p = spawn(FFMPEG, args);
    this.proc = p;
    p.stdout.on('data', (d: Buffer) => {
      this.chunks.push(d);
      this.buffered += d.length;
      this.wake();
      // Backpressure: pause when far ahead.
      if (this.buffered > this.frameSize * 8) p.stdout.pause();
    });
    p.stderr.on('data', () => {});
    p.on('close', () => {
      if (this.proc === p) {
        this.ended = true;
        this.wake();
      }
    });
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }

  private async readFrame(): Promise<Buffer | null> {
    const size = this.frameSize;
    while (this.buffered < size) {
      if (this.ended) return null;
      this.proc?.stdout.resume();
      await new Promise<void>((r) => this.waiters.push(r));
    }
    const out = Buffer.allocUnsafe(size);
    let off = 0;
    while (off < size) {
      const c = this.chunks[0]!;
      const take = Math.min(c.length, size - off);
      c.copy(out, off, 0, take);
      off += take;
      if (take === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(take);
    }
    this.buffered -= size;
    if (this.buffered < this.frameSize * 4) this.proc?.stdout.resume();
    return out;
  }

  /** Frame (per `depth`) displayed at source time t (seconds). */
  frameAt(t: number): Promise<Buffer> {
    const job = this.queue.then(() => this.frameAtUnqueued(t));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async frameAtUnqueued(t: number): Promise<Buffer> {
    this.lastUsed = Date.now();
    t = Math.max(0, t);
    const idx = Math.floor((t - this.streamStart) * this.fps + 1e-3);
    if (this.last && idx === this.last.index && this.proc) return this.last.data;
    if (!this.proc || idx < this.nextIndex || idx - this.nextIndex > this.fps * 2) {
      this.start(t);
      return this.frameAtUnqueued(t);
    }
    let frame: Buffer | null = null;
    while (this.nextIndex <= idx) {
      frame = await this.readFrame();
      if (!frame) break;
      this.last = { index: this.nextIndex, data: frame };
      this.nextIndex++;
    }
    if (!frame) {
      // Past the end: hold the last decoded frame, or decode the final frame explicitly.
      if (this.last) return this.last.data;
      if (t > 0.05) return this.frameAtUnqueued(Math.max(0, t - 0.5));
      return Buffer.alloc(this.frameSize);
    }
    return frame;
  }

  stop(): void {
    if (this.proc) {
      const p = this.proc;
      this.proc = undefined;
      p.stdout.removeAllListeners('data');
      p.kill('SIGKILL');
    }
  }
}

/**
 * Converts linear float `gbrap` planes (1.0 = reference white) to what the browser composites:
 * extended-sRGB half floats for an HDR render, or tone-mapped 8- or 16-bit RGBA in `gamut`
 * (`toneMap: false` clips instead, for sources whose white is already 1.0).
 */
export function linearPlanesToFrame(planes: Buffer, n: number, src: Gamut, opts: { depth?: 8 | 16; gamut?: CanvasGamut; hdr?: boolean; toneMap?: boolean }): { data: Buffer; colorSpace: CanvasGamut; format: 'rgba' | 'rgba64le' | 'rgba-float16' } {
  const f = new Float32Array(planes.buffer.slice(planes.byteOffset, planes.byteOffset + n * 16));
  const target: CanvasGamut = opts.hdr ? 'srgb' : (opts.gamut ?? 'srgb');
  const m = gamutMatrix(src, target);
  const depth = opts.depth ?? 8;
  const out = Buffer.alloc(n * (opts.hdr || depth === 16 ? 8 : 4));
  const o16 = new Uint16Array(out.buffer, out.byteOffset, out.length >> 1);
  for (let i = 0; i < n; i++) {
    const g = f[i]!, b = f[n + i]!, r = f[2 * n + i]!, a = Math.min(1, Math.max(0, f[3 * n + i]!));
    let R = m[0] * r + m[1] * g + m[2] * b, G = m[3] * r + m[4] * g + m[5] * b, B = m[6] * r + m[7] * g + m[8] * b;
    if (opts.hdr) {
      o16[i * 4] = floatToHalf(extendedLinearToSrgb(R));
      o16[i * 4 + 1] = floatToHalf(extendedLinearToSrgb(G));
      o16[i * 4 + 2] = floatToHalf(extendedLinearToSrgb(B));
      o16[i * 4 + 3] = floatToHalf(a);
      continue;
    }
    if (opts.toneMap !== false) [R, G, B] = toneMapLinear(Math.max(0, R), Math.max(0, G), Math.max(0, B));
    else [R, G, B] = [Math.max(0, R), Math.max(0, G), Math.max(0, B)];
    const enc = [extendedLinearToSrgb(R), extendedLinearToSrgb(G), extendedLinearToSrgb(B), a];
    if (depth === 16) for (let k = 0; k < 4; k++) o16[i * 4 + k] = Math.round(Math.min(1, enc[k]!) * 65535);
    else for (let k = 0; k < 4; k++) out[i * 4 + k] = Math.round(Math.min(1, enc[k]!) * 255);
  }
  return { data: out, colorSpace: target, format: opts.hdr ? 'rgba-float16' : depth === 16 ? 'rgba64le' : 'rgba' };
}

/** Pool of decoders keyed by file / size / client. */
export class FrameServer {
  private decoders = new Map<string, SequentialDecoder>();
  private timer?: NodeJS.Timeout;

  constructor(private maxIdleMs = 30_000) {}

  /** A frame, with `colorSpace` naming the space its pixels are in (converted toward `gamut` when the source is wide gamut). */
  async frame(
    file: string,
    t: number,
    opts: { width?: number; height?: number; client?: string; depth?: 8 | 16; gamut?: CanvasGamut; hdr?: boolean } = {},
  ): Promise<{ data: Buffer; width: number; height: number; colorSpace: CanvasGamut; format: 'rgba' | 'rgba64le' | 'rgba-float16' }> {
    const info = await probe(file);
    const natW = info.width ?? 16;
    const natH = info.height ?? 16;
    let w = opts.width ?? natW;
    let h = opts.height ?? natH;
    // Never upscale beyond the source; keep even dims, keep aspect if only one given.
    if (opts.width && !opts.height) h = Math.round((natH * w) / natW);
    if (opts.height && !opts.width) w = Math.round((natW * h) / natH);
    if (w > natW || h > natH) {
      w = natW;
      h = natH;
    }
    w = Math.max(2, Math.round(w));
    h = Math.max(2, Math.round(h));
    const fps = info.fps && info.fps < 240 ? info.fps : 30;
    if (isHdrTransfer(info.colorTransfer)) return this.hdrFrame(file, t, info.colorTransfer, info.colorPrimaries, w, h, fps, opts);
    const depth = opts.depth ?? 8;
    const g = videoGamut(info.colorPrimaries, info.colorTransfer, opts.gamut ?? 'srgb');
    const key = `${file}|${w}x${h}|${depth}|${g.colorSpace}|${opts.client ?? 0}`;
    let dec = this.decoders.get(key);
    if (!dec) {
      dec = new SequentialDecoder(file, w, h, fps, depth, g.filter);
      this.decoders.set(key, dec);
      this.scheduleCleanup();
    }
    return { data: await dec.frameAt(t), width: w, height: h, colorSpace: g.colorSpace, format: depth === 16 ? 'rgba64le' : 'rgba' };
  }

  /**
   * HDR (PQ / HLG) sources: decoded to linear float, then sent as extended-sRGB half floats for an
   * HDR render, or tone mapped into SDR (8 or 16 bits, in `gamut`) otherwise.
   */
  private async hdrFrame(file: string, t: number, transfer: 'smpte2084' | 'arib-std-b67', primaries: string | undefined, w: number, h: number, fps: number, opts: { client?: string; depth?: 8 | 16; gamut?: CanvasGamut; hdr?: boolean }): Promise<{ data: Buffer; width: number; height: number; colorSpace: CanvasGamut; format: 'rgba' | 'rgba64le' | 'rgba-float16' }> {
    const key = `${file}|${w}x${h}|hdr|${opts.client ?? 0}`;
    let dec = this.decoders.get(key);
    if (!dec) {
      dec = new SequentialDecoder(file, w, h, fps, 32, `transferin=${transfer}`);
      this.decoders.set(key, dec);
      this.scheduleCleanup();
    }
    const planes = await dec.frameAt(t);
    return { ...linearPlanesToFrame(planes, w * h, primariesGamut(primaries) ?? 'rec2020', opts), width: w, height: h };
  }

  private scheduleCleanup() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [k, d] of this.decoders) {
        if (now - d.lastUsed > this.maxIdleMs) {
          d.stop();
          this.decoders.delete(k);
        }
      }
      if (!this.decoders.size && this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    }, 5000);
    this.timer.unref();
  }

  close(): void {
    for (const d of this.decoders.values()) d.stop();
    this.decoders.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
