import { hashSeed, type CanvasGamut, type Env, type MediaInfo } from '@tasweerix/core';
import { float16Surface, type AssetProvider, type Drawable } from '@tasweerix/render';

export interface BrowserAssetOptions {
  /** Base URL that relative asset paths are resolved against. */
  baseUrl?: string;
  /**
   * How video frames are obtained:
   *  - 'server': exact frames decoded by ffmpeg on a Tasweerix server (export, accurate scrubbing)
   *  - 'element': HTMLVideoElement seeking (fast preview, depends on browser codecs)
   */
  video?: 'server' | 'element';
  /** Server origin providing /__tx endpoints (defaults to baseUrl's origin). */
  server?: string;
  /** Client id so the server can keep one sequential decoder per render worker. */
  clientId?: string | number;
  /**
   * 16: decode high bit-depth images and server video frames at 16 bits into float16 canvases
   * (for a Renderer with `depth: 16`). Default 8.
   */
  depth?: 8 | 16;
  /**
   * Working gamut of the Renderer these assets feed. With 'display-p3' the server converts
   * wide-gamut video and 16-bit stills into P3 instead of clipping them to sRGB. Default 'srgb'.
   */
  gamut?: CanvasGamut;
}

const colorSpaceHeader = (res: Response): CanvasGamut => (res.headers.get('x-color-space') === 'display-p3' ? 'display-p3' : 'srgb');

function joinUrl(base: string, src: string): string {
  if (/^(https?:|data:|blob:)/.test(src)) return src;
  if (src.startsWith('/')) return new URL(src, base).toString();
  return new URL(src, base.endsWith('/') ? base : `${base}/`).toString();
}

const defaultBase = (): string => (typeof location !== 'undefined' ? location.href : 'http://localhost/');

/** Asset provider for browsers (studio preview and the headless export page). */
export class BrowserAssets implements AssetProvider {
  readonly baseUrl: string;
  readonly server: string;
  videoMode: 'server' | 'element';
  clientId: string;
  readonly depth: 8 | 16;
  readonly gamut: CanvasGamut;
  private images = new Map<string, Drawable>();
  private pendingImages = new Map<string, Promise<Drawable>>();
  private fonts = new Map<string, Promise<string>>();
  private videos = new Map<string, HTMLVideoElement>();
  private videoQueue = new Map<string, Promise<unknown>>();

  constructor(opts: BrowserAssetOptions = {}) {
    this.baseUrl = opts.baseUrl ?? defaultBase();
    this.server = opts.server ?? new URL(this.baseUrl).origin;
    this.videoMode = opts.video ?? 'server';
    this.clientId = String(opts.clientId ?? 0);
    this.depth = opts.depth ?? 8;
    this.gamut = opts.gamut ?? 'srgb';
  }

  url(src: string): string {
    return joinUrl(this.baseUrl, src);
  }

  async loadImage(src: string): Promise<Drawable> {
    const hit = this.images.get(src);
    if (hit) return hit;
    let p = this.pendingImages.get(src);
    if (!p) {
      p = (async () => {
        if (this.depth === 16) {
          const hi = await this.loadImage16(src);
          if (hi) {
            const s = float16Surface(hi.width, hi.height, hi.data, hi.colorSpace) as Drawable;
            this.images.set(src, s);
            return s;
          }
        }
        const res = await fetch(this.url(src));
        if (!res.ok) throw new Error(`Failed to load image ${src}: ${res.status}`);
        const blob = await res.blob();
        const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'default', colorSpaceConversion: 'default' });
        this.images.set(src, bmp);
        return bmp;
      })();
      this.pendingImages.set(src, p);
    }
    return p;
  }

  private images16 = new Map<string, Promise<{ width: number; height: number; data: Uint16Array; colorSpace: CanvasGamut } | undefined>>();

  /**
   * 16-bit decode through the Tasweerix server (`/__tx/image16`), with the embedded color profile
   * applied; undefined for 8-bit sources or without a server.
   */
  loadImage16(src: string): Promise<{ width: number; height: number; data: Uint16Array; colorSpace: CanvasGamut } | undefined> {
    let p = this.images16.get(src);
    if (!p) {
      p = (async () => {
        if (/^(https?:|data:|blob:)/.test(src)) return undefined;
        let res: Response;
        try {
          res = await fetch(`${this.server}/__tx/image16?${new URLSearchParams({ src, gamut: this.gamut })}`);
        } catch {
          return undefined;
        }
        if (res.status !== 200) return undefined;
        const width = Number(res.headers.get('x-width'));
        const height = Number(res.headers.get('x-height'));
        return { width, height, data: new Uint16Array(await res.arrayBuffer()), colorSpace: colorSpaceHeader(res) };
      })();
      this.images16.set(src, p);
    }
    return p;
  }

  getImage(src: string): Drawable | undefined {
    return this.images.get(src);
  }

  /** Registers an in-memory image (e.g. generated content) under a name. */
  putImage(name: string, img: Drawable): void {
    this.images.set(name, img);
  }

  async videoFrame(src: string, time: number, hint?: { width?: number; height?: number }): Promise<Drawable> {
    return this.videoMode === 'server' ? this.serverFrame(src, time, hint) : this.elementFrame(src, time);
  }

  private async serverFrame(src: string, time: number, hint?: { width?: number; height?: number }): Promise<Drawable> {
    const q = new URLSearchParams({ src, t: time.toFixed(6), client: this.clientId });
    if (hint?.width) q.set('w', String(hint.width));
    if (hint?.height) q.set('h', String(hint.height));
    if (this.depth === 16) q.set('depth', '16');
    if (this.gamut !== 'srgb') q.set('gamut', this.gamut);
    const res = await fetch(`${this.server}/__tx/frame?${q}`);
    if (!res.ok) throw new Error(`Frame request failed for ${src} @ ${time}: ${res.status} ${await res.text()}`);
    const w = Number(res.headers.get('x-width'));
    const h = Number(res.headers.get('x-height'));
    const colorSpace = colorSpaceHeader(res);
    if (this.depth === 16) return float16Surface(w, h, new Uint16Array(await res.arrayBuffer()), colorSpace) as Drawable;
    const buf = new Uint8ClampedArray(await res.arrayBuffer());
    return createImageBitmap(new ImageData(buf, w, h, colorSpace === 'srgb' ? undefined : { colorSpace }));
  }

  private async elementFrame(src: string, time: number): Promise<Drawable> {
    // Serialize seeks per element.
    const prev = this.videoQueue.get(src) ?? Promise.resolve();
    const job = prev.then(async () => {
      let v = this.videos.get(src);
      if (!v) {
        v = document.createElement('video');
        v.crossOrigin = 'anonymous';
        v.muted = true;
        v.preload = 'auto';
        v.playsInline = true;
        v.src = this.url(src);
        this.videos.set(src, v);
        await new Promise<void>((res, rej) => {
          v!.addEventListener('loadeddata', () => res(), { once: true });
          v!.addEventListener('error', () => rej(new Error(`Cannot load video ${src}`)), { once: true });
        });
      }
      const target = Math.min(Math.max(0, time), Math.max(0, (v.duration || 0) - 0.001));
      if (Math.abs(v.currentTime - target) > 0.0005 || v.readyState < 2) {
        await new Promise<void>((res) => {
          const done = () => res();
          v!.addEventListener('seeked', done, { once: true });
          v!.currentTime = target;
        });
      }
      return createImageBitmap(v);
    });
    this.videoQueue.set(src, job.catch(() => undefined));
    return job;
  }

  /** Direct access to the preview video element (for synchronized playback in the studio). */
  videoElement(src: string): HTMLVideoElement | undefined {
    return this.videos.get(src);
  }

  loadFont(src: string): Promise<string> {
    let p = this.fonts.get(src);
    if (!p) {
      p = (async () => {
        const family = `tx-${(hashSeed(src) >>> 0).toString(36)}`;
        const buf = await this.loadBinary(src);
        const face = new FontFace(family, buf);
        await face.load();
        const set = (typeof document !== 'undefined' ? document.fonts : (self as unknown as { fonts: FontFaceSet }).fonts) as FontFaceSet;
        set.add(face);
        return family;
      })();
      this.fonts.set(src, p);
    }
    return p;
  }

  async loadText(src: string): Promise<string> {
    const r = await fetch(this.url(src));
    if (!r.ok) throw new Error(`Failed to load ${src}: ${r.status}`);
    return r.text();
  }

  async loadBinary(src: string): Promise<ArrayBuffer> {
    const r = await fetch(this.url(src));
    if (!r.ok) throw new Error(`Failed to load ${src}: ${r.status}`);
    return r.arrayBuffer();
  }

  /** Decoded audio as interleaved float32 PCM from the server (falls back to WebAudio decoding). */
  async loadPcm(src: string, sampleRate = 48000, channels = 2): Promise<{ data: Float32Array[]; sampleRate: number }> {
    try {
      const r = await fetch(`${this.server}/__tx/pcm?${new URLSearchParams({ src, rate: String(sampleRate), channels: String(channels) })}`);
      if (!r.ok) throw new Error(String(r.status));
      const inter = new Float32Array(await r.arrayBuffer());
      const n = inter.length / channels;
      const data = Array.from({ length: channels }, () => new Float32Array(n));
      for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) data[c]![i] = inter[i * channels + c]!;
      return { data, sampleRate };
    } catch {
      const ctx = new OfflineAudioContext(channels, 1, sampleRate);
      const buf = await ctx.decodeAudioData(await this.loadBinary(src));
      return { data: Array.from({ length: channels }, (_, c) => buf.getChannelData(Math.min(c, buf.numberOfChannels - 1))), sampleRate: buf.sampleRate };
    }
  }

  endFrame(): void {}
}

/** Browser Env: probes media through the server, falling back to the browser's own decoders. */
export function browserEnv(assets: BrowserAssets): Env {
  const cache = new Map<string, Promise<MediaInfo>>();
  return {
    kind: 'browser',
    cache: {
      async get<T>(key: string, src?: string) {
        const r = await fetch(`${assets.server}/__tx/cache?${new URLSearchParams({ key, ...(src ? { src } : {}) })}`).catch(() => undefined);
        return r?.ok ? ((await r.json()) as T) : undefined;
      },
      async set(key, value, src) {
        await fetch(`${assets.server}/__tx/cache?${new URLSearchParams({ key, ...(src ? { src } : {}) })}`, { method: 'PUT', body: JSON.stringify(value) }).catch(() => undefined);
      },
    },
    async analyze(kind, src, params) {
      const r = await fetch(`${assets.server}/__tx/analyze`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, src, params }) });
      if (!r.ok) throw new Error(`analysis ${kind} failed: ${await r.text()}`);
      return r.json();
    },
    loadPcm: async (src, rate, ch) => (await assets.loadPcm(src, rate, ch)).data,
    loadBinary: (src) => assets.loadBinary(src),
    probe(src) {
      let p = cache.get(src);
      if (!p) {
        p = (async () => {
          try {
            const r = await fetch(`${assets.server}/__tx/probe?${new URLSearchParams({ src })}`);
            if (r.ok) return (await r.json()) as MediaInfo;
          } catch {
            /* fall through */
          }
          return probeInBrowser(assets.url(src));
        })();
        cache.set(src, p);
      }
      return p;
    },
  };
}

async function probeInBrowser(url: string): Promise<MediaInfo> {
  if (/\.(png|jpe?g|webp|gif|avif|bmp|svg)(\?|$)/i.test(url)) {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { width: img.naturalWidth, height: img.naturalHeight, hasVideo: true };
  }
  const isAudio = /\.(mp3|wav|aac|m4a|ogg|flac|opus)(\?|$)/i.test(url);
  const el = document.createElement(isAudio ? 'audio' : 'video') as HTMLVideoElement;
  el.preload = 'metadata';
  el.src = url;
  await new Promise<void>((res, rej) => {
    el.onloadedmetadata = () => res();
    el.onerror = () => rej(new Error(`Cannot probe ${url}`));
  });
  return { duration: el.duration, width: el.videoWidth || undefined, height: el.videoHeight || undefined, hasVideo: !isAudio, hasAudio: true };
}
