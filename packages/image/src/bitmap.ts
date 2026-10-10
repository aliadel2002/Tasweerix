/** Straight-alpha float RGBA image (0..1, sRGB-encoded). */
export interface Bitmap {
  width: number;
  height: number;
  data: Float32Array;
}

/** Single-channel coverage mask (0..1). */
export interface Mask {
  width: number;
  height: number;
  data: Float32Array;
}

export function createBitmap(width: number, height: number, fill?: [number, number, number, number]): Bitmap {
  const data = new Float32Array(width * height * 4);
  if (fill) for (let i = 0; i < width * height; i++) data.set(fill, i * 4);
  return { width, height, data };
}

export function createMask(width: number, height: number, value = 0): Mask {
  const data = new Float32Array(width * height);
  if (value) data.fill(value);
  return { width, height, data };
}

export function fromRGBA8(data: Uint8ClampedArray | Uint8Array, width: number, height: number): Bitmap {
  const out = new Float32Array(width * height * 4);
  for (let i = 0; i < out.length; i++) out[i] = data[i]! / 255;
  return { width, height, data: out };
}

/**
 * Converts to 8-bit RGBA. Color channels get deterministic triangular (TPDF) dither of ±1 LSB by
 * default, which hides banding in smooth gradients; exact 0 and 1 and the alpha channel stay exact.
 */
export function toRGBA8(b: Bitmap, opts: { dither?: boolean } = {}): Uint8ClampedArray {
  const dither = opts.dither ?? true;
  const out = new Uint8ClampedArray(b.width * b.height * 4);
  for (let i = 0; i < out.length; i++) {
    const v = Math.min(1, Math.max(0, b.data[i]!));
    const noise = dither && (i & 3) !== 3 && v > 0 && v < 1 ? (hash32(i) - hash32(i ^ 0x9e3779b9)) / 4294967296 : 0;
    out[i] = Math.round(v * 255 + noise);
  }
  return out;
}

/** Integer hash (lowbias32) → 0..2^32-1. */
function hash32(n: number): number {
  n ^= n >>> 16;
  n = Math.imul(n, 0x7feb352d);
  n ^= n >>> 15;
  n = Math.imul(n, 0x846ca68b);
  n ^= n >>> 16;
  return n >>> 0;
}

export function cloneBitmap(b: Bitmap): Bitmap {
  return { width: b.width, height: b.height, data: new Float32Array(b.data) };
}

/** Bilinear sample with edge clamping (returns straight RGBA). */
export function sample(b: Bitmap, x: number, y: number, out: number[] = [0, 0, 0, 0]): number[] {
  const { width: w, height: h, data } = b;
  x = Math.min(Math.max(x - 0.5, 0), w - 1);
  y = Math.min(Math.max(y - 0.5, 0), h - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0;
  const fy = y - y0;
  for (let c = 0; c < 4; c++) {
    const a = data[(y0 * w + x0) * 4 + c]!;
    const bb = data[(y0 * w + x1) * 4 + c]!;
    const cc = data[(y1 * w + x0) * 4 + c]!;
    const d = data[(y1 * w + x1) * 4 + c]!;
    out[c] = (a * (1 - fx) + bb * fx) * (1 - fy) + (cc * (1 - fx) + d * fx) * fy;
  }
  return out;
}

export const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 1e-9) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const hh = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  const [r, g, b] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m];
}

/** Applies fn per pixel, blended through an optional mask. */
export function mapPixels(b: Bitmap, fn: (r: number, g: number, bl: number, a: number, x: number, y: number) => [number, number, number, number?], mask?: Mask): Bitmap {
  const out = cloneBitmap(b);
  const d = out.data;
  for (let y = 0; y < b.height; y++)
    for (let x = 0; x < b.width; x++) {
      const i = (y * b.width + x) * 4;
      const m = mask ? mask.data[y * b.width + x]! : 1;
      if (m <= 0) continue;
      const r = fn(d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!, x, y);
      d[i] = d[i]! + (r[0] - d[i]!) * m;
      d[i + 1] = d[i + 1]! + (r[1] - d[i + 1]!) * m;
      d[i + 2] = d[i + 2]! + (r[2] - d[i + 2]!) * m;
      if (r[3] !== undefined) d[i + 3] = d[i + 3]! + (r[3] - d[i + 3]!) * m;
    }
  return out;
}
