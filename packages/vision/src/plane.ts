import type { Vec2 } from '@tasweerix/core';
import { goodFeatures } from './features';
import { buildPyramid, trackConsistent, type Pyramid } from './flow';
import { fromSimilarity, happly, hcompose, H_IDENTITY, ransacHomography, type Homography } from './homography';
import { gray, sample as bilinear, type Gray } from './image';
import { ransacSimilarity } from './similarity';

/** Four corners of a plane: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Vec2, Vec2, Vec2, Vec2];

/** A tracked plane: where its corners are over time, in source pixels. */
export interface PlaneTrack {
  version: 1;
  /** Source size the coordinates refer to. */
  width: number;
  height: number;
  fps: number;
  /** Source time of the first sample. */
  start: number;
  /** Source time at which `corners` were picked (the reference frame). */
  time: number;
  /** Per frame: the corners of the plane. */
  corners: Quad[];
  /** Per frame: the homography mapping reference-frame source pixels onto this frame. */
  homographies: Homography[];
  /** True where the plane could not be followed (the last known position is held). */
  lost: boolean[];
}

/** Ray-casting point-in-polygon test. */
export function insideQuad(q: Vec2[], p: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const a = q[i]!;
    const b = q[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function area(q: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % q.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** Convex, same orientation as the reference and not collapsed or exploded. */
function plausible(q: Vec2[], ref: Vec2[]): boolean {
  const a0 = area(ref);
  const a = area(q);
  if (Math.sign(a) !== Math.sign(a0) || Math.abs(a) < Math.abs(a0) * 0.1 || Math.abs(a) > Math.abs(a0) * 10) return false;
  for (let i = 0; i < 4; i++) {
    const p = q[i]!;
    const n = q[(i + 1) % 4]!;
    const nn = q[(i + 2) % 4]!;
    const cross = (n[0] - p[0]) * (nn[1] - n[1]) - (n[1] - p[1]) * (nn[0] - n[0]);
    if (Math.sign(cross) !== Math.sign(a0)) return false;
  }
  return true;
}

/** The frame resampled into the reference frame's geometry: out(x) = img(H(x)), only inside `box`. */
function warpGray(img: Gray, H: Homography, box: [number, number, number, number]): Gray {
  const out = gray(img.width, img.height);
  const [x0, y0, x1, y1] = box;
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.width, x1); x++) {
      const p = happly(H, [x, y]);
      out.data[y * img.width + x] = bilinear(img, p[0], p[1]);
    }
  }
  return out;
}

/**
 * Follows a plane from frame `from` through `frames` (in the given order): corners found inside the
 * current quad are tracked to the next frame and a RANSAC homography moves the plane (a similarity
 * when too few features agree on a perspective change). Each estimate is then refined against the
 * reference frame itself: the new frame is warped back into the reference geometry and the
 * reference features are tracked into it, so small errors do not accumulate into drift.
 */
export function followPlaneInFrames(frames: Gray[], from: number, corners: Quad, step: 1 | -1, out: { homographies: Homography[]; lost: boolean[] }): void {
  let H = H_IDENTITY;
  let prev: Pyramid | undefined;
  const ref = corners;
  const refPyr = buildPyramid(frames[from]!, 4);
  const rcx = ref.reduce((s, p) => s + p[0], 0) / 4;
  const rcy = ref.reduce((s, p) => s + p[1], 0) / 4;
  const rr = Math.max(...ref.map((p) => Math.hypot(p[0] - rcx, p[1] - rcy)));
  const refPts = goodFeatures(refPyr.levels[0]!, { region: { center: [rcx, rcy], radius: rr }, max: 200, quality: 0.01, minDistance: Math.max(3, Math.round(rr / 25)), border: 4 }).filter((p) => insideQuad(ref, p));
  // Region warped for the refinement: the reference quad plus a margin for the tracking windows.
  const margin = 32;
  const box: [number, number, number, number] = [Math.floor(Math.min(...ref.map((p) => p[0])) - margin), Math.floor(Math.min(...ref.map((p) => p[1])) - margin), Math.ceil(Math.max(...ref.map((p) => p[0])) + margin), Math.ceil(Math.max(...ref.map((p) => p[1])) + margin)];
  for (let i = from; i >= 0 && i < frames.length; i += step) {
    const pyr = buildPyramid(frames[i]!, 4);
    if (prev) {
      const quad = ref.map((c) => happly(H, c));
      const cx = quad.reduce((s, p) => s + p[0], 0) / 4;
      const cy = quad.reduce((s, p) => s + p[1], 0) / 4;
      const radius = Math.max(...quad.map((p) => Math.hypot(p[0] - cx, p[1] - cy)));
      const pts = goodFeatures(prev.levels[0]!, { region: { center: [cx, cy], radius }, max: 200, quality: 0.01, minDistance: Math.max(3, Math.round(radius / 25)), border: 4 }).filter((p) => insideQuad(quad, p));
      const { from: a, to: b } = trackConsistent(prev, pyr, pts, { radius: 7, maxError: 1 });
      const thr = Math.max(1, frames[i]!.width / 400);
      let stepH: Homography | undefined;
      if (a.length >= 8) {
        const r = ransacHomography(a, b, { threshold: thr, seed: i });
        if (r && r.inliers >= Math.max(8, a.length * 0.4)) stepH = r.model;
      }
      if (!stepH && a.length >= 3) {
        const r = ransacSimilarity(a, b, { threshold: thr, seed: i });
        if (r && r.inliers >= Math.max(3, a.length * 0.4)) stepH = fromSimilarity(r.model);
      }
      let next = stepH && hcompose(stepH, H);
      if (next && refPts.length >= 8) {
        // The residual is small: two pyramid levels keep the windows inside the warped region.
        const warped = buildPyramid(warpGray(frames[i]!, next, box), 2);
        const { from: ra, to: rb } = trackConsistent(refPyr, warped, refPts, { radius: 7, maxError: 1 });
        if (ra.length >= 8) {
          const r = ransacHomography(ra, rb, { threshold: thr, seed: i });
          if (r && r.inliers >= Math.max(8, ra.length * 0.4)) {
            const refined = hcompose(next, r.model);
            if (plausible(ref.map((c) => happly(refined, c)), ref)) next = refined;
          }
        }
      }
      if (next && plausible(ref.map((c) => happly(next!, c)), ref)) {
        H = next!;
        out.lost[i] = false;
      } else out.lost[i] = true;
    } else out.lost[i] = false;
    out.homographies[i] = H;
    prev = pyr;
  }
}

/** Tracks a plane through a frame range, forward and backward from the frame it was picked on. */
export function trackPlaneInFrames(frames: Gray[], at: number, corners: Quad): { homographies: Homography[]; lost: boolean[] } {
  const out = { homographies: new Array<Homography>(frames.length), lost: new Array<boolean>(frames.length) };
  followPlaneInFrames(frames, at, corners, 1, out);
  followPlaneInFrames(frames, at, corners, -1, out);
  return out;
}

/** Index and blend factor of a source time in a track (held at the ends). */
function sample(t: { fps: number; start: number }, n: number, sourceTime: number): [number, number, number] {
  const f = Math.min(n - 1, Math.max(0, (sourceTime - t.start) * t.fps));
  const i = Math.floor(f);
  return [i, Math.min(n - 1, i + 1), f - i];
}

/** Corners of a tracked plane at a source time (linear interpolation between frames). */
export function planeCornersAt(t: PlaneTrack, sourceTime: number): Quad {
  const n = t.corners.length;
  if (!n) return [[0, 0], [0, 0], [0, 0], [0, 0]];
  const [i, j, k] = sample(t, n, sourceTime);
  const a = t.corners[i]!;
  const b = t.corners[j]!;
  return a.map((p, c) => [p[0] + (b[c]![0] - p[0]) * k, p[1] + (b[c]![1] - p[1]) * k]) as Quad;
}

/** Where a point of the plane (reference-frame source pixels) is at a source time. */
export function planePointAt(t: PlaneTrack, point: Vec2, sourceTime: number): Vec2 {
  const n = t.homographies.length;
  if (!n) return point;
  const [i, j, k] = sample(t, n, sourceTime);
  const a = happly(t.homographies[i]!, point);
  const b = happly(t.homographies[j]!, point);
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
}
