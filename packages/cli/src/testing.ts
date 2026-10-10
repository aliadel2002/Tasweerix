import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Browser } from 'playwright-core';
import { halfToFloatTable } from '@tasweerix/core';
import { bundle } from './bundle';
import { launchBrowser } from './browser';
import { startRenderServer } from './server';

export interface RenderedFrame {
  width: number;
  height: number;
  /** rgba bytes, rgba64le when rendered at depth 16, or half-float rgba for HDR. */
  data: Buffer;
  /** RGBA at pixel (x, y): 0..255, 0..65535 at depth 16, or extended-sRGB floats for HDR. */
  at(x: number, y: number): [number, number, number, number];
}

let shared: Browser | undefined;
async function browser() {
  shared ??= await launchBrowser();
  return shared;
}
export async function closeTestBrowser(): Promise<void> {
  await shared?.close();
  shared = undefined;
}

/**
 * Renders frames of an entry (file path or inline source) in headless Chromium and returns pixels.
 * Used by tests across packages.
 */
export async function renderFrames(opts: { entry?: string; source?: string; dir?: string; root?: string; frames: number[]; scale?: number; comp?: string; props?: Record<string, unknown>; depth?: 8 | 16; gamut?: 'srgb' | 'display-p3'; hdr?: boolean }): Promise<{ info: Record<string, any>; frames: RenderedFrame[]; json: Record<string, unknown> }> {
  let entry = opts.entry;
  if (!entry) {
    const dir = opts.dir ?? join(process.cwd(), '.tasweerix-test');
    mkdirSync(dir, { recursive: true });
    entry = join(dir, `entry-${Math.random().toString(36).slice(2)}.ts`);
    writeFileSync(entry, opts.source!);
  }
  const { code } = await bundle({ entry, platform: 'browser' });
  const got = new Map<number, Buffer>();
  const server = await startRenderServer({ projectRoot: opts.root ?? dirname(entry), script: code, onFrame: (_c, f, d) => got.set(f, Buffer.from(d)) });
  const b = await browser();
  const page = await b.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.stack ?? e.message));
  try {
    await page.goto(`${server.url}/`);
    await page.waitForFunction(() => !!(window as any).__tx || !!(window as any).__txError, null, { timeout: 30_000 });
    const info = (await page.evaluate((o) => (window as any).__tx.init(o), { client: 0, scale: opts.scale, comp: opts.comp, props: opts.props, depth: opts.depth, gamut: opts.gamut, hdr: opts.hdr })) as Record<string, any>;
    for (const f of opts.frames) await page.evaluate((n) => (window as any).__tx.frame(n), f);
    const json = (await page.evaluate(() => (window as any).__tx.json())) as Record<string, unknown>;
    const t0 = Date.now();
    while (got.size < new Set(opts.frames).size && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 10));
    const w = info.outWidth as number;
    const h = info.outHeight as number;
    return {
      info,
      json,
      frames: opts.frames.map((f) => {
        const data = got.get(f)!;
        const at =
          opts.hdr
            ? (x: number, y: number) => { const i = (Math.round(y) * w + Math.round(x)) * 8; const t = halfToFloatTable(); return [0, 2, 4, 6].map((o) => t[data.readUInt16LE(i + o)]!) as [number, number, number, number]; }
            : opts.depth === 16
            ? (x: number, y: number) => { const i = (Math.round(y) * w + Math.round(x)) * 8; return [0, 2, 4, 6].map((o) => data.readUInt16LE(i + o)) as [number, number, number, number]; }
            : (x: number, y: number) => { const i = (Math.round(y) * w + Math.round(x)) * 4; return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!] as [number, number, number, number]; };
        return { width: w, height: h, data, at };
      }),
    };
  } catch (e) {
    throw new Error(`${(e as Error).message}\n${errors.join('\n')}`);
  } finally {
    await page.close();
    await server.close();
  }
}
