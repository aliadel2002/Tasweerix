import { createRandom, type Vec2 } from '@tasweerix/core';

/**
 * A similarity transform (rotation + uniform scale + translation):
 *   x' = a·x − b·y + tx,   y' = b·x + a·y + ty
 * with a = s·cos θ and b = s·sin θ.
 */
export type Similarity = [a: number, b: number, tx: number, ty: number];

export const IDENTITY: Similarity = [1, 0, 0, 0];

export function apply(s: Similarity, p: Vec2): Vec2 {
  return [s[0] * p[0] - s[1] * p[1] + s[2], s[1] * p[0] + s[0] * p[1] + s[3]];
}

/** (s1 ∘ s2)(p) = s1(s2(p)). */
export function compose(s1: Similarity, s2: Similarity): Similarity {
  const [a1, b1, x1, y1] = s1;
  const [a2, b2, x2, y2] = s2;
  return [a1 * a2 - b1 * b2, a1 * b2 + b1 * a2, a1 * x2 - b1 * y2 + x1, b1 * x2 + a1 * y2 + y1];
}

export function invert(s: Similarity): Similarity {
  const [a, b, x, y] = s;
  const d = a * a + b * b;
  const ia = a / d;
  const ib = -b / d;
  return [ia, ib, -(ia * x - ib * y), -(ib * x + ia * y)];
}

/** Translation, rotation (radians) and log-scale of a similarity. */
export function decompose(s: Similarity): { x: number; y: number; angle: number; logScale: number } {
  return { x: s[2], y: s[3], angle: Math.atan2(s[1], s[0]), logScale: Math.log(Math.hypot(s[0], s[1])) };
}

export function fromParams(x: number, y: number, angle: number, logScale: number): Similarity {
  const s = Math.exp(logScale);
  return [s * Math.cos(angle), s * Math.sin(angle), x, y];
}

/** Least-squares similarity mapping `src` onto `dst` (closed form). */
export function fitSimilarity(src: Vec2[], dst: Vec2[], translationOnly = false): Similarity | null {
  const n = src.length;
  if (n === 0) return null;
  let sx = 0;
  let sy = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    sx += src[i]![0];
    sy += src[i]![1];
    dx += dst[i]![0];
    dy += dst[i]![1];
  }
  sx /= n;
  sy /= n;
  dx /= n;
  dy /= n;
  if (translationOnly || n < 2) return [1, 0, dx - sx, dy - sy];
  let num1 = 0;
  let num2 = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const px = src[i]![0] - sx;
    const py = src[i]![1] - sy;
    const qx = dst[i]![0] - dx;
    const qy = dst[i]![1] - dy;
    num1 += px * qx + py * qy;
    num2 += px * qy - py * qx;
    den += px * px + py * py;
  }
  if (den < 1e-9) return [1, 0, dx - sx, dy - sy];
  const a = num1 / den;
  const b = num2 / den;
  return [a, b, dx - (a * sx - b * sy), dy - (b * sx + a * sy)];
}

export interface RansacResult {
  model: Similarity;
  inliers: number;
}

/**
 * Robust similarity estimate: RANSAC over point pairs, then a least-squares refit on the inliers.
 * Deterministic (seeded) so analyses are reproducible.
 */
export function ransacSimilarity(src: Vec2[], dst: Vec2[], o: { threshold?: number; iterations?: number; seed?: number; translationOnly?: boolean } = {}): RansacResult | null {
  const n = src.length;
  if (n < 2) {
    const m = fitSimilarity(src, dst, true);
    return m ? { model: m, inliers: n } : null;
  }
  const thr2 = (o.threshold ?? 1.5) ** 2;
  const rnd = createRandom(o.seed ?? 7);
  const count = (m: Similarity, mask?: boolean[]) => {
    let c = 0;
    for (let i = 0; i < n; i++) {
      const p = apply(m, src[i]!);
      const inl = (p[0] - dst[i]![0]) ** 2 + (p[1] - dst[i]![1]) ** 2 <= thr2;
      if (mask) mask[i] = inl;
      if (inl) c++;
    }
    return c;
  };
  let best: Similarity = fitSimilarity(src, dst, o.translationOnly)!;
  let bestCount = count(best);
  const iters = o.iterations ?? 200;
  for (let it = 0; it < iters && bestCount < n; it++) {
    const i = Math.floor(rnd() * n);
    let j = Math.floor(rnd() * (n - 1));
    if (j >= i) j++;
    const m = fitSimilarity([src[i]!, src[j]!], [dst[i]!, dst[j]!], o.translationOnly);
    if (!m) continue;
    const s = Math.hypot(m[0], m[1]);
    if (s < 0.5 || s > 2) continue;
    const c = count(m);
    if (c > bestCount) {
      best = m;
      bestCount = c;
    }
  }
  // Refit on inliers twice (the inlier set can grow after the first refit).
  for (let k = 0; k < 2; k++) {
    const mask: boolean[] = [];
    count(best, mask);
    const s = src.filter((_, i) => mask[i]);
    const d = dst.filter((_, i) => mask[i]);
    if (s.length < 2) break;
    best = fitSimilarity(s, d, o.translationOnly)!;
  }
  return { model: best, inliers: count(best) };
}
