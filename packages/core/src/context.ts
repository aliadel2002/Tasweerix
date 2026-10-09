import { createNoise, type Noise } from './noise';
import { createRandom, type Random } from './random';

/** Everything an animated value can look at when it is evaluated. */
export interface FrameContext {
  /** Local time of the node being evaluated, in seconds (0 = node start). */
  time: number;
  /** Absolute composition time in seconds. */
  globalTime: number;
  /** Absolute composition frame index. */
  frame: number;
  fps: number;
  /** Duration of the node being evaluated (Infinity if open ended). */
  duration: number;
  /** time / duration, clamped to 0..1 (0 if open ended). */
  progress: number;
  /** Composition size. */
  width: number;
  height: number;
  /** Deterministic random generator for a seed (stable across frames). */
  random(seed?: number | string): Random;
  /** Seeded simplex noise. */
  noise(seed?: number | string): Noise;
  /** Arbitrary per-render data (e.g. input props for templated renders). */
  props: Record<string, unknown>;
  /** Index of the item when evaluated inside a repeater / glyph animator. */
  index?: number;
  count?: number;
}

const randomCache = new Map<string, Random>();

export function makeContext(init: Partial<FrameContext> & { fps: number; width: number; height: number }): FrameContext {
  const time = init.time ?? 0;
  const duration = init.duration ?? Infinity;
  return {
    time,
    globalTime: init.globalTime ?? time,
    frame: init.frame ?? Math.floor((init.globalTime ?? time) * init.fps + 1e-6),
    fps: init.fps,
    duration,
    progress: Number.isFinite(duration) && duration > 0 ? Math.min(1, Math.max(0, time / duration)) : 0,
    width: init.width,
    height: init.height,
    props: init.props ?? {},
    index: init.index,
    count: init.count,
    random(seed = 0) {
      // Fresh generator each call so results don't depend on evaluation order.
      const key = String(seed);
      randomCache.delete(key);
      return createRandom(seed);
    },
    noise: (seed = 0) => createNoise(seed),
  };
}

/** Derives a child context with a different local time / duration. */
export function localContext(parent: FrameContext, time: number, duration: number): FrameContext {
  return {
    ...parent,
    time,
    duration,
    progress: Number.isFinite(duration) && duration > 0 ? Math.min(1, Math.max(0, time / duration)) : 0,
  };
}
