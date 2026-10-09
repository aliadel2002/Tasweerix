import { isTrack, resolve, Track, type Animatable, type KeyInput, type TrackOptions } from './animatable';
import { localContext, type FrameContext } from './context';
import { resolveEasing, type EasingInput } from './easing';
import type { Env } from './env';
import type { Vec2 } from './math';
import { captureSource, type SourceRef } from './source';
import { toSeconds, type TimeInput } from './time';

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity'
  | 'add'
  | 'destination-out'
  | 'source-atop';

/** A filter applied to a node (implemented by the renderer / plugins). */
export interface FilterSpec {
  kind: string;
  params: Record<string, Animatable<any>>;
  /** Mix of filtered result over the original (0..1). */
  amount?: Animatable<number>;
}

export type MaskMode = 'alpha' | 'alpha-inverted' | 'luma' | 'luma-inverted';
export interface MaskSpec {
  node: SceneNode;
  mode: MaskMode;
}

export interface Shadow {
  color: string;
  blur: number;
  x: number;
  y: number;
}

/** Props every node has. */
export interface BaseProps {
  /** Position of the anchor point in parent coordinates. */
  position: Vec2;
  /** Anchor point in the node's own coordinates (rotation/scale pivot). */
  anchor: Vec2;
  scale: Vec2 | number;
  /** Degrees, clockwise. */
  rotation: number;
  /** Degrees. */
  skew: Vec2;
  opacity: number;
  blend: BlendMode;
  visible: boolean;
  shadow: Shadow | null;
  /** Motion blur shutter angle in degrees (0 = off). Rendered with sub-frame sampling. */
  motionBlur: number;
}

export type AnimProps<P> = { [K in keyof P]?: Animatable<P[K]> };
export type Resolved<P> = { [K in keyof P]: P[K] };

/** Options accepted by every node factory. */
export interface NodeOptions {
  name?: string;
  /** Start time in the parent's timeline. */
  start?: TimeInput;
  /** Visible duration (defaults to the media length or open ended). */
  duration?: TimeInput;
  /** End time in parent timeline (alternative to duration). */
  end?: TimeInput;
  /** Shorthand for position. */
  at?: Animatable<Vec2>;
  filters?: FilterSpec[];
}

export const BASE_DEFAULTS: Resolved<BaseProps> = {
  position: [0, 0],
  anchor: [0, 0],
  scale: 1,
  rotation: 0,
  skew: [0, 0],
  opacity: 1,
  blend: 'normal',
  visible: true,
  shadow: null,
  motionBlur: 0,
};

const BASE_KEYS = new Set(Object.keys(BASE_DEFAULTS).concat(['position']));

let nextId = 1;
export function resetIds(): void {
  nextId = 1;
}

/** Applies a behavior (preset, animation helper) to a node. */
export type Behavior<N extends SceneNode = SceneNode> = (node: N) => void;

export interface AnimateTiming {
  start?: TimeInput;
  duration?: TimeInput;
  delay?: TimeInput;
  ease?: EasingInput;
}

/**
 * Base class of the retained scene graph. Nodes hold Animatable props and timing; they never
 * hold per-frame state, which makes any frame renderable in any order.
 */
export class SceneNode<P extends object = {}> {
  readonly kind: string;
  readonly id: string;
  name?: string;
  props: AnimProps<P & BaseProps> = {};
  children: SceneNode[] = [];
  parent?: SceneNode;
  /** Start time in the parent's local timeline (seconds). */
  start = 0;
  /** Explicit duration (seconds). */
  duration?: number;
  /** Intrinsic content duration (e.g. media length), filled during prepare. */
  naturalDuration?: number;
  /** Content time speed multiplier (affects children & media, not own props). */
  speed = 1;
  /** Optional content time remap (local seconds → content seconds). */
  timeRemap?: Animatable<number>;
  filters: FilterSpec[] = [];
  maskSpec?: MaskSpec;
  /** Clip children to own bounds (groups with size). */
  clip = false;
  source?: SourceRef;
  /** Free-form metadata for tools and plugins. */
  meta: Record<string, unknown> = {};
  /** Layout hook executed after children are prepared (used by sequences). */
  layout?: (node: SceneNode, env: Env) => void;

  constructor(kind: string, props: AnimProps<P & BaseProps> = {}, opts: NodeOptions = {}) {
    this.kind = kind;
    this.id = `${kind}-${nextId++}`;
    this.source = captureSource();
    this.props = { ...props };
    this.applyOptions(opts);
  }

  protected applyOptions(opts: NodeOptions): void {
    if (opts.name) this.name = opts.name;
    if (opts.start !== undefined) this.start = toSeconds(opts.start);
    if (opts.duration !== undefined) this.duration = toSeconds(opts.duration);
    if (opts.end !== undefined) this.duration = toSeconds(opts.end) - this.start;
    if (opts.at !== undefined) (this.props as AnimProps<BaseProps>).position = opts.at;
    if (opts.filters) this.filters.push(...opts.filters);
  }

  /** Default prop values for this node kind (merged over BASE_DEFAULTS). */
  defaults(): Partial<Resolved<P & BaseProps>> {
    return {};
  }

  // ---------- Fluent API ----------

  /** Sets one or more props (static values, tracks or drivers). */
  set(p: AnimProps<P & BaseProps>): this {
    Object.assign(this.props, p);
    return this;
  }

  /** Reads the raw (unresolved) prop value. */
  get<K extends keyof (P & BaseProps)>(key: K): Animatable<(P & BaseProps)[K]> | undefined {
    return this.props[key] as Animatable<(P & BaseProps)[K]> | undefined;
  }

  /** Sets keyframes for a prop: `node.keys('opacity', [[0, 0], ['1s', 1, 'outCubic']])`. */
  keys<K extends keyof (P & BaseProps)>(key: K, list: KeyInput<(P & BaseProps)[K]>[], opts?: TrackOptions): this {
    const tr = new Track(list, opts);
    tr.source = captureSource();
    (this.props as Record<string, unknown>)[key as string] = tr;
    return this;
  }

  /**
   * Tweens props from their current value (or explicit [from, to] pairs) over a time window.
   * Successive calls append keyframes, so animations can be chained naturally:
   *   node.animate({ opacity: [0, 1] }, { duration: 0.5 }).animate({ scale: 1.2 }, { start: 2 })
   */
  animate(to: { [K in keyof (P & BaseProps)]?: (P & BaseProps)[K] | [(P & BaseProps)[K], (P & BaseProps)[K]] }, timing: AnimateTiming = {}): this {
    const start = toSeconds(timing.start ?? 0) + toSeconds(timing.delay ?? 0);
    const dur = toSeconds(timing.duration ?? 0.5);
    const e = resolveEasing(timing.ease ?? 'inOutCubic');
    const src = captureSource();
    for (const [k, target] of Object.entries(to)) {
      const key = k as keyof (P & BaseProps);
      const pair = Array.isArray(target) && target.length === 2 && isPairFor(key as string, target);
      const fromVal = pair ? (target as unknown[])[0] : undefined;
      const toVal = pair ? (target as unknown[])[1] : target;
      const cur = (this.props as Record<string, unknown>)[k];
      let tr: Track<unknown>;
      if (isTrack(cur)) {
        tr = cur as Track<unknown>;
      } else {
        const initial = fromVal !== undefined ? fromVal : cur !== undefined && typeof cur !== 'function' ? cur : this.defaultOf(key);
        tr = new Track<unknown>([[0, initial]]);
        tr.source = src;
        if (start > 0 && fromVal === undefined) tr.add([start, initial]);
      }
      if (fromVal !== undefined) tr.add([start, fromVal]);
      else if (!tr.keys.some((kf) => Math.abs(kf.t - start) < 1e-9)) tr.add([start, tr.at(start)]);
      tr.add({ t: start + dur, v: toVal, ease: e });
      (this.props as Record<string, unknown>)[k] = tr;
    }
    return this;
  }

  /** Applies behaviors / presets. */
  use(...behaviors: Behavior<this>[]): this {
    for (const b of behaviors) b(this);
    return this;
  }

  /** Sets timing in the parent timeline. */
  span(start: TimeInput, duration?: TimeInput): this {
    this.start = toSeconds(start);
    if (duration !== undefined) this.duration = toSeconds(duration);
    return this;
  }
  startAt(t: TimeInput): this {
    this.start = toSeconds(t);
    return this;
  }
  lasting(d: TimeInput): this {
    this.duration = toSeconds(d);
    return this;
  }
  endAt(t: TimeInput): this {
    this.duration = toSeconds(t) - this.start;
    return this;
  }

  /** Playback speed for content (media and children). */
  rate(speed: number): this {
    this.speed = speed;
    return this;
  }
  /** Remaps content time with an animatable (seconds → seconds), e.g. speed ramps or freeze frames. */
  remap(fn: Animatable<number>): this {
    this.timeRemap = fn;
    return this;
  }

  filter(...f: FilterSpec[]): this {
    this.filters.push(...f);
    return this;
  }
  mask(node: SceneNode, mode: MaskMode = 'alpha'): this {
    node.parent = this;
    this.maskSpec = { node, mode };
    return this;
  }
  blend(mode: BlendMode): this {
    (this.props as AnimProps<BaseProps>).blend = mode;
    return this;
  }
  named(name: string): this {
    this.name = name;
    return this;
  }
  at(pos: Animatable<Vec2>): this {
    (this.props as AnimProps<BaseProps>).position = pos;
    return this;
  }

  add<T extends SceneNode[]>(...nodes: T): T[0] {
    for (const n of nodes) {
      if (n.parent && n.parent !== this) n.parent.remove(n);
      n.parent = this;
      this.children.push(n);
    }
    return nodes[0];
  }
  remove(node: SceneNode): this {
    const i = this.children.indexOf(node);
    if (i >= 0) this.children.splice(i, 1);
    node.parent = undefined;
    return this;
  }

  // ---------- Evaluation ----------

  defaultOf(key: keyof (P & BaseProps)): unknown {
    const d = this.defaults() as Record<string, unknown>;
    if (key in d) return d[key as string];
    return (BASE_DEFAULTS as unknown as Record<string, unknown>)[key as string];
  }

  /** Resolves a single prop at the given context. */
  value<K extends keyof (P & BaseProps)>(key: K, ctx: FrameContext): (P & BaseProps)[K] {
    const raw = this.props[key];
    if (raw === undefined) return this.defaultOf(key) as (P & BaseProps)[K];
    return resolve(raw as Animatable<(P & BaseProps)[K]>, ctx);
  }

  /** Resolves all props (defaults merged). */
  evaluate(ctx: FrameContext): Resolved<P & BaseProps> {
    const out: Record<string, unknown> = { ...BASE_DEFAULTS, ...this.defaults() };
    for (const [k, v] of Object.entries(this.props)) {
      if (v !== undefined) out[k] = resolve(v as Animatable<unknown>, ctx);
    }
    return out as Resolved<P & BaseProps>;
  }

  /** Visible duration in the parent's timeline. */
  effectiveDuration(): number {
    if (this.duration !== undefined) return this.duration;
    if (this.naturalDuration !== undefined) return this.naturalDuration / Math.abs(this.speed || 1);
    return Infinity;
  }

  get end(): number {
    return this.start + this.effectiveDuration();
  }

  /** Is the node visible at the given parent-local time? */
  activeAt(parentTime: number): boolean {
    const t = parentTime - this.start;
    return t >= -1e-9 && t < this.effectiveDuration() - 1e-9;
  }

  /** Context for this node's own props given the parent context. */
  localCtx(parentCtx: FrameContext): FrameContext {
    return localContext(parentCtx, parentCtx.time - this.start, this.effectiveDuration());
  }

  /** Content time (for children / media) given this node's local context. */
  contentTime(local: FrameContext): number {
    if (this.timeRemap !== undefined) return resolve(this.timeRemap, local);
    return local.time * this.speed;
  }

  /** Context passed to children. */
  childCtx(local: FrameContext): FrameContext {
    const t = this.contentTime(local);
    return localContext(local, t, Infinity);
  }

  /** Start offset of this node in absolute composition time (ignores time remaps). */
  globalStart(): number {
    let t = this.start;
    let p = this.parent;
    while (p) {
      t = p.start + t / (p.speed || 1);
      p = p.parent;
    }
    return t;
  }

  /** Called once before rendering (probe media, load fonts, ...). */
  async prepare(env: Env): Promise<void> {
    await Promise.all(this.children.map((c) => c.prepare(env)));
    if (this.maskSpec) await this.maskSpec.node.prepare(env);
    this.layout?.(this, env);
  }

  /** Depth-first traversal. */
  walk(fn: (n: SceneNode, depth: number) => void | false, depth = 0): void {
    if (fn(this, depth) === false) return;
    for (const c of this.children) c.walk(fn, depth + 1);
  }

  find(pred: (n: SceneNode) => boolean): SceneNode | undefined {
    let found: SceneNode | undefined;
    this.walk((n) => {
      if (!found && pred(n)) found = n;
      return found ? false : undefined;
    });
    return found;
  }

  toJSON(): Record<string, unknown> {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this.props)) {
      props[k] = typeof v === 'function' ? '<driver>' : isTrack(v) ? (v as Track<unknown>).toJSON() : v;
    }
    return {
      kind: this.kind,
      id: this.id,
      name: this.name,
      start: this.start,
      duration: Number.isFinite(this.effectiveDuration()) ? this.effectiveDuration() : null,
      speed: this.speed !== 1 ? this.speed : undefined,
      props,
      filters: this.filters.length ? this.filters.map((f) => f.kind) : undefined,
      mask: this.maskSpec ? { mode: this.maskSpec.mode, node: this.maskSpec.node.toJSON() } : undefined,
      children: this.children.length ? this.children.map((c) => c.toJSON()) : undefined,
    };
  }
}

/** Heuristic: is `[a, b]` a from/to pair for this prop (vs a single Vec2 value)? */
function isPairFor(key: string, v: unknown[]): boolean {
  const vecProps = new Set(['position', 'anchor', 'skew', 'size', 'from', 'to', 'center']);
  // For scale, two numbers mean from → to (use keys() for non-uniform targets or pass [[1, 1], [2, 1]]).
  if (key === 'scale') return true;
  if (vecProps.has(key)) return Array.isArray(v[0]);
  if (key === 'trim' || key === 'dash' || key === 'radius') return Array.isArray(v[0]);
  return true;
}

export function isBaseProp(k: string): boolean {
  return BASE_KEYS.has(k);
}
