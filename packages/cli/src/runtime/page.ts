/**
 * Browser runtime for headless export. Loaded by Chromium; drives the renderer frame by frame and
 * streams raw RGBA frames back to the Node process over a WebSocket.
 */
import * as entry from 'tasweerix:entry';
import { isCompositionDefinition, setEnv, type Composition, type CompositionDefinition } from '@tasweerix/core';
import { Renderer } from '@tasweerix/render';
import { BrowserAssets, browserEnv } from '@tasweerix/media';

declare global {
  interface Window {
    __tx: {
      init(opts: InitOptions): Promise<Record<string, unknown>>;
      frame(n: number): Promise<void>;
      /** Renders and streams frames start..end (inclusive) without a round trip per frame. */
      frames(start: number, end: number): Promise<void>;
      json(): Record<string, unknown>;
      timings(): Record<string, number>;
    };
    __txError?: string;
  }
}

interface InitOptions {
  comp?: string;
  props?: Record<string, unknown>;
  scale?: number;
  client: number;
  motionBlurSamples?: number;
  /** Node kinds to leave out (graphics-only layers for interchange). */
  hide?: string[];
  /** Force a transparent background. */
  transparentBackground?: boolean;
  /** 16: composite in float16 and send rgba64le frames (8 bytes per pixel). Default 8. */
  depth?: 8 | 16;
}

let comp: Composition;
let renderer: Renderer;
let ws: WebSocket;
let timings: Record<string, number> = {};
let depth: 8 | 16 = 8;

function pickDefinition(name?: string): CompositionDefinition {
  const mod = entry as Record<string, unknown>;
  if (name) {
    const d = mod[name];
    if (!isCompositionDefinition(d)) throw new Error(`Export "${name}" is not a composition`);
    return d;
  }
  if (isCompositionDefinition(mod.default)) return mod.default;
  const first = Object.values(mod).find(isCompositionDefinition);
  if (!first) throw new Error('Entry has no composition export (export default composition(...))');
  return first;
}

window.__tx = {
  async init(opts) {
    depth = opts.depth ?? 8;
    const assets = new BrowserAssets({ baseUrl: `${location.origin}/project/`, server: location.origin, video: 'server', clientId: opts.client, depth });
    setEnv(browserEnv(assets));
    const def = pickDefinition(opts.comp);
    comp = await def.create({ props: opts.props });
    // Half-float GPU intermediates: export runs on software GL, where 'auto' would pick 8-bit and band.
    renderer = new Renderer({ assets, scale: opts.scale ?? comp.scale, motionBlurSamples: opts.motionBlurSamples, glPrecision: 'half', depth });
    if (opts.hide) renderer.skipKinds = new Set(opts.hide);
    if (opts.transparentBackground) comp.background = null;
    await renderer.prepare(comp);
    await document.fonts.ready;
    ws = new WebSocket(`ws://${location.host}/__tx/ws?client=${opts.client}`);
    ws.binaryType = 'arraybuffer';
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error('WebSocket failed'));
    });
    return {
      name: comp.name,
      kind: comp.kind,
      width: comp.width,
      height: comp.height,
      outWidth: Math.round(comp.width * renderer.scale),
      outHeight: Math.round(comp.height * renderer.scale),
      fps: comp.fps,
      duration: comp.duration,
      frameCount: comp.frameCount,
      transparent: comp.background === null,
      depth,
    };
  },
  async frame(n) {
    const t0 = performance.now();
    await renderer.renderFrame(comp, n);
    const t1 = performance.now();
    const px = depth === 16 ? new Uint8Array(renderer.pixels16().buffer) : renderer.pixels().data;
    const t2 = performance.now();
    timings = { render: t1 - t0, read: t2 - t1 };
    // Header: frame index (uint32) then pixels (rgba, or rgba64le at depth 16).
    const msg = new Uint8Array(4 + px.length);
    new DataView(msg.buffer).setUint32(0, n, true);
    msg.set(px, 4);
    ws.send(msg.buffer);
    // Wait until buffered data is flushed to keep memory bounded.
    while (ws.bufferedAmount > 64 * 1024 * 1024) await new Promise((r) => setTimeout(r, 2));
  },
  async frames(start, end) {
    for (let n = start; n <= end; n++) await window.__tx.frame(n);
  },
  timings() {
    return timings;
  },
  json() {
    return comp.toJSON();
  },
};

window.addEventListener('error', (e) => (window.__txError = String(e.error?.stack ?? e.message)));
window.addEventListener('unhandledrejection', (e) => (window.__txError = String((e.reason as Error)?.stack ?? e.reason)));
