import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { FFMPEG, probe } from './ffmpeg';

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
  ) {}

  get frameSize(): number {
    return this.width * this.height * 4;
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
      '-vf', `fps=${this.fps},scale=${this.width}:${this.height}:flags=bicubic,format=rgba`,
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
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

  /** RGBA frame displayed at source time t (seconds). */
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

/** Pool of decoders keyed by file / size / client. */
export class FrameServer {
  private decoders = new Map<string, SequentialDecoder>();
  private timer?: NodeJS.Timeout;

  constructor(private maxIdleMs = 30_000) {}

  async frame(file: string, t: number, opts: { width?: number; height?: number; client?: string } = {}): Promise<{ data: Buffer; width: number; height: number }> {
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
    const key = `${file}|${w}x${h}|${opts.client ?? 0}`;
    let dec = this.decoders.get(key);
    if (!dec) {
      dec = new SequentialDecoder(file, w, h, fps);
      this.decoders.set(key, dec);
      this.scheduleCleanup();
    }
    return { data: await dec.frameAt(t), width: w, height: h };
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
