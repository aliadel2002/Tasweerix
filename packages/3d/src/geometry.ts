import { flattenPath, parsePath, type PathData, type Vec2 } from '@tasweerix/core';
import { v3, type Vec3 } from './math3d';
import { cleanPolygon, groupShapes, triangulate } from './triangulate';

/** Indexed triangle mesh data. */
export interface Geometry {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  /** Optional per-vertex colors (RGBA 0–1). */
  colors?: Float32Array;
}

class Builder {
  p: number[] = [];
  n: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  vertex(p: Vec3, n: Vec3, uv: Vec2): number {
    this.p.push(p[0], p[1], p[2]);
    this.n.push(n[0], n[1], n[2]);
    this.uv.push(uv[0], uv[1]);
    return this.p.length / 3 - 1;
  }
  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }
  build(): Geometry {
    return { positions: new Float32Array(this.p), normals: new Float32Array(this.n), uvs: new Float32Array(this.uv), indices: new Uint32Array(this.idx) };
  }
}

/** Axis-aligned box centered on the origin. */
export function boxGeometry(w = 1, h = 1, d = 1): Geometry {
  const b = new Builder();
  const faces: { n: Vec3; u: Vec3; v: Vec3 }[] = [
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
  ];
  const half: Vec3 = [w / 2, h / 2, d / 2];
  for (const f of faces) {
    const corner = (su: number, sv: number): Vec3 => [0, 1, 2].map((k) => (f.n[k]! + f.u[k]! * su + f.v[k]! * sv) * half[k]!) as Vec3;
    const a = b.vertex(corner(-1, -1), f.n, [0, 1]);
    const c = b.vertex(corner(1, -1), f.n, [1, 1]);
    const e = b.vertex(corner(1, 1), f.n, [1, 0]);
    const g = b.vertex(corner(-1, 1), f.n, [0, 0]);
    b.tri(a, c, e);
    b.tri(a, e, g);
  }
  return b.build();
}

/** Plane in the XY plane facing +Z. */
export function planeGeometry(w = 1, h = 1, segments = 1): Geometry {
  const b = new Builder();
  const n = Math.max(1, segments);
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) b.vertex([(i / n - 0.5) * w, (0.5 - j / n) * h, 0], [0, 0, 1], [i / n, j / n]);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      b.tri(a, a + n + 1, a + 1);
      b.tri(a + 1, a + n + 1, a + n + 2);
    }
  }
  return b.build();
}

export function sphereGeometry(r = 0.5, widthSegments = 48, heightSegments = 24): Geometry {
  const b = new Builder();
  for (let j = 0; j <= heightSegments; j++) {
    const v = j / heightSegments;
    const phi = v * Math.PI;
    for (let i = 0; i <= widthSegments; i++) {
      const u = i / widthSegments;
      const th = u * Math.PI * 2;
      const n: Vec3 = [-Math.cos(th) * Math.sin(phi), Math.cos(phi), Math.sin(th) * Math.sin(phi)];
      b.vertex(v3.scale(n, r), n, [u, v]);
    }
  }
  for (let j = 0; j < heightSegments; j++) {
    for (let i = 0; i < widthSegments; i++) {
      const a = j * (widthSegments + 1) + i;
      const c = a + widthSegments + 1;
      if (j !== 0) b.tri(a, c, a + 1);
      if (j !== heightSegments - 1) b.tri(a + 1, c, c + 1);
    }
  }
  return b.build();
}

/** Cylinder (or cone when one radius is 0) along Y. */
export function cylinderGeometry(rTop = 0.5, rBottom = 0.5, height = 1, radialSegments = 48, caps = true): Geometry {
  const b = new Builder();
  const slope = (rBottom - rTop) / height;
  for (let j = 0; j <= 1; j++) {
    const y = height / 2 - j * height;
    const r = j === 0 ? rTop : rBottom;
    for (let i = 0; i <= radialSegments; i++) {
      const th = (i / radialSegments) * Math.PI * 2;
      const n = v3.normalize([Math.sin(th), slope, Math.cos(th)]);
      b.vertex([r * Math.sin(th), y, r * Math.cos(th)], n, [i / radialSegments, j]);
    }
  }
  for (let i = 0; i < radialSegments; i++) {
    const a = i;
    const c = i + radialSegments + 1;
    b.tri(a, c, a + 1);
    b.tri(a + 1, c, c + 1);
  }
  if (caps) {
    for (const top of [true, false]) {
      const r = top ? rTop : rBottom;
      if (r <= 0) continue;
      const y = top ? height / 2 : -height / 2;
      const n: Vec3 = [0, top ? 1 : -1, 0];
      const center = b.vertex([0, y, 0], n, [0.5, 0.5]);
      const start = b.p.length / 3;
      for (let i = 0; i <= radialSegments; i++) {
        const th = (i / radialSegments) * Math.PI * 2;
        b.vertex([r * Math.sin(th), y, r * Math.cos(th)], n, [0.5 + Math.sin(th) / 2, 0.5 - Math.cos(th) / 2]);
      }
      for (let i = 0; i < radialSegments; i++) (top ? b.tri(center, start + i, start + i + 1) : b.tri(center, start + i + 1, start + i));
    }
  }
  return b.build();
}

/** Torus in the XY plane (ring radius `radius`, tube radius `tube`). */
export function torusGeometry(radius = 0.5, tube = 0.2, radialSegments = 32, tubularSegments = 96): Geometry {
  const b = new Builder();
  for (let j = 0; j <= radialSegments; j++) {
    for (let i = 0; i <= tubularSegments; i++) {
      const u = (i / tubularSegments) * Math.PI * 2;
      const v = (j / radialSegments) * Math.PI * 2;
      const p: Vec3 = [(radius + tube * Math.cos(v)) * Math.cos(u), (radius + tube * Math.cos(v)) * Math.sin(u), tube * Math.sin(v)];
      const c: Vec3 = [radius * Math.cos(u), radius * Math.sin(u), 0];
      b.vertex(p, v3.normalize(v3.sub(p, c)), [i / tubularSegments, j / radialSegments]);
    }
  }
  for (let j = 1; j <= radialSegments; j++) {
    for (let i = 1; i <= tubularSegments; i++) {
      const a = (tubularSegments + 1) * j + i - 1;
      const bb = (tubularSegments + 1) * (j - 1) + i - 1;
      const c = (tubularSegments + 1) * (j - 1) + i;
      const d = (tubularSegments + 1) * j + i;
      b.tri(a, bb, d);
      b.tri(bb, c, d);
    }
  }
  return b.build();
}

export interface ExtrudeOptions {
  /** Depth along Z (centered on z = 0). */
  depth?: number;
  /** Curve flattening tolerance in path units. */
  tolerance?: number;
  /** Side edges sharper than this (degrees) get hard normals; smoother ones are shaded smooth. */
  smoothAngle?: number;
  /** Units per path unit (paths are usually in pixels: 0.01 turns 100 px into 1 unit). */
  scale?: number;
  /** Center the shape on the origin (default true). */
  center?: boolean;
}

/**
 * Extrudes SVG path data (or several paths) into a solid: front and back caps (holes supported,
 * fill rule by nesting) and side walls. Path coordinates are y-down like SVG; the result is y-up.
 */
export function extrudeGeometry(paths: string | PathData | (string | PathData)[], o: ExtrudeOptions = {}): Geometry {
  const list = Array.isArray(paths) && (paths.length === 0 || typeof paths[0] === 'string' || Array.isArray(paths[0])) ? (paths as (string | PathData)[]) : [paths as string | PathData];
  const k = o.scale ?? 1;
  const rings: Vec2[][] = [];
  for (const p of list) {
    const data = typeof p === 'string' ? parsePath(p) : p;
    for (const sub of flattenPath(data, o.tolerance ?? 0.25)) {
      const pts = cleanPolygon(sub.points.map(([x, y]) => [x * k, -y * k] as Vec2));
      if (pts.length >= 3) rings.push(pts);
    }
  }
  let cx = 0;
  let cy = 0;
  if (o.center !== false && rings.length) {
    const xs = rings.flat().map((p) => p[0]);
    const ys = rings.flat().map((p) => p[1]);
    cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  }
  const depth = o.depth ?? 0.2;
  const z0 = depth / 2;
  const cosSmooth = Math.cos(((o.smoothAngle ?? 35) * Math.PI) / 180);
  const b = new Builder();
  const bounds = rings.flat();
  const minX = Math.min(...bounds.map((p) => p[0]));
  const maxX = Math.max(...bounds.map((p) => p[0]));
  const minY = Math.min(...bounds.map((p) => p[1]));
  const maxY = Math.max(...bounds.map((p) => p[1]));
  const uvOf = (p: Vec2): Vec2 => [(p[0] - minX) / (maxX - minX || 1), 1 - (p[1] - minY) / (maxY - minY || 1)];
  for (const shape of groupShapes(rings)) {
    const { points, triangles } = triangulate(shape.outer, shape.holes);
    // Front (+Z) and back (−Z) caps.
    const front = points.map((p) => b.vertex([p[0] - cx, p[1] - cy, z0], [0, 0, 1], uvOf(p)));
    const back = points.map((p) => b.vertex([p[0] - cx, p[1] - cy, -z0], [0, 0, -1], uvOf(p)));
    for (let i = 0; i < triangles.length; i += 3) {
      b.tri(front[triangles[i]!]!, front[triangles[i + 1]!]!, front[triangles[i + 2]!]!);
      b.tri(back[triangles[i]!]!, back[triangles[i + 2]!]!, back[triangles[i + 1]!]!);
    }
    // Side walls: outer rings counter-clockwise, holes clockwise, so outward normals are (dy, −dx).
    const ccw = (r: Vec2[], want: boolean) => {
      let a = 0;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j]![0] - r[i]![0]) * (r[j]![1] + r[i]![1]);
      return a > 0 === want ? r : r.slice().reverse();
    };
    for (const ring of [ccw(shape.outer, true), ...shape.holes.map((h) => ccw(h, false))]) {
      const n = ring.length;
      const edgeN: Vec3[] = ring.map((p, i) => {
        const q = ring[(i + 1) % n]!;
        return v3.normalize([q[1] - p[1], -(q[0] - p[0]), 0]);
      });
      let along = 0;
      for (let i = 0; i < n; i++) {
        const p = ring[i]!;
        const q = ring[(i + 1) % n]!;
        const prevN = edgeN[(i + n - 1) % n]!;
        const nextN = edgeN[(i + 1) % n]!;
        const en = edgeN[i]!;
        // Smooth across gentle corners.
        const np = v3.dot(prevN, en) > cosSmooth ? v3.normalize(v3.add(prevN, en)) : en;
        const nq = v3.dot(nextN, en) > cosSmooth ? v3.normalize(v3.add(nextN, en)) : en;
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const a = b.vertex([p[0] - cx, p[1] - cy, z0], np, [along, 0]);
        const bb = b.vertex([q[0] - cx, q[1] - cy, z0], nq, [along + len, 0]);
        const c = b.vertex([q[0] - cx, q[1] - cy, -z0], nq, [along + len, 1]);
        const d = b.vertex([p[0] - cx, p[1] - cy, -z0], np, [along, 1]);
        b.tri(a, d, c);
        b.tri(a, c, bb);
        along += len;
      }
    }
  }
  return b.build();
}

/** Recomputes smooth vertex normals from faces. */
export function computeNormals(g: Pick<Geometry, 'positions' | 'indices'>): Float32Array {
  const n = new Float32Array(g.positions.length);
  const P = g.positions;
  for (let i = 0; i < g.indices.length; i += 3) {
    const a = g.indices[i]! * 3;
    const b = g.indices[i + 1]! * 3;
    const c = g.indices[i + 2]! * 3;
    const e1: Vec3 = [P[b]! - P[a]!, P[b + 1]! - P[a + 1]!, P[b + 2]! - P[a + 2]!];
    const e2: Vec3 = [P[c]! - P[a]!, P[c + 1]! - P[a + 1]!, P[c + 2]! - P[a + 2]!];
    const f = v3.cross(e1, e2);
    for (const k of [a, b, c]) {
      n[k] += f[0];
      n[k + 1] += f[1];
      n[k + 2] += f[2];
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!) || 1;
    n[i] /= l;
    n[i + 1] /= l;
    n[i + 2] /= l;
  }
  return n;
}

/** Axis-aligned bounds of a geometry. */
export function geometryBounds(g: Geometry): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < g.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, g.positions[i + k]!);
      max[k] = Math.max(max[k]!, g.positions[i + k]!);
    }
  }
  return { min, max };
}
