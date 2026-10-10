import type { MotionData } from './motion';
import { fromSimilarity, hcompose, H_IDENTITY, hinvert, hscale, splitHomography, toHomography, type Homography } from './homography';
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
  /**
   * Camera model. 'similarity' (default) corrects translation, rotation and zoom. 'perspective'
   * also removes the keystone / perspective wobble of a camera turning and tilting, using the
   * homographies measured by `analyzeMotion({ model: 'perspective' })`.
   */
  model?: 'similarity' | 'perspective';
}

/** Per-frame corrections to apply to a clip, in normalized coordinates (see `correctionAt`). */
export interface StabilizeData {
  fps: number;
  start: number;
  /** Frame height / width. */
  aspect: number;
  zoom: number;
  /**
   * Per frame [a, b, tx, ty] (similarity) or a 9-number homography (perspective model): maps frame
   * coordinates to stabilized ones. Coordinates are centered on the frame and measured in frame
   * widths. The zoom is included.
   */
  frames: (Similarity | Homography)[];
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
export function zoomToCover(c: Similarity | Homography, aspect: number): number {
  const hx = 0.5;
  const hy = aspect / 2;
  const m = hinvert(toHomography(c));
  // p = inv(q / Z) must stay inside the frame for every output corner q. With k = 1/Z and
  // inv = [A b; g 1], p = (k·Aq + b) / (k·g·q + 1): each bound is linear in k once multiplied by w.
  let kMax = 1;
  let kMin = 0;
  for (const q of [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]] as const) {
    const gw = m[6] * q[0] + m[7] * q[1];
    for (let ax = 0; ax < 2; ax++) {
      const half = ax === 0 ? hx : hy;
      const u = m[ax * 3]! * q[0] + m[ax * 3 + 1]! * q[1];
      const v = m[ax * 3 + 2]!;
      // ±(k·u + v) − half·(k·gw + m8) ≤ 0
      for (const sign of [1, -1]) {
        const alpha = sign * u - half * gw;
        const beta = sign * v - half * m[8];
        if (Math.abs(alpha) < 1e-12) {
          if (beta > 0) return Infinity;
          continue;
        }
        if (alpha > 0) kMax = Math.min(kMax, -beta / alpha);
        else kMin = Math.max(kMin, -beta / alpha);
      }
    }
  }
  // Every corner must stay in front of the camera (w > 0) at the chosen zoom.
  for (const q of [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]] as const) if (m[8] + kMax * (m[6] * q[0] + m[7] * q[1]) <= 0) return Infinity;
  return kMax > kMin && kMax > 0 ? 1 / kMax : Infinity;
}

/** Blends a correction toward the identity (t = 0 → identity, 1 → full correction). */
function partial(c: Similarity, t: number): Similarity {
  const d = decompose(c);
  return fromParams(d.x * t, d.y * t, d.angle * t, d.logScale * t);
}

/** Blends a perspective correction toward the identity. */
function partialH(c: Homography, t: number, aspect: number): Homography {
  const { similarity, residual } = splitHomography(c, 1, aspect);
  const k = residual.map((v, i) => H_IDENTITY[i]! + (v - H_IDENTITY[i]!) * t) as Homography;
  return hcompose(fromSimilarity(partial(similarity, t)), k);
}

/** Hides moving edges: partial corrections where `maxZoom` is not enough, then the common zoom. */
function cropCorrections<T extends Similarity | Homography>(corrections: T[], aspect: number, o: StabilizeOptions, blend: (c: T, t: number) => T): { corrections: T[]; zoom: number } {
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
        if (zoomToCover(blend(c, mid), aspect) <= maxZoom) lo = mid;
        else hi = mid;
      }
      return blend(c, lo);
    });
    zoom = Math.min(maxZoom, Math.max(1, ...corrections.map((c) => zoomToCover(c, aspect))));
  }
  return { corrections, zoom };
}

/** Target path of a list of similarity path parameters: smoothed, locked (mean) or kept. */
function targetPath(path: Similarity[], fps: number, o: StabilizeOptions): Similarity[] {
  const params = path.map(decompose);
  // Unwrap angles so smoothing never averages across ±π.
  for (let i = 1; i < params.length; i++) {
    let a = params[i]!.angle;
    while (a - params[i - 1]!.angle > Math.PI) a -= 2 * Math.PI;
    while (a - params[i - 1]!.angle < -Math.PI) a += 2 * Math.PI;
    params[i]!.angle = a;
  }
  const lock = o.mode === 'lock';
  const sigma = (o.smoothing ?? 1) * fps * 0.5;
  const target = (v: number[], enabled = true) => (!enabled ? v.slice() : lock ? v.map(() => mean(v)) : smooth(v, sigma));
  const tx = target(params.map((p) => p.x));
  const ty = target(params.map((p) => p.y));
  const ta = target(params.map((p) => p.angle), o.rotation !== false);
  const ts = target(params.map((p) => p.logScale), o.scale !== false);
  return path.map((_, i) => fromParams(tx[i]!, ty[i]!, ta[i]!, ts[i]!));
}

/**
 * Perspective stabilization: the camera path is a chain of homographies. Each is split into its
 * closest similarity (smoothed like the similarity model) and a near-identity perspective residual
 * (smoothed element-wise, or held at its mean when locking).
 */
function computePerspective(m: MotionData, o: StabilizeOptions): StabilizeData {
  const W = m.width;
  const aspect = m.height / m.width;
  const hs = m.homographies!;
  const path: Homography[] = [];
  let acc = H_IDENTITY;
  for (let i = 0; i < hs.length; i++) {
    acc = i === 0 ? H_IDENTITY : hcompose(hscale(hs[i]!, W), acc);
    path.push(acc);
  }
  const parts = path.map((p) => splitHomography(p, 1, aspect));
  const sims = targetPath(
    parts.map((p) => p.similarity),
    m.fps,
    o,
  );
  const sigma = (o.smoothing ?? 1) * m.fps * 0.5;
  const residualTarget = Array.from({ length: 9 }, (_, k) => {
    const v = parts.map((p) => p.residual[k]!);
    return o.mode === 'lock' ? v.map(() => mean(v)) : smooth(v, sigma);
  });
  const corrections = path.map((p, i) => hcompose(hcompose(fromSimilarity(sims[i]!), residualTarget.map((v) => v[i]!) as Homography), hinvert(p)));
  const r = cropCorrections(corrections, aspect, o, (c, t) => partialH(c, t, aspect));
  const z = fromSimilarity([r.zoom, 0, 0, 0]);
  return { fps: m.fps, start: m.start, aspect, zoom: +r.zoom.toFixed(4), frames: r.corrections.map((c) => hcompose(z, c).map((x) => +x.toFixed(7)) as Homography) };
}

/**
 * Turns measured motion into per-frame corrections: accumulates the camera path, smooths it (or
 * locks it), and zooms just enough to hide the moving edges.
 */
export function computeStabilization(m: MotionData, o: StabilizeOptions = {}): StabilizeData {
  if (o.model === 'perspective') {
    if (!m.homographies) throw new Error("computeStabilization: model 'perspective' needs motion analysed with analyzeMotion({ model: 'perspective' })");
    return computePerspective(m, o);
  }
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
  const aspect = m.height / m.width;
  const targets = targetPath(path, m.fps, o);
  const r = cropCorrections(
    path.map((p, i) => compose(targets[i]!, invert(p))),
    aspect,
    o,
    partial,
  );
  const z: Similarity = [r.zoom, 0, 0, 0];
  const r6 = (x: number) => +x.toFixed(6);
  return { fps: m.fps, start: m.start, aspect, zoom: +r.zoom.toFixed(4), frames: r.corrections.map((c) => compose(z, c).map(r6) as Similarity) };
}

/** Correction at a source time (linear interpolation between frames, held at the ends). */
export function correctionAt(d: StabilizeData, sourceTime: number): Similarity | Homography {
  const n = d.frames.length;
  if (!n) return IDENTITY;
  const f = Math.min(n - 1, Math.max(0, (sourceTime - d.start) * d.fps));
  const i = Math.floor(f);
  const t = f - i;
  const a = d.frames[i]!;
  const b = d.frames[Math.min(n - 1, i + 1)]!;
  return t < 1e-6 ? a : (a.map((v, k) => v + (b[k]! - v) * t) as Similarity | Homography);
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
