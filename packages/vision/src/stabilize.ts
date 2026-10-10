import type { MotionData } from './motion';
import { compose, decompose, fromParams, IDENTITY, invert, type Similarity } from './similarity';

export interface StabilizeOptions {
  /**
   * 'smooth' keeps the intended camera move and removes shake; 'lock' holds the frame still like a
   * tripod shot.
   */
  mode?: 'smooth' | 'lock';
  /** Seconds of camera motion averaged in 'smooth' mode (higher is steadier). Default 1. */
  smoothing?: number;
  /** Correct rotation (default true) and zoom (default true). */
  rotation?: boolean;
  scale?: boolean;
  /**
   * How the moving frame edges are hidden: 'auto' zooms in just enough (up to `maxZoom`),
   * a number is a fixed zoom, 'none' leaves edges visible.
   */
  crop?: 'auto' | 'none' | number;
  /** Largest zoom 'auto' may use (default 1.3). Frames that would need more are corrected less. */
  maxZoom?: number;
}

/** Per-frame corrections to apply to a clip, in normalized coordinates (see `correctionAt`). */
export interface StabilizeData {
  fps: number;
  start: number;
  /** Frame height / width. */
  aspect: number;
  zoom: number;
  /**
   * Per frame [a, b, tx, ty]: maps frame coordinates to stabilized ones. Coordinates are centered on
   * the frame and measured in frame widths. The zoom is included.
   */
  frames: Similarity[];
}

/** Gaussian smoothing that renormalizes weights at the edges (no reflection artifacts). */
function smooth(v: number[], sigma: number): number[] {
  if (sigma <= 0) return v.slice();
  const r = Math.ceil(sigma * 3);
  const w = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  return v.map((_, i) => {
    let s = 0;
    let ws = 0;
    for (let k = -r; k <= r; k++) {
      const j = i + k;
      if (j < 0 || j >= v.length) continue;
      s += v[j]! * w[k + r]!;
      ws += w[k + r]!;
    }
    return s / ws;
  });
}

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);

/** Smallest zoom (≥ 1) for which a corrected frame still covers the whole output frame. */
export function zoomToCover(c: Similarity, aspect: number): number {
  const hx = 0.5;
  const hy = aspect / 2;
  const inv = invert(c);
  // p = inv(q / Z) = A⁻¹q / Z + inv.t must stay inside the frame for every output corner q.
  let kMax = 1;
  let kMin = 0;
  for (const q of [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]] as const) {
    const u = [inv[0] * q[0] - inv[1] * q[1], inv[1] * q[0] + inv[0] * q[1]];
    const v = [inv[2], inv[3]];
    for (let ax = 0; ax < 2; ax++) {
      const half = ax === 0 ? hx : hy;
      const ua = u[ax]!;
      const va = v[ax]!;
      // −half ≤ k·u + v ≤ half
      if (Math.abs(ua) < 1e-12) {
        if (Math.abs(va) > half) return Infinity;
        continue;
      }
      const lo = (-half - va) / ua;
      const hi = (half - va) / ua;
      kMax = Math.min(kMax, Math.max(lo, hi));
      kMin = Math.max(kMin, Math.min(lo, hi));
    }
  }
  return kMax > kMin && kMax > 0 ? 1 / kMax : Infinity;
}

/** Blends a correction toward the identity (t = 0 → identity, 1 → full correction). */
function partial(c: Similarity, t: number): Similarity {
  const d = decompose(c);
  return fromParams(d.x * t, d.y * t, d.angle * t, d.logScale * t);
}

/**
 * Turns measured motion into per-frame corrections: accumulates the camera path, smooths it (or
 * locks it), and zooms just enough to hide the moving edges.
 */
export function computeStabilization(m: MotionData, o: StabilizeOptions = {}): StabilizeData {
  const n = m.motions.length;
  const W = m.width;
  // Camera path: P_i maps frame-0 coordinates to frame-i coordinates (normalized by width).
  const path: Similarity[] = [];
  let acc: Similarity = IDENTITY;
  for (let i = 0; i < n; i++) {
    const f = m.motions[i]!;
    acc = i === 0 ? IDENTITY : compose([f[0], f[1], f[2] / W, f[3] / W], acc);
    path.push(acc);
  }
  const params = path.map(decompose);
  // Unwrap angles so smoothing never averages across ±π.
  for (let i = 1; i < n; i++) {
    let a = params[i]!.angle;
    while (a - params[i - 1]!.angle > Math.PI) a -= 2 * Math.PI;
    while (a - params[i - 1]!.angle < -Math.PI) a += 2 * Math.PI;
    params[i]!.angle = a;
  }
  const xs = params.map((p) => p.x);
  const ys = params.map((p) => p.y);
  const as = params.map((p) => p.angle);
  const ss = params.map((p) => p.logScale);
  const lock = o.mode === 'lock';
  const sigma = (o.smoothing ?? 1) * m.fps * 0.5;
  const target = (v: number[], enabled = true) => (!enabled ? v.slice() : lock ? v.map(() => mean(v)) : smooth(v, sigma));
  const tx = target(xs);
  const ty = target(ys);
  const ta = target(as, o.rotation !== false);
  const ts = target(ss, o.scale !== false);
  const aspect = m.height / m.width;
  let corrections: Similarity[] = path.map((p, i) => compose(fromParams(tx[i]!, ty[i]!, ta[i]!, ts[i]!), invert(p)));

  let zoom = 1;
  const crop = o.crop ?? 'auto';
  if (typeof crop === 'number') zoom = Math.max(0.1, crop);
  else if (crop === 'auto') {
    const maxZoom = o.maxZoom ?? 1.3;
    // Frames whose shake is too large to hide within maxZoom get a partial correction.
    corrections = corrections.map((c) => {
      if (zoomToCover(c, aspect) <= maxZoom) return c;
      let lo = 0;
      let hi = 1;
      for (let k = 0; k < 20; k++) {
        const mid = (lo + hi) / 2;
        if (zoomToCover(partial(c, mid), aspect) <= maxZoom) lo = mid;
        else hi = mid;
      }
      return partial(c, lo);
    });
    zoom = Math.min(maxZoom, Math.max(1, ...corrections.map((c) => zoomToCover(c, aspect))));
  }
  const z: Similarity = [zoom, 0, 0, 0];
  const r6 = (x: number) => +x.toFixed(6);
  return { fps: m.fps, start: m.start, aspect, zoom: +zoom.toFixed(4), frames: corrections.map((c) => compose(z, c).map(r6) as Similarity) };
}

/** Correction at a source time (linear interpolation between frames, held at the ends). */
export function correctionAt(d: StabilizeData, sourceTime: number): Similarity {
  const n = d.frames.length;
  if (!n) return IDENTITY;
  const f = Math.min(n - 1, Math.max(0, (sourceTime - d.start) * d.fps));
  const i = Math.floor(f);
  const t = f - i;
  const a = d.frames[i]!;
  const b = d.frames[Math.min(n - 1, i + 1)]!;
  return t < 1e-6 ? a : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
}

/** Shake statistics of measured motion (pixels at analysis resolution, degrees). */
export function shakeStats(m: MotionData): { meanShift: number; maxShift: number; maxRotation: number; frames: number } {
  let sum = 0;
  let max = 0;
  let rot = 0;
  for (const f of m.motions) {
    const d = Math.hypot(f[2], f[3]);
    sum += d;
    max = Math.max(max, d);
    rot = Math.max(rot, Math.abs((Math.atan2(f[1], f[0]) * 180) / Math.PI));
  }
  return { meanShift: sum / Math.max(1, m.motions.length), maxShift: max, maxRotation: rot, frames: m.motions.length };
}
