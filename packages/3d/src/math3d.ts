import type { Vec3 } from '@tasweerix/core';

export type { Vec3 };
/** Column-major 4×4 matrix (WebGL layout). */
export type Mat4 = Float32Array;

export const v3 = {
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k],
  dot: (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a: Vec3): number => Math.hypot(a[0], a[1], a[2]),
  normalize(a: Vec3): Vec3 {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
};

export const mat4 = {
  identity(): Mat4 {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  },
  multiply(a: Mat4, b: Mat4): Mat4 {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!;
      }
    }
    return o;
  },
  translation(t: Vec3): Mat4 {
    const m = mat4.identity();
    m[12] = t[0];
    m[13] = t[1];
    m[14] = t[2];
    return m;
  },
  /** Translation · rotation (Euler XYZ in degrees, as in three.js) · scale. */
  compose(t: Vec3, rotDeg: Vec3, s: Vec3): Mat4 {
    const [x, y, z] = rotDeg.map((d) => (d * Math.PI) / 180) as Vec3;
    const a = Math.cos(x);
    const b = Math.sin(x);
    const c = Math.cos(y);
    const d = Math.sin(y);
    const e = Math.cos(z);
    const f = Math.sin(z);
    const ae = a * e;
    const af = a * f;
    const be = b * e;
    const bf = b * f;
    const m = new Float32Array(16);
    m[0] = c * e * s[0];
    m[4] = -c * f * s[1];
    m[8] = d * s[2];
    m[1] = (af + be * d) * s[0];
    m[5] = (ae - bf * d) * s[1];
    m[9] = -b * c * s[2];
    m[2] = (bf - ae * d) * s[0];
    m[6] = (be + af * d) * s[1];
    m[10] = a * c * s[2];
    m[12] = t[0];
    m[13] = t[1];
    m[14] = t[2];
    m[15] = 1;
    return m;
  },
  /** From a translation, a unit quaternion [x, y, z, w] and a scale (glTF nodes). */
  fromQuat(t: Vec3, q: [number, number, number, number], s: Vec3): Mat4 {
    const [x, y, z, w] = q;
    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const xy = x * y2;
    const xz = x * z2;
    const yy = y * y2;
    const yz = y * z2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;
    const m = new Float32Array(16);
    m[0] = (1 - (yy + zz)) * s[0];
    m[1] = (xy + wz) * s[0];
    m[2] = (xz - wy) * s[0];
    m[4] = (xy - wz) * s[1];
    m[5] = (1 - (xx + zz)) * s[1];
    m[6] = (yz + wx) * s[1];
    m[8] = (xz + wy) * s[2];
    m[9] = (yz - wx) * s[2];
    m[10] = (1 - (xx + yy)) * s[2];
    m[12] = t[0];
    m[13] = t[1];
    m[14] = t[2];
    m[15] = 1;
    return m;
  },
  perspective(fovYDeg: number, aspect: number, near: number, far: number): Mat4 {
    const f = 1 / Math.tan((fovYDeg * Math.PI) / 360);
    const m = new Float32Array(16);
    m[0] = f / aspect;
    m[5] = f;
    m[10] = (far + near) / (near - far);
    m[11] = -1;
    m[14] = (2 * far * near) / (near - far);
    return m;
  },
  ortho(left: number, right: number, bottom: number, top: number, near: number, far: number): Mat4 {
    const m = new Float32Array(16);
    m[0] = 2 / (right - left);
    m[5] = 2 / (top - bottom);
    m[10] = -2 / (far - near);
    m[12] = -(right + left) / (right - left);
    m[13] = -(top + bottom) / (top - bottom);
    m[14] = -(far + near) / (far - near);
    m[15] = 1;
    return m;
  },
  lookAt(eye: Vec3, target: Vec3, up: Vec3 = [0, 1, 0]): Mat4 {
    let z = v3.sub(eye, target);
    if (v3.len(z) < 1e-9) z = [0, 0, 1];
    z = v3.normalize(z);
    let x = v3.cross(up, z);
    if (v3.len(x) < 1e-9) x = v3.cross([0, 0, 1], z);
    x = v3.normalize(x);
    const y = v3.cross(z, x);
    const m = new Float32Array(16);
    m[0] = x[0];
    m[4] = x[1];
    m[8] = x[2];
    m[1] = y[0];
    m[5] = y[1];
    m[9] = y[2];
    m[2] = z[0];
    m[6] = z[1];
    m[10] = z[2];
    m[12] = -v3.dot(x, eye);
    m[13] = -v3.dot(y, eye);
    m[14] = -v3.dot(z, eye);
    m[15] = 1;
    return m;
  },
  invert(m: Mat4): Mat4 {
    const o = new Float32Array(16);
    const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m as unknown as number[];
    const b00 = a00! * a11! - a01! * a10!;
    const b01 = a00! * a12! - a02! * a10!;
    const b02 = a00! * a13! - a03! * a10!;
    const b03 = a01! * a12! - a02! * a11!;
    const b04 = a01! * a13! - a03! * a11!;
    const b05 = a02! * a13! - a03! * a12!;
    const b06 = a20! * a31! - a21! * a30!;
    const b07 = a20! * a32! - a22! * a30!;
    const b08 = a20! * a33! - a23! * a30!;
    const b09 = a21! * a32! - a22! * a31!;
    const b10 = a21! * a33! - a23! * a31!;
    const b11 = a22! * a33! - a23! * a32!;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return mat4.identity();
    det = 1 / det;
    o[0] = (a11! * b11 - a12! * b10 + a13! * b09) * det;
    o[1] = (a02! * b10 - a01! * b11 - a03! * b09) * det;
    o[2] = (a31! * b05 - a32! * b04 + a33! * b03) * det;
    o[3] = (a22! * b04 - a21! * b05 - a23! * b03) * det;
    o[4] = (a12! * b08 - a10! * b11 - a13! * b07) * det;
    o[5] = (a00! * b11 - a02! * b08 + a03! * b07) * det;
    o[6] = (a32! * b02 - a30! * b05 - a33! * b01) * det;
    o[7] = (a20! * b05 - a22! * b02 + a23! * b01) * det;
    o[8] = (a10! * b10 - a11! * b08 + a13! * b06) * det;
    o[9] = (a01! * b08 - a00! * b10 - a03! * b06) * det;
    o[10] = (a30! * b04 - a31! * b02 + a33! * b00) * det;
    o[11] = (a21! * b02 - a20! * b04 - a23! * b00) * det;
    o[12] = (a11! * b07 - a10! * b09 - a12! * b06) * det;
    o[13] = (a00! * b09 - a01! * b07 + a02! * b06) * det;
    o[14] = (a31! * b01 - a30! * b03 - a32! * b00) * det;
    o[15] = (a20! * b03 - a21! * b01 + a22! * b00) * det;
    return o;
  },
  /** Inverse-transpose of the upper 3×3 (for normals), as a 3×3 column-major array. */
  normalMatrix(m: Mat4): Float32Array {
    const inv = mat4.invert(m);
    return new Float32Array([inv[0]!, inv[4]!, inv[8]!, inv[1]!, inv[5]!, inv[9]!, inv[2]!, inv[6]!, inv[10]!]);
  },
  transformPoint(m: Mat4, p: Vec3): Vec3 {
    const w = m[3]! * p[0] + m[7]! * p[1] + m[11]! * p[2] + m[15]!;
    return [(m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!) / w, (m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!) / w, (m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!) / w];
  },
  transformDir(m: Mat4, d: Vec3): Vec3 {
    return [m[0]! * d[0] + m[4]! * d[1] + m[8]! * d[2], m[1]! * d[0] + m[5]! * d[1] + m[9]! * d[2], m[2]! * d[0] + m[6]! * d[1] + m[10]! * d[2]];
  },
};
