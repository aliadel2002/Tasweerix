import { ease, resolveEasing, toSeconds, type EasingInput, type GlyphAnimator, type GlyphState, type GlyphUnit, type TimeInput } from '@tasweerix/core';

export interface RevealOptions {
  by?: GlyphUnit;
  order?: GlyphAnimator['order'];
  start?: TimeInput;
  /** Seconds between units. */
  stagger?: TimeInput;
  /** Duration of each unit's animation. */
  duration?: TimeInput;
  ease?: EasingInput;
  from?: Partial<GlyphState>;
  to?: Partial<GlyphState>;
  seed?: number;
}

function anim(o: RevealOptions, defaults: Partial<RevealOptions>): GlyphAnimator {
  const m = { ...defaults, ...o };
  return {
    by: m.by ?? 'glyph',
    order: m.order ?? 'reading',
    start: toSeconds(m.start ?? 0),
    stagger: toSeconds(m.stagger ?? 0.04),
    duration: toSeconds(m.duration ?? 0.5),
    ease: resolveEasing(m.ease ?? 'outCubic'),
    from: m.from ?? { opacity: 0 },
    to: m.to,
    seed: m.seed ?? 0,
  };
}

/**
 * Kinetic typography presets. Each returns a GlyphAnimator for `text(...).glyphs(...)`.
 * Units can be glyphs, clusters, words or lines; order 'reading' respects RTL scripts.
 */
export const textFx = {
  /** Generic reveal from a state (opacity, y, scale, rotation, blur …) to rest. */
  reveal: (o: RevealOptions = {}) => anim(o, { from: { opacity: 0, y: 40 } }),
  fadeUp: (o: RevealOptions = {}) => anim(o, { from: { opacity: 0, y: 30 }, ease: 'outCubic' }),
  fadeDown: (o: RevealOptions = {}) => anim(o, { from: { opacity: 0, y: -30 }, ease: 'outCubic' }),
  pop: (o: RevealOptions = {}) => anim(o, { from: { opacity: 0, scale: 0.2 }, ease: 'outBack', duration: 0.45 }),
  blurIn: (o: RevealOptions = {}) => anim(o, { from: { opacity: 0, blur: 12, scale: 1.15 }, ease: 'outQuart', duration: 0.7 }),
  spinIn: (o: RevealOptions = {}) => anim(o, { from: { opacity: 0, rotation: -90, scale: 0.5 }, ease: 'outBack' }),
  dropIn: (o: RevealOptions = {}) => anim(o, { from: { opacity: 0, y: -120 }, ease: 'outBounce', duration: 0.8 }),
  stretchIn: (o: RevealOptions = {}) => anim(o, { from: { opacity: 0, scaleY: 2.2, scaleX: 0.4 }, ease: 'outElastic', duration: 0.9 }),
  /** Characters appear one by one with a hard cut. */
  typewriter: (o: { start?: TimeInput; cps?: number; by?: GlyphUnit } = {}) =>
    anim({ start: o.start, stagger: 1 / (o.cps ?? 18), duration: 0.001, by: o.by ?? 'cluster', ease: ease.hold }, { from: { opacity: 0 } }),
  /** Left-to-right (or reading-order) wipe of each unit. */
  wipe: (o: RevealOptions = {}) => anim(o, { from: { reveal: 0 }, ease: 'inOutCubic', duration: 0.35 }),
  /** Exit animation (animates from rest to the `to` state). */
  out: (o: RevealOptions & { to?: Partial<GlyphState> } = {}): GlyphAnimator => ({
    ...anim(o, {}),
    from: {},
    to: o.to ?? { opacity: 0, y: -30 },
  }),
  /** Continuous sine wave across units. */
  wave: (o: { amplitude?: number; frequency?: number; phase?: number; by?: GlyphUnit } = {}): GlyphAnimator => ({
    by: o.by ?? 'glyph',
    order: 'visual',
    start: 0,
    stagger: 0,
    duration: 0,
    ease: ease.linear,
    from: {},
    seed: 0,
    custom: ({ index, ctx }) => ({ y: Math.sin(ctx.time * (o.frequency ?? 2) * Math.PI * 2 + index * (o.phase ?? 0.5)) * (o.amplitude ?? 12) }),
  }),
  /** Random jitter per unit (glitchy, hand-made feel). */
  jitter: (o: { amount?: number; rotate?: number; fps?: number; seed?: number; by?: GlyphUnit } = {}): GlyphAnimator => ({
    by: o.by ?? 'glyph',
    order: 'reading',
    start: 0,
    stagger: 0,
    duration: 0,
    ease: ease.linear,
    from: {},
    seed: o.seed ?? 0,
    custom: ({ index, ctx }) => {
      const r = ctx.random(`${o.seed ?? 0}:${index}:${Math.floor(ctx.time * (o.fps ?? 12))}`);
      const a = o.amount ?? 3;
      return { x: (r() - 0.5) * 2 * a, y: (r() - 0.5) * 2 * a, rotation: (r() - 0.5) * 2 * (o.rotate ?? 4) };
    },
  }),
  /** Highlights units sequentially (karaoke). */
  highlight: (o: { color: string; start?: TimeInput; stagger?: TimeInput; by?: GlyphUnit; scale?: number }): GlyphAnimator => ({
    by: o.by ?? 'word',
    order: 'reading',
    start: toSeconds(o.start ?? 0),
    stagger: toSeconds(o.stagger ?? 0.3),
    duration: toSeconds(o.stagger ?? 0.3),
    ease: ease.linear,
    from: {},
    seed: 0,
    custom: ({ progress }) => (progress > 0 && progress < 1 ? { fill: o.color, scale: o.scale ?? 1.06 } : {}),
  }),
};

const SCRAMBLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+=?';

/** Text driver that decodes from random characters into the final string. */
export function scramble(final: string, opts: { start?: TimeInput; duration?: TimeInput; charset?: string; seed?: number } = {}) {
  const start = toSeconds(opts.start ?? 0);
  const dur = toSeconds(opts.duration ?? 1.2);
  const cs = opts.charset ?? SCRAMBLE;
  return (ctx: import('@tasweerix/core').FrameContext): string => {
    const p = Math.min(1, Math.max(0, (ctx.time - start) / dur));
    const settled = Math.floor(p * final.length);
    const r = ctx.random(`${opts.seed ?? 0}:${Math.floor(ctx.time * 20)}`);
    return [...final].map((ch, i) => (i < settled || ch === ' ' ? ch : cs[Math.floor(r() * cs.length)]!)).join('');
  };
}

/** Number counter driver with formatting. */
export function counter(from: number, to: number, opts: { start?: TimeInput; duration?: TimeInput; ease?: EasingInput; decimals?: number; prefix?: string; suffix?: string; separator?: string; locale?: string } = {}) {
  const start = toSeconds(opts.start ?? 0);
  const dur = toSeconds(opts.duration ?? 1.5);
  const e = resolveEasing(opts.ease ?? 'outCubic');
  return (ctx: import('@tasweerix/core').FrameContext): string => {
    const p = e(Math.min(1, Math.max(0, (ctx.time - start) / dur)));
    const v = from + (to - from) * p;
    const s = opts.locale
      ? v.toLocaleString(opts.locale, { minimumFractionDigits: opts.decimals ?? 0, maximumFractionDigits: opts.decimals ?? 0 })
      : v.toFixed(opts.decimals ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, opts.separator ?? ',');
    return `${opts.prefix ?? ''}${s}${opts.suffix ?? ''}`;
  };
}
