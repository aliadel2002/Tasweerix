import type { Animatable } from './animatable';
import type { FrameContext } from './context';
import type { Env, MediaInfo } from './env';
import type { Rect, Vec2 } from './math';
import { SceneNode, type AnimProps, type BaseProps, type NodeOptions, type Resolved } from './node';
import type { Paint } from './paint';
import { toSeconds, type TimeInput } from './time';

// ---------------------------------------------------------------- Shapes

export type LineCap = 'butt' | 'round' | 'square';
export type LineJoin = 'miter' | 'round' | 'bevel';

export interface ShapeStyle {
  fill: Paint;
  stroke: Paint;
  strokeWidth: number;
  lineCap: LineCap;
  lineJoin: LineJoin;
  miterLimit: number;
  dash: number[];
  dashOffset: number;
  /** Trim paths: visible portion of the outline, 0..1. */
  trimStart: number;
  trimEnd: number;
  /** Offset (0..1, wraps) applied to the trim window. */
  trimOffset: number;
  /** Paint stroke below fill (useful for outlined text). */
  strokeFirst: boolean;
  fillRule: 'nonzero' | 'evenodd';
}

export const SHAPE_DEFAULTS: Resolved<ShapeStyle> = {
  fill: '#ffffff',
  stroke: null,
  strokeWidth: 0,
  lineCap: 'butt',
  lineJoin: 'miter',
  miterLimit: 10,
  dash: [],
  dashOffset: 0,
  trimStart: 0,
  trimEnd: 1,
  trimOffset: 0,
  strokeFirst: false,
  fillRule: 'nonzero',
};

type ShapeOpts<P> = AnimProps<P & ShapeStyle & BaseProps> & NodeOptions;

function split<P>(o: ShapeOpts<P> | undefined): [AnimProps<P & ShapeStyle & BaseProps>, NodeOptions] {
  const { name, start, duration, end, at, filters, ...rest } = (o ?? {}) as ShapeOpts<P>;
  return [rest as AnimProps<P & ShapeStyle & BaseProps>, { name, start, duration, end, at, filters }];
}

export class ShapeNode<P extends object = {}> extends SceneNode<P & ShapeStyle> {
  override defaults(): Partial<Resolved<P & ShapeStyle & BaseProps>> {
    return { ...SHAPE_DEFAULTS } as Partial<Resolved<P & ShapeStyle & BaseProps>>;
  }
}

export interface RectProps {
  size: Vec2;
  /** Corner radius (single or [tl, tr, br, bl]). */
  radius: number | [number, number, number, number];
}
export class RectNode extends ShapeNode<RectProps> {
  override defaults() {
    return { ...super.defaults(), size: [100, 100] as Vec2, radius: 0 };
  }
}
export function rect(opts?: ShapeOpts<RectProps>): RectNode {
  const [p, o] = split(opts);
  return new RectNode('rect', p, o);
}

export interface EllipseProps {
  size: Vec2;
  /** Partial ellipse (arc) in degrees. */
  startAngle: number;
  endAngle: number;
}
export class EllipseNode extends ShapeNode<EllipseProps> {
  override defaults() {
    return { ...super.defaults(), size: [100, 100] as Vec2, startAngle: 0, endAngle: 360 };
  }
}
export function ellipse(opts?: ShapeOpts<EllipseProps>): EllipseNode {
  const [p, o] = split(opts);
  return new EllipseNode('ellipse', p, o);
}
export function circle(radius: Animatable<number>, opts?: ShapeOpts<EllipseProps>): EllipseNode {
  const n = ellipse(opts);
  n.set({
    size:
      typeof radius === 'number'
        ? ([radius * 2, radius * 2] as Vec2)
        : (ctx: FrameContext) => {
            const r = typeof radius === 'function' ? radius(ctx) : (radius as { at(t: number): number }).at(ctx.time);
            return [r * 2, r * 2] as Vec2;
          },
  });
  return n;
}

export interface PolygonProps {
  sides: number;
  radius: number;
  cornerRadius: number;
}
export class PolygonNode extends ShapeNode<PolygonProps> {
  override defaults() {
    return { ...super.defaults(), sides: 6, radius: 50, cornerRadius: 0 };
  }
}
export function polygon(opts?: ShapeOpts<PolygonProps>): PolygonNode {
  const [p, o] = split(opts);
  return new PolygonNode('polygon', p, o);
}

export interface StarProps {
  points: number;
  outerRadius: number;
  innerRadius: number;
  cornerRadius: number;
}
export class StarNode extends ShapeNode<StarProps> {
  override defaults() {
    return { ...super.defaults(), points: 5, outerRadius: 50, innerRadius: 22, cornerRadius: 0 };
  }
}
export function star(opts?: ShapeOpts<StarProps>): StarNode {
  const [p, o] = split(opts);
  return new StarNode('star', p, o);
}

export interface PathProps {
  /** SVG path data. Animating between two paths morphs them (with @tasweerix/illustrate). */
  d: string;
}
export class PathNode extends ShapeNode<PathProps> {
  override defaults() {
    return { ...super.defaults(), d: '' };
  }
}
export function path(d: Animatable<string>, opts?: ShapeOpts<PathProps>): PathNode {
  const [p, o] = split(opts);
  return new PathNode('path', { ...p, d }, o);
}

export interface PolylineProps {
  points: Vec2[];
  closed: boolean;
  /** Catmull-Rom smoothing tension (0 = straight segments). */
  smooth: number;
}
export class PolylineNode extends ShapeNode<PolylineProps> {
  override defaults() {
    return {
      ...super.defaults(),
      points: [] as Vec2[],
      closed: false,
      smooth: 0,
      fill: null,
      stroke: '#ffffff',
      strokeWidth: 4,
      lineCap: 'round' as const,
      lineJoin: 'round' as const,
    };
  }
}
export function polyline(points: Animatable<Vec2[]>, opts?: ShapeOpts<PolylineProps>): PolylineNode {
  const [p, o] = split(opts);
  return new PolylineNode('polyline', { ...p, points }, o);
}
export function line(from: Vec2, to: Vec2, opts?: ShapeOpts<PolylineProps>): PolylineNode {
  return polyline([from, to], opts);
}

// ---------------------------------------------------------------- Text

export type TextAlign = 'left' | 'center' | 'right' | 'start' | 'end' | 'justify';
export type TextBaseline = 'top' | 'middle' | 'bottom' | 'alphabetic';

export interface TextProps {
  text: string;
  /** CSS font family name, or a font asset path (".ttf/.otf/.woff2"). */
  font: string;
  size: number;
  weight: number | string;
  style: 'normal' | 'italic';
  align: TextAlign;
  baseline: TextBaseline;
  direction: 'auto' | 'ltr' | 'rtl';
  lineHeight: number;
  letterSpacing: number;
  wordSpacing: number;
  maxWidth: number;
  /** OpenType features, e.g. { liga: 1, ss01: 1 }. */
  features: Record<string, number>;
  /** Variable font axes, e.g. { wght: 650 }. */
  variations: Record<string, number>;
  /** Script/language hints for shaping (e.g. 'arab', 'ar'). */
  script: string;
  language: string;
}

/** Selection of glyph units an animator acts on. */
export type GlyphUnit = 'glyph' | 'cluster' | 'char' | 'word' | 'line';

/** Per-glyph animation (used for kinetic typography). Implemented by the renderer. */
export interface GlyphAnimator {
  by: GlyphUnit;
  /** Order in which units are staggered. 'reading' respects RTL. */
  order: 'reading' | 'visual' | 'reverse' | 'center-out' | 'edges-in' | 'random';
  /** Seconds between consecutive units. */
  stagger: number;
  start: number;
  /** Duration of each unit's animation. */
  duration: number;
  ease: (t: number) => number;
  /** Values at progress 0 (animated to the unit's rest state at progress 1). */
  from: Partial<GlyphState>;
  /** Optional explicit end state (defaults to rest). */
  to?: Partial<GlyphState>;
  seed: number;
  /** Optional custom per-unit function. */
  custom?: (unit: { index: number; count: number; progress: number; ctx: FrameContext }) => Partial<GlyphState>;
}

export interface GlyphState {
  x: number;
  y: number;
  scale: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  opacity: number;
  blur: number;
  fill: string;
  /** Fraction of the glyph visible (typewriter-like reveal). */
  reveal: number;
  /** Tracking added after the unit. */
  tracking: number;
}

export class TextNode extends ShapeNode<TextProps> {
  glyphAnimators: GlyphAnimator[] = [];
  override defaults() {
    return {
      ...super.defaults(),
      text: '',
      font: 'sans-serif',
      size: 48,
      weight: 400,
      style: 'normal' as const,
      align: 'center' as TextAlign,
      baseline: 'middle' as TextBaseline,
      direction: 'auto' as const,
      lineHeight: 1.2,
      letterSpacing: 0,
      wordSpacing: 0,
      maxWidth: 0,
      features: {},
      variations: {},
      script: '',
      language: '',
    };
  }
  /** Adds a per-glyph animator (see motion.textReveal etc.). */
  glyphs(...anims: GlyphAnimator[]): this {
    this.glyphAnimators.push(...anims);
    return this;
  }
}
export function text(content: Animatable<string>, opts?: ShapeOpts<TextProps>): TextNode {
  const [p, o] = split(opts);
  return new TextNode('text', { ...p, text: content }, o);
}

// ---------------------------------------------------------------- Media

export type Fit = 'contain' | 'cover' | 'fill' | 'none' | 'scale-down';

export interface ImageProps {
  src: string;
  /** Display box. Defaults to the image's natural size. */
  size: Vec2 | null;
  fit: Fit;
  /** Crop rectangle in source pixels. */
  crop: Rect | null;
  smoothing: boolean;
}
export class ImageNode extends SceneNode<ImageProps> {
  info?: MediaInfo;
  override defaults() {
    return { src: '', size: null, fit: 'contain' as Fit, crop: null, smoothing: true };
  }
  override async prepare(env: Env): Promise<void> {
    const src = this.props.src;
    if (typeof src === 'string' && src) this.info = await env.probe(src).catch(() => ({}));
    await super.prepare(env);
  }
}
export function image(src: string, opts?: AnimProps<ImageProps & BaseProps> & NodeOptions): ImageNode {
  const [p, o] = split(opts as ShapeOpts<ImageProps>);
  return new ImageNode('image', { ...(p as AnimProps<ImageProps & BaseProps>), src }, o);
}

export interface VideoProps extends ImageProps {
  volume: number;
}
export interface VideoOptions extends NodeOptions {
  /** [in, out] source points. */
  trim?: [TimeInput, TimeInput?];
  /** Playback speed (negative plays in reverse). */
  speed?: number;
  muted?: boolean;
  loop?: boolean;
}
export class VideoNode extends SceneNode<VideoProps> {
  info?: MediaInfo;
  trimIn = 0;
  trimOut?: number;
  muted = false;
  loop = false;
  /**
   * Extra transform of the picture inside its box at a source time (stabilization, reframing):
   * [a, b, tx, ty] maps frame coordinates — centered, in frame widths — to displayed ones
   * (x' = a·x − b·y + tx, y' = b·x + a·y + ty). The result is clipped to the box.
   */
  mediaTransform?: (sourceTime: number) => [number, number, number, number] | null | undefined;
  override defaults() {
    return { src: '', size: null, fit: 'contain' as Fit, crop: null, smoothing: true, volume: 1 };
  }
  get src(): string {
    return this.props.src as string;
  }
  override async prepare(env: Env): Promise<void> {
    this.info = await env.probe(this.src).catch(() => ({}));
    const srcDur = this.info.duration;
    const out = this.trimOut ?? srcDur;
    if (out !== undefined && !this.loop) this.naturalDuration = Math.max(0, out - this.trimIn);
    await super.prepare(env);
  }
  /** Source media time for a node-local context. */
  sourceTime(local: FrameContext): number {
    let t = this.contentTime(local);
    const out = this.trimOut ?? this.info?.duration;
    if (this.speed < 0 && out !== undefined) t = out - this.trimIn + t; // reverse: t is negative
    let st = this.trimIn + t;
    if (this.loop && out !== undefined) {
      const span = out - this.trimIn;
      if (span > 0) st = this.trimIn + (((st - this.trimIn) % span) + span) % span;
    }
    if (out !== undefined) st = Math.min(st, out - 1e-4);
    return Math.max(0, st);
  }
  trim(inPoint: TimeInput, outPoint?: TimeInput): this {
    this.trimIn = toSeconds(inPoint);
    this.trimOut = outPoint !== undefined ? toSeconds(outPoint) : undefined;
    return this;
  }
}
export function video(src: string, opts: VideoOptions & AnimProps<VideoProps & BaseProps> = {}): VideoNode {
  const { trim, speed, muted, loop, ...rest } = opts;
  const [p, o] = split(rest as ShapeOpts<VideoProps>);
  const n = new VideoNode('video', { ...(p as AnimProps<VideoProps & BaseProps>), src }, o);
  if (trim) n.trim(trim[0], trim[1]);
  if (speed !== undefined) n.speed = speed;
  if (muted) n.muted = true;
  if (loop) n.loop = true;
  return n;
}

// ---------------------------------------------------------------- Fills

export interface SolidProps {
  color: Paint;
  /** Size (defaults to the composition size). */
  size: Vec2 | null;
}
export class SolidNode extends SceneNode<SolidProps> {
  override defaults() {
    return { color: '#000000', size: null };
  }
}
export function solid(color: Animatable<Paint>, opts?: AnimProps<SolidProps & BaseProps> & NodeOptions): SolidNode {
  const [p, o] = split(opts as ShapeOpts<SolidProps>);
  return new SolidNode('solid', { ...(p as AnimProps<SolidProps & BaseProps>), color }, o);
}

// ---------------------------------------------------------------- Custom drawing

export interface DrawApi {
  /** CanvasRenderingContext2D (or Offscreen) already transformed to the node's local space. */
  ctx: CanvasRenderingContext2D;
  frame: FrameContext;
  size: Vec2;
}
export interface CanvasProps {
  size: Vec2 | null;
}
export class CanvasNode extends SceneNode<CanvasProps> {
  draw: (api: DrawApi) => void;
  constructor(draw: (api: DrawApi) => void, props: AnimProps<CanvasProps & BaseProps>, opts: NodeOptions) {
    super('canvas', props, opts);
    this.draw = draw;
  }
  override defaults() {
    return { size: null };
  }
}
/** Immediate-mode drawing escape hatch: `canvas(({ ctx, frame }) => { ... })`. */
export function canvas(draw: (api: DrawApi) => void, opts?: AnimProps<CanvasProps & BaseProps> & NodeOptions): CanvasNode {
  const [p, o] = split(opts as ShapeOpts<CanvasProps>);
  return new CanvasNode(draw, p as AnimProps<CanvasProps & BaseProps>, o);
}

// ---------------------------------------------------------------- Containers

export interface GroupProps {
  /** Optional size (used for clipping and as layout box). */
  size: Vec2 | null;
}
export class GroupNode extends SceneNode<GroupProps> {
  override defaults() {
    return { size: null };
  }
  override effectiveDuration(): number {
    if (this.duration !== undefined) return this.duration;
    if (this.naturalDuration !== undefined) return this.naturalDuration / Math.abs(this.speed || 1);
    return Infinity;
  }
}
export function group(...children: (SceneNode | (AnimProps<GroupProps & BaseProps> & NodeOptions & { clip?: boolean }))[]): GroupNode {
  const nodes = children.filter((c): c is SceneNode => c instanceof SceneNode);
  const opts = (children.find((c) => !(c instanceof SceneNode)) ?? {}) as AnimProps<GroupProps & BaseProps> &
    NodeOptions & { clip?: boolean };
  const { clip, ...rest } = opts;
  const [p, o] = split(rest as ShapeOpts<GroupProps>);
  const g = new GroupNode('group', p as AnimProps<GroupProps & BaseProps>, o);
  if (clip) g.clip = true;
  if (nodes.length) g.add(...nodes);
  return g;
}

/** Adjustment layer: applies its filters to everything rendered below it in the same parent. */
export class AdjustmentNode extends SceneNode {}
export function adjustment(...filters: import('./node').FilterSpec[]): AdjustmentNode {
  const n = new AdjustmentNode('adjustment');
  n.filters.push(...filters);
  return n;
}
