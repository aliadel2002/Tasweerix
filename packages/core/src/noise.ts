import { createRandom } from './random';

/** Seeded simplex noise in 1D/2D/3D plus fractal Brownian motion helpers. */
export interface Noise {
  noise1(x: number): number;
  noise2(x: number, y: number): number;
  noise3(x: number, y: number, z: number): number;
  fbm2(x: number, y: number, octaves?: number, lacunarity?: number, gain?: number): number;
  fbm3(x: number, y: number, z: number, octaves?: number, lacunarity?: number, gain?: number): number;
  /** Curl of 2D noise field, useful for flow fields/particles. */
  curl2(x: number, y: number, eps?: number): [number, number];
}

const GRAD3 = [
  [1, 1, 0],
  [-1, 1, 0],
  [1, -1, 0],
  [-1, -1, 0],
  [1, 0, 1],
  [-1, 0, 1],
  [1, 0, -1],
  [-1, 0, -1],
  [0, 1, 1],
  [0, -1, 1],
  [0, 1, -1],
  [0, -1, -1],
] as const;

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const F3 = 1 / 3;
const G3 = 1 / 6;

const noiseCache = new Map<string, Noise>();

export function createNoise(seed: number | string = 0): Noise {
  const key = String(seed);
  const hit = noiseCache.get(key);
  if (hit) return hit;
  const rnd = createRandom(`noise:${seed}`);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [p[i], p[j]] = [p[j]!, p[i]!];
  }
  const perm = new Uint8Array(512);
  const permMod12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255]!;
    permMod12[i] = perm[i]! % 12;
  }

  function noise2(xin: number, yin: number): number {
    let n0 = 0,
      n1 = 0,
      n2 = 0;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) {
      const g = GRAD3[permMod12[ii + perm[jj]!]!]!;
      t0 *= t0;
      n0 = t0 * t0 * (g[0] * x0 + g[1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) {
      const g = GRAD3[permMod12[ii + i1 + perm[jj + j1]!]!]!;
      t1 *= t1;
      n1 = t1 * t1 * (g[0] * x1 + g[1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) {
      const g = GRAD3[permMod12[ii + 1 + perm[jj + 1]!]!]!;
      t2 *= t2;
      n2 = t2 * t2 * (g[0] * x2 + g[1] * y2);
    }
    return 70 * (n0 + n1 + n2);
  }

  function noise3(xin: number, yin: number, zin: number): number {
    let n0 = 0,
      n1 = 0,
      n2 = 0,
      n3 = 0;
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const z0 = zin - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) [i1, j1, k1, i2, j2, k2] = [1, 0, 0, 1, 1, 0];
      else if (x0 >= z0) [i1, j1, k1, i2, j2, k2] = [1, 0, 0, 1, 0, 1];
      else [i1, j1, k1, i2, j2, k2] = [0, 0, 1, 1, 0, 1];
    } else {
      if (y0 < z0) [i1, j1, k1, i2, j2, k2] = [0, 0, 1, 0, 1, 1];
      else if (x0 < z0) [i1, j1, k1, i2, j2, k2] = [0, 1, 0, 0, 1, 1];
      else [i1, j1, k1, i2, j2, k2] = [0, 1, 0, 1, 1, 0];
    }
    const x1 = x0 - i1 + G3,
      y1 = y0 - j1 + G3,
      z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3,
      y2 = y0 - j2 + 2 * G3,
      z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3,
      y3 = y0 - 1 + 3 * G3,
      z3 = z0 - 1 + 3 * G3;
    const ii = i & 255,
      jj = j & 255,
      kk = k & 255;
    const contrib = (tt: number, gi: number, x: number, y: number, z: number) => {
      if (tt < 0) return 0;
      const g = GRAD3[gi]!;
      tt *= tt;
      return tt * tt * (g[0] * x + g[1] * y + g[2] * z);
    };
    n0 = contrib(0.6 - x0 * x0 - y0 * y0 - z0 * z0, permMod12[ii + perm[jj + perm[kk]!]!]!, x0, y0, z0);
    n1 = contrib(
      0.6 - x1 * x1 - y1 * y1 - z1 * z1,
      permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]!]!]!,
      x1,
      y1,
      z1,
    );
    n2 = contrib(
      0.6 - x2 * x2 - y2 * y2 - z2 * z2,
      permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]!]!]!,
      x2,
      y2,
      z2,
    );
    n3 = contrib(
      0.6 - x3 * x3 - y3 * y3 - z3 * z3,
      permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]!]!]!,
      x3,
      y3,
      z3,
    );
    return 32 * (n0 + n1 + n2 + n3);
  }

  const n: Noise = {
    noise1: (x) => noise2(x, 0.5),
    noise2,
    noise3,
    fbm2(x, y, octaves = 4, lac = 2, gain = 0.5) {
      let amp = 1,
        freq = 1,
        sum = 0,
        norm = 0;
      for (let o = 0; o < octaves; o++) {
        sum += amp * noise2(x * freq, y * freq);
        norm += amp;
        amp *= gain;
        freq *= lac;
      }
      return sum / norm;
    },
    fbm3(x, y, z, octaves = 4, lac = 2, gain = 0.5) {
      let amp = 1,
        freq = 1,
        sum = 0,
        norm = 0;
      for (let o = 0; o < octaves; o++) {
        sum += amp * noise3(x * freq, y * freq, z * freq);
        norm += amp;
        amp *= gain;
        freq *= lac;
      }
      return sum / norm;
    },
    curl2(x, y, eps = 1e-3) {
      const dx = (noise2(x + eps, y) - noise2(x - eps, y)) / (2 * eps);
      const dy = (noise2(x, y + eps) - noise2(x, y - eps)) / (2 * eps);
      return [dy, -dx];
    },
  };
  noiseCache.set(key, n);
  return n;
}
