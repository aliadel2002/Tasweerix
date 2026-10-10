import {
  flattenPath,
  keys,
  parsePath,
  registerInterpolator,
  resamplePolyline,
  toSeconds,
  type EasingInput,
  type TimeInput,
  type Track,
  type Vec2,
} from '@tasweerix/core';

const SAMPLES = 160;
const cache = new Map<string, Vec2[][]>();

function polygonArea(p: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i]!;
    const [x1, y1] = p[(i + 1) % p.length]!;
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

function prepared(d: string): Vec2[][] {
  let v = cache.get(d);
  if (!v) {
    const subs = flattenPath(parsePath(d), 0.5).filter((s) => s.points.length > 1);
    v = subs.map((s) => {
      let pts = resamplePolyline(s.points, SAMPLES, s.closed);
      if (s.closed && polygonArea(pts) < 0) pts = pts.reverse(); // consistent winding
      return pts;
    });
    // Larger shapes first so subpaths pair sensibly.
    v.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
    if (cache.size > 500) cache.clear();
    cache.set(d, v);
  }
  return v;
}

function centroid(p: Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const q of p) {
    x += q[0];
    y += q[1];
  }
  return [x / p.length, y / p.length];
}

/** Rotates b's start index to best match a (minimizes summed squared distance). */
function align(a: Vec2[], b: Vec2[]): Vec2[] {
  let best = 0;
  let bestD = Infinity;
  const step = Math.max(1, Math.floor(SAMPLES / 64));
  for (let off = 0; off < b.length; off += step) {
    let d = 0;
    for (let i = 0; i < a.length; i += 4) {
      const p = a[i]!;
      const q = b[(i + off) % b.length]!;
      d += (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
    }
    if (d < bestD) {
      bestD = d;
      best = off;
    }
  }
  return b.map((_, i) => b[(i + best) % b.length]!);
}

const alignCache = new Map<string, [Vec2[][], Vec2[][]]>();

/** Morphs between two SVG path strings with any number of subpaths. */
export function morphPaths(a: string, b: string, t: number): string {
  const key = `${a}→${b}`;
  let pair = alignCache.get(key);
  if (!pair) {
    const A = prepared(a);
    const B = prepared(b);
    const n = Math.max(A.length, B.length);
    const pa: Vec2[][] = [];
    const pb: Vec2[][] = [];
    for (let i = 0; i < n; i++) {
      // Missing subpaths grow from / shrink to the centroid of their counterpart.
      const sa = A[i] ?? Array.from({ length: SAMPLES }, () => centroid(B[i]!));
      const sb = B[i] ?? Array.from({ length: SAMPLES }, () => centroid(A[i]!));
      pa.push(sa);
      pb.push(align(sa, sb));
    }
    pair = [pa, pb];
    if (alignCache.size > 500) alignCache.clear();
    alignCache.set(key, pair);
  }
  const [pa, pb] = pair;
  let d = '';
  for (let s = 0; s < pa.length; s++) {
    const A = pa[s]!;
    const B = pb[s]!;
    for (let i = 0; i < A.length; i++) {
      const x = A[i]![0] + (B[i]![0] - A[i]![0]) * t;
      const y = A[i]![1] + (B[i]![1] - A[i]![1]) * t;
      d += `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`;
    }
    d += 'Z';
  }
  return d;
}

const PATH_RE = /^\s*[Mm]\s*-?[\d.]/;

registerInterpolator({
  name: 'svg-path-morph',
  test: (a, b) => typeof a === 'string' && typeof b === 'string' && a !== b && PATH_RE.test(a) && PATH_RE.test(b),
  mix: (a: string, b: string, t: number) => morphPaths(a, b, t),
});

/** Keyframed morph through several shapes: `path(morph([star, circle, heart], { each: 1 }))`. */
export function morph(shapes: string[], opts: { start?: TimeInput; each?: TimeInput; hold?: TimeInput; ease?: EasingInput } = {}): Track<string> {
  const start = toSeconds(opts.start ?? 0);
  const each = toSeconds(opts.each ?? 1);
  const hold = toSeconds(opts.hold ?? 0);
  const list: [number, string, EasingInput?][] = [];
  let t = start;
  shapes.forEach((s, i) => {
    if (i === 0) list.push([t, s]);
    else {
      t += each;
      list.push([t, s, opts.ease ?? 'inOutCubic']);
    }
    if (hold && i < shapes.length - 1) {
      t += hold;
      list.push([t, s, 'hold']);
    }
  });
  return keys(list as never);
}
