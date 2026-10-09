import type { FrameContext } from './context';
import { ease as easings, resolveEasing, type Easing, type EasingInput } from './easing';
import { interpolate } from './interpolate';
import { toSeconds, type TimeInput } from './time';
import { captureSource, type SourceRef } from './source';

export type Driver<T> = (ctx: FrameContext) => T;
/** A value that may be static, keyframed or computed per frame. */
export type Animatable<T> = T | Track<T> | Driver<T>;

export interface Keyframe<T> {
  /** Time in seconds (local to the owning node). */
  t: number;
  v: T;
  /** Easing used for the segment that *arrives* at this key. */
  ease?: Easing;
  /** If true the previous value is held until this key (step). */
  hold?: boolean;
}

export type KeyInput<T> =
  | [TimeInput, T]
  | [TimeInput, T, EasingInput]
  | { t: TimeInput; v: T; ease?: EasingInput; hold?: boolean };

export type LoopMode = 'none' | 'loop' | 'pingpong' | 'continue';

export interface TrackOptions {
  ease?: EasingInput;
  loop?: LoopMode;
  /** Time offset applied before lookup (seconds). */
  offset?: TimeInput;
  /** Playback speed of the track. */
  speed?: number;
}

/** Keyframed value track. Stateless: `at(t)` can be called for any time in any order. */
export class Track<T> {
  readonly isTrack = true;
  keys: Keyframe<T>[] = [];
  loop: LoopMode;
  defaultEase: Easing;
  offset: number;
  speed: number;
  source?: SourceRef;

  constructor(keys: KeyInput<T>[] = [], opts: TrackOptions = {}) {
    this.defaultEase = resolveEasing(opts.ease, easings.linear);
    this.loop = opts.loop ?? 'none';
    this.offset = toSeconds(opts.offset ?? 0);
    this.speed = opts.speed ?? 1;
    for (const k of keys) this.add(k);
  }

  add(k: KeyInput<T>): this {
    let key: Keyframe<T>;
    if (Array.isArray(k)) {
      key = { t: toSeconds(k[0]), v: k[1], ease: k[2] ? resolveEasing(k[2]) : undefined };
    } else {
      key = { t: toSeconds(k.t), v: k.v, ease: k.ease ? resolveEasing(k.ease) : undefined, hold: k.hold };
    }
    const idx = this.keys.findIndex((x) => Math.abs(x.t - key.t) < 1e-9);
    if (idx >= 0) this.keys[idx] = key;
    else {
      this.keys.push(key);
      this.keys.sort((a, b) => a.t - b.t);
    }
    return this;
  }

  /** Appends a key relative to the last key: `.then('0.5s', 100, 'outCubic')`. */
  then(after: TimeInput, v: T, e?: EasingInput): this {
    const last = this.keys[this.keys.length - 1];
    return this.add([(last?.t ?? 0) + toSeconds(after), v, e as EasingInput]);
  }

  get start(): number {
    return this.keys[0]?.t ?? 0;
  }
  get end(): number {
    return this.keys[this.keys.length - 1]?.t ?? 0;
  }
  get span(): number {
    return this.end - this.start;
  }

  private mapTime(t: number): number {
    t = (t - this.offset) * this.speed;
    const s = this.start;
    const span = this.span;
    if (span <= 0 || this.loop === 'none' || this.loop === 'continue' || t <= s) return t;
    const rel = t - s;
    if (this.loop === 'loop') return s + (rel % span);
    const cycle = Math.floor(rel / span);
    const r = rel % span;
    return s + (cycle % 2 === 0 ? r : span - r);
  }

  at(time: number): T {
    const keys = this.keys;
    if (keys.length === 0) throw new Error('Track has no keyframes');
    if (keys.length === 1) return keys[0]!.v;
    const t = this.mapTime(time);
    const first = keys[0]!;
    const last = keys[keys.length - 1]!;
    if (t <= first.t) return first.v;
    if (t >= last.t) {
      if (this.loop === 'continue' && typeof last.v === 'number' && keys.length >= 2) {
        const prev = keys[keys.length - 2]!;
        const vel = ((last.v as number) - (prev.v as number)) / (last.t - prev.t || 1);
        return ((last.v as number) + vel * (t - last.t)) as T;
      }
      return last.v;
    }
    // Binary search for segment.
    let lo = 0;
    let hi = keys.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (keys[mid]!.t <= t) lo = mid;
      else hi = mid;
    }
    const a = keys[lo]!;
    const b = keys[hi]!;
    if (b.hold) return a.v;
    const p = (t - a.t) / (b.t - a.t);
    const e = b.ease ?? this.defaultEase;
    return interpolate(a.v, b.v, e(p));
  }

  /** Returns a copy shifted in time. */
  shift(dt: TimeInput): Track<T> {
    const d = toSeconds(dt);
    const tr = new Track<T>([], { loop: this.loop });
    tr.defaultEase = this.defaultEase;
    tr.speed = this.speed;
    tr.offset = this.offset;
    tr.keys = this.keys.map((k) => ({ ...k, t: k.t + d }));
    return tr;
  }

  /** Maps every keyframe value. */
  map<U>(fn: (v: T) => U): Track<U> {
    const tr = new Track<U>([], { loop: this.loop });
    tr.defaultEase = this.defaultEase;
    tr.speed = this.speed;
    tr.offset = this.offset;
    tr.keys = this.keys.map((k) => ({ ...k, v: fn(k.v) }));
    return tr;
  }

  toJSON(): unknown {
    return { track: this.keys.map((k) => ({ t: k.t, v: k.v, hold: k.hold || undefined })), loop: this.loop };
  }
}

export function isTrack(v: unknown): v is Track<unknown> {
  return !!v && typeof v === 'object' && (v as Track<unknown>).isTrack === true;
}

/** Build a keyframe track: `keys([[0, 0], ['1s', 1, 'outCubic']])` or `keys({ 0: 0, '1s': 1 })`. */
export function keys<T>(input: KeyInput<T>[] | Record<string, T>, opts?: TrackOptions): Track<T> {
  const list: KeyInput<T>[] = Array.isArray(input)
    ? input
    : Object.entries(input).map(([t, v]) => [isNaN(Number(t)) ? t : Number(t), v] as [TimeInput, T]);
  const tr = new Track<T>(list, opts);
  tr.source = captureSource();
  return tr;
}

export interface TweenOptions {
  start?: TimeInput;
  duration?: TimeInput;
  ease?: EasingInput;
  delay?: TimeInput;
}

/** Two-key tween: `tween(0, 1, { start: '1s', duration: '0.5s', ease: 'outCubic' })`. */
export function tween<T>(from: T, to: T, opts: TweenOptions = {}): Track<T> {
  const s = toSeconds(opts.start ?? 0) + toSeconds(opts.delay ?? 0);
  const d = toSeconds(opts.duration ?? 1);
  const tr = new Track<T>([
    [s, from],
    [s + d, to, opts.ease ?? 'inOutCubic'],
  ]);
  tr.source = captureSource();
  return tr;
}

export function resolve<T>(a: Animatable<T>, ctx: FrameContext): T {
  if (typeof a === 'function') return (a as Driver<T>)(ctx);
  if (isTrack(a)) return (a as Track<T>).at(ctx.time);
  return a as T;
}

/** True when the value changes over time. */
export function isAnimated(a: unknown): boolean {
  return typeof a === 'function' || isTrack(a);
}

/** Builds a driver from a function of local time in seconds. */
export function over<T>(fn: (t: number, ctx: FrameContext) => T): Driver<T> {
  return (ctx) => fn(ctx.time, ctx);
}

/** Expressions — reusable procedural drivers. */
export const expr = {
  /** Noise-based wobble around a base value. */
  wiggle(frequency: number, amplitude: number, base: Animatable<number> = 0, seed: number | string = 0): Driver<number> {
    return (ctx) => resolve(base, ctx) + ctx.noise(seed).noise2(ctx.time * frequency, 0.37) * amplitude;
  },
  /** 2D wiggle around a point. */
  wiggle2(
    frequency: number,
    amplitude: number,
    base: Animatable<[number, number]> = [0, 0],
    seed: number | string = 0,
  ): Driver<[number, number]> {
    return (ctx) => {
      const b = resolve(base, ctx);
      const n = ctx.noise(seed);
      return [b[0] + n.noise2(ctx.time * frequency, 11.1) * amplitude, b[1] + n.noise2(ctx.time * frequency, 71.7) * amplitude];
    };
  },
  oscillate(frequency: number, amplitude: number, base = 0, phase = 0): Driver<number> {
    return (ctx) => base + Math.sin((ctx.time * frequency + phase) * Math.PI * 2) * amplitude;
  },
  /** Linear ramp: value + rate * t. */
  ramp(rate: number, base = 0): Driver<number> {
    return (ctx) => base + rate * ctx.time;
  },
  /** Loops a track over its key span. */
  loop<T>(track: Track<T>, mode: LoopMode = 'loop'): Track<T> {
    const t = track.map((v) => v);
    t.loop = mode;
    return t;
  },
  /** Delays any animatable in time. */
  delay<T>(a: Animatable<T>, by: TimeInput): Driver<T> {
    const d = toSeconds(by);
    return (ctx) => resolve(a, { ...ctx, time: ctx.time - d });
  },
  /** Time-remaps any animatable through an easing over [start, start+duration]. */
  remap<T>(a: Animatable<T>, fn: (t: number) => number): Driver<T> {
    return (ctx) => resolve(a, { ...ctx, time: fn(ctx.time) });
  },
  /** Combine several animatables. */
  combine<A extends unknown[], R>(fn: (...vals: A) => R, ...inputs: { [K in keyof A]: Animatable<A[K]> }): Driver<R> {
    return (ctx) => fn(...(inputs.map((i) => resolve(i as Animatable<unknown>, ctx)) as A));
  },
  /** Holds a value constant (useful to freeze a driver at a given time). */
  freeze<T>(a: Animatable<T>, at: TimeInput): Driver<T> {
    const t = toSeconds(at);
    return (ctx) => resolve(a, { ...ctx, time: t });
  },
};
