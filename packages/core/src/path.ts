import type { Vec2 } from './math';

/**
 * Normalized path representation: absolute move / line / cubic / close commands.
 * Every SVG command (incl. quadratic curves and arcs) is converted into these.
 */
export type PathCmd =
  | { c: 'M'; p: Vec2 }
  | { c: 'L'; p: Vec2 }
  | { c: 'C'; c1: Vec2; c2: Vec2; p: Vec2 }
  | { c: 'Z' };

export type PathData = PathCmd[];

const NUM_RE = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;

/** Parses SVG path data into normalized absolute commands. */
export function parsePath(d: string): PathData {
  const out: PathData = [];
  const segs = d.match(/[a-df-z][^a-df-z]*/gi) ?? [];
  let cur: Vec2 = [0, 0];
  let start: Vec2 = [0, 0];
  let lastCtrl: Vec2 | null = null;
  let lastQuad: Vec2 | null = null;
  for (const seg of segs) {
    const cmd = seg[0]!;
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const nums = (seg.slice(1).match(NUM_RE) ?? []).map(Number);
    const abs = (x: number, y: number): Vec2 => (rel ? [cur[0] + x, cur[1] + y] : [x, y]);
    let i = 0;
    const take = (n: number) => {
      const r = nums.slice(i, i + n);
      i += n;
      return r;
    };
    const more = (n: number) => i + n <= nums.length;
    if (C === 'Z') {
      out.push({ c: 'Z' });
      cur = start;
      lastCtrl = lastQuad = null;
      continue;
    }
    let first = true;
    while (first || (C !== 'Z' && more(argCount(C)))) {
      if (!more(argCount(C))) break;
      first = false;
      switch (C) {
        case 'M': {
          const [x, y] = take(2) as [number, number];
          const p = abs(x, y);
          // Subsequent pairs after M are implicit L.
          if (out.length && i > 2) out.push({ c: 'L', p });
          else out.push({ c: 'M', p });
          cur = p;
          if (i <= 2) start = p;
          lastCtrl = lastQuad = null;
          break;
        }
        case 'L': {
          const [x, y] = take(2) as [number, number];
          cur = abs(x, y);
          out.push({ c: 'L', p: cur });
          lastCtrl = lastQuad = null;
          break;
        }
        case 'H': {
          const [x] = take(1) as [number];
          cur = [rel ? cur[0] + x : x, cur[1]];
          out.push({ c: 'L', p: cur });
          lastCtrl = lastQuad = null;
          break;
        }
        case 'V': {
          const [y] = take(1) as [number];
          cur = [cur[0], rel ? cur[1] + y : y];
          out.push({ c: 'L', p: cur });
          lastCtrl = lastQuad = null;
          break;
        }
        case 'C': {
          const [a, b, c, dd, e, f] = take(6) as number[];
          const c1 = abs(a!, b!);
          const c2 = abs(c!, dd!);
          const p = abs(e!, f!);
          out.push({ c: 'C', c1, c2, p });
          cur = p;
          lastCtrl = c2;
          lastQuad = null;
          break;
        }
        case 'S': {
          const [c, dd, e, f] = take(4) as number[];
          const c1: Vec2 = lastCtrl ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] : cur;
          const c2 = abs(c!, dd!);
          const p = abs(e!, f!);
          out.push({ c: 'C', c1, c2, p });
          cur = p;
          lastCtrl = c2;
          lastQuad = null;
          break;
        }
        case 'Q': {
          const [a, b, e, f] = take(4) as number[];
          const q = abs(a!, b!);
          const p = abs(e!, f!);
          out.push(quadToCubic(cur, q, p));
          cur = p;
          lastQuad = q;
          lastCtrl = null;
          break;
        }
        case 'T': {
          const [e, f] = take(2) as number[];
          const q: Vec2 = lastQuad ? [2 * cur[0] - lastQuad[0], 2 * cur[1] - lastQuad[1]] : cur;
          const p = abs(e!, f!);
          out.push(quadToCubic(cur, q, p));
          cur = p;
          lastQuad = q;
          lastCtrl = null;
          break;
        }
        case 'A': {
          const [rx, ry, rot, large, sweep, x, y] = take(7) as number[];
          const p = abs(x!, y!);
          out.push(...arcToCubics(cur, p, rx!, ry!, rot!, !!large, !!sweep));
          cur = p;
          lastCtrl = lastQuad = null;
          break;
        }
        default:
          i = nums.length;
      }
    }
  }
  return out;
}

function argCount(c: string): number {
  return { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }[c] ?? 0;
}

function quadToCubic(p0: Vec2, q: Vec2, p: Vec2): PathCmd {
  return {
    c: 'C',
    c1: [p0[0] + (2 / 3) * (q[0] - p0[0]), p0[1] + (2 / 3) * (q[1] - p0[1])],
    c2: [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])],
    p,
  };
}

function arcToCubics(p0: Vec2, p1: Vec2, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean): PathCmd[] {
  if (rx === 0 || ry === 0) return [{ c: 'L', p: p1 }];
  const phi = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2;
  const dy = (p0[1] - p1[1]) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (p0[0] + p1[0]) / 2;
  const cy = sin * cxp + cos * cyp + (p0[1] + p1[1]) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.ceil(Math.abs(dt) / (Math.PI / 2));
  const out: PathCmd[] = [];
  const step = dt / n;
  const k = (4 / 3) * Math.tan(step / 4);
  let a = t1;
  const pt = (t: number): Vec2 => [cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos];
  const dpt = (t: number): Vec2 => [-rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos];
  for (let i = 0; i < n; i++) {
    const b = a + step;
    const pa = pt(a);
    const pb = i === n - 1 ? p1 : pt(b);
    const da = dpt(a);
    const db = dpt(b);
    out.push({ c: 'C', c1: [pa[0] + k * da[0], pa[1] + k * da[1]], c2: [pb[0] - k * db[0], pb[1] - k * db[1]], p: pb });
    a = b;
  }
  return out;
}

const fmt = (n: number) => (Math.abs(n) < 1e-9 ? '0' : String(+n.toFixed(3)));

/** Serializes normalized commands back to an SVG path string. */
export function serializePath(p: PathData): string {
  return p
    .map((c) => {
      switch (c.c) {
        case 'M':
          return `M${fmt(c.p[0])} ${fmt(c.p[1])}`;
        case 'L':
          return `L${fmt(c.p[0])} ${fmt(c.p[1])}`;
        case 'C':
          return `C${fmt(c.c1[0])} ${fmt(c.c1[1])} ${fmt(c.c2[0])} ${fmt(c.c2[1])} ${fmt(c.p[0])} ${fmt(c.p[1])}`;
        default:
          return 'Z';
      }
    })
    .join('');
}

/** Applies a point transform to every command. */
export function mapPath(p: PathData, fn: (v: Vec2) => Vec2): PathData {
  return p.map((c) => {
    switch (c.c) {
      case 'M':
      case 'L':
        return { c: c.c, p: fn(c.p) };
      case 'C':
        return { c: 'C', c1: fn(c.c1), c2: fn(c.c2), p: fn(c.p) };
      default:
        return c;
    }
  });
}

/** Subpaths as polylines (flattened curves). */
export function flattenPath(p: PathData, tolerance = 0.5): { points: Vec2[]; closed: boolean }[] {
  const subs: { points: Vec2[]; closed: boolean }[] = [];
  let cur: { points: Vec2[]; closed: boolean } | null = null;
  let last: Vec2 = [0, 0];
  let start: Vec2 = [0, 0];
  for (const c of p) {
    if (c.c === 'M') {
      cur = { points: [c.p], closed: false };
      subs.push(cur);
      last = start = c.p;
    } else if (c.c === 'L') {
      if (!cur) {
        cur = { points: [last], closed: false };
        subs.push(cur);
      }
      cur.points.push(c.p);
      last = c.p;
    } else if (c.c === 'C') {
      if (!cur) {
        cur = { points: [last], closed: false };
        subs.push(cur);
      }
      const len = Math.hypot(c.c1[0] - last[0], c.c1[1] - last[1]) + Math.hypot(c.c2[0] - c.c1[0], c.c2[1] - c.c1[1]) + Math.hypot(c.p[0] - c.c2[0], c.p[1] - c.c2[1]);
      const n = Math.max(2, Math.min(256, Math.ceil(Math.sqrt(len / tolerance) * 2)));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const u = 1 - t;
        cur.points.push([
          u * u * u * last[0] + 3 * u * u * t * c.c1[0] + 3 * u * t * t * c.c2[0] + t * t * t * c.p[0],
          u * u * u * last[1] + 3 * u * u * t * c.c1[1] + 3 * u * t * t * c.c2[1] + t * t * t * c.p[1],
        ]);
      }
      last = c.p;
    } else if (c.c === 'Z') {
      if (cur) {
        cur.closed = true;
        cur = null;
      }
      last = start;
    }
  }
  return subs.filter((s) => s.points.length > 0);
}

export function polylineLength(points: Vec2[], closed = false): number {
  let l = 0;
  for (let i = 1; i < points.length; i++) l += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  if (closed && points.length > 1) l += Math.hypot(points[0]![0] - points[points.length - 1]![0], points[0]![1] - points[points.length - 1]![1]);
  return l;
}

export function pathLength(p: PathData): number {
  return flattenPath(p).reduce((s, sp) => s + polylineLength(sp.points, sp.closed), 0);
}

export function pathBounds(p: PathData): { x: number; y: number; width: number; height: number } {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const sp of flattenPath(p, 1))
    for (const [x, y] of sp.points) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Point and tangent angle (radians) at a fraction 0..1 of the total path length. */
export function pointAtLength(p: PathData | Vec2[], fraction: number): { point: Vec2; angle: number } {
  const subs = Array.isArray(p[0]) ? [{ points: p as Vec2[], closed: false }] : flattenPath(p as PathData);
  const pts: Vec2[] = [];
  for (const s of subs) {
    pts.push(...s.points);
    if (s.closed && s.points.length) pts.push(s.points[0]!);
  }
  if (pts.length === 0) return { point: [0, 0], angle: 0 };
  if (pts.length === 1) return { point: pts[0]!, angle: 0 };
  const total = polylineLength(pts);
  let target = Math.min(Math.max(fraction, 0), 1) * total;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (target <= seg || i === pts.length - 1) {
      const t = seg ? Math.min(1, target / seg) : 0;
      return { point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], angle: Math.atan2(b[1] - a[1], b[0] - a[0]) };
    }
    target -= seg;
  }
  return { point: pts[pts.length - 1]!, angle: 0 };
}

/**
 * Trim paths: keeps the portion between start and end (fractions of total length), shifted by offset.
 * Returns polylines (curves flattened).
 */
export function trimPolylines(subs: { points: Vec2[]; closed: boolean }[], start: number, end: number, offset = 0): Vec2[][] {
  const flat = subs.map((s) => (s.closed && s.points.length ? [...s.points, s.points[0]!] : s.points));
  const lens = flat.map((pts) => polylineLength(pts));
  const total = lens.reduce((a, b) => a + b, 0);
  if (total === 0) return [];
  let s = Math.min(start, end);
  let e = Math.max(start, end);
  if (e - s >= 1 - 1e-9) return flat;
  if (e - s <= 1e-9) return [];
  s += offset;
  e += offset;
  const shift = Math.floor(s);
  s -= shift;
  e -= shift;
  const ranges: [number, number][] = e > 1 ? [[s * total, total], [0, (e - 1) * total]] : [[s * total, e * total]];
  const out: Vec2[][] = [];
  for (const [a, b] of ranges) {
    let acc = 0;
    flat.forEach((pts, si) => {
      const L = lens[si]!;
      const sa = Math.max(a - acc, 0);
      const sb = Math.min(b - acc, L);
      if (sb > sa) out.push(slicePolyline(pts, sa, sb));
      acc += L;
    });
  }
  return out;
}

function slicePolyline(pts: Vec2[], a: number, b: number): Vec2[] {
  const out: Vec2[] = [];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1]!;
    const p1 = pts[i]!;
    const seg = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const s0 = acc;
    const s1 = acc + seg;
    if (s1 >= a && s0 <= b && seg > 0) {
      const ta = Math.max(0, (a - s0) / seg);
      const tb = Math.min(1, (b - s0) / seg);
      const pa: Vec2 = [p0[0] + (p1[0] - p0[0]) * ta, p0[1] + (p1[1] - p0[1]) * ta];
      const pb: Vec2 = [p0[0] + (p1[0] - p0[0]) * tb, p0[1] + (p1[1] - p0[1]) * tb];
      if (out.length === 0) out.push(pa);
      out.push(pb);
    }
    acc = s1;
  }
  return out;
}

/** Resamples a closed/open polyline into exactly n evenly spaced points. */
export function resamplePolyline(pts: Vec2[], n: number, closed = false): Vec2[] {
  const src = closed && pts.length ? [...pts, pts[0]!] : pts;
  const total = polylineLength(src);
  if (n <= 1 || total === 0) return Array.from({ length: n }, () => (src[0] ?? [0, 0]) as Vec2);
  const out: Vec2[] = [];
  const step = total / (closed ? n : n - 1);
  let seg = 1;
  let segStart = 0;
  for (let i = 0; i < n; i++) {
    const target = i * step;
    while (seg < src.length - 1 && segStart + Math.hypot(src[seg]![0] - src[seg - 1]![0], src[seg]![1] - src[seg - 1]![1]) < target) {
      segStart += Math.hypot(src[seg]![0] - src[seg - 1]![0], src[seg]![1] - src[seg - 1]![1]);
      seg++;
    }
    const a = src[seg - 1]!;
    const b = src[seg]!;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const t = L ? Math.min(1, Math.max(0, (target - segStart) / L)) : 0;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

export function polylineToPath(points: Vec2[], closed = false): PathData {
  if (!points.length) return [];
  const out: PathData = [{ c: 'M', p: points[0]! }];
  for (let i = 1; i < points.length; i++) out.push({ c: 'L', p: points[i]! });
  if (closed) out.push({ c: 'Z' });
  return out;
}

/** Catmull-Rom spline through points, as cubic beziers. */
export function smoothPolyline(points: Vec2[], closed = false, tension = 0.5): PathData {
  if (points.length < 3 || tension <= 0) return polylineToPath(points, closed);
  const n = points.length;
  const get = (i: number): Vec2 => (closed ? points[(i + n) % n]! : points[Math.max(0, Math.min(n - 1, i))]!);
  const out: PathData = [{ c: 'M', p: points[0]! }];
  const segs = closed ? n : n - 1;
  const k = tension / 3;
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1);
    const p1 = get(i);
    const p2 = get(i + 1);
    const p3 = get(i + 2);
    out.push({
      c: 'C',
      c1: [p1[0] + (p2[0] - p0[0]) * k, p1[1] + (p2[1] - p0[1]) * k],
      c2: [p2[0] - (p3[0] - p1[0]) * k, p2[1] - (p3[1] - p1[1]) * k],
      p: p2,
    });
  }
  if (closed) out.push({ c: 'Z' });
  return out;
}

// ------------------------------------------------------------- Shape builders

export function rectPath(w: number, h: number, radius: number | [number, number, number, number] = 0): PathData {
  const x = -w / 2;
  const y = -h / 2;
  const max = Math.min(Math.abs(w), Math.abs(h)) / 2;
  const [tl, tr, br, bl] = (Array.isArray(radius) ? radius : [radius, radius, radius, radius]).map((r) => Math.min(Math.max(0, r), max)) as [number, number, number, number];
  const K = 0.5522847498;
  const out: PathData = [{ c: 'M', p: [x + tl, y] }, { c: 'L', p: [x + w - tr, y] }];
  if (tr) out.push({ c: 'C', c1: [x + w - tr + tr * K, y], c2: [x + w, y + tr - tr * K], p: [x + w, y + tr] });
  out.push({ c: 'L', p: [x + w, y + h - br] });
  if (br) out.push({ c: 'C', c1: [x + w, y + h - br + br * K], c2: [x + w - br + br * K, y + h], p: [x + w - br, y + h] });
  out.push({ c: 'L', p: [x + bl, y + h] });
  if (bl) out.push({ c: 'C', c1: [x + bl - bl * K, y + h], c2: [x, y + h - bl + bl * K], p: [x, y + h - bl] });
  out.push({ c: 'L', p: [x, y + tl] });
  if (tl) out.push({ c: 'C', c1: [x, y + tl - tl * K], c2: [x + tl - tl * K, y], p: [x + tl, y] });
  out.push({ c: 'Z' });
  return out;
}

/**
 * Ellipse (or arc) centered on the origin. Partial arcs are pie wedges when `pie` is true (for fills)
 * and open arcs otherwise (for strokes, e.g. donut charts and progress rings).
 */
export function ellipsePath(w: number, h: number, startDeg = 0, endDeg = 360, pie = true): PathData {
  const rx = w / 2;
  const ry = h / 2;
  const full = Math.abs(endDeg - startDeg) >= 360 - 1e-9;
  const a0 = ((startDeg - 90) * Math.PI) / 180;
  const a1 = ((endDeg - 90) * Math.PI) / 180;
  const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2)));
  const step = (a1 - a0) / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const pt = (a: number): Vec2 => [rx * Math.cos(a), ry * Math.sin(a)];
  const out: PathData = [];
  if (!full && pie) out.push({ c: 'M', p: [0, 0] }, { c: 'L', p: pt(a0) });
  else out.push({ c: 'M', p: pt(a0) });
  let a = a0;
  for (let i = 0; i < n; i++) {
    const b = a + step;
    const pa = pt(a);
    const pb = pt(b);
    out.push({
      c: 'C',
      c1: [pa[0] - k * rx * Math.sin(a), pa[1] + k * ry * Math.cos(a)],
      c2: [pb[0] + k * rx * Math.sin(b), pb[1] - k * ry * Math.cos(b)],
      p: pb,
    });
    a = b;
  }
  if (full || pie) out.push({ c: 'Z' });
  return out;
}

/** Rounds polygon corners with quadratic-like cubic fillets. */
export function roundedPolygonPath(points: Vec2[], radius: number): PathData {
  if (radius <= 0 || points.length < 3) return polylineToPath(points, true);
  const n = points.length;
  const out: PathData = [];
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n]!;
    const p = points[i]!;
    const next = points[(i + 1) % n]!;
    const d1 = Math.hypot(prev[0] - p[0], prev[1] - p[1]);
    const d2 = Math.hypot(next[0] - p[0], next[1] - p[1]);
    const r = Math.min(radius, d1 / 2, d2 / 2);
    const a: Vec2 = [p[0] + ((prev[0] - p[0]) / d1) * r, p[1] + ((prev[1] - p[1]) / d1) * r];
    const b: Vec2 = [p[0] + ((next[0] - p[0]) / d2) * r, p[1] + ((next[1] - p[1]) / d2) * r];
    out.push(i === 0 ? { c: 'M', p: a } : { c: 'L', p: a });
    out.push({ c: 'C', c1: [a[0] + (p[0] - a[0]) * 0.55, a[1] + (p[1] - a[1]) * 0.55], c2: [b[0] + (p[0] - b[0]) * 0.55, b[1] + (p[1] - b[1]) * 0.55], p: b });
  }
  out.push({ c: 'Z' });
  return out;
}

export function polygonPoints(sides: number, radius: number): Vec2[] {
  const n = Math.max(3, Math.round(sides));
  return Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    return [Math.cos(a) * radius, Math.sin(a) * radius] as Vec2;
  });
}

export function starPoints(points: number, outer: number, inner: number): Vec2[] {
  const n = Math.max(2, Math.round(points));
  return Array.from({ length: n * 2 }, (_, i) => {
    const a = -Math.PI / 2 + (i / (n * 2)) * Math.PI * 2;
    const r = i % 2 === 0 ? outer : inner;
    return [Math.cos(a) * r, Math.sin(a) * r] as Vec2;
  });
}
