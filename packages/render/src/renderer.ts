import {
  AdjustmentNode,
  CompNode,
  Composition,
  isTrack,
  localContext,
  mat2d,
  resolve,
  SceneNode,
  type BaseProps,
  type FilterSpec,
  type FrameContext,
  type Mat2D,
  type Vec2,
} from '@tasweerix/core';
import type { AssetProvider } from './assets';
import { getFilter, LUMA_TO_ALPHA, MIX_FRAG, type FilterContext } from './filters';
import { GLPipeline, type Tex } from './gl';
import { toCanvasPaint } from './paint';
import { createSurface, ctx2d, SurfacePool, type Ctx2D, type Surface } from './surface';

/** Everything a drawer needs to draw one node's own content. */
export interface DrawContext {
  ctx: Ctx2D;
  node: SceneNode<any>;
  props: Record<string, any> & BaseProps;
  /** Node-local frame context. */
  frame: FrameContext;
  renderer: Renderer;
  /** World matrix (composition pixels) of the node's local space. */
  matrix: Mat2D;
  /** Draws the node's children (for drawers that handle children themselves). */
  drawChildren(): void;
}

export interface DrawerOptions {
  /** The drawer renders children itself (e.g. transition groups). */
  drawsChildren?: boolean;
  /** Extra prefetch for nodes that need async resources per frame. */
  collect?(node: SceneNode<any>, local: FrameContext, renderer: Renderer): Promise<void> | void;
  /** One-time async preparation before the first frame (fonts, processed images …). */
  prepare?(node: SceneNode<any>, renderer: Renderer): Promise<void>;
}

export type Drawer = (d: DrawContext) => void;

const drawers = new Map<string, { draw: Drawer; opts: DrawerOptions }>();
export function registerDrawer(kind: string, draw: Drawer, opts: DrawerOptions = {}): void {
  drawers.set(kind, { draw, opts });
}
export function getDrawer(kind: string) {
  return drawers.get(kind);
}

export interface RendererOptions {
  assets: AssetProvider;
  /** Output pixels per composition pixel (e.g. 0.5 for half-res previews, 2 for retina). */
  scale?: number;
  /** Sub-frame samples for motion blur. */
  motionBlurSamples?: number;
  /** Target canvas; created when omitted. */
  canvas?: Surface;
  /** GPU intermediate precision (see GLPipeline). */
  glPrecision?: 'auto' | 'half' | 'byte';
}

const BLEND: Record<string, GlobalCompositeOperation> = {
  normal: 'source-over',
  add: 'lighter',
};

/**
 * Renders compositions frame by frame. Stateless with respect to time: any frame can be
 * rendered in any order, which enables scrubbing and parallel export.
 */
export class Renderer {
  readonly assets: AssetProvider;
  scale: number;
  motionBlurSamples: number;
  glPrecision: 'auto' | 'half' | 'byte';
  canvas: Surface;
  ctx: Ctx2D;
  private pool: SurfacePool;
  private _gl?: GLPipeline;
  /** Video frames prefetched for the frame being rendered. */
  videoFrames = new Map<string, CanvasImageSource & { width: number; height: number }>();
  /** Per-frame cache for drawers. */
  frameCache = new Map<string, unknown>();
  comp?: Composition;
  private compStack: Composition[] = [];

  constructor(opts: RendererOptions) {
    this.assets = opts.assets;
    this.scale = opts.scale ?? 1;
    this.motionBlurSamples = opts.motionBlurSamples ?? 10;
    this.glPrecision = opts.glPrecision ?? 'auto';
    this.canvas = opts.canvas ?? createSurface(1, 1);
    this.ctx = ctx2d(this.canvas);
    this.pool = new SurfacePool(1, 1);
  }

  get gl(): GLPipeline {
    if (!this._gl) this._gl = new GLPipeline(1, 1, this.glPrecision);
    return this._gl;
  }

  get width(): number {
    return this.canvas.width;
  }
  get height(): number {
    return this.canvas.height;
  }

  /** Loads images, fonts, LUTs and other static assets used by the composition. */
  async prepare(comp: Composition): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    const ctx0 = comp.contextAt(0);
    const visit = (root: SceneNode) =>
      root.walk((n) => {
        if (n.maskSpec) visit(n.maskSpec.node);
        if (n.kind === 'comp' && (n as CompNode).inner) visit((n as CompNode).inner!.root);
        const src = n.props as Record<string, unknown>;
        if (n.kind === 'image' && typeof src.src === 'string') tasks.push(this.assets.loadImage(src.src));
        for (const v of Object.values(src)) {
          if (v && typeof v === 'object' && (v as { type?: string }).type === 'pattern') tasks.push(this.assets.loadImage((v as { src: string }).src));
        }
        for (const f of n.filters) {
          const impl = getFilter(f.kind);
          if (impl?.prepare) tasks.push(impl.prepare(staticParams(f, ctx0), this.assets));
        }
        const d = drawers.get(n.kind);
        if (d?.opts.prepare) tasks.push(d.opts.prepare(n, this));
        return undefined;
      });
    visit(comp.root);
    await Promise.all(tasks.map((t) => t.catch((e) => console.warn('[tasweerix] asset failed:', e?.message ?? e))));
  }

  /** Renders a frame into `this.canvas` (resized to comp size × scale). Supports fractional frames. */
  async renderFrame(comp: Composition, frame: number, props?: Record<string, unknown>): Promise<Surface> {
    this.comp = comp;
    const w = Math.max(1, Math.round(comp.width * this.scale));
    const h = Math.max(1, Math.round(comp.height * this.scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.ctx = ctx2d(this.canvas);
    }
    this.pool.resize(w, h);
    const ctx = comp.contextAt(frame, props);
    if (this._gl) this._gl.time = ctx.time;
    this.frameCache.clear();
    await this.collect(comp, ctx);
    this.compStack = [comp];
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, w, h);
    this.drawBackground(c, comp);
    this.renderChildren(comp.root, ctx, c, mat2d.scale(this.scale), 1);
    this._gl?.releaseAll();
    this.assets.endFrame?.();
    this.videoFrames.clear();
    return this.canvas;
  }

  /** Reads the last rendered frame. */
  pixels(): ImageData {
    return this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
  }

  private drawBackground(c: Ctx2D, comp: Composition) {
    if (!comp.background) return;
    const p = toCanvasPaint(c, comp.background, this.assets);
    if (!p) return;
    c.save();
    c.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    c.fillStyle = p;
    c.fillRect(0, 0, comp.width, comp.height);
    c.restore();
  }

  // ------------------------------------------------------------ prefetch

  /** Walks active nodes and prefetches async per-frame resources (video frames). */
  private async collect(comp: Composition, ctx: FrameContext): Promise<void> {
    const tasks: Promise<void>[] = [];
    const visit = (node: SceneNode, parentCtx: FrameContext, compDims: Composition) => {
      if (!node.activeAt(parentCtx.time) && !node.meta.isRoot) return;
      const local = node.meta.isRoot ? parentCtx : node.localCtx(parentCtx);
      const blur = (node.props as { motionBlur?: unknown }).motionBlur;
      const mb = blur !== undefined ? (resolve(blur as number, local) as number) : 0;
      const offsets = mb > 0 ? this.subframeOffsets(mb, compDims.fps) : [0];
      for (const off of offsets) {
        const l = off ? localContext(local, local.time + off, local.duration) : local;
        const d = drawers.get(node.kind);
        if (d?.opts.collect) {
          const r = d.opts.collect(node, l, this);
          if (r) tasks.push(r);
        }
        const cctx = node.meta.isRoot ? l : node.childCtx(l);
        if (node.maskSpec) visit(node.maskSpec.node, l, compDims);
        if (node.kind === 'comp' && (node as CompNode).inner) {
          const inner = (node as CompNode).inner!;
          const ic = inner.contextAt(node.contentTime(l) * inner.fps, parentCtx.props);
          visit(inner.root, ic, inner);
        }
        for (const ch of node.children) visit(ch, cctx, compDims);
      }
    };
    visit(comp.root, ctx, comp);
    await Promise.all(tasks);
  }

  subframeOffsets(shutterDeg: number, fps: number): number[] {
    const n = Math.max(2, this.motionBlurSamples);
    const span = shutterDeg / 360 / fps;
    return Array.from({ length: n }, (_, i) => (i / (n - 1) - 0.5) * span);
  }

  // ------------------------------------------------------------ traversal

  /** Renders the children of `parent` (in parent's content time) onto target. */
  renderChildren(parent: SceneNode, childCtx: FrameContext, target: Ctx2D, parentMatrix: Mat2D, alpha: number): void {
    for (const child of parent.children) {
      if (child.kind === 'adjustment') {
        if (child.activeAt(childCtx.time)) this.applyAdjustment(child as AdjustmentNode, child.localCtx(childCtx), target);
        continue;
      }
      this.renderNode(child, childCtx, target, parentMatrix, alpha);
    }
  }

  /** Local matrix of a node given its resolved props. */
  localMatrix(node: SceneNode, p: BaseProps, frame: FrameContext): Mat2D {
    let pos = p.position;
    if ((node.props as Partial<BaseProps>).position === undefined && node.parent?.meta.isRoot) pos = [frame.width / 2, frame.height / 2];
    const sc: Vec2 = typeof p.scale === 'number' ? [p.scale, p.scale] : p.scale;
    return mat2d.compose(pos, sc, p.rotation, p.anchor, p.skew);
  }

  renderNode(node: SceneNode, parentCtx: FrameContext, target: Ctx2D, parentMatrix: Mat2D, alpha: number): void {
    if (!node.activeAt(parentCtx.time)) return;
    const local = node.localCtx(parentCtx);
    const props = node.evaluate(local) as Record<string, any> & BaseProps;
    if (!props.visible || props.opacity <= 0) return;
    const matrix = mat2d.multiply(parentMatrix, this.localMatrix(node, props, local));
    const blend = BLEND[props.blend] ?? (props.blend as GlobalCompositeOperation);
    const hasAdjustChild = node.children.some((c) => c.kind === 'adjustment');
    const groupish = node.children.length > 0;
    const needsLayer =
      node.filters.length > 0 ||
      !!node.maskSpec ||
      props.motionBlur > 0 ||
      hasAdjustChild ||
      (groupish && (props.opacity < 1 || blend !== 'source-over' || !!props.shadow)) ||
      !!node.clip;

    if (!needsLayer) {
      target.globalAlpha = alpha * props.opacity;
      target.globalCompositeOperation = blend;
      this.applyShadow(target, props);
      this.drawContent(node, props, local, target, matrix, alpha * props.opacity);
      this.clearShadow(target);
      target.globalCompositeOperation = 'source-over';
      return;
    }

    const layer = this.pool.acquire();
    if (props.motionBlur > 0) {
      const offs = this.subframeOffsets(props.motionBlur, this.compStack[this.compStack.length - 1]?.fps ?? 30);
      const tmp = this.pool.acquire();
      for (const off of offs) {
        tmp.ctx.setTransform(1, 0, 0, 1, 0, 0);
        tmp.ctx.clearRect(0, 0, this.pool.width, this.pool.height);
        const pc = localContext(parentCtx, parentCtx.time + off, parentCtx.duration);
        const l2 = node.localCtx(pc);
        const p2 = node.evaluate(l2) as Record<string, any> & BaseProps;
        const m2 = mat2d.multiply(parentMatrix, this.localMatrix(node, p2, l2));
        this.drawContent(node, p2, l2, tmp.ctx, m2, 1);
        layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
        layer.ctx.globalAlpha = 1 / offs.length;
        layer.ctx.globalCompositeOperation = 'lighter';
        layer.ctx.drawImage(tmp.surface, 0, 0);
      }
      layer.ctx.globalAlpha = 1;
      layer.ctx.globalCompositeOperation = 'source-over';
      this.pool.release(tmp.surface);
    } else {
      if (node.clip) this.clipToSize(layer.ctx, props, matrix);
      this.drawContent(node, props, local, layer.ctx, matrix, 1);
      if (node.clip) layer.ctx.restore();
    }

    if (node.maskSpec) this.applyMask(node, local, layer.ctx, layer.surface, matrix);
    if (node.filters.length) this.applyFilters(node.filters, local, layer.ctx, layer.surface);

    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalAlpha = alpha * props.opacity;
    target.globalCompositeOperation = blend;
    this.applyShadow(target, props, true);
    target.drawImage(layer.surface, 0, 0);
    target.restore();
    this.pool.release(layer.surface);
  }

  private clipToSize(ctx: Ctx2D, props: Record<string, any>, matrix: Mat2D) {
    const size = props.size as Vec2 | null | undefined;
    ctx.save();
    if (!size) return;
    ctx.setTransform(...matrix);
    ctx.beginPath();
    ctx.rect(-size[0] / 2, -size[1] / 2, size[0], size[1]);
    ctx.clip();
  }

  /** Draws own content and children (no layering decisions). */
  drawContent(node: SceneNode, props: Record<string, any> & BaseProps, local: FrameContext, target: Ctx2D, matrix: Mat2D, alpha: number): void {
    const d = drawers.get(node.kind);
    const drawChildren = () => {
      const cctx = node.childCtx(local);
      this.renderChildren(node, cctx, target, matrix, alpha);
    };
    if (d) {
      target.setTransform(...matrix);
      target.globalAlpha = alpha;
      d.draw({ ctx: target, node, props, frame: local, renderer: this, matrix, drawChildren });
      if (d.opts.drawsChildren) return;
    }
    if (node.children.length) {
      const prevOp = target.globalCompositeOperation;
      target.globalCompositeOperation = 'source-over';
      drawChildren();
      target.globalCompositeOperation = prevOp;
    }
  }

  private applyShadow(target: Ctx2D, props: BaseProps, deviceSpace = false) {
    const s = props.shadow;
    if (!s) return;
    const k = deviceSpace ? this.scale : this.scale;
    target.shadowColor = s.color;
    target.shadowBlur = s.blur * k;
    target.shadowOffsetX = s.x * k;
    target.shadowOffsetY = s.y * k;
  }
  private clearShadow(target: Ctx2D) {
    target.shadowColor = 'transparent';
    target.shadowBlur = 0;
    target.shadowOffsetX = 0;
    target.shadowOffsetY = 0;
  }

  // ------------------------------------------------------------ masks, filters, adjustments

  private applyMask(node: SceneNode, local: FrameContext, layerCtx: Ctx2D, layerSurface: Surface, matrix: Mat2D) {
    const spec = node.maskSpec!;
    const m = this.pool.acquire();
    this.renderNode(spec.node, local, m.ctx, matrix, 1);
    let maskSurface: Surface = m.surface;
    if (spec.mode.startsWith('luma')) {
      const gl = this.gl;
      const t = gl.upload(m.surface);
      const l = gl.run(LUMA_TO_ALPHA, { uTex: t, uInvert: 0 });
      const img = gl.output(l);
      m.ctx.setTransform(1, 0, 0, 1, 0, 0);
      m.ctx.clearRect(0, 0, this.pool.width, this.pool.height);
      m.ctx.drawImage(img, 0, 0);
      img.close?.();
      gl.release(t);
      gl.release(l);
      maskSurface = m.surface;
    }
    layerCtx.save();
    layerCtx.setTransform(1, 0, 0, 1, 0, 0);
    layerCtx.globalAlpha = 1;
    layerCtx.globalCompositeOperation = spec.mode.endsWith('inverted') ? 'destination-out' : 'destination-in';
    layerCtx.drawImage(maskSurface, 0, 0);
    layerCtx.restore();
    void layerSurface;
    this.pool.release(m.surface);
  }

  /** Runs a filter chain over a surface in place. */
  applyFilters(filters: FilterSpec[], local: FrameContext, ctx: Ctx2D, surface: Surface): void {
    const gl = this.gl;
    const fc: FilterContext = { gl, frame: local, assets: this.assets, scale: this.scale };
    let tex: Tex = gl.upload(surface);
    for (const f of filters) {
      const impl = getFilter(f.kind);
      if (!impl) {
        console.warn(`[tasweerix] unknown filter "${f.kind}"`);
        continue;
      }
      const params = resolveParams(f, local);
      const amount = f.amount !== undefined ? resolve(f.amount, local) : 1;
      if (amount <= 0) continue;
      const out = impl.apply(tex, params, fc);
      if (amount < 1) {
        const mixed = gl.run(MIX_FRAG, { uTex: out, uOrig: tex, uAmount: amount });
        gl.release(out);
        gl.release(tex);
        tex = mixed;
      } else {
        gl.release(tex);
        tex = out;
      }
    }
    const img = gl.output(tex);
    gl.release(tex);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(img, 0, 0);
    ctx.restore();
    img.close?.();
  }

  private applyAdjustment(node: AdjustmentNode, local: FrameContext, target: Ctx2D) {
    const props = node.evaluate(local);
    if (!props.visible || props.opacity <= 0) return;
    const canvas = target.canvas as Surface;
    if (props.opacity >= 1) {
      this.applyFilters(node.filters, local, target, canvas);
      return;
    }
    const tmp = this.pool.acquire();
    tmp.ctx.drawImage(canvas, 0, 0);
    this.applyFilters(node.filters, local, tmp.ctx, tmp.surface);
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalAlpha = props.opacity;
    target.drawImage(tmp.surface, 0, 0);
    target.restore();
    this.pool.release(tmp.surface);
  }

  // ------------------------------------------------------------ helpers for drawers

  /** Renders a single node (and subtree) into a fresh full-size layer. Caller must release. */
  renderToLayer(node: SceneNode, parentCtx: FrameContext, parentMatrix: Mat2D): { surface: Surface; ctx: Ctx2D } {
    const l = this.pool.acquire();
    this.renderNode(node, parentCtx, l.ctx, parentMatrix, 1);
    return l;
  }
  releaseLayer(s: Surface): void {
    this.pool.release(s);
  }
  acquireLayer(): { surface: Surface; ctx: Ctx2D } {
    return this.pool.acquire();
  }

  /** Renders a nested composition's content into the target at the given world matrix. */
  renderInnerComp(inner: Composition, time: number, target: Ctx2D, matrix: Mat2D, alpha: number, props: Record<string, unknown>): void {
    const ctx = inner.contextAt(time * inner.fps, { ...inner.props, ...props });
    this.compStack.push(inner);
    const m = mat2d.multiply(matrix, mat2d.translate(-inner.width / 2, -inner.height / 2));
    if (inner.background) {
      target.setTransform(...m);
      const p = toCanvasPaint(target, inner.background, this.assets);
      if (p) {
        target.fillStyle = p;
        target.fillRect(0, 0, inner.width, inner.height);
      }
    }
    this.renderChildren(inner.root, ctx, target, m, alpha);
    this.compStack.pop();
  }

  /** Key for prefetched video frames. */
  static frameKey(src: string, time: number): string {
    return `${src}@${time.toFixed(5)}`;
  }
}

function staticParams(f: FilterSpec, ctx: FrameContext): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(f.params)) out[k] = typeof v === 'function' || isTrack(v) ? resolve(v, ctx) : v;
  return out;
}
function resolveParams(f: FilterSpec, ctx: FrameContext): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(f.params)) out[k] = resolve(v, ctx);
  return out;
}
