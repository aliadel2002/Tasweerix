import type { Vec2 } from '@tasweerix/core';
import { gradients, pyramid, samplePatch, type Gray } from './image';

/** An image prepared for tracking: Gaussian pyramid plus gradients per level. */
export interface Pyramid {
  levels: Gray[];
  gx: Gray[];
  gy: Gray[];
}

export function buildPyramid(img: Gray, levels = 4): Pyramid {
  const lv = pyramid(img, levels);
  const g = lv.map(gradients);
  return { levels: lv, gx: g.map((x) => x.gx), gy: g.map((x) => x.gy) };
}

export interface FlowOptions {
  /** Half size of the tracking window (window is (2r+1)²). */
  radius?: number;
  iterations?: number;
  /** Stop when the update is smaller than this (pixels). */
  epsilon?: number;
}

/**
 * Pyramidal Lucas–Kanade optical flow (Bouguet): tracks points from `prev` to `next`.
 * Returns new positions and whether each point was tracked.
 */
export function lucasKanade(prev: Pyramid, next: Pyramid, pts: Vec2[], o: FlowOptions = {}): { points: Vec2[]; ok: boolean[] } {
  const r = o.radius ?? 7;
  const iters = o.iterations ?? 20;
  const eps = o.epsilon ?? 0.01;
  const L = Math.min(prev.levels.length, next.levels.length);
  const n = (2 * r + 1) ** 2;
  const I = new Float32Array(n);
  const IX = new Float32Array(n);
  const IY = new Float32Array(n);
  const J = new Float32Array(n);
  const points: Vec2[] = [];
  const ok: boolean[] = [];
  for (const p of pts) {
    let gx = 0;
    let gy = 0;
    let good = true;
    for (let l = L - 1; l >= 0; l--) {
      const k = 1 / (1 << l);
      const px = p[0] * k;
      const py = p[1] * k;
      // Template and gradients around the point in the previous image.
      samplePatch(prev.levels[l]!, px, py, r, I);
      samplePatch(prev.gx[l]!, px, py, r, IX);
      samplePatch(prev.gy[l]!, px, py, r, IY);
      let gxx = 0;
      let gyy = 0;
      let gxy = 0;
      for (let i = 0; i < n; i++) {
        gxx += IX[i]! * IX[i]!;
        gyy += IY[i]! * IY[i]!;
        gxy += IX[i]! * IY[i]!;
      }
      const det = gxx * gyy - gxy * gxy;
      if (det < 1e-6 * n * n) {
        good = false;
        break;
      }
      let vx = 0;
      let vy = 0;
      for (let it = 0; it < iters; it++) {
        samplePatch(next.levels[l]!, px + gx + vx, py + gy + vy, r, J);
        let bx = 0;
        let by = 0;
        for (let i = 0; i < n; i++) {
          const diff = I[i]! - J[i]!;
          bx += diff * IX[i]!;
          by += diff * IY[i]!;
        }
        const ex = (gyy * bx - gxy * by) / det;
        const ey = (gxx * by - gxy * bx) / det;
        vx += ex;
        vy += ey;
        if (ex * ex + ey * ey < eps * eps) break;
      }
      if (l > 0) {
        gx = 2 * (gx + vx);
        gy = 2 * (gy + vy);
      } else {
        gx += vx;
        gy += vy;
      }
    }
    const q: Vec2 = [p[0] + gx, p[1] + gy];
    const W = next.levels[0]!.width;
    const H = next.levels[0]!.height;
    if (!Number.isFinite(q[0]) || !Number.isFinite(q[1]) || q[0] < 0 || q[1] < 0 || q[0] > W - 1 || q[1] > H - 1) good = false;
    points.push(q);
    ok.push(good);
  }
  return { points, ok };
}

/**
 * Tracks points forward, then back again, and keeps only points that return to where they started
 * (forward–backward consistency rejects occlusions and drift).
 */
export function trackConsistent(prev: Pyramid, next: Pyramid, pts: Vec2[], o: FlowOptions & { maxError?: number } = {}): { from: Vec2[]; to: Vec2[] } {
  const fwd = lucasKanade(prev, next, pts, o);
  const back = lucasKanade(next, prev, fwd.points, o);
  const maxErr = o.maxError ?? 0.75;
  const from: Vec2[] = [];
  const to: Vec2[] = [];
  pts.forEach((p, i) => {
    if (!fwd.ok[i] || !back.ok[i]) return;
    const b = back.points[i]!;
    if ((b[0] - p[0]) ** 2 + (b[1] - p[1]) ** 2 > maxErr * maxErr) return;
    from.push(p);
    to.push(fwd.points[i]!);
  });
  return { from, to };
}
