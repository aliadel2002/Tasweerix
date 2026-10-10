/**
 * HDR helpers: half-float bit conversion, the extended sRGB curve the compositor works in, and the
 * PQ (SMPTE ST 2084) and HLG (ARIB STD-B67) transfer functions used to write HDR video.
 *
 * Scale: a working value of 1.0 is SDR reference white, shown at {@link HDR_REFERENCE_WHITE} nits
 * (ITU-R BT.2408). Values above 1 are brighter highlights.
 */

import { gamutMatrix, type Gamut } from './icc';

/** Nits of SDR reference white (graphics white) in HDR output, per ITU-R BT.2408. */
export const HDR_REFERENCE_WHITE = 203;

export type HdrTransfer = 'pq' | 'hlg';

let halfTable: Float32Array | undefined;

/** Lookup table from IEEE half-float bits to float. */
export function halfToFloatTable(): Float32Array {
  if (halfTable) return halfTable;
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const m = h & 0x3ff;
    t[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
  }
  return (halfTable = t);
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** Float → IEEE half-float bits (round to nearest even). */
export function floatToHalf(v: number): number {
  f32[0] = v;
  const x = u32[0]!;
  const sign = (x >> 16) & 0x8000;
  const exp = (x >> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  let e = exp - 127 + 15;
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let h = mant >> shift;
    const rem = mant & ((1 << shift) - 1);
    const half = 1 << (shift - 1);
    if (rem > half || (rem === half && h & 1)) h++;
    return sign | h;
  }
  let h = (e << 10) | (mant >> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && h & 1)) h++;
  return sign | h;
}

/** sRGB curve extended past 0..1: mirrored for negatives (wide-gamut colors), continued above 1. */
export function extendedSrgbToLinear(v: number): number {
  const a = Math.abs(v);
  const l = a <= 0.04045 ? a / 12.92 : Math.pow((a + 0.055) / 1.055, 2.4);
  return v < 0 ? -l : l;
}

export function extendedLinearToSrgb(v: number): number {
  const a = Math.abs(v);
  const e = a <= 0.0031308 ? a * 12.92 : 1.055 * Math.pow(a, 1 / 2.4) - 0.055;
  return v < 0 ? -e : e;
}

const PQ = { m1: 2610 / 16384, m2: (2523 / 4096) * 128, c1: 3424 / 4096, c2: (2413 / 4096) * 32, c3: (2392 / 4096) * 32 };

/** PQ inverse EOTF: absolute luminance (nits, 0..10000) → signal 0..1. */
export function pqEncode(nits: number): number {
  const y = Math.min(1, Math.max(0, nits / 10000));
  const p = Math.pow(y, PQ.m1);
  return Math.pow((PQ.c1 + PQ.c2 * p) / (1 + PQ.c3 * p), PQ.m2);
}

/** PQ EOTF: signal 0..1 → nits. */
export function pqDecode(signal: number): number {
  const p = Math.pow(Math.min(1, Math.max(0, signal)), 1 / PQ.m2);
  return 10000 * Math.pow(Math.max(0, p - PQ.c1) / (PQ.c2 - PQ.c3 * p), 1 / PQ.m1);
}

const HLG = { a: 0.17883277, b: 0.28466892, c: 0.55991073 };
/** Scene light at which HLG puts reference white (75% signal, ITU-R BT.2408). */
const HLG_WHITE = 0.26496256;

/** HLG OETF: normalized scene light 0..1 → signal 0..1. */
export function hlgEncode(e: number): number {
  e = Math.min(1, Math.max(0, e));
  return e <= 1 / 12 ? Math.sqrt(3 * e) : HLG.a * Math.log(12 * e - HLG.b) + HLG.c;
}

export function hlgDecode(signal: number): number {
  signal = Math.min(1, Math.max(0, signal));
  return signal <= 0.5 ? (signal * signal) / 3 : (Math.exp((signal - HLG.c) / HLG.a) + HLG.b) / 12;
}

/**
 * Encodes composited frames for HDR video: half-float RGBA in extended sRGB (1.0 = reference white)
 * → BT.2020 primaries → PQ or HLG signal as 16-bit RGBA. Alpha is copied.
 */
export function encodeHdrFrame(half: Uint16Array, transfer: HdrTransfer, from: Gamut = 'srgb'): Uint16Array {
  const ht = halfToFloatTable();
  const m = gamutMatrix(from, 'rec2020');
  // Linear (1 = reference white) → signal, through a table indexed by the 4th root (fine near black, reaches 49x white for PQ's 10000 nits).
  const N = 8192;
  const maxLin = transfer === 'pq' ? 10000 / HDR_REFERENCE_WHITE : 1 / HLG_WHITE;
  const table = new Uint16Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const l = (i / N) ** 4 * maxLin;
    table[i] = Math.round((transfer === 'pq' ? pqEncode(l * HDR_REFERENCE_WHITE) : hlgEncode(l * HLG_WHITE)) * 65535);
  }
  const enc = (l: number) => {
    if (!(l > 0)) return 0;
    if (l >= maxLin) return 65535;
    const p = Math.sqrt(Math.sqrt(l / maxLin)) * N;
    const i = Math.min(N - 1, p | 0);
    return Math.round(table[i]! + (table[i + 1]! - table[i]!) * (p - i));
  };
  const out = new Uint16Array(half.length);
  for (let i = 0; i < half.length; i += 4) {
    const r = extendedSrgbToLinear(ht[half[i]!]!), g = extendedSrgbToLinear(ht[half[i + 1]!]!), b = extendedSrgbToLinear(ht[half[i + 2]!]!);
    out[i] = enc(m[0] * r + m[1] * g + m[2] * b);
    out[i + 1] = enc(m[3] * r + m[4] * g + m[5] * b);
    out[i + 2] = enc(m[6] * r + m[7] * g + m[8] * b);
    out[i + 3] = Math.round(Math.min(1, Math.max(0, ht[half[i + 3]!]!)) * 65535);
  }
  return out;
}

/**
 * Decodes HDR or linear float pixels (RGB planes or RGBA, linear light with 1 = reference white)
 * into extended sRGB half-float RGBA in the sRGB gamut (wide colors become negative components).
 */
export function linearToExtendedHalf(rgba: Float32Array, from: Gamut = 'srgb'): Uint16Array {
  const m = gamutMatrix(from, 'srgb');
  const out = new Uint16Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i]!, g = rgba[i + 1]!, b = rgba[i + 2]!;
    out[i] = floatToHalf(extendedLinearToSrgb(m[0] * r + m[1] * g + m[2] * b));
    out[i + 1] = floatToHalf(extendedLinearToSrgb(m[3] * r + m[4] * g + m[5] * b));
    out[i + 2] = floatToHalf(extendedLinearToSrgb(m[6] * r + m[7] * g + m[8] * b));
    out[i + 3] = floatToHalf(rgba[i + 3]!);
  }
  return out;
}

/**
 * Tone maps linear RGB (1 = reference white) into 0..1 for SDR, on the brightest channel so hue is
 * kept: below `knee` nothing changes, above it highlights roll off smoothly toward 1 (with slope 1
 * at the knee, so there is no visible seam).
 */
export function toneMapLinear(r: number, g: number, b: number, knee = 0.6): [number, number, number] {
  const m = Math.max(r, g, b);
  if (m <= knee) return [r, g, b];
  const t = knee + (1 - knee) * (1 - Math.exp(-(m - knee) / (1 - knee)));
  const k = t / m;
  return [r * k, g * k, b * k];
}

/**
 * HDR10 mastering display string for x265 / SVT-AV1: Display P3 (D65) primaries, as most HDR
 * monitors are, with the given peak and a 0.0001-nit black.
 */
export function masteringDisplay(peakNits = 1000): string {
  return `G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(${Math.round(peakNits * 10000)},1)`;
}
