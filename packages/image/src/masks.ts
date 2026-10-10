import { parseColor, type ColorInput } from '@tasweerix/core';
import { createMask, luma, rgbToHsv, type Bitmap, type Mask } from './bitmap';
import { blurBuffer } from './filters';

/** A mask description resolved against an image when applied. */
export type MaskSpec =
  | { type: 'all' }
  | { type: 'rect'; x: number; y: number; width: number; height: number; feather?: number }
  | { type: 'ellipse' | 'radial'; center: [number, number]; radius: [number, number] | number; feather?: number }
  | { type: 'linear'; from: [number, number]; to: [number, number] }
  | { type: 'color'; color: ColorInput; tolerance?: number; feather?: number; space?: 'rgb' | 'hue' }
  | { type: 'luminance'; min?: number; max?: number; softness?: number }
  | { type: 'wand'; x: number; y: number; tolerance?: number; contiguous?: boolean; feather?: number }
  | { type: 'brush'; strokes: { points: [number, number][]; size: number; hardness?: number; erase?: boolean }[] }
  | { type: 'polygon'; points: [number, number][]; feather?: number }
  | { type: 'invert'; of: MaskSpec }
  | { type: 'combine'; op: 'add' | 'subtract' | 'intersect'; a: MaskSpec; b: MaskSpec }
  | { type: 'refine'; of: MaskSpec; grow?: number; feather?: number; contrast?: number };

/** Mask builders. Coordinates are in image pixels. */
export const mask = {
  all: (): MaskSpec => ({ type: 'all' }),
  rect: (x: number, y: number, width: number, height: number, feather = 0): MaskSpec => ({ type: 'rect', x, y, width, height, feather }),
  ellipse: (center: [number, number], radius: [number, number] | number, feather = 0): MaskSpec => ({ type: 'ellipse', center, radius, feather }),
  /** Radial gradient: 1 at center, fading to 0 at radius (feather = fraction of radius that fades). */
  radial: (center: [number, number], radius: number, feather = 0.5): MaskSpec => ({ type: 'radial', center, radius, feather }),
  /** Linear gradient: 1 at `from`, 0 at `to` (graduated filter). */
  linear: (from: [number, number], to: [number, number]): MaskSpec => ({ type: 'linear', from, to }),
  /** Select by color (rgb distance or hue distance). */
  color: (color: ColorInput, tolerance = 0.15, feather = 0.05, space: 'rgb' | 'hue' = 'rgb'): MaskSpec => ({ type: 'color', color, tolerance, feather, space }),
  /** Select by brightness range (luminosity mask). */
  luminance: (min = 0.5, max = 1, softness = 0.1): MaskSpec => ({ type: 'luminance', min, max, softness }),
  /** Magic wand from a seed pixel. */
  wand: (x: number, y: number, tolerance = 0.1, contiguous = true, feather = 0): MaskSpec => ({ type: 'wand', x, y, tolerance, contiguous, feather }),
  brush: (strokes: { points: [number, number][]; size: number; hardness?: number; erase?: boolean }[]): MaskSpec => ({ type: 'brush', strokes }),
  polygon: (points: [number, number][], feather = 0): MaskSpec => ({ type: 'polygon', points, feather }),
  invert: (of: MaskSpec): MaskSpec => ({ type: 'invert', of }),
  add: (a: MaskSpec, b: MaskSpec): MaskSpec => ({ type: 'combine', op: 'add', a, b }),
  subtract: (a: MaskSpec, b: MaskSpec): MaskSpec => ({ type: 'combine', op: 'subtract', a, b }),
  intersect: (a: MaskSpec, b: MaskSpec): MaskSpec => ({ type: 'combine', op: 'intersect', a, b }),
  /** Grow/shrink (px), feather (px) and contrast of an existing mask. */
  refine: (of: MaskSpec, opts: { grow?: number; feather?: number; contrast?: number }): MaskSpec => ({ type: 'refine', of, ...opts }),
};

const smooth = (e0: number, e1: number, x: number) => {
  if (e1 === e0) return x >= e1 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

function featherMask(m: Mask, px: number): Mask {
  if (!px) return m;
  return { width: m.width, height: m.height, data: blurBuffer(m.data, m.width, m.height, 1, px / 2) };
}

/** Morphological grow (positive) / shrink (negative) using a separable max/min filter. */
function growMask(m: Mask, px: number): Mask {
  if (!px) return m;
  const r = Math.round(Math.abs(px));
  const op = px > 0 ? Math.max : Math.min;
  const { width: w, height: h } = m;
  const pass = (src: Float32Array, horiz: boolean) => {
    const out = new Float32Array(src.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let v = src[y * w + x]!;
        for (let k = -r; k <= r; k++) {
          const xx = horiz ? Math.min(w - 1, Math.max(0, x + k)) : x;
          const yy = horiz ? y : Math.min(h - 1, Math.max(0, y + k));
          v = op(v, src[yy * w + xx]!);
        }
        out[y * w + x] = v;
      }
    return out;
  };
  return { width: w, height: h, data: pass(pass(m.data, true), false) };
}

export function resolveMask(spec: MaskSpec, img: Bitmap): Mask {
  const { width: w, height: h, data } = img;
  const m = createMask(w, h);
  const d = m.data;
  switch (spec.type) {
    case 'all':
      d.fill(1);
      return m;
    case 'rect': {
      for (let y = Math.max(0, Math.floor(spec.y)); y < Math.min(h, spec.y + spec.height); y++)
        for (let x = Math.max(0, Math.floor(spec.x)); x < Math.min(w, spec.x + spec.width); x++) d[y * w + x] = 1;
      return featherMask(m, spec.feather ?? 0);
    }
    case 'ellipse':
    case 'radial': {
      const [rx, ry] = Array.isArray(spec.radius) ? spec.radius : [spec.radius, spec.radius];
      const f = spec.type === 'radial' ? (spec.feather ?? 0.5) : 0;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const dx = (x + 0.5 - spec.center[0]) / rx;
          const dy = (y + 0.5 - spec.center[1]) / ry;
          const r = Math.hypot(dx, dy);
          d[y * w + x] = f > 0 ? 1 - smooth(1 - f, 1, r) : r <= 1 ? 1 : 0;
        }
      return spec.type === 'ellipse' ? featherMask(m, spec.feather ?? 0) : m;
    }
    case 'linear': {
      const vx = spec.to[0] - spec.from[0];
      const vy = spec.to[1] - spec.from[1];
      const L2 = vx * vx + vy * vy || 1;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const t = ((x + 0.5 - spec.from[0]) * vx + (y + 0.5 - spec.from[1]) * vy) / L2;
          d[y * w + x] = 1 - smooth(0, 1, t);
        }
      return m;
    }
    case 'color': {
      const [cr, cg, cb] = parseColor(spec.color);
      const tol = spec.tolerance ?? 0.15;
      const fe = spec.feather ?? 0.05;
      const targetHue = rgbToHsv(cr, cg, cb)[0];
      for (let p = 0; p < w * h; p++) {
        const r = data[p * 4]!;
        const g = data[p * 4 + 1]!;
        const b = data[p * 4 + 2]!;
        let dist: number;
        if (spec.space === 'hue') {
          const [hh, s] = rgbToHsv(r, g, b);
          dist = Math.abs(((hh - targetHue + 540) % 360) - 180) / 180 + (s < 0.1 ? 1 : 0);
        } else dist = Math.hypot(r - cr, g - cg, b - cb) / Math.sqrt(3);
        d[p] = 1 - smooth(tol, tol + fe, dist);
      }
      return m;
    }
    case 'luminance': {
      const s = spec.softness ?? 0.1;
      const lo = spec.min ?? 0.5;
      const hi = spec.max ?? 1;
      for (let p = 0; p < w * h; p++) {
        const l = luma(data[p * 4]!, data[p * 4 + 1]!, data[p * 4 + 2]!);
        d[p] = smooth(lo - s, lo, l) * (1 - smooth(hi, hi + s, l));
      }
      return m;
    }
    case 'wand': {
      const sx = Math.min(w - 1, Math.max(0, Math.round(spec.x)));
      const sy = Math.min(h - 1, Math.max(0, Math.round(spec.y)));
      const si = (sy * w + sx) * 4;
      const seed = [data[si]!, data[si + 1]!, data[si + 2]!];
      const tol = spec.tolerance ?? 0.1;
      const close = (p: number) => Math.hypot(data[p * 4]! - seed[0]!, data[p * 4 + 1]! - seed[1]!, data[p * 4 + 2]! - seed[2]!) / Math.sqrt(3) <= tol;
      if (spec.contiguous === false) {
        for (let p = 0; p < w * h; p++) d[p] = close(p) ? 1 : 0;
      } else {
        const stack = [sy * w + sx];
        const seen = new Uint8Array(w * h);
        while (stack.length) {
          const p = stack.pop()!;
          if (seen[p]) continue;
          seen[p] = 1;
          if (!close(p)) continue;
          d[p] = 1;
          const x = p % w;
          const y = (p / w) | 0;
          if (x > 0) stack.push(p - 1);
          if (x < w - 1) stack.push(p + 1);
          if (y > 0) stack.push(p - w);
          if (y < h - 1) stack.push(p + w);
        }
      }
      return featherMask(m, spec.feather ?? 0);
    }
    case 'brush': {
      for (const st of spec.strokes) {
        const rad = st.size / 2;
        const hard = st.hardness ?? 0.5;
        const pts = densify(st.points, Math.max(1, rad / 4));
        for (const [px, py] of pts) {
          for (let y = Math.max(0, Math.floor(py - rad)); y < Math.min(h, Math.ceil(py + rad)); y++)
            for (let x = Math.max(0, Math.floor(px - rad)); x < Math.min(w, Math.ceil(px + rad)); x++) {
              const r = Math.hypot(x + 0.5 - px, y + 0.5 - py) / rad;
              const v = 1 - smooth(hard, 1, r);
              const i = y * w + x;
              d[i] = st.erase ? Math.min(d[i]!, 1 - v) : Math.max(d[i]!, v);
            }
        }
      }
      return m;
    }
    case 'polygon': {
      const pts = spec.points;
      for (let y = 0; y < h; y++) {
        const yy = y + 0.5;
        const xs: number[] = [];
        for (let i = 0; i < pts.length; i++) {
          const [x0, y0] = pts[i]!;
          const [x1, y1] = pts[(i + 1) % pts.length]!;
          if ((y0 <= yy && y1 > yy) || (y1 <= yy && y0 > yy)) xs.push(x0 + ((yy - y0) / (y1 - y0)) * (x1 - x0));
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.ceil(xs[k]! - 0.5)); x < Math.min(w, Math.floor(xs[k + 1]! - 0.5) + 1); x++) d[y * w + x] = 1;
      }
      return featherMask(m, spec.feather ?? 0);
    }
    case 'invert': {
      const o = resolveMask(spec.of, img);
      for (let p = 0; p < d.length; p++) d[p] = 1 - o.data[p]!;
      return m;
    }
    case 'combine': {
      const a = resolveMask(spec.a, img).data;
      const b = resolveMask(spec.b, img).data;
      for (let p = 0; p < d.length; p++) d[p] = spec.op === 'add' ? Math.min(1, a[p]! + b[p]!) : spec.op === 'subtract' ? Math.max(0, a[p]! - b[p]!) : a[p]! * b[p]!;
      return m;
    }
    case 'refine': {
      let o = resolveMask(spec.of, img);
      if (spec.grow) o = growMask(o, spec.grow);
      if (spec.feather) o = featherMask(o, spec.feather);
      if (spec.contrast) {
        const k = 1 + spec.contrast;
        o = { ...o, data: o.data.map((v) => Math.min(1, Math.max(0, (v - 0.5) * k + 0.5))) };
      }
      return o;
    }
  }
}

function densify(points: [number, number][], step: number): [number, number][] {
  if (points.length < 2) return points;
  const out: [number, number][] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]!;
    const [x1, y1] = points[i]!;
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let k = 1; k <= n; k++) out.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
  }
  return out;
}
