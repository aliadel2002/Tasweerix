import { AudioClip, type AudioEffectSpec, type BusSpec } from './audio';
import type { Animatable } from './animatable';
import { makeContext, type FrameContext } from './context';
import { getEnv, type Env } from './env';
import { GroupNode, VideoNode } from './nodes';
import { SceneNode, type NodeOptions } from './node';
import type { Paint } from './paint';
import { frameCount, toSeconds, withFps, type TimeInput } from './time';

export type CompositionKind = 'video' | 'still' | 'audio';

export interface CompositionOptions {
  name?: string;
  width?: number;
  height?: number;
  fps?: number;
  /** Total duration. Defaults to the end of the last finite node / audio clip. */
  duration?: TimeInput;
  /** Background paint (null = transparent). */
  background?: Paint;
  sampleRate?: number;
  /** Default input props (overridable at render time, e.g. for templated batch renders). */
  props?: Record<string, unknown>;
  /** Pixel density multiplier for exports. */
  scale?: number;
}

export interface Marker {
  time: number;
  label: string;
  color?: string;
}

export type BuildFn<P extends Record<string, unknown> = Record<string, unknown>> = (
  c: Composition,
  props: P,
) => void | Promise<void>;

/** A built, prepared composition ready to render. */
export class Composition {
  readonly kind: CompositionKind;
  name: string;
  width: number;
  height: number;
  fps: number;
  sampleRate: number;
  background: Paint;
  scale: number;
  explicitDuration?: number;
  root: GroupNode;
  audioClips: AudioClip[] = [];
  buses = new Map<string, BusSpec>();
  markers: Marker[] = [];
  props: Record<string, unknown>;
  prepared = false;
  meta: Record<string, unknown> = {};

  constructor(kind: CompositionKind, opts: CompositionOptions = {}) {
    this.kind = kind;
    this.name = opts.name ?? 'Untitled';
    this.width = opts.width ?? 1920;
    this.height = opts.height ?? 1080;
    this.fps = opts.fps ?? 30;
    this.sampleRate = opts.sampleRate ?? 48000;
    this.background = opts.background === undefined ? (kind === 'still' ? null : '#000000') : opts.background;
    this.scale = opts.scale ?? 1;
    this.props = { ...(opts.props ?? {}) };
    if (opts.duration !== undefined) this.explicitDuration = withFps(this.fps, () => toSeconds(opts.duration!));
    this.root = new GroupNode('group', {}, { name: 'root' });
    this.root.meta.isRoot = true;
    this.buses.set('master', { name: 'master', effects: [], gain: 0, pan: 0, output: '' });
  }

  /** Adds nodes to the root. Returns the first node for chaining. */
  add<T extends SceneNode>(node: T, ...more: SceneNode[]): T {
    this.root.add(node, ...more);
    return node;
  }

  /** Adds an audio clip (or creates one from a path). */
  audio(clip: AudioClip | string, opts?: ConstructorParameters<typeof AudioClip>[1]): AudioClip {
    const c = typeof clip === 'string' ? new AudioClip(clip, opts) : clip;
    this.audioClips.push(c);
    return c;
  }

  /** Defines / updates a mixer bus. */
  bus(name: string, opts: { effects?: AudioEffectSpec[]; gain?: Animatable<number>; pan?: Animatable<number>; output?: string } = {}): BusSpec {
    const b: BusSpec = this.buses.get(name) ?? { name, effects: [], gain: 0, pan: 0, output: name === 'master' ? '' : 'master' };
    if (opts.effects) b.effects = opts.effects;
    if (opts.gain !== undefined) b.gain = opts.gain;
    if (opts.pan !== undefined) b.pan = opts.pan;
    if (opts.output !== undefined) b.output = opts.output;
    this.buses.set(name, b);
    return b;
  }

  /** Master bus effects (limiter, EQ, ...). */
  master(...effects: AudioEffectSpec[]): this {
    this.bus('master').effects.push(...effects);
    return this;
  }

  marker(time: TimeInput, label: string, color?: string): this {
    this.markers.push({ time: withFps(this.fps, () => toSeconds(time)), label, color });
    return this;
  }

  get duration(): number {
    if (this.explicitDuration !== undefined) return this.explicitDuration;
    if (this.kind === 'still') return 1 / this.fps;
    let end = 0;
    for (const c of this.root.children) if (Number.isFinite(c.end)) end = Math.max(end, c.end);
    for (const a of this.allAudioClips()) if (Number.isFinite(a.end)) end = Math.max(end, a.end);
    return end > 0 ? end : 5;
  }

  get frameCount(): number {
    return Math.max(1, frameCount(this.duration, this.fps));
  }

  /** Context for evaluating root-level values at a frame (supports fractional frames for motion blur). */
  contextAt(frame: number, props?: Record<string, unknown>): FrameContext {
    const t = frame / this.fps;
    return makeContext({
      time: t,
      globalTime: t,
      frame: Math.floor(frame + 1e-6),
      fps: this.fps,
      width: this.width,
      height: this.height,
      duration: this.duration,
      props: props ?? this.props,
    });
  }

  /** Explicit clips plus implicit clips generated from (non-muted) video nodes. */
  allAudioClips(): AudioClip[] {
    const implicit: AudioClip[] = [];
    this.root.walk((n) => {
      if (n instanceof VideoNode && !n.muted && n.info?.hasAudio) {
        const clip = new AudioClip(n.src, { bus: (n.meta.audioBus as string) ?? 'master' });
        clip.implicit = true;
        clip.name = n.name ?? n.id;
        clip.start = n.globalStart();
        clip.trimIn = n.trimIn;
        clip.trimOut = n.trimOut;
        clip.info = n.info;
        clip.loop = n.loop;
        let speed = n.speed;
        for (let p = n.parent; p; p = p.parent) speed *= p.speed;
        clip.speed = Math.abs(speed);
        clip.reverse = speed < 0;
        if (n.duration !== undefined) clip.duration = n.duration;
        const vol = n.props.volume;
        if (vol !== undefined) clip.volume = vol as Animatable<number>;
        clip.meta.videoNode = n.id;
        implicit.push(clip);
      }
      return undefined;
    });
    return [...this.audioClips, ...implicit];
  }

  async prepare(env: Env = getEnv()): Promise<this> {
    await this.root.prepare(env);
    await Promise.all(this.audioClips.map((a) => a.prepare(env)));
    this.prepared = true;
    return this;
  }

  /** Finds a node by id or name. */
  node(idOrName: string): SceneNode | undefined {
    return this.root.find((n) => n.id === idOrName || n.name === idOrName);
  }

  toJSON(): Record<string, unknown> {
    return {
      kind: this.kind,
      name: this.name,
      width: this.width,
      height: this.height,
      fps: this.fps,
      duration: this.duration,
      frameCount: this.frameCount,
      sampleRate: this.sampleRate,
      background: this.background,
      markers: this.markers,
      root: this.root.toJSON(),
      audio: this.allAudioClips().map((a) => a.toJSON()),
      buses: [...this.buses.values()].map((b) => ({ name: b.name, effects: b.effects.map((e) => e.kind), output: b.output })),
    };
  }
}

/** A lazily-built composition. The build function runs in whatever environment renders it. */
export interface CompositionDefinition<P extends Record<string, unknown> = Record<string, unknown>> {
  readonly __tasweerix: 'composition';
  kind: CompositionKind;
  options: CompositionOptions;
  build: BuildFn<P>;
  /** Builds and prepares a fresh composition instance. */
  create(opts?: { props?: Partial<P>; env?: Env }): Promise<Composition>;
}

function define<P extends Record<string, unknown>>(
  kind: CompositionKind,
  options: CompositionOptions,
  build: BuildFn<P>,
): CompositionDefinition<P> {
  return {
    __tasweerix: 'composition',
    kind,
    options,
    build,
    async create(opts = {}) {
      const c = new Composition(kind, options);
      Object.assign(c.props, opts.props ?? {});
      await withFps(c.fps, () => build(c, c.props as P));
      await c.prepare(opts.env ?? getEnv());
      return c;
    },
  };
}

/** Defines a video / motion-graphics composition. */
export function composition<P extends Record<string, unknown> = Record<string, unknown>>(
  options: CompositionOptions,
  build: BuildFn<P>,
): CompositionDefinition<P> {
  return define('video', options, build);
}

/** Defines a single image (photo edit / illustration). */
export function still<P extends Record<string, unknown> = Record<string, unknown>>(
  options: Omit<CompositionOptions, 'fps' | 'duration'>,
  build: BuildFn<P>,
): CompositionDefinition<P> {
  return define('still', { ...options, fps: 1, duration: 1 }, build);
}

/** Defines an audio-only project (podcast mix, sound design, music). */
export function soundscape<P extends Record<string, unknown> = Record<string, unknown>>(
  options: Omit<CompositionOptions, 'width' | 'height' | 'background'>,
  build: BuildFn<P>,
): CompositionDefinition<P> {
  return define('audio', { ...options, width: 0, height: 0, background: null }, build);
}

export function isCompositionDefinition(v: unknown): v is CompositionDefinition {
  return !!v && typeof v === 'object' && (v as CompositionDefinition).__tasweerix === 'composition';
}

// ---------------------------------------------------------------- Nested compositions

/** Nested composition (pre-comp). Renders another definition as a layer with its own timeline. */
export class CompNode extends SceneNode<{ size: [number, number] | null }> {
  definition: CompositionDefinition;
  inner?: Composition;
  inputProps: Record<string, unknown>;
  constructor(def: CompositionDefinition, props: Record<string, unknown>, opts: NodeOptions) {
    super('comp', {}, opts);
    this.definition = def;
    this.inputProps = props;
  }
  override defaults() {
    return { size: null };
  }
  override async prepare(env: Env): Promise<void> {
    this.inner = await this.definition.create({ props: this.inputProps, env });
    this.naturalDuration = this.inner.duration;
    await super.prepare(env);
  }
}

export function comp(def: CompositionDefinition, opts: NodeOptions & { props?: Record<string, unknown> } = {}): CompNode {
  const { props, ...rest } = opts;
  return new CompNode(def, props ?? {}, rest);
}
