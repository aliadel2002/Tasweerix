import type { Vec2 } from '@tasweerix/core';

/** Signed area (positive = counter-clockwise in a y-up system). */
export function signedArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j]![0] - poly[i]![0]) * (poly[j]![1] + poly[i]![1]);
  return a / 2;
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Removes repeated and collinear points (they break ear clipping). */
export function cleanPolygon(poly: Vec2[], eps = 1e-9): Vec2[] {
  let pts = poly.filter((p, i) => {
    const q = poly[(i + poly.length - 1) % poly.length]!;
    return Math.abs(p[0] - q[0]) > eps || Math.abs(p[1] - q[1]) > eps;
  });
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length > 3; i++) {
      const a = pts[(i + pts.length - 1) % pts.length]!;
      const b = pts[i]!;
      const c = pts[(i + 1) % pts.length]!;
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(cross) < eps * 1e3) {
        pts.splice(i, 1);
        changed = true;
        i--;
      }
    }
  }
  return pts;
}

const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

function inTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  return cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
}

function segmentsIntersect(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): boolean {
  const d1 = cross(q1, q2, p1);
  const d2 = cross(q1, q2, p2);
  const d3 = cross(p1, p2, q1);
  const d4 = cross(p1, p2, q2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * Joins holes into an outer ring with zero-width bridges (as earcut does): each hole, rightmost
 * first, connects from its rightmost vertex to a visible vertex of the ring.
 * Outer must be counter-clockwise, holes clockwise. Returns indices into `all`.
 */
function bridgeHoles(outer: number[], holes: number[][], all: Vec2[]): number[] {
  let ring = outer.slice();
  const sorted = holes.map((h) => ({ h, maxX: Math.max(...h.map((i) => all[i]![0])) })).sort((a, b) => b.maxX - a.maxX);
  for (const { h } of sorted) {
    // Rightmost vertex of the hole.
    let hi = 0;
    for (let k = 1; k < h.length; k++) if (all[h[k]!]![0] > all[h[hi]!]![0]) hi = k;
    const m = all[h[hi]!]!;
    // Candidate ring vertices sorted by distance; pick the first whose bridge crosses no edge.
    const cands = ring.map((ri, k) => ({ k, d: (all[ri]![0] - m[0]) ** 2 + (all[ri]![1] - m[1]) ** 2, right: all[ri]![0] >= m[0] })).sort((a, b) => (a.right === b.right ? a.d - b.d : a.right ? -1 : 1));
    let chosen = -1;
    const edges: [Vec2, Vec2][] = [];
    for (let k = 0; k < ring.length; k++) edges.push([all[ring[k]!]!, all[ring[(k + 1) % ring.length]!]!]);
    for (const hole of holes) for (let k = 0; k < hole.length; k++) edges.push([all[hole[k]!]!, all[hole[(k + 1) % hole.length]!]!]);
    for (const c of cands) {
      const p = all[ring[c.k]!]!;
      if (!edges.some(([a, b]) => a !== p && b !== p && a !== m && b !== m && segmentsIntersect(m, p, a, b))) {
        chosen = c.k;
        break;
      }
    }
    if (chosen < 0) chosen = cands[0]!.k;
    const holeSeq = [...h.slice(hi), ...h.slice(0, hi), h[hi]!];
    ring = [...ring.slice(0, chosen + 1), ...holeSeq, ...ring.slice(chosen)];
  }
  return ring;
}

/**
 * Triangulates a polygon with holes by ear clipping. Returns triangles as index triples into the
 * concatenation [outer, ...holes]. Orientation of the inputs does not matter.
 */
export function triangulate(outer: Vec2[], holes: Vec2[][] = []): { points: Vec2[]; triangles: number[] } {
  const o = signedArea(outer) < 0 ? outer.slice().reverse() : outer.slice();
  const hs = holes.map((h) => (signedArea(h) > 0 ? h.slice().reverse() : h.slice()));
  const all: Vec2[] = [...o, ...hs.flat()];
  let off = o.length;
  const holeIdx = hs.map((h) => {
    const idx = h.map((_, i) => off + i);
    off += h.length;
    return idx;
  });
  let ring = bridgeHoles(o.map((_, i) => i), holeIdx, all);
  const tris: number[] = [];
  let guard = 0;
  while (ring.length > 3 && guard++ < 100000) {
    let clipped = false;
    for (let i = 0; i < ring.length; i++) {
      const ia = ring[(i + ring.length - 1) % ring.length]!;
      const ib = ring[i]!;
      const ic = ring[(i + 1) % ring.length]!;
      const a = all[ia]!;
      const b = all[ib]!;
      const c = all[ic]!;
      if (cross(a, b, c) <= 1e-12) continue; // reflex or degenerate
      let ear = true;
      for (const j of ring) {
        if (j === ia || j === ib || j === ic) continue;
        const p = all[j]!;
        // Bridge duplicates share coordinates with ear corners: ignore exact matches.
        if ((p[0] === a[0] && p[1] === a[1]) || (p[0] === b[0] && p[1] === b[1]) || (p[0] === c[0] && p[1] === c[1])) continue;
        if (inTriangle(p, a, b, c)) {
          ear = false;
          break;
        }
      }
      if (!ear) continue;
      tris.push(ia, ib, ic);
      ring.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // Numerical trouble (self-touching input): drop the flattest vertex and continue.
      let best = 0;
      let bestArea = Infinity;
      for (let i = 0; i < ring.length; i++) {
        const ar = Math.abs(cross(all[ring[(i + ring.length - 1) % ring.length]!]!, all[ring[i]!]!, all[ring[(i + 1) % ring.length]!]!));
        if (ar < bestArea) {
          bestArea = ar;
          best = i;
        }
      }
      ring = ring.filter((_, i) => i !== best);
    }
  }
  if (ring.length === 3 && cross(all[ring[0]!]!, all[ring[1]!]!, all[ring[2]!]!) > 0) tris.push(ring[0]!, ring[1]!, ring[2]!);
  return { points: all, triangles: tris };
}

/**
 * Groups closed outlines into shapes (outer ring + holes) by nesting depth: even depth = outer,
 * odd depth = hole of the smallest enclosing outer. Works for any winding convention.
 */
export function groupShapes(rings: Vec2[][]): { outer: Vec2[]; holes: Vec2[][] }[] {
  const items = rings.filter((r) => r.length >= 3 && Math.abs(signedArea(r)) > 1e-9).map((r) => ({ r, area: Math.abs(signedArea(r)) }));
  items.sort((a, b) => b.area - a.area);
  const depth: number[] = [];
  const parent: number[] = [];
  items.forEach((it, i) => {
    let p = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (pointInPolygon(it.r[0]!, items[j]!.r) && (p < 0 || items[j]!.area < items[p]!.area)) p = j;
    }
    parent.push(p);
    depth.push(p < 0 ? 0 : depth[p]! + 1);
  });
  const shapes = new Map<number, { outer: Vec2[]; holes: Vec2[][] }>();
  items.forEach((it, i) => {
    if (depth[i]! % 2 === 0) shapes.set(i, { outer: it.r, holes: [] });
  });
  items.forEach((it, i) => {
    if (depth[i]! % 2 === 1) shapes.get(parent[i]!)?.holes.push(it.r);
  });
  return [...shapes.values()];
}
