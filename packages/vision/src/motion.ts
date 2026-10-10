import { createRandom, type Vec2 } from '@tasweerix/core';
import { goodFeatures } from './features';
import { buildPyramid, trackConsistent, type Pyramid } from './flow';
import { gray, type Gray } from './image';
import { cornerDistance, fromSimilarity, ransacHomography, solveLinear, type Homography } from './homography';
import { IDENTITY, ransacSimilarity, type Similarity } from './similarity';

/** Frame-to-frame camera motion of a clip, as measured by `analyzeMotion`. */
export interface MotionData {
  version: 1;
  /** Analysis resolution (pixels). Motions are expressed in these pixels around the frame center. */
  width: number;
  height: number;
  fps: number;
  /** Source time of the first analysed frame. */
  start: number;
  /**
   * Per frame: the similarity mapping the previous frame onto this one (centered pixel coordinates).
   * Frame 0 is the identity.
   */
  motions: Similarity[];
  /** Inlier count per frame (confidence). */
  inliers: number[];
  /**
   * With `model: 'perspective'`: per frame, the homography mapping the previous frame onto this one
   * (same coordinates as `motions`). Frames where perspective could not be measured reliably hold
   * their similarity.
   */
  homographies?: Homography[];
  /**
   * With `rollingShutter: true`: per frame, the row-proportional part of the motion [wx, wy]
   * (pixels per frame height) measured jointly with `motions`. A rolling shutter reads rows one
   * after another, so when the camera speeds up or slows down, lower rows move more than upper
   * ones between frames; `estimateReadout` turns this into the sensor's readout time.
   */
  shear?: Vec2[];
}

export interface MotionOptions {
  /** Features tracked per frame. */
  features?: number;
  /** Estimate translation only (no rotation / zoom). */
  translationOnly?: boolean;
  /** 'perspective' also measures a homography per frame (see `MotionData.homographies`). */
  model?: 'similarity' | 'perspective';
  /** Also measure the rolling-shutter shear of each frame (see `MotionData.shear`). */
  rollingShutter?: boolean;
}

/**
 * Streams frames and measures the global (camera) motion between consecutive frames with
 * Shi–Tomasi corners, forward–backward Lucas–Kanade flow and RANSAC.
 */
export class MotionEstimator {
  private prev?: Pyramid;
  readonly motions: Similarity[] = [];
  readonly inliers: number[] = [];
  readonly homographies: Homography[] = [];
  readonly shear: Vec2[] = [];

  constructor(
    readonly width: number,
    readonly height: number,
    private o: MotionOptions = {},
  ) {}

  /** Adds the next frame (8-bit or float gray, width × height). */
  push(frame: ArrayLike<number> | Gray): Similarity {
    const img = 'data' in (frame as Gray) ? (frame as Gray) : gray(this.width, this.height, frame as ArrayLike<number>);
    const pyr = buildPyramid(img, 4);
    let m: Similarity = IDENTITY;
    let inl = 0;
    let h: Homography | undefined;
    let w: Vec2 = [0, 0];
    if (this.prev) {
      const pts = goodFeatures(this.prev.levels[0]!, { max: this.o.features ?? 250, quality: 0.01, minDistance: Math.max(6, Math.round(this.width / 50)) });
      const { from, to } = trackConsistent(this.prev, pyr, pts, { radius: 7 });
      const cx = this.width / 2;
      const cy = this.height / 2;
      const c = (p: Vec2): Vec2 => [p[0] - cx, p[1] - cy];
      if (from.length >= 6) {
        const r = ransacSimilarity(from.map(c), to.map(c), { threshold: Math.max(1, this.width / 400), translationOnly: this.o.translationOnly, seed: this.motions.length });
        if (r && r.inliers >= Math.max(5, from.length * 0.2)) {
          m = r.model;
          inl = r.inliers;
        }
        if (this.o.rollingShutter && !this.o.translationOnly) {
          // Rows read at different times shear the motion: measure it jointly so it does not bias the similarity.
          const rs = ransacSimilarityShear(from.map(c), to.map(c), this.height, { threshold: Math.max(1, this.width / 400), seed: this.motions.length });
          if (rs && rs.inliers >= Math.max(6, from.length * 0.2, inl * 0.9)) {
            m = rs.model;
            w = rs.shear;
            inl = rs.inliers;
          }
        }
        if (this.o.model === 'perspective') h = this.perspective(from.map(c), to.map(c), m, inl);
      }
    }
    if (this.o.model === 'perspective') this.homographies.push(h ?? fromSimilarity(m));
    if (this.o.rollingShutter) this.shear.push(w);
    this.prev = pyr;
    this.motions.push(m);
    this.inliers.push(inl);
    return m;
  }

  /**
   * Homography between two frames, or undefined when it is not trustworthy: too few inliers, or a
   * perspective change far larger than camera shake (usually a moving foreground dominating).
   */
  private perspective(from: Vec2[], to: Vec2[], sim: Similarity, simInliers: number): Homography | undefined {
    if (from.length < 12 || simInliers === 0) return undefined;
    const r = ransacHomography(from, to, { threshold: Math.max(1, this.width / 400), seed: this.motions.length });
    if (!r || r.inliers < Math.max(12, simInliers * 0.9)) return undefined;
    if (cornerDistance(r.model, fromSimilarity(sim), this.width, this.height) > this.width * 0.08) return undefined;
    return r.model;
  }

  result(fps: number, start: number): MotionData {
    const r4 = (x: number) => +x.toFixed(6);
    const out: MotionData = { version: 1, width: this.width, height: this.height, fps, start, motions: this.motions.map((m) => m.map(r4) as Similarity), inliers: this.inliers };
    // Perspective terms are tiny in pixel units: keep significant digits rather than decimals.
    if (this.o.model === 'perspective') out.homographies = this.homographies.map((h) => h.map((x) => +x.toPrecision(9)) as Homography);
    if (this.o.rollingShutter) out.shear = this.shear.map((v) => v.map(r4) as Vec2);
    return out;
  }
}

/** Similarity plus row shear: x' = a·x − b·y + tx + wx·y/H,  y' = b·x + a·y + ty + wy·y/H. */
export interface SimilarityShear {
  model: Similarity;
  shear: Vec2;
}

/** Least-squares similarity with rolling-shutter shear (centered pixel coordinates, frame height `H`). */
export function fitSimilarityShear(src: Vec2[], dst: Vec2[], H: number): SimilarityShear | null {
  if (src.length < 3) return null;
  const AtA = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
  const Atb = new Array<number>(6).fill(0);
  const add = (row: number[], rhs: number) => {
    for (let i = 0; i < 6; i++) {
      Atb[i]! += row[i]! * rhs;
      for (let j = 0; j < 6; j++) AtA[i]![j]! += row[i]! * row[j]!;
    }
  };
  for (let k = 0; k < src.length; k++) {
    const [x, y] = src[k]!;
    const s = y / H;
    add([x, -y, 1, 0, s, 0], dst[k]![0]);
    add([y, x, 0, 1, 0, s], dst[k]![1]);
  }
  const v = solveLinear(AtA, Atb);
  if (!v || v.some((x) => !Number.isFinite(x))) return null;
  return { model: [v[0]!, v[1]!, v[2]!, v[3]!], shear: [v[4]!, v[5]!] };
}

/** RANSAC over 3-point samples for `fitSimilarityShear`, refitted on the inliers. */
export function ransacSimilarityShear(src: Vec2[], dst: Vec2[], H: number, o: { threshold?: number; iterations?: number; seed?: number } = {}): (SimilarityShear & { inliers: number }) | null {
  const n = src.length;
  if (n < 3) return null;
  const thr2 = (o.threshold ?? 1.5) ** 2;
  const rnd = createRandom(o.seed ?? 7);
  const count = (f: SimilarityShear, mask?: boolean[]) => {
    const [a, b, tx, ty] = f.model;
    let c = 0;
    for (let i = 0; i < n; i++) {
      const [x, y] = src[i]!;
      const s = y / H;
      const inl = (a * x - b * y + tx + f.shear[0] * s - dst[i]![0]) ** 2 + (b * x + a * y + ty + f.shear[1] * s - dst[i]![1]) ** 2 <= thr2;
      if (mask) mask[i] = inl;
      if (inl) c++;
    }
    return c;
  };
  let best: SimilarityShear | null = null;
  let bestCount = 0;
  for (let it = 0; it < (o.iterations ?? 300) && bestCount < n; it++) {
    const idx = new Set<number>();
    while (idx.size < 3) idx.add(Math.floor(rnd() * n));
    const ids = [...idx];
    const f = fitSimilarityShear(
      ids.map((i) => src[i]!),
      ids.map((i) => dst[i]!),
      H,
    );
    if (!f) continue;
    const s = Math.hypot(f.model[0], f.model[1]);
    if (s < 0.5 || s > 2) continue;
    const c = count(f);
    if (c > bestCount) {
      best = f;
      bestCount = c;
    }
  }
  if (!best) return null;
  for (let k = 0; k < 2; k++) {
    const mask: boolean[] = [];
    count(best, mask);
    const f = fitSimilarityShear(
      src.filter((_, i) => mask[i]),
      dst.filter((_, i) => mask[i]),
      H,
    );
    if (!f) break;
    best = f;
  }
  return { ...best, inliers: count(best) };
}
