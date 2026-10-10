import { createRandom, type Vec2 } from '@tasweerix/core';
import { fitSimilarity, type Similarity } from './similarity';

/**
 * A projective transform (homography), row-major and normalized so that h33 = 1:
 *   w = g·x + h·y + 1,   x' = (a·x + b·y + c) / w,   y' = (d·x + e·y + f) / w
 * It models a camera looking at a plane from a changing viewpoint (pan/tilt perspective, keystone).
 */
export type Homography = [a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number];

export const H_IDENTITY: Homography = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function fromSimilarity(s: Similarity): Homography {
  return [s[0], -s[1], s[2], s[1], s[0], s[3], 0, 0, 1];
}

/** The homography of a media transform (4 numbers: similarity, 9: homography). */
export function toHomography(t: Similarity | Homography | readonly number[]): Homography {
  return t.length === 9 ? (t as Homography) : fromSimilarity(t as Similarity);
}

function normalize(m: number[]): Homography {
  const k = Math.abs(m[8]!) > 1e-12 ? 1 / m[8]! : 1;
  return m.map((v) => v * k) as Homography;
}

export function happly(m: Homography, p: Vec2): Vec2 {
  const w = m[6] * p[0] + m[7] * p[1] + m[8];
  return [(m[0] * p[0] + m[1] * p[1] + m[2]) / w, (m[3] * p[0] + m[4] * p[1] + m[5]) / w];
}

/** (m1 ∘ m2)(p) = m1(m2(p)). */
export function hcompose(m1: Homography, m2: Homography): Homography {
  const r: number[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r.push(m1[i * 3]! * m2[j]! + m1[i * 3 + 1]! * m2[3 + j]! + m1[i * 3 + 2]! * m2[6 + j]!);
  return normalize(r);
}

export function hinvert(m: Homography): Homography {
  const [a, b, c, d, e, f, g, h, i] = m;
  const adj = [e * i - f * h, c * h - b * i, b * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, b * g - a * h, a * e - b * d];
  return normalize(adj);
}

/** Expresses a homography given in pixel coordinates in units of `k` pixels (e.g. k = width). */
export function hscale(m: Homography, k: number): Homography {
  return normalize([m[0], m[1], m[2] / k, m[3], m[4], m[5] / k, m[6] * k, m[7] * k, m[8]]);
}

/** Solves A·x = b (n × n, row-major) by Gaussian elimination with partial pivoting. */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    if (Math.abs(M[piv]![col]!) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv]!, M[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const k = M[r]![col]! / M[col]![col]!;
      if (k === 0) continue;
      for (let c = col; c <= n; c++) M[r]![c]! -= k * M[col]![c]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

/** Similarity that moves the centroid to 0 and the mean distance to √2 (Hartley normalization). */
function conditioner(pts: Vec2[]): Homography {
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p[0];
    my += p[1];
  }
  mx /= pts.length;
  my /= pts.length;
  let d = 0;
  for (const p of pts) d += Math.hypot(p[0] - mx, p[1] - my);
  d /= pts.length;
  const s = d > 1e-12 ? Math.SQRT2 / d : 1;
  return [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1];
}

/** Least-squares homography mapping `src` onto `dst` (normalized DLT, ≥ 4 points). */
export function fitHomography(src: Vec2[], dst: Vec2[]): Homography | null {
  const n = src.length;
  if (n < 4) return null;
  const Ts = conditioner(src);
  const Td = conditioner(dst);
  // Normal equations of the 2n × 8 system with h33 = 1.
  const AtA = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  const Atb = new Array<number>(8).fill(0);
  const add = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      Atb[i]! += row[i]! * rhs;
      for (let j = 0; j < 8; j++) AtA[i]![j]! += row[i]! * row[j]!;
    }
  };
  for (let k = 0; k < n; k++) {
    const [x, y] = happly(Ts, src[k]!);
    const [u, v] = happly(Td, dst[k]!);
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const h = solveLinear(AtA, Atb);
  if (!h || h.some((v) => !Number.isFinite(v))) return null;
  return hcompose(hinvert(Td), hcompose([...h, 1] as Homography, Ts));
}

export interface HomographyRansacResult {
  model: Homography;
  inliers: number;
}

/** Twice the signed area of a triangle. */
const cross = (a: Vec2, b: Vec2, c: Vec2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** Rejects samples with three (nearly) collinear points: they do not determine a homography. */
function degenerate(p: Vec2[]): boolean {
  let span = 0;
  for (const a of p) for (const b of p) span = Math.max(span, Math.hypot(a[0] - b[0], a[1] - b[1]));
  const min = span * span * 0.01;
  return Math.abs(cross(p[0]!, p[1]!, p[2]!)) < min || Math.abs(cross(p[0]!, p[1]!, p[3]!)) < min || Math.abs(cross(p[0]!, p[2]!, p[3]!)) < min || Math.abs(cross(p[1]!, p[2]!, p[3]!)) < min;
}

/**
 * Robust homography estimate: RANSAC over 4-point samples, then least-squares refits on the
 * inliers. Deterministic (seeded) so analyses are reproducible.
 */
export function ransacHomography(src: Vec2[], dst: Vec2[], o: { threshold?: number; iterations?: number; seed?: number } = {}): HomographyRansacResult | null {
  const n = src.length;
  if (n < 4) return null;
  const thr2 = (o.threshold ?? 1.5) ** 2;
  const rnd = createRandom(o.seed ?? 7);
  const count = (m: Homography, mask?: boolean[]) => {
    let c = 0;
    for (let i = 0; i < n; i++) {
      const w = m[6] * src[i]![0] + m[7] * src[i]![1] + m[8];
      const p = happly(m, src[i]!);
      const inl = w > 0 && (p[0] - dst[i]![0]) ** 2 + (p[1] - dst[i]![1]) ** 2 <= thr2;
      if (mask) mask[i] = inl;
      if (inl) c++;
    }
    return c;
  };
  let best: Homography | null = null;
  let bestCount = 0;
  const iters = o.iterations ?? 300;
  for (let it = 0; it < iters && bestCount < n; it++) {
    const idx = new Set<number>();
    while (idx.size < 4) idx.add(Math.floor(rnd() * n));
    const ids = [...idx];
    const s = ids.map((i) => src[i]!);
    if (degenerate(s)) continue;
    const m = fitHomography(s, ids.map((i) => dst[i]!));
    if (!m) continue;
    const c = count(m);
    if (c > bestCount) {
      best = m;
      bestCount = c;
    }
  }
  if (!best) return null;
  for (let k = 0; k < 2; k++) {
    const mask: boolean[] = [];
    count(best, mask);
    const s = src.filter((_, i) => mask[i]);
    const d = dst.filter((_, i) => mask[i]);
    if (s.length < 4) break;
    const m = fitHomography(s, d);
    if (!m) break;
    best = m;
  }
  return { model: best, inliers: count(best) };
}

/** Corners of a frame centered on the origin (`w` × `h`). */
export function frameCorners(w: number, h: number): Vec2[] {
  return [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ];
}

/**
 * Splits a homography into its closest similarity S (least squares on the frame corners) and the
 * remaining perspective part K, with m = S ∘ K. K is close to the identity for camera shake.
 */
export function splitHomography(m: Homography, w: number, h: number): { similarity: Similarity; residual: Homography } {
  const c = frameCorners(w, h);
  const s = fitSimilarity(c, c.map((p) => happly(m, p)))!;
  return { similarity: s, residual: hcompose(hinvert(fromSimilarity(s)), m) };
}

/** Largest distance a frame corner moves between two transforms (same units as the frame). */
export function cornerDistance(m1: Homography, m2: Homography, w: number, h: number): number {
  let d = 0;
  for (const p of frameCorners(w, h)) {
    const a = happly(m1, p);
    const b = happly(m2, p);
    d = Math.max(d, Math.hypot(a[0] - b[0], a[1] - b[1]));
  }
  return d;
}
