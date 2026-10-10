import type { Geometry } from './geometry';
import type { AnimationChannel, Model, ModelPart, Quat } from './loaders';
import { mat4, type Mat4, type Vec3 } from './math3d';

/** Index of a clip by name or index (-1 when the model has no such clip). */
export function clipIndex(model: Model, animation: string | number | null | undefined): number {
  const clips = model.animations ?? [];
  if (animation === null || animation === undefined || !clips.length) return -1;
  if (typeof animation === 'number') return animation >= 0 && animation < clips.length ? Math.floor(animation) : -1;
  return clips.findIndex((c) => c.name === animation);
}

/** True when a model needs posing every frame (animations, skins or morph targets). */
export function isPosable(model: Model): boolean {
  return !!model.animations?.length || model.parts.some((p) => p.skin !== undefined || p.morph);
}

export interface ModelPose {
  /** World matrix of every node inside the model. */
  worlds: Mat4[];
  /** Morph weights per node (animated or default). */
  weights: (number[] | undefined)[];
}

function findKey(times: Float32Array, t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

function slerp(a: number[], b: number[], t: number): number[] {
  let [bx, by, bz, bw] = b as [number, number, number, number];
  let cos = a[0]! * bx + a[1]! * by + a[2]! * bz + a[3]! * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let k0 = 1 - t;
  let k1 = t;
  if (cos < 0.9995) {
    const th = Math.acos(cos);
    const s = Math.sin(th);
    k0 = Math.sin((1 - t) * th) / s;
    k1 = Math.sin(t * th) / s;
  }
  return normalizeQ([a[0]! * k0 + bx * k1, a[1]! * k0 + by * k1, a[2]! * k0 + bz * k1, a[3]! * k0 + bw * k1]);
}

function normalizeQ(q: number[]): number[] {
  const l = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!) || 1;
  return q.map((x) => x / l);
}

/** Value of an animation channel at time `t` (seconds), `n` components per key. */
export function sampleChannel(ch: AnimationChannel, t: number, n: number): number[] {
  const { times, values } = ch;
  const cubic = ch.interpolation === 'CUBICSPLINE';
  // Cubic spline keys store [in-tangent, value, out-tangent].
  const val = (k: number, part = 1) => Array.from(values.subarray((cubic ? k * 3 + part : k) * n, (cubic ? k * 3 + part : k) * n + n));
  const last = times.length - 1;
  if (last < 0) return new Array(n).fill(0);
  if (t <= times[0]!) return val(0);
  if (t >= times[last]!) return val(last);
  const k = findKey(times, t);
  const dt = times[k + 1]! - times[k]!;
  const u = dt > 0 ? (t - times[k]!) / dt : 0;
  if (ch.interpolation === 'STEP') return val(k);
  if (cubic) {
    const p0 = val(k);
    const m0 = val(k, 2);
    const p1 = val(k + 1);
    const m1 = val(k + 1, 0);
    const u2 = u * u;
    const u3 = u2 * u;
    const out = p0.map((_, i) => (2 * u3 - 3 * u2 + 1) * p0[i]! + (u3 - 2 * u2 + u) * dt * m0[i]! + (-2 * u3 + 3 * u2) * p1[i]! + (u3 - u2) * dt * m1[i]!);
    return ch.path === 'rotation' ? normalizeQ(out) : out;
  }
  const a = val(k);
  const b = val(k + 1);
  if (ch.path === 'rotation') return slerp(a, b, u);
  return a.map((x, i) => x + (b[i]! - x) * u);
}

/**
 * Poses a model's node hierarchy: clip `clip` sampled at `time` seconds (clip -1 = rest pose).
 */
export function poseModel(model: Model, clip: number, time: number): ModelPose {
  const nodes = model.nodes ?? [];
  const trs = nodes.map((n) => ({ t: n.translation as number[], r: n.rotation as number[], s: n.scale as number[], animated: false }));
  const weights: (number[] | undefined)[] = nodes.map((n) => n.weights);
  const anim = model.animations?.[clip];
  if (anim) {
    for (const ch of anim.channels) {
      const node = trs[ch.node];
      if (!node) continue;
      if (ch.path === 'weights') {
        const n = ch.values.length / ch.times.length / (ch.interpolation === 'CUBICSPLINE' ? 3 : 1);
        weights[ch.node] = sampleChannel(ch, time, n);
        continue;
      }
      const v = sampleChannel(ch, time, ch.path === 'rotation' ? 4 : 3);
      if (ch.path === 'translation') node.t = v;
      else if (ch.path === 'rotation') node.r = v;
      else node.s = v;
      node.animated = true;
    }
  }
  const worlds: Mat4[] = new Array(nodes.length);
  const visit = (i: number, parent: Mat4) => {
    const n = nodes[i]!;
    const p = trs[i]!;
    const local = n.matrix && !p.animated ? n.matrix : mat4.fromQuat(p.t as Vec3, p.r as Quat, p.s as Vec3);
    worlds[i] = mat4.multiply(parent, local);
    for (const c of n.children) visit(c, worlds[i]!);
  };
  for (const r of model.roots ?? []) visit(r, mat4.identity());
  for (let i = 0; i < nodes.length; i++) worlds[i] ??= mat4.identity();
  return { worlds, weights };
}

/** Matrix placing a part in model space for a pose (skinned parts are already in model space). */
export function partMatrix(part: ModelPart, pose: ModelPose): Mat4 {
  if (part.skin !== undefined) return mat4.identity();
  return part.node !== undefined ? pose.worlds[part.node]! : part.matrix;
}

/** Morph weights of a part for a pose, with overrides by target name or index. */
export function partWeights(part: ModelPart, pose: ModelPose, overrides?: Record<string, number> | null): number[] {
  const m = part.morph!;
  const base = (part.node !== undefined ? pose.weights[part.node] : undefined) ?? m.weights;
  return m.positions.map((_, i) => {
    const o = overrides?.[m.names[i]!] ?? overrides?.[String(i)];
    return typeof o === 'number' ? o : (base[i] ?? 0);
  });
}

/**
 * Deformed geometry of a part: morph targets blended with `weights`, then skinned with the pose's
 * joint matrices (linear blend skinning).
 */
export function deformPart(model: Model, part: ModelPart, pose: ModelPose, weights: number[] | null): Geometry {
  const g = part.geometry;
  let positions = g.positions;
  let normals = g.normals;
  if (part.morph && weights?.some((w) => w !== 0)) {
    positions = Float32Array.from(positions);
    normals = Float32Array.from(normals);
    weights.forEach((w, t) => {
      if (!w) return;
      const dp = part.morph!.positions[t]!;
      for (let i = 0; i < positions.length; i++) positions[i]! += w * dp[i]!;
      const dn = part.morph!.normals[t];
      if (dn) for (let i = 0; i < normals.length; i++) normals[i]! += w * dn[i]!;
    });
  }
  const skin = part.skin !== undefined ? model.skins?.[part.skin] : undefined;
  if (skin && part.joints && part.weights) {
    const jm = skin.joints.map((j, i) => mat4.multiply(pose.worlds[j] ?? mat4.identity(), skin.inverseBind[i]!));
    const per = part.influences ?? 4;
    const count = positions.length / 3;
    const op = new Float32Array(positions.length);
    const on = new Float32Array(normals.length);
    const m = new Float32Array(16);
    for (let v = 0; v < count; v++) {
      m.fill(0);
      let total = 0;
      for (let k = 0; k < per; k++) {
        const w = part.weights[v * per + k]!;
        if (!w) continue;
        const j = jm[part.joints[v * per + k]!];
        if (!j) continue;
        total += w;
        for (let e = 0; e < 16; e++) m[e]! += w * j[e]!;
      }
      // Unweighted vertices stay in place; weights are renormalized (exporters round them).
      if (total <= 0) {
        m.fill(0);
        m[0] = m[5] = m[10] = m[15] = 1;
      } else if (Math.abs(total - 1) > 1e-6) for (let e = 0; e < 16; e++) m[e]! /= total;
      const x = positions[v * 3]!;
      const y = positions[v * 3 + 1]!;
      const z = positions[v * 3 + 2]!;
      op[v * 3] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
      op[v * 3 + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
      op[v * 3 + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
      // Normals by the blended linear part (exact for rotations and uniform scale).
      const nx = normals[v * 3]!;
      const ny = normals[v * 3 + 1]!;
      const nz = normals[v * 3 + 2]!;
      const tx = m[0]! * nx + m[4]! * ny + m[8]! * nz;
      const ty = m[1]! * nx + m[5]! * ny + m[9]! * nz;
      const tz = m[2]! * nx + m[6]! * ny + m[10]! * nz;
      const l = Math.hypot(tx, ty, tz) || 1;
      on[v * 3] = tx / l;
      on[v * 3 + 1] = ty / l;
      on[v * 3 + 2] = tz / l;
    }
    positions = op;
    normals = on;
  } else if (normals !== g.normals) {
    for (let i = 0; i < normals.length; i += 3) {
      const l = Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!) || 1;
      normals[i]! /= l;
      normals[i + 1]! /= l;
      normals[i + 2]! /= l;
    }
  }
  return { ...g, positions, normals };
}
