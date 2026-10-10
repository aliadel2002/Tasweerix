import { curveTable } from '@tasweerix/render';
import { cloneBitmap, hsvToRgb, luma, mapPixels, rgbToHsv, type Bitmap, type Mask } from './bitmap';

export interface Histogram {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  luma: Uint32Array;
  count: number;
}

export function histogram(b: Bitmap): Histogram {
  const h: Histogram = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), luma: new Uint32Array(256), count: 0 };
  const d = b.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3]! <= 0) continue;
    const q = (v: number) => Math.min(255, Math.max(0, Math.round(v * 255)));
    h.r[q(d[i]!)]!++;
    h.g[q(d[i + 1]!)]!++;
    h.b[q(d[i + 2]!)]!++;
    h.luma[q(luma(d[i]!, d[i + 1]!, d[i + 2]!))]!++;
    h.count++;
  }
  return h;
}

/** Value at a cumulative fraction of a histogram channel (0..1). */
export function percentile(hist: Uint32Array, count: number, p: number): number {
  if (p <= 0) {
    for (let i = 0; i < 256; i++) if (hist[i]) return i / 255;
    return 0;
  }
  if (p >= 1) {
    for (let i = 255; i >= 0; i--) if (hist[i]) return i / 255;
    return 1;
  }
  const target = p * count;
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i]!;
    if (acc >= target) return i / 255;
  }
  return 1;
}

/** Stretches each channel (or luma only) so `clip` fraction of pixels hit black/white. */
export function autoLevels(b: Bitmap, opts: { clip?: number; perChannel?: boolean } = {}): Bitmap {
  const clip = opts.clip ?? 0.005;
  const h = histogram(b);
  const chans = opts.perChannel ? [h.r, h.g, h.b] : [h.luma, h.luma, h.luma];
  const lo = chans.map((c) => percentile(c, h.count, clip));
  const hi = chans.map((c) => percentile(c, h.count, 1 - clip));
  return mapPixels(b, (r, g, bl) => [
    (r - lo[0]!) / Math.max(1e-3, hi[0]! - lo[0]!),
    (g - lo[1]!) / Math.max(1e-3, hi[1]! - lo[1]!),
    (bl - lo[2]!) / Math.max(1e-3, hi[2]! - lo[2]!),
  ].map((v) => Math.min(1, Math.max(0, v))) as [number, number, number]);
}

/** Auto white balance: gray-world (default) or white-patch (brightest pixels become neutral). */
export function autoWhiteBalance(b: Bitmap, method: 'gray-world' | 'white-patch' = 'gray-world', strength = 1): Bitmap {
  let sr = 0, sg = 0, sb = 0, n = 0;
  const d = b.data;
  if (method === 'gray-world') {
    for (let i = 0; i < d.length; i += 4) {
      const l = luma(d[i]!, d[i + 1]!, d[i + 2]!);
      if (l < 0.05 || l > 0.95) continue;
      sr += d[i]!;
      sg += d[i + 1]!;
      sb += d[i + 2]!;
      n++;
    }
  } else {
    const h = histogram(b);
    const thr = percentile(h.luma, h.count, 0.99);
    for (let i = 0; i < d.length; i += 4) {
      if (luma(d[i]!, d[i + 1]!, d[i + 2]!) < thr) continue;
      sr += d[i]!;
      sg += d[i + 1]!;
      sb += d[i + 2]!;
      n++;
    }
  }
  if (!n) return cloneBitmap(b);
  const avg = (sr + sg + sb) / (3 * n);
  const k = [avg / (sr / n), avg / (sg / n), avg / (sb / n)].map((x) => 1 + (x - 1) * strength);
  return mapPixels(b, (r, g, bl) => [Math.min(1, r * k[0]!), Math.min(1, g * k[1]!), Math.min(1, bl * k[2]!)]);
}

export interface AdjustParams {
  exposure?: number;
  brightness?: number;
  contrast?: number;
  highlights?: number;
  shadows?: number;
  whites?: number;
  blacks?: number;
  saturation?: number;
  vibrance?: number;
  temperature?: number;
  tint?: number;
  hue?: number;
  gamma?: number;
}

/** CPU tone & color adjustment (mirrors the GPU `grade` filter), optionally through a mask. */
export function adjust(b: Bitmap, p: AdjustParams, mask?: Mask): Bitmap {
  const exp = Math.pow(2, p.exposure ?? 0);
  const temp = p.temperature ?? 0;
  const tint = p.tint ?? 0;
  const wb = [1 + temp * 0.2 + tint * 0.05, 1 - tint * 0.1, 1 - temp * 0.2 + tint * 0.05];
  return mapPixels(
    b,
    (r, g, bl) => {
      let c = [r, g, bl].map((v, i) => Math.pow(Math.pow(Math.max(v, 0), 2.2) * exp * wb[i]!, 1 / 2.2) + (p.brightness ?? 0));
      const l = luma(c[0]!, c[1]!, c[2]!);
      const sh = 1 - smooth(0, 0.5, l);
      const hi = smooth(0.5, 1, l);
      c = c.map((v) => v + v * (p.shadows ?? 0) * sh * 0.8 + (p.highlights ?? 0) * hi * 0.5 * ((p.highlights ?? 0) > 0 ? 1 - v : v));
      c = c.map((v) => (p.blacks ?? 0) * 0.15 + v * (1 + (p.whites ?? 0) * 0.15 - (p.blacks ?? 0) * 0.15));
      c = c.map((v) => (v - 0.435) * (1 + (p.contrast ?? 0)) + 0.435);
      if (p.gamma) c = c.map((v) => Math.pow(Math.max(v, 0), 1 / p.gamma!));
      if (p.hue) {
        const [h, s, v] = rgbToHsv(clamp(c[0]!), clamp(c[1]!), clamp(c[2]!));
        c = hsvToRgb(h + p.hue, s, v);
      }
      const g2 = luma(c[0]!, c[1]!, c[2]!);
      c = c.map((v) => g2 + (v - g2) * (1 + (p.saturation ?? 0)));
      if (p.vibrance) {
        const sat = Math.max(...c) - Math.min(...c);
        const g3 = luma(c[0]!, c[1]!, c[2]!);
        c = c.map((v) => g3 + (v - g3) * (1 + p.vibrance! * (1 - sat)));
      }
      return c.map(clamp) as [number, number, number];
    },
    mask,
  );
}

export function curves(b: Bitmap, p: { rgb?: [number, number][]; r?: [number, number][]; g?: [number, number][]; b?: [number, number][] }, mask?: Mask): Bitmap {
  const [all, cr, cg, cb] = [p.rgb, p.r, p.g, p.b].map((x) => curveTable(x));
  const lut = (t: Float32Array, v: number) => t[Math.min(255, Math.max(0, Math.round(v * 255)))]!;
  return mapPixels(b, (r, g, bl) => [lut(cr!, lut(all!, r)), lut(cg!, lut(all!, g)), lut(cb!, lut(all!, bl))], mask);
}

/** Hue/saturation/lightness per hue range (center in degrees, width in degrees). */
export function hsl(b: Bitmap, p: { hue?: number; saturation?: number; lightness?: number; range?: number; width?: number }, mask?: Mask): Bitmap {
  return mapPixels(
    b,
    (r, g, bl) => {
      const [h, s, v] = rgbToHsv(r, g, bl);
      let w = 1;
      if (p.range !== undefined) {
        const d = Math.abs(((h - p.range + 540) % 360) - 180);
        const W = p.width ?? 60;
        w = (1 - smooth(W / 2, W, d)) * smooth(0.02, 0.15, s);
      }
      let [nr, ng, nb] = hsvToRgb(h + w * (p.hue ?? 0), clamp(s * (1 + w * (p.saturation ?? 0))), v);
      const L = (p.lightness ?? 0) * w;
      if (L > 0) [nr, ng, nb] = [nr + (1 - nr) * L, ng + (1 - ng) * L, nb + (1 - nb) * L];
      else if (L < 0) [nr, ng, nb] = [nr * (1 + L), ng * (1 + L), nb * (1 + L)];
      return [nr, ng, nb];
    },
    mask,
  );
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));
function smooth(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
