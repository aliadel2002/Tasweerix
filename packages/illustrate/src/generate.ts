import polygonClipping from 'polygon-clipping';
import { createNoise, createRandom, polylineToPath, serializePath, smoothPolyline, type Vec2 } from '@tasweerix/core';

/** Poisson-disc sampling (Bridson): evenly spread random points with a minimum distance. */
export function poissonDisc(width: number, height: number, minDist: number, opts: { seed?: number | string; k?: number; max?: number } = {}): Vec2[] {
  const rnd = createRandom(opts.seed ?? 1);
  const k = opts.k ?? 30;
  const cell = minDist / Math.SQRT2;
  const gw = Math.ceil(width / cell);
  const gh = Math.ceil(height / cell);
  const grid = new Int32Array(gw * gh).fill(-1);
  const pts: Vec2[] = [];
  const active: number[] = [];
  const add = (p: Vec2) => {
    pts.push(p);
    active.push(pts.length - 1);
    grid[Math.floor(p[1] / cell) * gw + Math.floor(p[0] / cell)] = pts.length - 1;
  };
  add([rnd() * width, rnd() * height]);
  while (active.length && pts.length < (opts.max ?? Infinity)) {
    const ai = Math.floor(rnd() * active.length);
    const base = pts[active[ai]!]!;
    let found = false;
    for (let t = 0; t < k; t++) {
      const a = rnd() * Math.PI * 2;
      const r = minDist * (1 + rnd());
      const p: Vec2 = [base[0] + Math.cos(a) * r, base[1] + Math.sin(a) * r];
      if (p[0] < 0 || p[1] < 0 || p[0] >= width || p[1] >= height) continue;
      const gx = Math.floor(p[0] / cell);
      const gy = Math.floor(p[1] / cell);
      let ok = true;
      for (let y = Math.max(0, gy - 2); y <= Math.min(gh - 1, gy + 2) && ok; y++)
        for (let x = Math.max(0, gx - 2); x <= Math.min(gw - 1, gx + 2); x++) {
          const i = grid[y * gw + x]!;
          if (i >= 0 && Math.hypot(pts[i]![0] - p[0], pts[i]![1] - p[1]) < minDist) {
            ok = false;
            break;
          }
        }
      if (ok) {
        add(p);
        found = true;
        break;
      }
    }
    if (!found) active.splice(ai, 1);
  }
  return pts;
}

export type Triangle = [number, number, number];

/** Delaunay triangulation (Bowyer–Watson). Returns index triples into `points`. */
export function delaunay(points: Vec2[]): Triangle[] {
  const n = points.length;
  if (n < 3) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  const d = Math.max(maxX - minX, maxY - minY) * 20;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const pts: Vec2[] = [...points, [cx - d, cy - d], [cx + d, cy - d], [cx, cy + d]];
  type T = { a: number; b: number; c: number; x: number; y: number; r2: number };
  const circ = (a: number, b: number, c: number): T => {
    const [ax, ay] = pts[a]!;
    const [bx, by] = pts[b]!;
    const [qx, qy] = pts[c]!;
    const D = 2 * (ax * (by - qy) + bx * (qy - ay) + qx * (ay - by)) || 1e-12;
    const ux = ((ax * ax + ay * ay) * (by - qy) + (bx * bx + by * by) * (qy - ay) + (qx * qx + qy * qy) * (ay - by)) / D;
    const uy = ((ax * ax + ay * ay) * (qx - bx) + (bx * bx + by * by) * (ax - qx) + (qx * qx + qy * qy) * (bx - ax)) / D;
    return { a, b, c, x: ux, y: uy, r2: (ax - ux) ** 2 + (ay - uy) ** 2 };
  };
  let tris: T[] = [circ(n, n + 1, n + 2)];
  for (let i = 0; i < n; i++) {
    const [px, py] = pts[i]!;
    const bad: T[] = [];
    const good: T[] = [];
    for (const t of tris) ((px - t.x) ** 2 + (py - t.y) ** 2 < t.r2 ? bad : good).push(t);
    const edges = new Map<string, [number, number]>();
    for (const t of bad)
      for (const [u, v] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]] as [number, number][]) {
        const k = u < v ? `${u},${v}` : `${v},${u}`;
        if (edges.has(k)) edges.delete(k);
        else edges.set(k, [u, v]);
      }
    for (const [u, v] of edges.values()) good.push(circ(u, v, i));
    tris = good;
  }
  return tris.filter((t) => t.a < n && t.b < n && t.c < n).map((t) => [t.a, t.b, t.c]);
}

/** Voronoi cells (polygons) for points, clipped to a rectangle. */
export function voronoi(points: Vec2[], bounds: [number, number, number, number]): Vec2[][] {
  const [bx, by, bw, bh] = bounds;
  // Mirror points across the bounds so outer cells close properly.
  const mirrored: Vec2[] = [...points];
  for (const [x, y] of points) mirrored.push([2 * bx - x, y], [2 * (bx + bw) - x, y], [x, 2 * by - y], [x, 2 * (by + bh) - y]);
  const tris = delaunay(mirrored);
  const centers = tris.map(([a, b, c]) => {
    const [ax, ay] = mirrored[a]!;
    const [qx, qy] = mirrored[b]!;
    const [cx, cy] = mirrored[c]!;
    const D = 2 * (ax * (qy - cy) + qx * (cy - ay) + cx * (ay - qy)) || 1e-12;
    return [
      ((ax * ax + ay * ay) * (qy - cy) + (qx * qx + qy * qy) * (cy - ay) + (cx * cx + cy * cy) * (ay - qy)) / D,
      ((ax * ax + ay * ay) * (cx - qx) + (qx * qx + qy * qy) * (ax - cx) + (cx * cx + cy * cy) * (qx - ax)) / D,
    ] as Vec2;
  });
  const byPoint = new Map<number, number[]>();
  tris.forEach((t, ti) => t.forEach((p) => (p < points.length ? (byPoint.get(p) ?? byPoint.set(p, []).get(p)!).push(ti) : 0)));
  const box: [number, number][][] = [[[bx, by], [bx + bw, by], [bx + bw, by + bh], [bx, by + bh], [bx, by]]];
  return points.map((p, i) => {
    const cs = (byPoint.get(i) ?? []).map((ti) => centers[ti]!);
    cs.sort((a, b) => Math.atan2(a[1] - p[1], a[0] - p[0]) - Math.atan2(b[1] - p[1], b[0] - p[0]));
    if (cs.length < 3) return [];
    const ring = [...cs, cs[0]!].map((c) => [c[0], c[1]] as [number, number]);
    const clipped = polygonClipping.intersection([ring], box);
    return (clipped[0]?.[0] ?? []).slice(0, -1) as Vec2[];
  });
}

/** Flow-field streamlines following curl/simplex noise. Returns SVG path strings. */
export function flowField(width: number, height: number, opts: { lines?: number; steps?: number; stepSize?: number; scale?: number; seed?: number; smooth?: number; curl?: boolean } = {}): string[] {
  const noise = createNoise(opts.seed ?? 1);
  const rnd = createRandom(opts.seed ?? 1);
  const scale = opts.scale ?? 0.003;
  const out: string[] = [];
  for (let l = 0; l < (opts.lines ?? 300); l++) {
    let x = rnd() * width;
    let y = rnd() * height;
    const pts: Vec2[] = [[x, y]];
    for (let s = 0; s < (opts.steps ?? 60); s++) {
      let dx: number;
      let dy: number;
      if (opts.curl) [dx, dy] = noise.curl2(x * scale, y * scale);
      else {
        const a = noise.fbm2(x * scale, y * scale, 3) * Math.PI * 2;
        dx = Math.cos(a);
        dy = Math.sin(a);
      }
      const L = Math.hypot(dx, dy) || 1;
      x += (dx / L) * (opts.stepSize ?? 4);
      y += (dy / L) * (opts.stepSize ?? 4);
      if (x < 0 || y < 0 || x > width || y > height) break;
      pts.push([x, y]);
    }
    if (pts.length > 2) out.push(serializePath(smoothPolyline(pts, false, opts.smooth ?? 0.5)));
  }
  return out;
}

/** L-system turtle graphics. F/G draw forward, f moves, +/- turn, [ ] push/pop. */
export function lSystem(axiom: string, rules: Record<string, string>, opts: { iterations?: number; angle?: number; step?: number; startAngle?: number } = {}): string {
  let s = axiom;
  for (let i = 0; i < (opts.iterations ?? 4); i++) s = [...s].map((c) => rules[c] ?? c).join('');
  const ang = ((opts.angle ?? 25) * Math.PI) / 180;
  const step = opts.step ?? 8;
  let x = 0;
  let y = 0;
  let a = ((opts.startAngle ?? -90) * Math.PI) / 180;
  const stack: [number, number, number][] = [];
  let d = 'M0 0';
  let penDown = true;
  for (const c of s) {
    if (c === 'F' || c === 'G') {
      x += Math.cos(a) * step;
      y += Math.sin(a) * step;
      d += penDown ? `L${+x.toFixed(2)} ${+y.toFixed(2)}` : `M${+x.toFixed(2)} ${+y.toFixed(2)}`;
      penDown = true;
    } else if (c === 'f') {
      x += Math.cos(a) * step;
      y += Math.sin(a) * step;
      d += `M${+x.toFixed(2)} ${+y.toFixed(2)}`;
    } else if (c === '+') a += ang;
    else if (c === '-') a -= ang;
    else if (c === '[') stack.push([x, y, a]);
    else if (c === ']') {
      [x, y, a] = stack.pop() ?? [0, 0, 0];
      d += `M${+x.toFixed(2)} ${+y.toFixed(2)}`;
    }
  }
  return d;
}

/** Organic closed blob shape (noise-perturbed circle). */
export function blob(radius: number, opts: { points?: number; wobble?: number; seed?: number; time?: number } = {}): string {
  const n = opts.points ?? 12;
  const noise = createNoise(opts.seed ?? 1);
  const pts: Vec2[] = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    const r = radius * (1 + noise.noise3(Math.cos(a), Math.sin(a), opts.time ?? 0) * (opts.wobble ?? 0.25));
    return [Math.cos(a) * r, Math.sin(a) * r];
  });
  return serializePath(smoothPolyline(pts, true, 0.5));
}

/** Layered noise ridge lines ("Joy Division" style terrain). */
export function ridgeLines(width: number, height: number, opts: { lines?: number; amplitude?: number; seed?: number; resolution?: number } = {}): string[] {
  const noise = createNoise(opts.seed ?? 1);
  const lines = opts.lines ?? 40;
  const res = opts.resolution ?? 120;
  const out: string[] = [];
  for (let l = 0; l < lines; l++) {
    const y0 = (height * (l + 1)) / (lines + 1);
    const pts: Vec2[] = [];
    for (let i = 0; i <= res; i++) {
      const x = (width * i) / res;
      const center = 1 - Math.abs(i / res - 0.5) * 2;
      const amp = (opts.amplitude ?? 60) * Math.pow(center, 2);
      pts.push([x, y0 - Math.abs(noise.fbm2(i * 0.05, l * 0.3, 4)) * amp * 2]);
    }
    out.push(serializePath(polylineToPath(pts)));
  }
  return out;
}

/** Spirograph (hypotrochoid) curve. */
export function spirograph(R: number, r: number, d: number, opts: { revolutions?: number; steps?: number } = {}): string {
  const rev = opts.revolutions ?? r / gcd(Math.round(R), Math.round(r));
  const steps = opts.steps ?? 2000;
  const pts: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2 * rev;
    pts.push([(R - r) * Math.cos(t) + d * Math.cos(((R - r) / r) * t), (R - r) * Math.sin(t) - d * Math.sin(((R - r) / r) * t)]);
  }
  return serializePath(polylineToPath(pts));
}
function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : Math.max(1, a);
}

/** Repeating pattern geometry over a rectangle. */
export const patterns = {
  stripes(width: number, height: number, spacing: number, thickness: number, angle = 45): string {
    const out: string[] = [];
    const diag = Math.hypot(width, height);
    const a = (angle * Math.PI) / 180;
    const [ux, uy] = [Math.cos(a), Math.sin(a)];
    const [nx, ny] = [-uy, ux];
    for (let o = -diag; o <= diag; o += spacing) {
      const cx = width / 2 + nx * o;
      const cy = height / 2 + ny * o;
      const p = (s: number, w: number): Vec2 => [cx + ux * s + nx * w, cy + uy * s + ny * w];
      const q = [p(-diag, 0), p(diag, 0), p(diag, thickness), p(-diag, thickness)];
      out.push(serializePath(polylineToPath(q, true)));
    }
    return out.join('');
  },
  dots(width: number, height: number, spacing: number, radius: number, offsetRows = true): string {
    let d = '';
    for (let y = spacing / 2, row = 0; y < height; y += spacing, row++)
      for (let x = spacing / 2 + (offsetRows && row % 2 ? spacing / 2 : 0); x < width; x += spacing)
        d += `M${x + radius} ${y}A${radius} ${radius} 0 1 1 ${x - radius} ${y}A${radius} ${radius} 0 1 1 ${x + radius} ${y}Z`;
    return d;
  },
  grid(width: number, height: number, spacing: number): string {
    let d = '';
    for (let x = 0; x <= width; x += spacing) d += `M${x} 0L${x} ${height}`;
    for (let y = 0; y <= height; y += spacing) d += `M0 ${y}L${width} ${y}`;
    return d;
  },
  checker(width: number, height: number, size: number): string {
    let d = '';
    for (let y = 0, r = 0; y < height; y += size, r++)
      for (let x = (r % 2) * size; x < width; x += size * 2) d += `M${x} ${y}h${size}v${size}h${-size}Z`;
    return d;
  },
  hexagons(width: number, height: number, radius: number): string {
    let d = '';
    const h = Math.sqrt(3) * radius;
    for (let y = 0, r = 0; y < height + h; y += h / 2, r++)
      for (let x = (r % 2) * radius * 1.5; x < width + radius * 3; x += radius * 3) {
        const pts: Vec2[] = Array.from({ length: 6 }, (_, i) => [x + radius * Math.cos((i * Math.PI) / 3), y + radius * Math.sin((i * Math.PI) / 3)]);
        d += serializePath(polylineToPath(pts, true));
      }
    return d;
  },
};
