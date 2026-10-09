import type { Animatable } from './animatable';
import type { Env, MediaInfo } from './env';
import { captureSource, type SourceRef } from './source';
import { toSeconds, type TimeInput } from './time';

/** An audio effect in a clip / bus chain (implemented by @tasweerix/audio). */
export interface AudioEffectSpec {
  kind: string;
  params: Record<string, Animatable<any>>;
  /** Dry/wet mix 0..1. */
  mix?: Animatable<number>;
  /** Sidechain source (e.g. for ducking): clip id or bus name. */
  sidechain?: AudioClip | string;
}

/** Procedural audio source (synth). Evaluated by @tasweerix/audio. */
export interface GeneratorSpec {
  kind: string;
  params: Record<string, unknown>;
}

export type FadeCurve = 'linear' | 'equal-power' | 'exponential' | 'logarithmic' | 's-curve';

let clipId = 1;

export interface AudioClipOptions {
  start?: TimeInput;
  trim?: [TimeInput, TimeInput?];
  duration?: TimeInput;
  /** Gain in dB (animatable). */
  gain?: Animatable<number>;
  /** Linear volume multiplier (animatable). Multiplied with gain. */
  volume?: Animatable<number>;
  pan?: Animatable<number>;
  speed?: number;
  /** Pitch shift in semitones (independent of speed). */
  pitch?: number;
  /** When true, speed changes do not change pitch (time-stretch). */
  preservePitch?: boolean;
  loop?: boolean;
  reverse?: boolean;
  bus?: string;
  name?: string;
  muted?: boolean;
}

export class AudioClip {
  readonly id: string;
  name?: string;
  src: string | null;
  generator?: GeneratorSpec;
  start = 0;
  trimIn = 0;
  trimOut?: number;
  duration?: number;
  naturalDuration?: number;
  gain: Animatable<number> = 0;
  volume: Animatable<number> = 1;
  pan: Animatable<number> = 0;
  speed = 1;
  pitch = 0;
  preservePitch = false;
  loop = false;
  reverse = false;
  muted = false;
  fadeInDur = 0;
  fadeOutDur = 0;
  fadeInCurve: FadeCurve = 'equal-power';
  fadeOutCurve: FadeCurve = 'equal-power';
  effects: AudioEffectSpec[] = [];
  bus = 'master';
  info?: MediaInfo;
  /** Set for clips generated from video nodes. */
  implicit = false;
  source?: SourceRef;
  meta: Record<string, unknown> = {};

  constructor(src: string | GeneratorSpec, opts: AudioClipOptions = {}) {
    this.id = `audio-${clipId++}`;
    if (typeof src === 'string') this.src = src;
    else {
      this.src = null;
      this.generator = src;
    }
    this.source = captureSource();
    if (opts.start !== undefined) this.start = toSeconds(opts.start);
    if (opts.trim) {
      this.trimIn = toSeconds(opts.trim[0]);
      if (opts.trim[1] !== undefined) this.trimOut = toSeconds(opts.trim[1]);
    }
    if (opts.duration !== undefined) this.duration = toSeconds(opts.duration);
    if (opts.gain !== undefined) this.gain = opts.gain;
    if (opts.volume !== undefined) this.volume = opts.volume;
    if (opts.pan !== undefined) this.pan = opts.pan;
    if (opts.speed !== undefined) this.speed = opts.speed;
    if (opts.pitch !== undefined) this.pitch = opts.pitch;
    if (opts.preservePitch) this.preservePitch = true;
    if (opts.loop) this.loop = true;
    if (opts.reverse) this.reverse = true;
    if (opts.bus) this.bus = opts.bus;
    if (opts.name) this.name = opts.name;
    if (opts.muted) this.muted = true;
  }

  at(t: TimeInput): this {
    this.start = toSeconds(t);
    return this;
  }
  trim(inPoint: TimeInput, outPoint?: TimeInput): this {
    this.trimIn = toSeconds(inPoint);
    this.trimOut = outPoint !== undefined ? toSeconds(outPoint) : undefined;
    return this;
  }
  lasting(d: TimeInput): this {
    this.duration = toSeconds(d);
    return this;
  }
  fadeIn(d: TimeInput, curve: FadeCurve = 'equal-power'): this {
    this.fadeInDur = toSeconds(d);
    this.fadeInCurve = curve;
    return this;
  }
  fadeOut(d: TimeInput, curve: FadeCurve = 'equal-power'): this {
    this.fadeOutDur = toSeconds(d);
    this.fadeOutCurve = curve;
    return this;
  }
  /** Gain in dB (animatable). */
  db(gain: Animatable<number>): this {
    this.gain = gain;
    return this;
  }
  vol(v: Animatable<number>): this {
    this.volume = v;
    return this;
  }
  panTo(p: Animatable<number>): this {
    this.pan = p;
    return this;
  }
  rate(speed: number, preservePitch = false): this {
    this.speed = speed;
    this.preservePitch = preservePitch;
    return this;
  }
  shiftPitch(semitones: number): this {
    this.pitch = semitones;
    return this;
  }
  looped(on = true): this {
    this.loop = on;
    return this;
  }
  reversed(on = true): this {
    this.reverse = on;
    return this;
  }
  toBus(name: string): this {
    this.bus = name;
    return this;
  }
  effect(...fx: AudioEffectSpec[]): this {
    this.effects.push(...fx);
    return this;
  }
  /** Ducks this clip under another (sidechain compression). */
  duck(under: AudioClip | string, opts: { amount?: number; threshold?: number; attack?: number; release?: number } = {}): this {
    this.effects.push({
      kind: 'duck',
      params: {
        amount: opts.amount ?? -12,
        threshold: opts.threshold ?? -40,
        attack: opts.attack ?? 0.08,
        release: opts.release ?? 0.4,
      },
      sidechain: under,
    });
    return this;
  }

  /** Seconds of source used (before speed). */
  sourceSpan(): number | undefined {
    const out = this.trimOut ?? this.info?.duration ?? this.naturalDuration;
    return out !== undefined ? Math.max(0, out - this.trimIn) : undefined;
  }

  effectiveDuration(): number {
    if (this.duration !== undefined) return this.duration;
    if (this.loop) return Infinity;
    const span = this.sourceSpan();
    if (span === undefined) return Infinity;
    return span / Math.abs(this.speed || 1);
  }

  get end(): number {
    return this.start + this.effectiveDuration();
  }

  async prepare(env: Env): Promise<void> {
    if (this.src) this.info = await env.probe(this.src).catch(() => ({}));
    if (this.generator && this.duration === undefined && typeof this.generator.params.duration === 'number') {
      this.naturalDuration = this.generator.params.duration;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      name: this.name,
      src: this.src,
      generator: this.generator?.kind,
      start: this.start,
      trim: [this.trimIn, this.trimOut ?? null],
      duration: Number.isFinite(this.effectiveDuration()) ? this.effectiveDuration() : null,
      speed: this.speed,
      bus: this.bus,
      effects: this.effects.map((e) => e.kind),
      implicit: this.implicit || undefined,
    };
  }
}

/** Creates an audio clip from a file. */
export function audio(src: string, opts?: AudioClipOptions): AudioClip {
  return new AudioClip(src, opts);
}

/** Creates a procedural (synth) audio clip. */
export function generator(kind: string, params: Record<string, unknown>, opts?: AudioClipOptions): AudioClip {
  return new AudioClip({ kind, params }, opts);
}

export interface BusSpec {
  name: string;
  effects: AudioEffectSpec[];
  gain: Animatable<number>;
  pan: Animatable<number>;
  /** Output bus (defaults to master). */
  output: string;
}
