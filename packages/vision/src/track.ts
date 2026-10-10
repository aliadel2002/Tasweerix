import type { Vec2 } from '@tasweerix/core';
import { goodFeatures } from './features';
import { buildPyramid, trackConsistent, type Pyramid } from './flow';
import type { Gray } from './image';

/** Positions of a tracked point over time, in source pixels. */
export interface PointTrack {
  version: 1;
  /** Source size the points refer to. */
  width: number;
  height: number;
  fps: number;
  /** Source time of the first sample. */
  start: number;
  points: Vec2[];
  /** True where the point could not be followed (the last known position is held). */
  lost: boolean[];
}

/**
 * Follows a region from frame `from` through `frames` (in the given order): features found around
 * the current position are tracked to the next frame and their median displacement moves it.
 */
export function followRegion(frames: Gray[], from: number, center: Vec2, radius: number, step: 1 | -1, out: { points: Vec2[]; lost: boolean[] }): void {
  let pos = center;
  let prev: Pyramid | undefined;
  for (let i = from; i >= 0 && i < frames.length; i += step) {
    const pyr = buildPyramid(frames[i]!, 3);
    if (prev) {
      const pts = goodFeatures(prev.levels[0]!, { region: { center: pos, radius }, max: 60, quality: 0.02, minDistance: 3, border: 4 });
      let { from: a, to: b } = trackConsistent(prev, pyr, pts, { radius: 6, maxError: 1 });
      // Few corners (smooth or edge-only regions): track the region as one large window instead.
      if (a.length < 3) ({ from: a, to: b } = trackConsistent(prev, pyr, [pos], { radius: Math.max(6, Math.min(24, Math.round(radius))), maxError: 1 }));
      if (a.length) {
        const dx = a.map((p, k) => b[k]![0] - p[0]).sort((x, y) => x - y);
        const dy = a.map((p, k) => b[k]![1] - p[1]).sort((x, y) => x - y);
        const mid = Math.floor(dx.length / 2);
        pos = [pos[0] + dx[mid]!, pos[1] + dy[mid]!];
        out.lost[i] = false;
      } else out.lost[i] = true;
    } else out.lost[i] = false;
    out.points[i] = pos;
    prev = pyr;
  }
}

/** Tracks a point through a frame range, forward and backward from the frame it was picked on. */
export function trackPointInFrames(frames: Gray[], at: number, point: Vec2, radius = 16): { points: Vec2[]; lost: boolean[] } {
  const out = { points: new Array<Vec2>(frames.length), lost: new Array<boolean>(frames.length) };
  followRegion(frames, at, point, radius, 1, out);
  followRegion(frames, at, point, radius, -1, out);
  return out;
}

/** Position of a tracked point at a source time (linear interpolation, held at the ends). */
export function pointAt(t: PointTrack, sourceTime: number): Vec2 {
  const n = t.points.length;
  if (!n) return [0, 0];
  const f = Math.min(n - 1, Math.max(0, (sourceTime - t.start) * t.fps));
  const i = Math.floor(f);
  const k = f - i;
  const a = t.points[i]!;
  const b = t.points[Math.min(n - 1, i + 1)]!;
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
}
