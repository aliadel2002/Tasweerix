import { flattenPath, parsePath, polylineToPath, serializePath, smoothPolyline, type Vec2 } from '@tasweerix/core';

/** Ramer–Douglas–Peucker polyline simplification. */
export function simplifyPoints(pts: Vec2[], tolerance = 1): Vec2[] {
  if (pts.length < 3) return pts;
  const sq = tolerance * tolerance;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    const [ax, ay] = pts[a]!;
    const [bx, by] = pts[b]!;
    const dx = bx - ax;
    const dy = by - ay;
    const L = dx * dx + dy * dy || 1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i]!;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L));
      const d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > sq && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Simplifies a path (curves are flattened first). */
export function simplifyPath(d: string, tolerance = 1): string {
  return flattenPath(parsePath(d), tolerance / 4)
    .map((s) => serializePath(polylineToPath(simplifyPoints(s.points, tolerance), s.closed)))
    .join('');
}

/** Smooths a path through its (flattened) vertices with Catmull-Rom curves. */
export function smoothPath(d: string, tension = 0.5, simplify = 1): string {
  return flattenPath(parsePath(d), 0.5)
    .map((s) => serializePath(smoothPolyline(simplifyPoints(s.points, simplify), s.closed, tension)))
    .join('');
}
