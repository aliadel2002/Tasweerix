import polygonClipping, { type MultiPolygon, type Polygon, type Ring } from 'polygon-clipping';
import { flattenPath, parsePath, type Vec2 } from '@tasweerix/core';

/** Converts an SVG path to polygon rings (curves flattened). Holes follow even-odd nesting. */
export function pathToPolygons(d: string, tolerance = 0.25): MultiPolygon {
  const rings: Ring[] = flattenPath(parsePath(d), tolerance)
    .filter((s) => s.points.length >= 3)
    .map((s) => {
      const r = s.points.map((p) => [p[0], p[1]] as [number, number]);
      const f = r[0]!;
      const l = r[r.length - 1]!;
      if (f[0] !== l[0] || f[1] !== l[1]) r.push([f[0], f[1]]);
      return r;
    });
  if (!rings.length) return [];
  // XOR all rings: handles holes regardless of winding.
  return polygonClipping.xor(...(rings.map((r) => [r] as Polygon) as [Polygon, ...Polygon[]]));
}

export function polygonsToPath(mp: MultiPolygon): string {
  let d = '';
  for (const poly of mp)
    for (const ring of poly) {
      ring.forEach((p, i) => (d += `${i ? 'L' : 'M'}${+p[0].toFixed(3)} ${+p[1].toFixed(3)}`));
      d += 'Z';
    }
  return d;
}

const op = (fn: typeof polygonClipping.union) => (...paths: string[]): string => {
  const geoms = paths.map((p) => pathToPolygons(p)).filter((g) => g.length);
  if (!geoms.length) return '';
  return polygonsToPath(fn(geoms[0]!, ...geoms.slice(1)));
};

/** Boolean path operations (results are polygonal paths). */
export const boolean = {
  union: op(polygonClipping.union),
  intersect: op(polygonClipping.intersection),
  subtract: op(polygonClipping.difference),
  xor: op(polygonClipping.xor),
};

/** Snaps coordinates to a fine grid; polygon-clipping is far more robust on snapped input. */
const snap = (v: number) => Math.round(v * 256) / 256;
const snapPoly = (p: Polygon): Polygon => p.map((r) => r.map(([x, y]) => [snap(x), snap(y)] as [number, number]));

function circlePoly(c: Vec2, r: number, n = 16): Polygon {
  const ring: Ring = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.1234;
    ring.push([snap(c[0] + Math.cos(a) * r), snap(c[1] + Math.sin(a) * r)]);
  }
  ring.push([...ring[0]!] as [number, number]);
  return [ring];
}

/** Robust union of many pieces: pairwise tree reduction with a jitter retry. */
function unionMany(pieces: Polygon[]): MultiPolygon {
  let level: MultiPolygon[] = pieces.map((p) => [snapPoly(p)]);
  while (level.length > 1) {
    const next: MultiPolygon[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]!;
      const b = level[i + 1];
      if (!b) {
        next.push(a);
        continue;
      }
      try {
        next.push(polygonClipping.union(a, b));
      } catch {
        const jitter = (m: MultiPolygon) => m.map((p) => p.map((r) => r.map(([x, y]) => [x + 1 / 512, y - 1 / 512] as [number, number])));
        next.push(polygonClipping.union(a, jitter(b)));
      }
    }
    level = next;
  }
  return level[0] ?? [];
}

/**
 * Offsets (buffers) a closed path by `distance` px: positive grows, negative shrinks.
 * Implemented as a Minkowski-style union of edge quads and round joins.
 */
export function offsetPath(d: string, distance: number, opts: { segments?: number } = {}): string {
  const base = pathToPolygons(d);
  if (!base.length || !distance) return polygonsToPath(base);
  const r = Math.abs(distance);
  const pieces: Polygon[] = [];
  for (const poly of base)
    for (const ring of poly) {
      for (let i = 0; i < ring.length - 1; i++) {
        const a = ring[i]!;
        const b = ring[i + 1]!;
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const L = Math.hypot(dx, dy) || 1;
        const nx = (-dy / L) * r;
        const ny = (dx / L) * r;
        pieces.push([[[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny], [a[0] + nx, a[1] + ny]]]);
        pieces.push(circlePoly([a[0], a[1]], r, opts.segments ?? 16));
      }
    }
  const band = unionMany(pieces);
  const res = distance > 0 ? polygonClipping.union(base, band) : polygonClipping.difference(base, band);
  return polygonsToPath(res);
}

/** Outline of a stroke as a fillable path (stroke-to-path). */
export function strokeToPath(d: string, width: number): string {
  const subs = flattenPath(parsePath(d), 0.25);
  const r = width / 2;
  const pieces: Polygon[] = [];
  for (const s of subs) {
    const pts = s.closed ? [...s.points, s.points[0]!] : s.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const L = Math.hypot(dx, dy) || 1;
      const nx = (-dy / L) * r;
      const ny = (dx / L) * r;
      pieces.push([[[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny], [a[0] + nx, a[1] + ny]]]);
      pieces.push(circlePoly(a, r, 12));
    }
    if (pts.length) pieces.push(circlePoly(pts[pts.length - 1]!, r, 12));
  }
  if (!pieces.length) return '';
  return polygonsToPath(unionMany(pieces));
}
