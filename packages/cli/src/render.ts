import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { buildIcc, type CanvasGamut, type Gamut, type HdrTransfer } from '@tasweerix/core';
import { embedIcc, run, FFMPEG } from '@tasweerix/media/node';
import { bundle } from './bundle';
import { launchRenderBrowser, type GpuMode } from './browser';
import { codecFromPath, FrameEncoder, HDR_CODECS, type Codec } from './encode';
import { startRenderServer } from './server';

export interface RenderOptions {
  entry: string;
  output: string;
  /** Project root for assets (defaults to the entry's directory). */
  root?: string;
  comp?: string;
  props?: Record<string, unknown>;
  codec?: Codec;
  crf?: number;
  preset?: string;
  scale?: number;
  /** Frame range [start, end] inclusive. */
  range?: [number, number];
  /** Parallel browser workers (default: one per CPU core, up to 4). */
  concurrency?: number;
  /** Keep alpha channel where the codec supports it. */
  transparent?: boolean;
  /** Render a single frame as an image (photo export). */
  still?: number;
  /** Skip audio muxing. */
  muted?: boolean;
  motionBlurSamples?: number;
  /** Node kinds to leave out of the render. */
  hide?: string[];
  transparentBackground?: boolean;
  /** Compositing and frame depth: 16 keeps more than 8 bits from decode to ffmpeg. Default 8. */
  depth?: 8 | 16;
  /**
   * Color space of the output: 'display-p3' or 'rec2020' composite in Display P3 (sRGB content is
   * converted, P3 sources and colors keep their range) and tag the file. Default 'srgb'.
   */
  gamut?: Gamut;
  /**
   * HDR output with the PQ or HLG transfer, in BT.2020: composites in extended-range half floats
   * (1.0 = 203-nit reference white; brighter colors, HDR sources and `color(srgb 2 2 2)` go above).
   * Video needs h265 (the default then), av1, vp9 or prores; stills png (cICP tagged) or avif.
   */
  hdr?: HdrTransfer;
  /** Peak luminance in nits written to HDR10 mastering metadata (PQ). Default 1000. */
  hdrPeak?: number;
  /** GPU use for WebGL: 'auto' (default, or TASWEERIX_GPU) uses a hardware GPU when one answers. */
  gpu?: GpuMode;
  /** Exact Chromium GL flags, overriding `gpu` (used to compare WebGL backends). */
  glFlags?: string[];
  onProgress?: (p: { done: number; total: number; fps: number; eta: number }) => void;
  log?: (msg: string) => void;
  /** Hook to render audio for the composition; returns a WAV path or undefined. */
  renderAudio?: (opts: { entry: string; root: string; comp?: string; props?: Record<string, unknown>; start: number; duration: number; workDir: string }) => Promise<string | undefined>;
}

export interface CompInfo {
  name: string;
  kind: string;
  width: number;
  height: number;
  outWidth: number;
  outHeight: number;
  fps: number;
  duration: number;
  frameCount: number;
  transparent: boolean;
}

async function openPage(browserPage: Page, url: string, init: Record<string, unknown>): Promise<CompInfo> {
  const errors: string[] = [];
  browserPage.on('pageerror', (e) => errors.push(e.stack ?? e.message));
  browserPage.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`[console.${m.type()}] ${m.text()}`);
  });
  await browserPage.goto(url);
  await browserPage.waitForFunction(() => !!(window as any).__tx || !!(window as any).__txError, null, { timeout: 60_000 });
  const err = await browserPage.evaluate(() => (window as any).__txError as string | undefined);
  if (err) throw new Error(`Page failed to load: ${err}`);
  try {
    return (await browserPage.evaluate((o) => (window as any).__tx.init(o), init)) as CompInfo;
  } catch (e) {
    throw new Error(`${(e as Error).message}\n${errors.join('\n')}`);
  }
}

/** Renders a composition to a video file, image sequence or still image. */
export async function render(opts: RenderOptions): Promise<{ output: string; info: CompInfo; seconds: number }> {
  const t0 = Date.now();
  const log = opts.log ?? (() => {});
  const entry = resolve(opts.entry);
  const root = resolve(opts.root ?? dirname(entry));
  const output = resolve(opts.output);
  mkdirSync(dirname(output), { recursive: true });
  const { code } = await bundle({ entry, platform: 'browser' });
  const work = mkdtempSync(join(tmpdir(), 'tasweerix-render-'));
  const encoders = new Map<number, FrameEncoder>();
  const pending = new Map<number, Promise<void>>();
  let onFrameDone: (() => void) | undefined;
  const server = await startRenderServer({
    projectRoot: root,
    script: code,
    onFrame: (client, _frame, data) => {
      const enc = encoders.get(client);
      if (!enc) return;
      const prev = pending.get(client) ?? Promise.resolve();
      pending.set(client, prev.then(() => enc.write(data)));
      onFrameDone?.();
    },
  });
  const rb = await launchRenderBrowser(opts.gpu, opts.glFlags);
  const browsers: Browser[] = [rb.browser];
  try {
    log(rb.gpu ? `WebGL on GPU: ${rb.renderer}` : `WebGL in software (${rb.renderer || 'unknown renderer'}): heavy filter stacks render slowly${opts.gpu === 'on' ? '; no GPU answered' : ''}`);
    const first = await rb.browser.newPage();
    const gamut = opts.gamut ?? 'srgb';
    // Canvases offer sRGB and Display P3; Rec. 2020 output is converted from P3 at encode.
    const inputGamut: CanvasGamut = gamut === 'srgb' ? 'srgb' : 'display-p3';
    const hdr = opts.hdr;
    const baseInit = { comp: opts.comp, props: opts.props, scale: opts.scale, motionBlurSamples: opts.motionBlurSamples, hide: opts.hide, transparentBackground: opts.transparentBackground, depth: hdr ? 16 : opts.depth, gamut: hdr ? 'srgb' : inputGamut, hdr: !!hdr };
    const isStill = opts.still !== undefined;
    if (hdr && isStill && !/\.(png|avif)$/i.test(output)) throw new Error('HDR stills are written as .png (cICP tagged) or .avif');
    const info = await openPage(first, `${server.url}/`, { ...baseInit, client: 0 });
    log(`${info.name}: ${info.outWidth}x${info.outHeight} @ ${info.fps}fps, ${info.frameCount} frames (${info.duration.toFixed(2)}s)`);

    // ---------- Still image
    if (isStill || info.kind === 'still') {
      const frame = opts.still ?? 0;
      if (hdr && !/\.(png|avif)$/i.test(output)) throw new Error('HDR stills are written as .png (cICP tagged) or .avif');
      if (hdr) {
        const enc = new FrameEncoder({ width: info.outWidth, height: info.outHeight, fps: 1, codec: 'png', output: join(work, 'still.png'), depth: 16, hdr, hdrPeak: opts.hdrPeak });
        encoders.set(0, enc);
        await first.evaluate((n) => (window as any).__tx.frame(n), frame);
        await waitFrames(pending, encoders, 1);
        await pending.get(0);
        await enc.finish();
        await convertHdrStill(join(work, 'still.png'), output, hdr);
        return { output, info, seconds: (Date.now() - t0) / 1000 };
      }
      const stillGamut = /\.(png|jpe?g|webp|tiff?|avif)$/i.test(output) ? gamut : 'srgb';
      const enc = new FrameEncoder({ width: info.outWidth, height: info.outHeight, fps: 1, codec: 'png', output: join(work, 'still.png'), depth: opts.depth, keepDepth: /\.(png|tiff?|avif)$/i.test(output), inputGamut, gamut: stillGamut });
      encoders.set(0, enc);
      await first.evaluate((n) => (window as any).__tx.frame(n), frame);
      await waitFrames(pending, encoders, 1);
      await pending.get(0);
      await enc.finish();
      await convertStill(join(work, 'still.png'), output, opts.depth, stillGamut);
      return { output, info, seconds: (Date.now() - t0) / 1000 };
    }

    // ---------- Video
    const codec = opts.codec ?? (hdr && /\.(mp4|mkv)$/i.test(output) ? 'h265' : undefined) ?? codecFromPath(output) ?? 'h264';
    if (hdr && !HDR_CODECS.has(codec)) throw new Error(`HDR video needs h265, av1, vp9, prores or png frames, not ${codec}`);
    const alpha = !!opts.transparent;
    const [start, end] = opts.range ?? [0, info.frameCount - 1];
    const total = end - start + 1;
    const workers = Math.max(1, Math.min(opts.concurrency ?? Math.min(4, availableParallelism()), Math.ceil(total / 15)));
    const chunk = Math.ceil(total / workers);
    const segExt = codec === 'png' ? 'png' : codec === 'gif' || codec === 'webp' || codec === 'apng' ? 'mov' : output.split('.').pop()!;
    const segCodec: Codec = codec === 'gif' || codec === 'webp' || codec === 'apng' ? 'prores' : codec;
    // One browser per worker: pages in one browser share its GPU process, which serializes their GL work.
    const pages: Page[] = [
      first,
      ...(await Promise.all(
        Array.from({ length: workers - 1 }, async (_, k) => {
          const b = await rb.launchAnother();
          browsers.push(b);
          const p = await b.newPage();
          await openPage(p, `${server.url}/`, { ...baseInit, client: k + 1 });
          return p;
        }),
      )),
    ];
    const segFiles: string[] = [];
    let done = 0;
    const startTime = Date.now();
    onFrameDone = () => {
      done++;
      const el = (Date.now() - startTime) / 1000;
      opts.onProgress?.({ done, total, fps: done / el, eta: (total - done) / Math.max(0.01, done / el) });
    };
    await Promise.all(
      pages.map(async (page, i) => {
        const s = start + i * chunk;
        const e = Math.min(end, s + chunk - 1);
        if (s > e) return;
        const seg = codec === 'png' ? join(output, `frame_%05d.png`) : join(work, `seg_${String(i).padStart(3, '0')}.${segExt}`);
        if (codec === 'png') mkdirSync(output, { recursive: true });
        segFiles[i] = seg;
        const enc = new FrameEncoder({ width: info.outWidth, height: info.outHeight, fps: info.fps, codec: segCodec, crf: opts.crf, preset: opts.preset, alpha: alpha || segCodec === 'prores', output: seg, depth: opts.depth, inputGamut, gamut: segCodec === codec ? gamut : 'srgb', hdr, hdrPeak: opts.hdrPeak });
        encoders.set(i, enc);
        await page.evaluate(([a, b]) => (window as any).__tx.frames(a, b), [s, e]);
        await waitFrames(pending, encoders, e - s + 1, i);
        await pending.get(i);
        await enc.finish();
      }),
    );
    if (codec === 'png') return { output, info, seconds: (Date.now() - t0) / 1000 };

    // Concatenate segments.
    let video = segFiles.length === 1 ? segFiles[0]! : join(work, `joined.${segExt}`);
    if (segFiles.length > 1) {
      const list = join(work, 'list.txt');
      writeFileSync(list, segFiles.filter(Boolean).map((f) => `file '${f}'`).join('\n'));
      await run(FFMPEG, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', video]);
    }
    // Animated image formats are encoded from the lossless intermediate.
    if (codec === 'gif' || codec === 'webp' || codec === 'apng') {
      const args =
        codec === 'gif'
          ? ['-vf', 'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a', '-loop', '0']
          : codec === 'webp'
            ? ['-c:v', 'libwebp_anim', '-q:v', '85', '-loop', '0']
            : ['-c:v', 'apng', '-plays', '0'];
      await run(FFMPEG, ['-y', '-v', 'error', '-i', video, ...args, output]);
      return { output, info, seconds: (Date.now() - t0) / 1000 };
    }
    // Audio.
    let wav: string | undefined;
    if (!opts.muted && opts.renderAudio) {
      wav = await opts.renderAudio({ entry, root, comp: opts.comp, props: opts.props, start: start / info.fps, duration: total / info.fps, workDir: work });
    }
    if (wav) {
      const audioCodec = output.endsWith('.webm') ? ['-c:a', 'libopus', '-b:a', '192k'] : output.endsWith('.mov') && codec === 'prores' ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'aac', '-b:a', '256k'];
      await run(FFMPEG, ['-y', '-v', 'error', '-i', video, '-i', wav, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', ...audioCodec, '-shortest', output]);
    } else {
      await run(FFMPEG, ['-y', '-v', 'error', '-i', video, '-c', 'copy', output]);
    }
    return { output, info, seconds: (Date.now() - t0) / 1000 };
  } finally {
    for (const e of encoders.values()) e.abort();
    await Promise.all(browsers.map((b) => b.close().catch(() => {})));
    await server.close();
    rmSync(work, { recursive: true, force: true });
  }
}

/** Waits until the encoder for a client has received `count` frames over the socket. */
async function waitFrames(pending: Map<number, Promise<void>>, encoders: Map<number, FrameEncoder>, count: number, client = 0) {
  const t0 = Date.now();
  for (;;) {
    await pending.get(client);
    if ((encoders.get(client)?.frames ?? 0) >= count) return;
    if (Date.now() - t0 > 60_000) throw new Error('Timed out waiting for frames from the browser');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Writes an HDR still from the 16-bit PQ / HLG PNG: copied (its cICP chunk is the tag) or as tagged 10-bit AVIF. */
async function convertHdrStill(png: string, output: string, transfer: HdrTransfer) {
  if (/\.png$/i.test(output)) {
    const { copyFileSync } = await import('node:fs');
    copyFileSync(png, output);
    return;
  }
  await run(FFMPEG, ['-y', '-v', 'error', '-i', png, '-c:v', 'libaom-av1', '-still-picture', '1', '-crf', '20', '-vf', 'scale=out_color_matrix=bt2020nc:out_range=pc', '-pix_fmt', 'yuv420p10le', '-color_range', 'pc', '-color_primaries', 'bt2020', '-color_trc', transfer === 'pq' ? 'smpte2084' : 'arib-std-b67', '-colorspace', 'bt2020nc', output]);
}

/** Converts the PNG still (already in `gamut`, with its ICC profile) to the output format, keeping the color tag. */
async function convertStill(png: string, output: string, depth: 8 | 16 = 8, gamut: Gamut = 'srgb') {
  const ext = output.split('.').pop()!.toLowerCase();
  if (ext === 'png') {
    const { copyFileSync } = await import('node:fs');
    copyFileSync(png, output);
    return;
  }
  // A 16-bit intermediate keeps its depth in TIFF (rgba64le) and AVIF (10-bit); jpg/webp get a dithered 8-bit one.
  // AVIF is stored as YUV when it holds more than 8 bits or a wide gamut (RGB AVIF loses its
  // primaries tag in this ffmpeg), with an explicit matrix so decoders don't fall back to BT.601.
  const yuvAvif = depth === 16 || gamut !== 'srgb';
  const matrix = gamut === 'rec2020' ? 'bt2020nc' : 'bt709';
  const avif = ['-c:v', 'libaom-av1', '-still-picture', '1', '-crf', '20'];
  if (yuvAvif) avif.push('-vf', `scale=out_color_matrix=${matrix}:out_range=pc`, '-pix_fmt', depth === 16 ? 'yuv420p10le' : 'yuv420p', '-color_range', 'pc', '-color_primaries', gamut === 'rec2020' ? 'bt2020' : gamut === 'display-p3' ? 'smpte432' : 'bt709', '-color_trc', 'iec61966-2-1', '-colorspace', matrix);
  const args = ext === 'jpg' || ext === 'jpeg' ? ['-q:v', '2'] : ext === 'webp' ? ['-c:v', 'libwebp', '-q:v', '90'] : ext === 'avif' ? avif : [];
  await run(FFMPEG, ['-y', '-v', 'error', '-i', png, ...args, output]);
  // ffmpeg drops the PNG's ICC profile; put it back (AVIF carries its gamut in the tags above).
  if (gamut !== 'srgb' && /^(jpe?g|webp|tiff?)$/.test(ext)) {
    const { readFileSync } = await import('node:fs');
    writeFileSync(output, embedIcc(readFileSync(output), buildIcc(gamut)));
  }
}
