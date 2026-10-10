import { ellipse, group, palette, polyline, rect, text, toCss, toSeconds, resolveEasing, type EasingInput, type GroupNode, type NodeOptions, type TimeInput, type Vec2 } from '@tasweerix/core';
import { counter } from './text';

export interface ChartOptions extends NodeOptions {
  size?: Vec2;
  colors?: string[];
  /** Animation start & duration of the build-in. */
  animateIn?: { start?: TimeInput; duration?: TimeInput; stagger?: TimeInput; ease?: EasingInput } | false;
  labels?: boolean;
  font?: string;
  labelColor?: string;
  valueFormat?: (v: number) => string;
}

const progress = (o: ChartOptions['animateIn'], i: number) => {
  if (o === false) return () => 1;
  const s = toSeconds(o?.start ?? 0) + i * toSeconds(o?.stagger ?? 0.08);
  const d = toSeconds(o?.duration ?? 0.8);
  const e = resolveEasing(o?.ease ?? 'outCubic');
  return (t: number) => e(Math.min(1, Math.max(0, (t - s) / d)));
};

/** Animated bar chart. Bars grow from the baseline. */
export function barChart(data: { label?: string; value: number }[], o: ChartOptions = {}): GroupNode {
  const [W, H] = o.size ?? [800, 400];
  const max = Math.max(...data.map((d) => d.value), 1e-9);
  const cols = (o.colors ?? palette(['#22d3ee', '#6366f1', '#ec4899'], data.length).map((c) => toCss(c)));
  const g = group({ name: o.name ?? 'barChart', start: o.start, duration: o.duration, at: o.at });
  const slot = W / data.length;
  const bw = slot * 0.7;
  data.forEach((d, i) => {
    const p = progress(o.animateIn, i);
    const h = (d.value / max) * (H - (o.labels === false ? 0 : 40));
    const x = -W / 2 + slot * (i + 0.5);
    g.add(rect({ at: [x, H / 2], anchor: (f) => [0, (h * p(f.time)) / 2], size: (f) => [bw, Math.max(0.001, h * p(f.time))], radius: Math.min(8, bw / 6), fill: cols[i % cols.length]! }));
    if (o.labels !== false) {
      if (d.label) g.add(text(d.label, { at: [x, H / 2 + 24], size: 18, fill: o.labelColor ?? '#cbd5e1', font: o.font ?? 'sans-serif' }));
      g.add(text((f) => (o.valueFormat ?? ((v: number) => v.toFixed(0)))(d.value * p(f.time)), { at: (f) => [x, H / 2 - h * p(f.time) - 16], size: 18, weight: 700, fill: o.labelColor ?? '#ffffff', font: o.font ?? 'sans-serif', opacity: (f) => p(f.time) }));
    }
  });
  return g;
}

/** Animated line chart that draws itself (trim paths). */
export function lineChart(values: number[], o: ChartOptions & { strokeWidth?: number; dots?: boolean; smooth?: number } = {}): GroupNode {
  const [W, H] = o.size ?? [800, 400];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pts: Vec2[] = values.map((v, i) => [-W / 2 + (W * i) / Math.max(1, values.length - 1), H / 2 - ((v - min) / (max - min || 1)) * H]);
  const p = progress(o.animateIn, 0);
  const color = o.colors?.[0] ?? '#22d3ee';
  const g = group({ name: o.name ?? 'lineChart', start: o.start, duration: o.duration, at: o.at });
  g.add(polyline(pts, { stroke: color, strokeWidth: o.strokeWidth ?? 5, smooth: o.smooth ?? 0.5, trimEnd: (f) => p(f.time) }));
  if (o.dots !== false)
    pts.forEach((pt, i) => {
      const at = i / Math.max(1, pts.length - 1);
      g.add(ellipse({ at: pt, size: [12, 12], fill: color, scale: (f) => (p(f.time) >= at ? 1 : 0) }));
    });
  return g;
}

/** Animated pie / donut chart. */
export function pieChart(data: { label?: string; value: number }[], o: ChartOptions & { radius?: number; donut?: number } = {}): GroupNode {
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const R = o.radius ?? 180;
  const cols = o.colors ?? palette(['#22d3ee', '#6366f1', '#ec4899', '#f59e0b'], data.length).map((c) => toCss(c));
  const g = group({ name: o.name ?? 'pieChart', start: o.start, duration: o.duration, at: o.at });
  const p = progress(o.animateIn, 0);
  let acc = 0;
  data.forEach((d, i) => {
    const a0 = (acc / total) * 360;
    acc += d.value;
    const a1 = (acc / total) * 360;
    if (o.donut) {
      const w = R * o.donut;
      g.add(ellipse({ size: [2 * R - w, 2 * R - w], fill: null, stroke: cols[i % cols.length]!, strokeWidth: w, startAngle: a0, endAngle: (f) => a0 + Math.max(0.01, (a1 - a0) * p(f.time)) }));
    } else g.add(ellipse({ size: [2 * R, 2 * R], fill: cols[i % cols.length]!, startAngle: a0, endAngle: (f) => a0 + (a1 - a0) * p(f.time) }));
  });
  return g;
}

/** Animated number with formatting. */
export function numberCounter(to: number, o: { from?: number; start?: TimeInput; duration?: TimeInput; decimals?: number; prefix?: string; suffix?: string; size?: number; fill?: string; font?: string; weight?: number } & NodeOptions = {}) {
  // `start`/`duration` time the count; the text itself stays visible from `start` on.
  return text(counter(o.from ?? 0, to, { ...o, start: 0 }), { size: o.size ?? 96, fill: o.fill ?? '#fff', font: o.font ?? 'sans-serif', weight: o.weight ?? 800, at: o.at, start: o.start, name: o.name });
}

/** Progress bar filling over time. */
export function progressBar(o: { size?: Vec2; color?: string; track?: string; start?: TimeInput; duration?: TimeInput; ease?: EasingInput; radius?: number } & NodeOptions = {}): GroupNode {
  const [W, H] = o.size ?? [600, 16];
  const s = toSeconds(o.start ?? 0);
  const d = toSeconds(o.duration ?? 2);
  const e = resolveEasing(o.ease ?? 'inOutCubic');
  const p = (t: number) => e(Math.min(1, Math.max(0, (t - s) / d)));
  const g = group({ at: o.at, name: o.name ?? 'progressBar' });
  g.add(rect({ size: [W, H], radius: o.radius ?? H / 2, fill: o.track ?? 'rgba(255,255,255,0.15)' }));
  g.add(rect({ at: [-W / 2, 0], anchor: (f) => [-(W * p(f.time)) / 2, 0], size: (f) => [Math.max(0.001, W * p(f.time)), H], radius: o.radius ?? H / 2, fill: o.color ?? '#22d3ee' }));
  return g;
}
