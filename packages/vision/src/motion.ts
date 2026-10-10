import type { Vec2 } from '@tasweerix/core';
import { goodFeatures } from './features';
import { buildPyramid, trackConsistent, type Pyramid } from './flow';
import { gray, type Gray } from './image';
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
}

export interface MotionOptions {
  /** Features tracked per frame. */
  features?: number;
  /** Estimate translation only (no rotation / zoom). */
  translationOnly?: boolean;
}

/**
 * Streams frames and measures the global (camera) motion between consecutive frames with
 * Shi–Tomasi corners, forward–backward Lucas–Kanade flow and RANSAC.
 */
export class MotionEstimator {
  private prev?: Pyramid;
  readonly motions: Similarity[] = [];
  readonly inliers: number[] = [];

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
      }
    }
    this.prev = pyr;
    this.motions.push(m);
    this.inliers.push(inl);
    return m;
  }

  result(fps: number, start: number): MotionData {
    const r4 = (x: number) => +x.toFixed(6);
    return { version: 1, width: this.width, height: this.height, fps, start, motions: this.motions.map((m) => m.map(r4) as Similarity), inliers: this.inliers };
  }
}
