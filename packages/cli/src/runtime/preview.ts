/**
 * Studio preview runtime: bundled together with the user's project (with source maps) and loaded
 * by the studio UI. Exposes rendering, inspection, hit-testing and audio for the editor.
 */
import * as entry from 'tasweerix:entry';
import {
  isCompositionDefinition,
  isTrack,
  mat2d,
  parsePath,
  pathBounds,
  polygonPoints,
  setEnv,
  starPoints,
  type Composition,
  type CompositionDefinition,
  type Mat2D,
  type SceneNode,
  type Vec2,
  type BaseProps,
  type FrameContext,
} from '@tasweerix/core';
import { layoutText, fontFamilyFor, Renderer, type ResolvedText } from '@tasweerix/render';
import { BrowserAssets, browserEnv } from '@tasweerix/media';
import { renderMix, waveformPeaks } from '@tasweerix/audio';

globalThis.__TASWEERIX_TRACE__ = true;

export interface TimelineRow {
  id: string;
  name: string;
  kind: string;
  depth: number;
  start: number;
  end: number;
  frames: string[];
  keyframes: { prop: string; times: number[]; frames: string[] }[];
  parent?: string;
}

let comp: Composition | undefined;
let renderer: Renderer | undefined;
let assets: BrowserAssets;
const nodes = new Map<string, SceneNode>();

function definitions(): Record<string, CompositionDefinition> {
  const out: Record<string, CompositionDefinition> = {};
  for (const [k, v] of Object.entries(entry as Record<string, unknown>)) if (isCompositionDefinition(v)) out[k] = v;
  return out;
}

function world(n: SceneNode, frame: number): { m: Mat2D; local: FrameContext; props: Record<string, any> & BaseProps } | null {
  if (!comp) return null;
  const chain: SceneNode[] = [];
  for (let p: SceneNode | undefined = n; p && !p.meta.isRoot; p = p.parent) chain.unshift(p);
  let ctx = comp.contextAt(frame);
  let m = mat2d.identity();
  let local: FrameContext = ctx;
  let props: Record<string, any> & BaseProps = {} as never;
  for (const node of chain) {
    if (!node.activeAt(ctx.time)) return null;
    local = node.localCtx(ctx);
    props = node.evaluate(local) as typeof props;
    let pos = props.position;
    if ((node.props as Partial<BaseProps>).position === undefined && node.parent?.meta.isRoot) pos = [comp.width / 2, comp.height / 2];
    const sc: Vec2 = typeof props.scale === 'number' ? [props.scale, props.scale] : props.scale;
    m = mat2d.multiply(m, mat2d.compose(pos, sc, props.rotation, props.anchor, props.skew));
    ctx = node.childCtx(local);
  }
  return { m, local, props };
}

/** Local-space bounding box of a node's own content. */
function localBox(n: SceneNode, p: Record<string, any>): [number, number, number, number] | null {
  const size = p.size as Vec2 | null | undefined;
  switch (n.kind) {
    case 'rect':
    case 'ellipse':
    case 'canvas':
    case 'group':
      return size ? [-size[0] / 2, -size[1] / 2, size[0], size[1]] : null;
    case 'solid': {
      const s = size ?? [comp!.width, comp!.height];
      return [-s[0] / 2, -s[1] / 2, s[0], s[1]];
    }
    case 'polygon':
      return box(polygonPoints(p.sides, p.radius));
    case 'star':
      return box(starPoints(p.points, p.outerRadius, p.innerRadius));
    case 'path': {
      const b = pathBounds(parsePath(p.d));
      return [b.x, b.y, b.width, b.height];
    }
    case 'polyline':
      return box(p.points);
    case 'text': {
      const l = layoutText({ ...(p as ResolvedText), text: String(p.text), fontFamily: fontFamilyFor(p.font) });
      return [l.box.x, l.box.y, l.box.width, l.box.height];
    }
    case 'image':
    case 'photo':
    case 'video': {
      const s = size ?? [((n as unknown as { info?: { width?: number } }).info?.width ?? 100), ((n as unknown as { info?: { height?: number } }).info?.height ?? 100)];
      return [-s[0] / 2, -s[1] / 2, s[0], s[1]];
    }
    case 'comp': {
      const inner = (n as unknown as { inner?: Composition }).inner;
      return inner ? [-inner.width / 2, -inner.height / 2, inner.width, inner.height] : null;
    }
  }
  return null;
}
function box(pts: Vec2[]): [number, number, number, number] {
  const xs = pts.map((q) => q[0]);
  const ys = pts.map((q) => q[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
}

function quad(n: SceneNode, frame: number): Vec2[] | null {
  const w = world(n, frame);
  if (!w || !w.props.visible) return null;
  let b = localBox(n, w.props);
  if (!b && n.children.length) {
    // Union of children (in this node's space is complex) → approximate with world boxes of children.
    const pts = n.children.flatMap((c) => quad(c, frame) ?? []);
    if (!pts.length) return null;
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    return [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)], [Math.min(...xs), Math.max(...ys)]];
  }
  if (!b) return null;
  const [x, y, bw, bh] = b;
  return ([[x, y], [x + bw, y], [x + bw, y + bh], [x, y + bh]] as Vec2[]).map((pt) => mat2d.apply(w.m, pt));
}

function inside(q: Vec2[], p: Vec2): boolean {
  let c = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const [xi, yi] = q[i]!;
    const [xj, yj] = q[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

const api = {
  definitions: () => Object.keys(definitions()),
  async load(opts: { comp?: string; props?: Record<string, unknown>; canvas: HTMLCanvasElement; scale: number }) {
    assets = new BrowserAssets({ baseUrl: `${location.origin}/project/`, server: location.origin, video: 'server', clientId: 'studio' });
    setEnv(browserEnv(assets));
    const defs = definitions();
    const def = (opts.comp && defs[opts.comp]) || defs.default || Object.values(defs)[0];
    if (!def) throw new Error('This file exports no composition. Add: export default composition({...}, (c) => { ... })');
    comp = await def.create({ props: opts.props });
    renderer = new Renderer({ assets, scale: opts.scale, canvas: opts.canvas, motionBlurSamples: 6 });
    await renderer.prepare(comp);
    nodes.clear();
    comp.root.walk((n) => void nodes.set(n.id, n));
    return { name: comp.name, kind: comp.kind, width: comp.width, height: comp.height, fps: comp.fps, duration: comp.duration, frameCount: comp.frameCount, markers: comp.markers, hasAudio: comp.allAudioClips().length > 0 };
  },
  setScale(s: number) {
    if (renderer) renderer.scale = s;
  },
  async render(frame: number) {
    if (!comp || !renderer) return;
    await renderer.renderFrame(comp, frame);
  },
  timeline(): { rows: TimelineRow[]; audio: { id: string; name: string; start: number; end: number; src: string | null; frames: string[] }[] } {
    const rows: TimelineRow[] = [];
    if (!comp) return { rows, audio: [] };
    const visit = (n: SceneNode, depth: number) => {
      const start = n.globalStart();
      const d = n.effectiveDuration();
      let parentScale = 1;
      for (let p = n.parent; p; p = p.parent) parentScale /= p.speed || 1;
      const keyframes: TimelineRow['keyframes'] = [];
      for (const [k, v] of Object.entries(n.props)) {
        if (isTrack(v)) keyframes.push({ prop: k, times: v.keys.map((kf) => start + kf.t), frames: v.source?.frames ?? [] });
      }
      rows.push({ id: n.id, name: n.name ?? n.kind, kind: n.kind, depth, start, end: Number.isFinite(d) ? start + d * parentScale : comp!.duration, frames: n.source?.frames ?? [], keyframes, parent: n.parent?.meta.isRoot ? undefined : n.parent?.id });
      if (depth < 3) n.children.forEach((c) => visit(c, depth + 1));
    };
    comp.root.children.forEach((c) => visit(c, 0));
    const audio = comp.allAudioClips().map((a) => ({ id: a.id, name: a.name ?? a.src ?? a.generator?.kind ?? 'audio', start: a.start, end: Number.isFinite(a.end) ? a.end : comp!.duration, src: a.src, frames: a.source?.frames ?? [] }));
    return { rows, audio };
  },
  /** Evaluated props of a node at a frame (JSON-safe) and which props are animated. */
  inspect(id: string, frame: number) {
    const n = nodes.get(id);
    if (!n) return null;
    const w = world(n, frame);
    const props: Record<string, unknown> = {};
    const animated: string[] = [];
    const evaluated = w?.props ?? n.evaluate(comp!.contextAt(frame));
    for (const [k, v] of Object.entries(evaluated)) {
      if (typeof v === 'function' || (v && typeof v === 'object' && !Array.isArray(v) && !('type' in (v as object)) && k !== 'shadow' && k !== 'crop' && k !== 'features' && k !== 'variations')) continue;
      props[k] = v;
    }
    for (const [k, v] of Object.entries(n.props)) if (typeof v === 'function' || isTrack(v)) animated.push(k);
    return { id: n.id, kind: n.kind, name: n.name, start: n.start, duration: Number.isFinite(n.effectiveDuration()) ? n.effectiveDuration() : null, props, animated, explicit: Object.keys(n.props), frames: n.source?.frames ?? [], trackFrames: Object.fromEntries(Object.entries(n.props).filter(([, v]) => isTrack(v)).map(([k, v]) => [k, (v as { source?: { frames: string[] } }).source?.frames ?? []])), filters: n.filters.map((f) => f.kind) };
  },
  /** Topmost node under a composition-space point. */
  hitTest(x: number, y: number, frame: number): string | null {
    if (!comp) return null;
    let hit: string | null = null;
    const visit = (n: SceneNode) => {
      const q = quad(n, frame);
      if (q && inside(q, [x, y]) && n.kind !== 'group') hit = n.id;
      n.children.forEach(visit);
    };
    comp.root.children.forEach(visit);
    return hit;
  },
  bounds(id: string, frame: number): Vec2[] | null {
    const n = nodes.get(id);
    return n ? quad(n, frame) : null;
  },
  /** Position of a node's parent space for converting drags into prop values. */
  parentMatrix(id: string, frame: number): Mat2D | null {
    const n = nodes.get(id);
    if (!n || !n.parent || n.parent.meta.isRoot) return mat2d.identity();
    const w = world(n.parent, frame);
    return w ? w.m : null;
  },
  async audio(): Promise<{ sampleRate: number; channels: Float32Array[] } | null> {
    if (!comp || !comp.allAudioClips().length) return null;
    const { master } = await renderMix(comp, { load: async (src, sr, ch) => (await assets.loadPcm(src, sr, ch)).data, sampleRate: 48000 });
    return master;
  },
  async waveform(src: string, buckets: number) {
    const { data, sampleRate } = await assets.loadPcm(src, 8000, 1);
    const p = waveformPeaks({ sampleRate, channels: data }, buckets);
    return { min: Array.from(p.min), max: Array.from(p.max), duration: data[0]!.length / sampleRate };
  },
  json: () => comp?.toJSON(),
};

(window as unknown as { __txPreview: typeof api }).__txPreview = api;
export type PreviewApi = typeof api;
