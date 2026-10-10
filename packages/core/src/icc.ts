/**
 * Wide-gamut color math: RGB gamuts, the sRGB transfer curve, and ICC matrix/TRC profiles (build
 * one to tag an output file, parse one to convert a source into the working gamut).
 */

import { linearToSrgb } from './color';

/** RGB color spaces the pipeline knows. All use the D65 white point and the sRGB transfer curve. */
export type Gamut = 'srgb' | 'display-p3' | 'rec2020';

/** Gamuts a browser canvas can composite in (Chromium has no Rec. 2020 canvas). */
export type CanvasGamut = 'srgb' | 'display-p3';

export type Mat3 = [number, number, number, number, number, number, number, number, number];

const PRIMARIES: Record<Gamut, [number, number, number, number, number, number]> = {
  srgb: [0.64, 0.33, 0.3, 0.6, 0.15, 0.06],
  'display-p3': [0.68, 0.32, 0.265, 0.69, 0.15, 0.06],
  rec2020: [0.708, 0.292, 0.17, 0.797, 0.131, 0.046],
};
const D65: [number, number] = [0.3127, 0.329];
/** ICC profile connection space white (D50), as the spec rounds it. */
const D50_XYZ: [number, number, number] = [0.9642, 1, 0.8249];
const BRADFORD: Mat3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];

export function mul3(a: Mat3, b: Mat3): Mat3 {
  const o = new Array(9).fill(0) as Mat3;
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      o[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
  return o;
}

export function inv3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h,
    B = -(d * i - f * g),
    C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det,
    -(b * i - c * h) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    -(a * f - c * d) / det,
    C / det,
    -(a * h - b * g) / det,
    (a * e - b * d) / det,
  ];
}

function xyToXYZ(x: number, y: number): [number, number, number] {
  return [x / y, 1, (1 - x - y) / y];
}

function apply3(m: Mat3, v: [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** Bradford chromatic adaptation from D65 to the ICC D50 white. */
export const D65_TO_D50: Mat3 = (() => {
  const src = apply3(BRADFORD, xyToXYZ(D65[0], D65[1]));
  const dst = apply3(BRADFORD, D50_XYZ);
  const scale: Mat3 = [dst[0] / src[0], 0, 0, 0, dst[1] / src[1], 0, 0, 0, dst[2] / src[2]];
  return mul3(inv3(BRADFORD), mul3(scale, BRADFORD));
})();

/** Linear RGB → XYZ (D65) for a gamut. */
export function rgbToXyz(g: Gamut): Mat3 {
  const p = PRIMARIES[g];
  const r = xyToXYZ(p[0], p[1]),
    gr = xyToXYZ(p[2], p[3]),
    b = xyToXYZ(p[4], p[5]);
  const m: Mat3 = [r[0], gr[0], b[0], r[1], gr[1], b[1], r[2], gr[2], b[2]];
  const s = apply3(inv3(m), xyToXYZ(D65[0], D65[1]));
  return [
    m[0] * s[0],
    m[1] * s[1],
    m[2] * s[2],
    m[3] * s[0],
    m[4] * s[1],
    m[5] * s[2],
    m[6] * s[0],
    m[7] * s[1],
    m[8] * s[2],
  ];
}

/** Linear RGB → D50-adapted XYZ, the colorant matrix an ICC profile stores. */
export function rgbToXyzD50(g: Gamut): Mat3 {
  return mul3(D65_TO_D50, rgbToXyz(g));
}

/** Linear-light matrix converting RGB in one gamut to another. */
export function gamutMatrix(from: Gamut, to: Gamut): Mat3 {
  return mul3(inv3(rgbToXyz(to)), rgbToXyz(from));
}

// ---------------------------------------------------------------- ICC build

const GAMUT_NAMES: Record<Gamut, string> = {
  srgb: 'sRGB',
  'display-p3': 'Display P3',
  rec2020: 'Rec. 2020 (sRGB transfer)',
};

function s15(v: number): number {
  return Math.round(v * 65536) | 0;
}

/**
 * Builds a small ICC v4 display profile (matrix + sRGB parametric curve) for a gamut, for tagging
 * PNG, JPEG, TIFF and WebP output. Deterministic: fixed date and no profile ID.
 */
export function buildIcc(g: Gamut): Uint8Array {
  const text = (s: string) => {
    const b = new Uint8Array(28 + s.length * 2);
    const v = new DataView(b.buffer);
    b.set([0x6d, 0x6c, 0x75, 0x63]); // 'mluc'
    v.setUint32(8, 1);
    v.setUint32(12, 12);
    b.set([0x65, 0x6e, 0x55, 0x53], 16); // en US
    v.setUint32(20, s.length * 2);
    v.setUint32(24, 28);
    for (let i = 0; i < s.length; i++) v.setUint16(28 + i * 2, s.charCodeAt(i));
    return b;
  };
  const xyz = (x: number, y: number, z: number) => {
    const b = new Uint8Array(20);
    const v = new DataView(b.buffer);
    b.set([0x58, 0x59, 0x5a, 0x20]);
    v.setInt32(8, s15(x));
    v.setInt32(12, s15(y));
    v.setInt32(16, s15(z));
    return b;
  };
  const m = rgbToXyzD50(g);
  const chad = new Uint8Array(44);
  chad.set([0x73, 0x66, 0x33, 0x32]); // 'sf32'
  D65_TO_D50.forEach((c, i) => new DataView(chad.buffer).setInt32(8 + i * 4, s15(c)));
  const para = new Uint8Array(32);
  para.set([0x70, 0x61, 0x72, 0x61]); // 'para'
  const pv = new DataView(para.buffer);
  pv.setUint16(8, 3);
  [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045].forEach((c, i) => pv.setInt32(12 + i * 4, s15(c)));

  const tags: [string, Uint8Array][] = [
    ['desc', text(GAMUT_NAMES[g])],
    ['cprt', text('No copyright, use freely')],
    ['wtpt', xyz(...D50_XYZ)],
    ['chad', chad],
    ['rXYZ', xyz(m[0], m[3], m[6])],
    ['gXYZ', xyz(m[1], m[4], m[7])],
    ['bXYZ', xyz(m[2], m[5], m[8])],
    ['rTRC', para],
    ['gTRC', para],
    ['bTRC', para],
  ];
  const tableEnd = 128 + 4 + tags.length * 12;
  // Shared data (the three TRCs) is stored once.
  const offsets = new Map<Uint8Array, number>();
  let size = tableEnd;
  for (const [, d] of tags) {
    if (offsets.has(d)) continue;
    offsets.set(d, size);
    size += (d.length + 3) & ~3;
  }
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  const ascii = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
  };
  v.setUint32(0, size);
  v.setUint32(8, 0x04300000);
  ascii(12, 'mntr');
  ascii(16, 'RGB ');
  ascii(20, 'XYZ ');
  [2026, 1, 1, 0, 0, 0].forEach((n, i) => v.setUint16(24 + i * 2, n));
  ascii(36, 'acsp');
  v.setInt32(68, s15(D50_XYZ[0]));
  v.setInt32(72, s15(D50_XYZ[1]));
  v.setInt32(76, s15(D50_XYZ[2]));
  v.setUint32(128, tags.length);
  tags.forEach(([sig, d], i) => {
    ascii(132 + i * 12, sig);
    v.setUint32(136 + i * 12, offsets.get(d)!);
    v.setUint32(140 + i * 12, d.length);
  });
  for (const [d, o] of offsets) out.set(d, o);
  return out;
}

// ---------------------------------------------------------------- ICC parse

/** A parsed matrix/TRC profile: per-channel decode curves and the colorant matrix (to D50 XYZ). */
export interface IccProfile {
  /** RGB profiles: linear RGB → D50 XYZ. Absent for gray profiles. */
  matrix?: Mat3;
  /** Decode curves (encoded 0..1 → linear), one for gray. */
  curves: ((x: number) => number)[];
  description?: string;
}

/**
 * Parses an RGB or gray matrix/TRC ICC profile (v2 or v4), which covers sRGB, Display P3, Adobe
 * RGB, ProPhoto and Rec. 2020 profiles. Returns undefined for LUT-based profiles and non-display
 * color spaces (CMYK, Lab), which need a full color management module.
 */
export function parseIcc(bytes: Uint8Array): IccProfile | undefined {
  if (bytes.length < 132) return undefined;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (o: number, n = 4) => String.fromCharCode(...bytes.subarray(o, o + n));
  const space = str(16);
  if (str(36) !== 'acsp' || (space !== 'RGB ' && space !== 'GRAY')) return undefined;
  const tags = new Map<string, [number, number]>();
  const n = v.getUint32(128);
  for (let i = 0; i < n && 144 + i * 12 <= bytes.length; i++)
    tags.set(str(132 + i * 12), [v.getUint32(136 + i * 12), v.getUint32(140 + i * 12)]);
  const fx = (o: number) => v.getInt32(o) / 65536;
  const curve = (sig: string): ((x: number) => number) | undefined => {
    const t = tags.get(sig);
    if (!t || t[0] + 12 > bytes.length) return undefined;
    const o = t[0];
    const type = str(o);
    if (type === 'curv') {
      const count = v.getUint32(o + 8);
      if (count === 0) return (x) => x;
      if (count === 1) {
        const g = v.getUint16(o + 12) / 256;
        return (x) => (x <= 0 ? 0 : Math.pow(x, g));
      }
      const table = new Float32Array(count);
      for (let i = 0; i < count; i++) table[i] = v.getUint16(o + 12 + i * 2) / 65535;
      return (x) => {
        const p = Math.min(1, Math.max(0, x)) * (count - 1);
        const i = Math.min(count - 2, Math.floor(p));
        return table[i]! + (table[i + 1]! - table[i]!) * (p - i);
      };
    }
    if (type === 'para') {
      const fn = v.getUint16(o + 8);
      const k = [0, 1, 2, 3, 4, 5, 6].map((i) =>
        o + 12 + i * 4 + 4 <= bytes.length ? fx(o + 12 + i * 4) : 0,
      );
      const [g, a, b, c, d, e, f] = k as [number, number, number, number, number, number, number];
      const pw = (x: number) => (x <= 0 ? 0 : Math.pow(x, g));
      switch (fn) {
        case 0:
          return (x) => pw(x);
        case 1:
          return (x) => (x >= -b / a ? pw(a * x + b) : 0);
        case 2:
          return (x) => (x >= -b / a ? pw(a * x + b) + c : c);
        case 3:
          return (x) => (x >= d ? pw(a * x + b) : c * x);
        case 4:
          return (x) => (x >= d ? pw(a * x + b) + e : c * x + f);
      }
    }
    return undefined;
  };
  const xyz = (sig: string): [number, number, number] | undefined => {
    const t = tags.get(sig);
    if (!t || t[0] + 20 > bytes.length || str(t[0]) !== 'XYZ ') return undefined;
    return [fx(t[0] + 8), fx(t[0] + 12), fx(t[0] + 16)];
  };
  let description: string | undefined;
  const d = tags.get('desc');
  if (d && d[0] + 12 <= bytes.length) {
    if (str(d[0]) === 'desc')
      description = str(
        d[0] + 12,
        Math.max(0, Math.min(v.getUint32(d[0] + 8) - 1, bytes.length - d[0] - 12)),
      );
    else if (str(d[0]) === 'mluc' && d[0] + 28 <= bytes.length) {
      const len = v.getUint32(d[0] + 20),
        off = d[0] + v.getUint32(d[0] + 24);
      description = Array.from({ length: Math.floor(len / 2) }, (_, i) =>
        off + i * 2 + 2 <= bytes.length ? String.fromCharCode(v.getUint16(off + i * 2)) : '',
      ).join('');
    }
  }
  if (space === 'GRAY') {
    const k = curve('kTRC');
    return k ? { curves: [k], description } : undefined;
  }
  const r = xyz('rXYZ'),
    g = xyz('gXYZ'),
    b = xyz('bXYZ');
  const rc = curve('rTRC'),
    gc = curve('gTRC'),
    bc = curve('bTRC');
  if (!r || !g || !b || !rc || !gc || !bc) return undefined;
  return {
    matrix: [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]],
    curves: [rc, gc, bc],
    description,
  };
}

/**
 * Converts straight 16-bit RGBA pixels in place from an ICC profile to a gamut (sRGB transfer).
 * Out-of-gamut colors clip at 0 and 65535; alpha is untouched.
 */
export function convertRGBA16(px: Uint16Array, profile: IccProfile, to: Gamut): void {
  let dec = decodeTables.get(profile);
  if (!dec) {
    dec = profile.curves.map((c) => {
      const t = new Float32Array(65536);
      for (let i = 0; i < 65536; i++) t[i] = c(i / 65535);
      return t;
    });
    decodeTables.set(profile, dec);
  }
  // Linear light is steep near black, so the encode table is indexed by its square root.
  if (!encodeTable) {
    encodeTable = new Uint16Array(16385);
    for (let i = 0; i <= 16384; i++)
      encodeTable[i] = Math.round(Math.min(1, linearToSrgb((i / 16384) ** 2)) * 65535);
  }
  const enc = encodeTable;
  const encode = (l: number) => {
    if (l <= 0) return 0;
    if (l >= 1) return 65535;
    const p = Math.sqrt(l) * 16384;
    const i = Math.min(16383, p | 0);
    return Math.round(enc[i]! + (enc[i + 1]! - enc[i]!) * (p - i));
  };
  if (!profile.matrix) {
    // Gray: the curve maps to linear luminance; re-encode with the sRGB curve on all channels.
    const t = dec[0]!;
    for (let i = 0; i < px.length; i += 4) {
      const y = encode(t[px[i]!]!);
      px[i] = px[i + 1] = px[i + 2] = y;
    }
    return;
  }
  const m = mul3(inv3(rgbToXyzD50(to)), profile.matrix);
  const [dr, dg, db] = dec as [Float32Array, Float32Array, Float32Array];
  for (let i = 0; i < px.length; i += 4) {
    const r = dr[px[i]!]!,
      g = dg[px[i + 1]!]!,
      b = db[px[i + 2]!]!;
    px[i] = encode(m[0] * r + m[1] * g + m[2] * b);
    px[i + 1] = encode(m[3] * r + m[4] * g + m[5] * b);
    px[i + 2] = encode(m[6] * r + m[7] * g + m[8] * b);
  }
}

const decodeTables = new WeakMap<IccProfile, Float32Array[]>();
let encodeTable: Uint16Array | undefined;
const gamutProfiles = new Map<Gamut, IccProfile>();

/** The parsed profile of a built-in gamut (cached). */
export function gamutProfile(g: Gamut): IccProfile {
  let p = gamutProfiles.get(g);
  if (!p) gamutProfiles.set(g, (p = parseIcc(buildIcc(g))!));
  return p;
}

/**
 * Converts straight RGBA pixels (8- or 16-bit, sRGB transfer) from one gamut to another in place.
 * Colors outside the target clip; alpha is untouched.
 */
export function convertGamut(px: Uint8Array | Uint16Array, from: Gamut, to: Gamut): void {
  if (from === to) return;
  const profile = gamutProfile(from);
  if (px instanceof Uint16Array) {
    convertRGBA16(px, profile, to);
    return;
  }
  const wide = new Uint16Array(px.length);
  for (let i = 0; i < px.length; i++) wide[i] = px[i]! * 257;
  convertRGBA16(wide, profile, to);
  for (let i = 0; i < px.length; i++) if ((i & 3) !== 3) px[i] = Math.round(wide[i]! / 257);
}
