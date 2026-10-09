export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export const clamp = (v: number, lo = 0, hi = 1): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number): number => (a === b ? 0 : (v - a) / (b - a));
export const remap = (v: number, a0: number, a1: number, b0: number, b1: number, clamped = false): number => {
  const t = invLerp(a0, a1, v);
  return lerp(b0, b1, clamped ? clamp(t) : t);
};
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
export const fract = (x: number): number => x - Math.floor(x);
export const mod = (a: number, n: number): number => ((a % n) + n) % n;
export const deg = (r: number): number => (r * 180) / Math.PI;
export const rad = (d: number): number => (d * Math.PI) / 180;
export const approxEq = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;

export const v2 = {
  add: (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]],
  sub: (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]],
  mul: (a: Vec2, s: number): Vec2 => [a[0] * s, a[1] * s],
  dot: (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1],
  len: (a: Vec2): number => Math.hypot(a[0], a[1]),
  dist: (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]),
  norm: (a: Vec2): Vec2 => {
    const l = Math.hypot(a[0], a[1]) || 1;
    return [a[0] / l, a[1] / l];
  },
  lerp: (a: Vec2, b: Vec2, t: number): Vec2 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)],
  rotate: (a: Vec2, angleRad: number): Vec2 => {
    const c = Math.cos(angleRad);
    const s = Math.sin(angleRad);
    return [a[0] * c - a[1] * s, a[0] * s + a[1] * c];
  },
  angle: (a: Vec2): number => Math.atan2(a[1], a[0]),
  perp: (a: Vec2): Vec2 => [-a[1], a[0]],
};

/**
 * 2D affine matrix [a, b, c, d, e, f] matching the Canvas `setTransform(a, b, c, d, e, f)` layout:
 *   x' = a*x + c*y + e
 *   y' = b*x + d*y + f
 */
export type Mat2D = [number, number, number, number, number, number];

export const mat2d = {
  identity: (): Mat2D => [1, 0, 0, 1, 0, 0],
  multiply: (m: Mat2D, n: Mat2D): Mat2D => [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ],
  translate: (x: number, y: number): Mat2D => [1, 0, 0, 1, x, y],
  scale: (x: number, y: number = x): Mat2D => [x, 0, 0, y, 0, 0],
  rotate: (r: number): Mat2D => {
    const c = Math.cos(r);
    const s = Math.sin(r);
    return [c, s, -s, c, 0, 0];
  },
  skew: (ax: number, ay: number): Mat2D => [1, Math.tan(ay), Math.tan(ax), 1, 0, 0],
  invert: (m: Mat2D): Mat2D => {
    const det = m[0] * m[3] - m[1] * m[2];
    if (!det) return mat2d.identity();
    const id = 1 / det;
    return [
      m[3] * id,
      -m[1] * id,
      -m[2] * id,
      m[0] * id,
      (m[2] * m[5] - m[3] * m[4]) * id,
      (m[1] * m[4] - m[0] * m[5]) * id,
    ];
  },
  apply: (m: Mat2D, p: Vec2): Vec2 => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]],
  /** Composes translate(position) * rotate * skew * scale * translate(-anchor). */
  compose: (
    position: Vec2,
    scale: Vec2,
    rotationDeg: number,
    anchor: Vec2,
    skewDeg: Vec2 = [0, 0],
  ): Mat2D => {
    let m = mat2d.translate(position[0], position[1]);
    if (rotationDeg) m = mat2d.multiply(m, mat2d.rotate(rad(rotationDeg)));
    if (skewDeg[0] || skewDeg[1]) m = mat2d.multiply(m, mat2d.skew(rad(skewDeg[0]), rad(skewDeg[1])));
    if (scale[0] !== 1 || scale[1] !== 1) m = mat2d.multiply(m, mat2d.scale(scale[0], scale[1]));
    if (anchor[0] || anchor[1]) m = mat2d.multiply(m, mat2d.translate(-anchor[0], -anchor[1]));
    return m;
  },
};

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Fits a content box into a frame box. Returns the destination rect (may overflow for cover). */
export function fitRect(
  contentW: number,
  contentH: number,
  frameW: number,
  frameH: number,
  fit: 'contain' | 'cover' | 'fill' | 'none' | 'scale-down' = 'contain',
): Rect {
  let w = contentW;
  let h = contentH;
  if (fit === 'fill') {
    w = frameW;
    h = frameH;
  } else if (fit === 'contain' || fit === 'cover' || fit === 'scale-down') {
    const sx = frameW / contentW;
    const sy = frameH / contentH;
    let s = fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
    if (fit === 'scale-down') s = Math.min(1, s);
    w = contentW * s;
    h = contentH * s;
  }
  return { x: (frameW - w) / 2, y: (frameH - h) / 2, width: w, height: h };
}

/** Cubic bezier point. */
export function bezierPoint(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

export function sum(xs: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i]!;
  return s;
}

export function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

export const dbToGain = (db: number): number => Math.pow(10, db / 20);
export const gainToDb = (g: number): number => (g <= 0 ? -Infinity : 20 * Math.log10(g));
