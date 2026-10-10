import { group, line, rect, text, ellipse, toSeconds, resolve, type Animatable, type GroupNode, type TimeInput, type Vec2, type FrameContext } from '@tasweerix/core';
import { textFx } from './text';

export interface LowerThirdOptions {
  at?: Vec2;
  start?: TimeInput;
  duration?: TimeInput;
  accent?: string;
  font?: string;
  titleSize?: number;
  subtitleSize?: number;
  /** Text direction: lays the bar on the right for RTL. */
  rtl?: boolean;
}

/** Broadcast-style lower third with an accent bar, title and subtitle. */
export function lowerThird(title: string, subtitle = '', o: LowerThirdOptions = {}): GroupNode {
  const dur = toSeconds(o.duration ?? 5);
  const at = o.at ?? [140, 860];
  const dir = o.rtl ? -1 : 1;
  const g = group({ at, start: o.start, duration: dur, name: 'lowerThird' });
  const out = (t: number) => Math.min(1, Math.max(0, (dur - t) / 0.4));
  const inn = (t: number, d = 0) => Math.min(1, Math.max(0, (t - d) / 0.45));
  const ez = (x: number) => 1 - Math.pow(1 - x, 3);
  g.add(rect({ at: [0, 0], anchor: [0, 0], size: (f) => [8, 120 * ez(inn(f.time)) * out(f.time) + 0.001], fill: o.accent ?? '#22d3ee' }));
  const align = o.rtl ? 'right' : 'left';
  g.add(
    text(title, { at: [24 * dir, -22], align, size: o.titleSize ?? 56, weight: 800, fill: '#ffffff', font: o.font ?? 'sans-serif', opacity: (f) => out(f.time) }).glyphs(
      textFx.fadeUp({ by: 'glyph', stagger: 0.02, duration: 0.4, start: 0.15 }),
    ),
  );
  if (subtitle)
    g.add(
      text(subtitle, { at: [26 * dir, 34], align, size: o.subtitleSize ?? 30, weight: 500, fill: 'rgba(255,255,255,0.78)', font: o.font ?? 'sans-serif', opacity: (f) => out(f.time) }).glyphs(
        textFx.wipe({ by: 'word', stagger: 0.06, start: 0.4 }),
      ),
    );
  return g;
}

/** Centered title card with optional kicker line. */
export function titleCard(title: string, o: { kicker?: string; at?: Vec2; start?: TimeInput; duration?: TimeInput; font?: string; size?: number; color?: string; accent?: string } = {}): GroupNode {
  const g = group({ at: o.at, start: o.start, duration: o.duration, name: 'titleCard' });
  if (o.kicker) g.add(text(o.kicker.toUpperCase(), { at: [0, -(o.size ?? 120) * 0.75], size: (o.size ?? 120) * 0.22, letterSpacing: 8, weight: 700, fill: o.accent ?? '#22d3ee', font: o.font ?? 'sans-serif' }).glyphs(textFx.fadeDown({ stagger: 0.02 })));
  g.add(text(title, { size: o.size ?? 120, weight: 900, fill: o.color ?? '#fff', font: o.font ?? 'sans-serif' }).glyphs(textFx.blurIn({ stagger: 0.04, start: 0.2 })));
  g.add(line([-120, (o.size ?? 120) * 0.62], [120, (o.size ?? 120) * 0.62], { stroke: o.accent ?? '#22d3ee', strokeWidth: 4, trimStart: 0.5, trimEnd: (f) => 0.5 + 0.5 * Math.min(1, Math.max(0, (f.time - 0.5) / 0.6)) }).set({ trimStart: (f: FrameContext) => 0.5 - 0.5 * Math.min(1, Math.max(0, (f.time - 0.5) / 0.6)) }));
  return g;
}

/** Callout: a dot on a point of interest with a leader line and label. */
export function callout(point: Vec2, label: string, o: { offset?: Vec2; start?: TimeInput; color?: string; font?: string; size?: number } = {}): GroupNode {
  const off = o.offset ?? [160, -100];
  const c = o.color ?? '#facc15';
  // Absolute coordinates: anchor the group at the composition origin.
  const g = group({ start: o.start, name: 'callout', at: [0, 0] });
  const p = (t: number, d: number, len: number) => Math.min(1, Math.max(0, (t - d) / len));
  g.add(ellipse({ at: point, size: [18, 18], fill: c, scale: (f) => 1 - Math.pow(1 - p(f.time, 0, 0.3), 3) }));
  g.add(ellipse({ at: point, size: [18, 18], fill: null, stroke: c, strokeWidth: 3, scale: (f) => 1 + ((f.time * 1.2) % 1) * 2, opacity: (f) => 1 - ((f.time * 1.2) % 1) }));
  g.add(line(point, [point[0] + off[0], point[1] + off[1]], { stroke: c, strokeWidth: 3, trimEnd: (f) => p(f.time, 0.2, 0.4) }));
  g.add(text(label, { at: [point[0] + off[0] + Math.sign(off[0] || 1) * 12, point[1] + off[1]], align: off[0] >= 0 ? 'left' : 'right', size: o.size ?? 34, weight: 700, fill: '#fff', font: o.font ?? 'sans-serif' }).glyphs(textFx.fadeUp({ start: 0.5, stagger: 0.015 })));
  return g;
}

/** Audio spectrum bars driven by an analysis (see `analyze()` in @tasweerix/audio). */
export function spectrumBars(source: { spectrum(at: FrameContext, bands: number): number[] }, o: { bars?: number; width?: number; height?: number; at?: Vec2; color?: Animatable<string>; gap?: number; radius?: number; mirror?: boolean } = {}): GroupNode {
  const n = o.bars ?? 48;
  const W = o.width ?? 1200;
  const H = o.height ?? 300;
  const slot = W / n;
  const bw = slot * (1 - (o.gap ?? 0.3));
  const g = group({ at: o.at, name: 'spectrum' });
  for (let i = 0; i < n; i++) {
    const h = (f: FrameContext) => 4 + source.spectrum(f, n)[i]! * H;
    g.add(
      rect({
        at: [-W / 2 + slot * (i + 0.5), 0],
        anchor: (f) => [0, o.mirror ? 0 : h(f) / 2],
        size: (f) => [bw, h(f)],
        radius: o.radius ?? bw / 2,
        fill: (f) => resolve(o.color ?? '#22d3ee', { ...f, index: i, count: n }),
      }),
    );
  }
  return g;
}
