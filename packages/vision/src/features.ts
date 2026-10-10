import type { Vec2 } from '@tasweerix/core';
import { gradients, type Gray } from './image';

export interface FeatureOptions {
  /** Maximum number of corners. */
  max?: number;
  /** Minimum corner strength relative to the strongest corner (0–1). */
  quality?: number;
  /** Minimum distance between corners in pixels. */
  minDistance?: number;
  /** Pixels ignored at the image border. */
  border?: number;
  /** Only search inside this circle. */
  region?: { center: Vec2; radius: number };
}

/**
 * Shi–Tomasi corners ("good features to track"): local maxima of the smaller eigenvalue of the
 * structure tensor, strongest first, spread out by a minimum distance.
 */
export function goodFeatures(img: Gray, o: FeatureOptions = {}): Vec2[] {
  const max = o.max ?? 300;
  const quality = o.quality ?? 0.01;
  const minDist = o.minDistance ?? 8;
  const border = Math.max(2, o.border ?? 8);
  const { width: w, height: h } = img;
  let x0 = border;
  let y0 = border;
  let x1 = w - border;
  let y1 = h - border;
  if (o.region) {
    const [cx, cy] = o.region.center;
    const r = o.region.radius;
    x0 = Math.max(x0, Math.floor(cx - r));
    y0 = Math.max(y0, Math.floor(cy - r));
    x1 = Math.min(x1, Math.ceil(cx + r));
    y1 = Math.min(y1, Math.ceil(cy + r));
  }
  if (x1 - x0 < 3 || y1 - y0 < 3) return [];
  const { gx, gy } = gradients(img);
  // Structure tensor summed over a 3×3 block → min eigenvalue map.
  const score = new Float32Array(w * h);
  let best = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const row = (y + dy) * w;
        for (let dx = -1; dx <= 1; dx++) {
          const ix = gx.data[row + x + dx]!;
          const iy = gy.data[row + x + dx]!;
          sxx += ix * ix;
          syy += iy * iy;
          sxy += ix * iy;
        }
      }
      const half = (sxx + syy) / 2;
      const s = half - Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy);
      score[y * w + x] = s;
      if (s > best) best = s;
    }
  }
  if (best <= 0) return [];
  const thr = best * quality;
  const cands: { x: number; y: number; s: number }[] = [];
  const r2 = o.region ? o.region.radius * o.region.radius : Infinity;
  for (let y = y0 + 1; y < y1 - 1; y++) {
    for (let x = x0 + 1; x < x1 - 1; x++) {
      const s = score[y * w + x]!;
      if (s < thr) continue;
      if (o.region && (x - o.region.center[0]) ** 2 + (y - o.region.center[1]) ** 2 > r2) continue;
      // 3×3 non-maximum suppression.
      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && score[(y + dy) * w + x + dx]! > s) isMax = false;
      if (isMax) cands.push({ x, y, s });
    }
  }
  cands.sort((a, b) => b.s - a.s);
  // Minimum distance through a grid of buckets.
  const cell = Math.max(1, minDist);
  const gw = Math.ceil(w / cell);
  const grid = new Map<number, Vec2[]>();
  const out: Vec2[] = [];
  for (const c of cands) {
    const gx0 = Math.floor(c.x / cell);
    const gy0 = Math.floor(c.y / cell);
    let ok = true;
    for (let j = gy0 - 1; j <= gy0 + 1 && ok; j++) {
      for (let i = gx0 - 1; i <= gx0 + 1 && ok; i++) {
        for (const p of grid.get(j * gw + i) ?? []) if ((p[0] - c.x) ** 2 + (p[1] - c.y) ** 2 < minDist * minDist) ok = false;
      }
    }
    if (!ok) continue;
    const p: Vec2 = [c.x, c.y];
    out.push(p);
    const key = gy0 * gw + gx0;
    const list = grid.get(key);
    if (list) list.push(p);
    else grid.set(key, [p]);
    if (out.length >= max) break;
  }
  return out;
}
