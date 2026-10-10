import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Page } from 'playwright-core';
import { run, FFMPEG } from '@tasweerix/media/node';
import { bundle } from './bundle';
import { launchBrowser } from './browser';
import { codecFromPath, FrameEncoder, type Codec } from './encode';
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
  const server = await startRenderServer({
    projectRoot: root,
    script: code,
    onFrame: (client, _frame, data) => {
      const enc = encoders.get(client);
      if (!enc) return;
      const prev = pending.get(client) ?? Promise.resolve();
      pending.set(client, prev.then(() => enc.write(data)));
    },
  });
  const browser = await launchBrowser();
  try {
    const first = await browser.newPage();
    const baseInit = { comp: opts.comp, props: opts.props, scale: opts.scale, motionBlurSamples: opts.motionBlurSamples, hide: opts.hide, transparentBackground: opts.transparentBackground, depth: opts.depth };
    const info = await openPage(first, `${server.url}/`, { ...baseInit, client: 0 });
    log(`${info.name}: ${info.outWidth}x${info.outHeight} @ ${info.fps}fps, ${info.frameCount} frames (${info.duration.toFixed(2)}s)`);

    // ---------- Still image
    if (opts.still !== undefined || info.kind === 'still') {
      const frame = opts.still ?? 0;
      const enc = new FrameEncoder({ width: info.outWidth, height: info.outHeight, fps: 1, codec: 'png', output: join(work, 'still.png'), depth: opts.depth });
      encoders.set(0, enc);
      await first.evaluate((n) => (window as any).__tx.frame(n), frame);
      await waitFrames(pending, encoders, 1);
      await pending.get(0);
      await enc.finish();
      await convertStill(join(work, 'still.png'), output);
      return { output, info, seconds: (Date.now() - t0) / 1000 };
    }

    // ---------- Video
    const codec = opts.codec ?? codecFromPath(output) ?? 'h264';
    const alpha = !!opts.transparent;
    const [start, end] = opts.range ?? [0, info.frameCount - 1];
    const total = end - start + 1;
    const workers = Math.max(1, Math.min(opts.concurrency ?? 1, Math.ceil(total / 15)));
    const chunk = Math.ceil(total / workers);
    const segExt = codec === 'png' ? 'png' : codec === 'gif' || codec === 'webp' || codec === 'apng' ? 'mov' : output.split('.').pop()!;
    const segCodec: Codec = codec === 'gif' || codec === 'webp' || codec === 'apng' ? 'prores' : codec;
    const pages: Page[] = [first];
    for (let i = 1; i < workers; i++) {
      const p = await browser.newPage();
      await openPage(p, `${server.url}/`, { ...baseInit, client: i });
      pages.push(p);
    }
    const segFiles: string[] = [];
    let done = 0;
    const startTime = Date.now();
    await Promise.all(
      pages.map(async (page, i) => {
        const s = start + i * chunk;
        const e = Math.min(end, s + chunk - 1);
        if (s > e) return;
        const seg = codec === 'png' ? join(output, `frame_%05d.png`) : join(work, `seg_${String(i).padStart(3, '0')}.${segExt}`);
        if (codec === 'png') mkdirSync(output, { recursive: true });
        segFiles[i] = seg;
        const enc = new FrameEncoder({ width: info.outWidth, height: info.outHeight, fps: info.fps, codec: segCodec, crf: opts.crf, preset: opts.preset, alpha: alpha || segCodec === 'prores', output: seg, depth: opts.depth });
        encoders.set(i, enc);
        for (let f = s; f <= e; f++) {
          await page.evaluate((n) => (window as any).__tx.frame(n), f);
          done++;
          const el = (Date.now() - startTime) / 1000;
          opts.onProgress?.({ done, total, fps: done / el, eta: (total - done) / Math.max(0.01, done / el) });
        }
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
    await browser.close().catch(() => {});
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

async function convertStill(png: string, output: string) {
  const ext = output.split('.').pop()!.toLowerCase();
  if (ext === 'png') {
    const { copyFileSync } = await import('node:fs');
    copyFileSync(png, output);
    return;
  }
  const args = ext === 'jpg' || ext === 'jpeg' ? ['-q:v', '2'] : ext === 'webp' ? ['-c:v', 'libwebp', '-q:v', '90'] : ext === 'avif' ? ['-c:v', 'libaom-av1', '-still-picture', '1', '-crf', '20'] : [];
  await run(FFMPEG, ['-y', '-v', 'error', '-i', png, ...args, output]);
}
