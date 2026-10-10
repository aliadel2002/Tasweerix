import { resolveEasing, toSeconds, type FrameContext, type Behavior, type EasingInput, type SceneNode, type TimeInput, type Vec2 } from '@tasweerix/core';

export interface InOutOptions {
  /** Start (for enter) relative to node start; for exit, seconds before the node's end. */
  at?: TimeInput;
  duration?: TimeInput;
  ease?: EasingInput;
  delay?: TimeInput;
}

type Anim = Record<string, unknown>;

function enter(from: Anim, defaults: { duration: number; ease: EasingInput }) {
  return (o: InOutOptions = {}): Behavior => (n: SceneNode) => {
    const at = toSeconds(o.at ?? 0) + toSeconds(o.delay ?? 0);
    const d = toSeconds(o.duration ?? defaults.duration);
    const to: Anim = {};
    for (const k of Object.keys(from)) to[k] = [from[k], currentOf(n, k)];
    n.animate(to as never, { start: at, duration: d, ease: o.ease ?? defaults.ease });
  };
}

function exit(to: Anim, defaults: { duration: number; ease: EasingInput }) {
  return (o: InOutOptions = {}): Behavior => (n: SceneNode) => {
    const d = toSeconds(o.duration ?? defaults.duration);
    const dur = n.effectiveDuration();
    if (!Number.isFinite(dur)) throw new Error('exit behaviors need a node with a finite duration (use .lasting())');
    const at = dur - d - toSeconds(o.at ?? 0);
    n.animate(to as never, { start: at, duration: d, ease: o.ease ?? defaults.ease });
  };
}

function currentOf(n: SceneNode, k: string): unknown {
  const raw = (n.props as Record<string, unknown>)[k];
  if (raw !== undefined && typeof raw !== 'function' && !(raw as { isTrack?: boolean })?.isTrack) return raw;
  return n.defaultOf(k as never);
}

/** Relative offset behaviors read the node's static position. */
function slideFrom(dir: Vec2) {
  return (o: InOutOptions & { distance?: number } = {}): Behavior => (n: SceneNode) => {
    const pos = (currentOf(n, 'position') as Vec2 | undefined) ?? [0, 0];
    const dist = o.distance ?? 200;
    enter({ position: [pos[0] + dir[0] * dist, pos[1] + dir[1] * dist], opacity: 0 }, { duration: 0.6, ease: 'outCubic' })(o)(n);
  };
}
function slideTo(dir: Vec2) {
  return (o: InOutOptions & { distance?: number } = {}): Behavior => (n: SceneNode) => {
    const pos = (currentOf(n, 'position') as Vec2 | undefined) ?? [0, 0];
    const dist = o.distance ?? 200;
    exit({ position: [pos[0] + dir[0] * dist, pos[1] + dir[1] * dist], opacity: 0 }, { duration: 0.5, ease: 'inCubic' })(o)(n);
  };
}

/** Entrance / exit / loop behaviors: `node.use(enter.fade(), exit.slideDown({ duration: 0.4 }))`. */
export const enterFx = {
  fade: enter({ opacity: 0 }, { duration: 0.5, ease: 'outCubic' }),
  scale: enter({ scale: 0, opacity: 0 }, { duration: 0.5, ease: 'outBack' }),
  pop: enter({ scale: 0 }, { duration: 0.6, ease: 'outElastic' }),
  rotate: enter({ rotation: -180, scale: 0, opacity: 0 }, { duration: 0.7, ease: 'outBack' }),
  blur: enter({ opacity: 0, scale: 1.2 }, { duration: 0.6, ease: 'outQuart' }),
  slideLeft: slideFrom([1, 0]),
  slideRight: slideFrom([-1, 0]),
  slideUp: slideFrom([0, 1]),
  slideDown: slideFrom([0, -1]),
  /** Draw a stroke on (trim paths). */
  draw: enter({ trimEnd: 0 }, { duration: 1, ease: 'inOutCubic' }),
};

export const exitFx = {
  fade: exit({ opacity: 0 }, { duration: 0.4, ease: 'inCubic' }),
  scale: exit({ scale: 0, opacity: 0 }, { duration: 0.4, ease: 'inBack' }),
  slideLeft: slideTo([-1, 0]),
  slideRight: slideTo([1, 0]),
  slideUp: slideTo([0, -1]),
  slideDown: slideTo([0, 1]),
  /** Erase a stroke (trim start follows end). */
  erase: exit({ trimStart: 1 }, { duration: 0.8, ease: 'inOutCubic' }),
};

export const loopFx = {
  /** Gentle floating motion. */
  float: (o: { amplitude?: number; period?: number } = {}): Behavior => (n) => {
    const base = (currentOf(n, 'position') as Vec2 | undefined) ?? [0, 0];
    n.set({ position: (ctx: FrameContext) => [base[0], base[1] + Math.sin((ctx.time / (o.period ?? 3)) * Math.PI * 2) * (o.amplitude ?? 10)] as Vec2 });
  },
  /** Scale pulse. */
  pulse: (o: { amount?: number; period?: number } = {}): Behavior => (n) => {
    const base = (currentOf(n, 'scale') as number) ?? 1;
    n.set({ scale: (ctx: FrameContext) => base * (1 + Math.sin((ctx.time / (o.period ?? 1)) * Math.PI * 2) * (o.amount ?? 0.05)) });
  },
  /** Continuous rotation (degrees per second). */
  spin: (speed = 90): Behavior => (n) => {
    const base = (currentOf(n, 'rotation') as number) ?? 0;
    n.set({ rotation: (ctx: FrameContext) => base + ctx.time * speed });
  },
  /** Camera-shake style noise. */
  shake: (o: { amount?: number; frequency?: number; seed?: number } = {}): Behavior => (n) => {
    const base = (currentOf(n, 'position') as Vec2 | undefined) ?? [0, 0];
    n.set({
      position: (ctx: FrameContext) => {
        const nz = ctx.noise(o.seed ?? 7);
        const f = o.frequency ?? 8;
        const a = o.amount ?? 8;
        return [base[0] + nz.noise2(ctx.time * f, 1.3) * a, base[1] + nz.noise2(ctx.time * f, 9.1) * a] as Vec2;
      },
    });
  },
};

/** Easing helper re-export for presets. */
export { resolveEasing };
