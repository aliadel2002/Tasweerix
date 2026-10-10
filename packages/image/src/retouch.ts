import { cloneBitmap, sample, type Bitmap } from './bitmap';
import { blurBuffer } from './filters';

export interface PatchOptions {
  /** Source center (pixels). */
  from: [number, number];
  /** Destination center (pixels). */
  to: [number, number];
  radius: number;
  /** 0..1 portion of the radius that fades out. */
  feather?: number;
  opacity?: number;
}

/** Clone stamp: copies a feathered circular patch from → to. */
export function clone(b: Bitmap, p: PatchOptions): Bitmap {
  const out = cloneBitmap(b);
  const r = p.radius;
  const f = p.feather ?? 0.4;
  const op = p.opacity ?? 1;
  const px: number[] = [0, 0, 0, 0];
  for (let y = Math.max(0, Math.floor(p.to[1] - r)); y < Math.min(b.height, Math.ceil(p.to[1] + r)); y++)
    for (let x = Math.max(0, Math.floor(p.to[0] - r)); x < Math.min(b.width, Math.ceil(p.to[0] + r)); x++) {
      const d = Math.hypot(x + 0.5 - p.to[0], y + 0.5 - p.to[1]) / r;
      if (d >= 1) continue;
      const w = (d < 1 - f ? 1 : 1 - (d - (1 - f)) / f) * op;
      sample(b, x + 0.5 + p.from[0] - p.to[0], y + 0.5 + p.from[1] - p.to[1], px);
      const i = (y * b.width + x) * 4;
      for (let c = 0; c < 4; c++) out.data[i + c] = out.data[i + c]! + (px[c]! - out.data[i + c]!) * w;
    }
  return out;
}

/**
 * Healing brush: copies texture (high frequencies) from the source patch while keeping the
 * destination's low-frequency color/brightness, so blemishes vanish without visible seams.
 */
export function heal(b: Bitmap, p: PatchOptions): Bitmap {
  const r = p.radius;
  const pad = Math.ceil(r * 2);
  const x0 = Math.max(0, Math.floor(Math.min(p.to[0], p.from[0]) - pad));
  const y0 = Math.max(0, Math.floor(Math.min(p.to[1], p.from[1]) - pad));
  const x1 = Math.min(b.width, Math.ceil(Math.max(p.to[0], p.from[0]) + pad));
  const y1 = Math.min(b.height, Math.ceil(Math.max(p.to[1], p.from[1]) + pad));
  const w = x1 - x0;
  const h = y1 - y0;
  // Low-pass of the region (sigma ~ radius/2).
  const region = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) region.set(b.data.subarray(((y + y0) * b.width + x0) * 4, ((y + y0) * b.width + x1) * 4), y * w * 4);
  const low = blurBuffer(region, w, h, 4, Math.max(1, r / 2));
  const lowAt = (x: number, y: number, c: number) => {
    const xx = Math.min(w - 1, Math.max(0, Math.round(x - x0)));
    const yy = Math.min(h - 1, Math.max(0, Math.round(y - y0)));
    return low[(yy * w + xx) * 4 + c]!;
  };
  const out = cloneBitmap(b);
  const f = p.feather ?? 0.5;
  const op = p.opacity ?? 1;
  const dx = p.from[0] - p.to[0];
  const dy = p.from[1] - p.to[1];
  for (let y = Math.max(0, Math.floor(p.to[1] - r)); y < Math.min(b.height, Math.ceil(p.to[1] + r)); y++)
    for (let x = Math.max(0, Math.floor(p.to[0] - r)); x < Math.min(b.width, Math.ceil(p.to[0] + r)); x++) {
      const d = Math.hypot(x + 0.5 - p.to[0], y + 0.5 - p.to[1]) / r;
      if (d >= 1) continue;
      const wgt = (d < 1 - f ? 1 : 1 - (d - (1 - f)) / f) * op;
      const sx = Math.min(b.width - 1, Math.max(0, x + dx));
      const sy = Math.min(b.height - 1, Math.max(0, y + dy));
      const si = (Math.round(sy) * b.width + Math.round(sx)) * 4;
      const i = (y * b.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const detail = b.data[si + c]! - lowAt(sx, sy, c);
        // Destination base: low-pass of the surroundings excluding the blemish, approximated by the
        // ring average at the patch edge.
        const base = ringAverage(low, w, h, p.to[0] - x0, p.to[1] - y0, r, c);
        const v = Math.min(1, Math.max(0, base + detail));
        out.data[i + c] = out.data[i + c]! + (v - out.data[i + c]!) * wgt;
      }
    }
  return out;
}

const ringCache = new WeakMap<Float32Array, Map<string, number>>();
function ringAverage(low: Float32Array, w: number, h: number, cx: number, cy: number, r: number, c: number): number {
  let cache = ringCache.get(low);
  if (!cache) ringCache.set(low, (cache = new Map()));
  const key = `${cx}|${cy}|${r}|${c}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let s = 0;
  let n = 0;
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * Math.PI * 2;
    const x = Math.round(cx + Math.cos(a) * r * 1.15);
    const y = Math.round(cy + Math.sin(a) * r * 1.15);
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    s += low[(y * w + x) * 4 + c]!;
    n++;
  }
  const v = n ? s / n : 0;
  cache.set(key, v);
  return v;
}

/** Red-eye removal inside a circle: replaces saturated red with the pupil's dark luminance. */
export function redEye(b: Bitmap, center: [number, number], radius: number): Bitmap {
  const out = cloneBitmap(b);
  for (let y = Math.max(0, Math.floor(center[1] - radius)); y < Math.min(b.height, Math.ceil(center[1] + radius)); y++)
    for (let x = Math.max(0, Math.floor(center[0] - radius)); x < Math.min(b.width, Math.ceil(center[0] + radius)); x++) {
      if (Math.hypot(x + 0.5 - center[0], y + 0.5 - center[1]) > radius) continue;
      const i = (y * b.width + x) * 4;
      const r = b.data[i]!;
      const g = b.data[i + 1]!;
      const bl = b.data[i + 2]!;
      if (r > 0.3 && r > (g + bl) * 0.7) {
        const v = (g + bl) / 2;
        out.data[i] = v;
      }
    }
  return out;
}
