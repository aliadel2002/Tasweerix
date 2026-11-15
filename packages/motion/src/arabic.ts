import { ease, group, line, resolveEasing, text, toSeconds, type Animatable, type GlyphAnimator, type GroupNode, type TimeInput, type Vec2 } from '@tasweerix/core';
import type { RevealOptions } from './text';

function anim(o: RevealOptions, d: Required<Pick<RevealOptions, 'by' | 'stagger' | 'duration' | 'ease' | 'from'>>): GlyphAnimator {
  return {
    by: o.by ?? d.by,
    order: o.order ?? 'reading',
    start: toSeconds(o.start ?? 0),
    stagger: toSeconds(o.stagger ?? d.stagger),
    duration: toSeconds(o.duration ?? d.duration),
    ease: resolveEasing(o.ease ?? d.ease),
    from: o.from ?? d.from,
    to: o.to,
    seed: o.seed ?? 0,
  };
}

/**
 * Kinetic typography presets for Arabic and other joining scripts, for `text(...).glyphs(...)`.
 *
 * They animate whole letters (`cluster`, so a letter moves with its marks) or words, always in reading
 * order, and never add tracking: spacing letters apart is what breaks a joined word. With a font file
 * the text is shaped by HarfBuzz and letters move one by one; without one, units fall back to words.
 */
export const arabicFx = {
  /** Letters are written on one after another, each wiped in from its right edge like a pen stroke. */
  write: (o: RevealOptions = {}) => anim(o, { by: 'cluster', stagger: 0.07, duration: 0.42, ease: 'inOutCubic', from: { reveal: 0 } }),
  /** Ink soaks into the page: letters sharpen out of a soft blur. */
  ink: (o: RevealOptions = {}) => anim(o, { by: 'cluster', stagger: 0.05, duration: 0.8, ease: 'outQuart', from: { opacity: 0, blur: 10 } }),
  /** Letters drop a short way and settle on the baseline with a slight turn. */
  settle: (o: RevealOptions = {}) => anim(o, { by: 'cluster', stagger: 0.05, duration: 0.6, ease: 'outBack', from: { opacity: 0, y: -34, rotation: 7 } }),
  /** Words rise into place one at a time. Suits headlines and captions. */
  rise: (o: RevealOptions = {}) => anim(o, { by: 'word', stagger: 0.14, duration: 0.55, ease: 'outCubic', from: { opacity: 0, y: 46 } }),
  /** Words swing down as if hung from the line above. */
  swing: (o: RevealOptions = {}) => anim(o, { by: 'word', stagger: 0.16, duration: 0.8, ease: 'outBack', from: { opacity: 0, y: -24, rotation: 12 } }),
  /** Exit: letters lift away, last letter first. */
  lift: (o: RevealOptions = {}): GlyphAnimator => ({ ...anim({ order: 'reverse', ...o }, { by: 'cluster', stagger: 0.03, duration: 0.35, ease: 'inCubic', from: {} }), from: {}, to: o.to ?? { opacity: 0, y: -36 } }),
  /** A slow swell that passes through the words, for text that stays on screen. */
  breathe: (o: { amount?: number; period?: number; by?: GlyphAnimator['by'] } = {}): GlyphAnimator => ({
    by: o.by ?? 'word',
    order: 'reading',
    start: 0,
    stagger: 0,
    duration: 0,
    ease: ease.linear,
    from: {},
    seed: 0,
    custom: ({ index, ctx }) => ({ scale: 1 + (o.amount ?? 0.03) * Math.sin((ctx.time / (o.period ?? 3)) * Math.PI * 2 - index * 0.7) }),
  }),
};

export interface BilingualTitleOptions {
  at?: Vec2;
  start?: TimeInput;
  duration?: TimeInput;
  /** Font file for the Arabic line. Needed for letter-by-letter animation. */
  font?: string;
  /** Font for the Latin line (defaults to the Arabic font). */
  latinFont?: string;
  size?: number;
  color?: string;
  accent?: string;
}

/**
 * A two-language title: the Arabic line written on letter by letter, a rule drawn from the right, and
 * the Latin line rising beneath it. The Arabic line can be a driver, for example
 * `kashidaText('جميل', keys([[0.6, 0], [1.6, 4]]))` to stretch it as it lands.
 */
export function bilingualTitle(arabic: Animatable<string>, latin: string, o: BilingualTitleOptions = {}): GroupNode {
  const size = o.size ?? 120;
  const accent = o.accent ?? '#f2a93b';
  const g = group({ at: o.at, start: o.start, duration: o.duration, name: 'bilingualTitle' });
  g.add(text(arabic, { at: [0, -size * 0.2], size, weight: 800, fill: o.color ?? '#ffffff', font: o.font ?? 'sans-serif', direction: 'rtl' }).glyphs(arabicFx.write({ start: 0.1 })));
  const half = size * 1.4;
  const p = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, (t - 0.5) / 0.7)), 3);
  // Drawn from the right end, the way the line above it is read.
  g.add(line([half, size * 0.62], [-half, size * 0.62], { stroke: accent, strokeWidth: Math.max(2, size / 30), trimEnd: (f) => p(f.time) }));
  g.add(text(latin, { at: [0, size * 0.98], size: size * 0.3, weight: 600, fill: 'rgba(255,255,255,0.8)', font: o.latinFont ?? o.font ?? 'sans-serif', direction: 'ltr' }).glyphs(arabicFx.rise({ start: 0.8, stagger: 0.08 })));
  return g;
}
