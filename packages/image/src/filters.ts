import { cloneBitmap, createBitmap, luma, type Bitmap, type Mask } from './bitmap';

/** Separable gaussian blur on a float buffer with `channels` interleaved channels. */
export function blurBuffer(src: Float32Array, w: number, h: number, channels: number, sigma: number): Float32Array {
  if (sigma <= 0.01) return new Float32Array(src);
  const r = Math.ceil(sigma * 3);
  const k = new Float32Array(r * 2 + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp((-0.5 * i * i) / (sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i]! /= sum;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < channels; c++) {
        let acc = 0;
        for (let i = -r; i <= r; i++) {
          const xx = Math.min(w - 1, Math.max(0, x + i));
          acc += src[(y * w + xx) * channels + c]! * k[i + r]!;
        }
        tmp[(y * w + x) * channels + c] = acc;
      }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < channels; c++) {
        let acc = 0;
        for (let i = -r; i <= r; i++) {
          const yy = Math.min(h - 1, Math.max(0, y + i));
          acc += tmp[(yy * w + x) * channels + c]! * k[i + r]!;
        }
        out[(y * w + x) * channels + c] = acc;
      }
  return out;
}

/** Gaussian blur with premultiplied alpha. */
export function blur(b: Bitmap, radius: number, mask?: Mask): Bitmap {
  const pm = new Float32Array(b.data);
  for (let i = 0; i < pm.length; i += 4) for (let c = 0; c < 3; c++) pm[i + c]! *= pm[i + 3]!;
  const bl = blurBuffer(pm, b.width, b.height, 4, radius / 2);
  for (let i = 0; i < bl.length; i += 4) {
    const a = bl[i + 3]!;
    for (let c = 0; c < 3; c++) bl[i + c] = a > 1e-6 ? bl[i + c]! / a : 0;
  }
  const out = { width: b.width, height: b.height, data: bl };
  return mask ? blendMask(b, out, mask) : out;
}

/** Unsharp mask: original + amount × (original − blurred) above threshold. */
export function unsharp(b: Bitmap, p: { radius?: number; amount?: number; threshold?: number } = {}, mask?: Mask): Bitmap {
  const bl = blur(b, p.radius ?? 2);
  const out = cloneBitmap(b);
  const amt = p.amount ?? 0.8;
  const thr = p.threshold ?? 0;
  for (let i = 0; i < out.data.length; i += 4)
    for (let c = 0; c < 3; c++) {
      const d = b.data[i + c]! - bl.data[i + c]!;
      if (Math.abs(d) >= thr) out.data[i + c] = Math.max(0, b.data[i + c]! + d * amt);
    }
  return mask ? blendMask(b, out, mask) : out;
}

/** Clarity: midtone local-contrast boost (large-radius unsharp weighted to midtones). */
export function clarity(b: Bitmap, amount = 0.3, mask?: Mask): Bitmap {
  const radius = Math.max(8, Math.min(b.width, b.height) / 40);
  const bl = blur(b, radius);
  const out = cloneBitmap(b);
  for (let i = 0; i < out.data.length; i += 4) {
    const l = luma(b.data[i]!, b.data[i + 1]!, b.data[i + 2]!);
    const mid = 1 - Math.pow(2 * Math.min(1, l) - 1, 2);
    for (let c = 0; c < 3; c++) out.data[i + c] = Math.max(0, b.data[i + c]! + (b.data[i + c]! - bl.data[i + c]!) * amount * mid * 1.5);
  }
  return mask ? blendMask(b, out, mask) : out;
}

/** Dehaze using a simplified dark-channel prior. */
export function dehaze(b: Bitmap, amount = 0.5): Bitmap {
  const { width: w, height: h, data } = b;
  const dark = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) dark[i] = Math.min(data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!);
  const r = Math.max(2, Math.round(Math.min(w, h) / 100));
  // min filter (separable)
  const minFilter = (src: Float32Array, horizontal: boolean) => {
    const out = new Float32Array(src.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let m = 1;
        for (let k = -r; k <= r; k++) {
          const xx = horizontal ? Math.min(w - 1, Math.max(0, x + k)) : x;
          const yy = horizontal ? y : Math.min(h - 1, Math.max(0, y + k));
          m = Math.min(m, src[yy * w + xx]!);
        }
        out[y * w + x] = m;
      }
    return out;
  };
  const dc = minFilter(minFilter(dark, true), false);
  // Atmospheric light: brightest 0.1% of dark channel.
  const idx = Array.from(dc.keys()).sort((a, c) => dc[c]! - dc[a]!).slice(0, Math.max(1, Math.floor(w * h * 0.001)));
  const A = [0, 0, 0];
  for (const i of idx) for (let c = 0; c < 3; c++) A[c]! += data[i * 4 + c]! / idx.length;
  const t = blurBuffer(dc.map((v) => 1 - amount * 0.95 * v), w, h, 1, r);
  const out = cloneBitmap(b);
  for (let i = 0; i < w * h; i++) {
    const tt = Math.max(0.1, t[i]!);
    for (let c = 0; c < 3; c++) out.data[i * 4 + c] = Math.max(0, (data[i * 4 + c]! - A[c]!) / tt + A[c]!);
  }
  return out;
}

/** Edge-preserving bilateral denoise. */
export function denoise(b: Bitmap, p: { strength?: number; radius?: number } = {}, mask?: Mask): Bitmap {
  const { width: w, height: h, data } = b;
  const r = p.radius ?? 3;
  const sigmaS = r / 2;
  const sigmaR = 0.05 + (p.strength ?? 0.5) * 0.2;
  const out = cloneBitmap(b);
  const spatial = new Float32Array((2 * r + 1) ** 2);
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) spatial[(dy + r) * (2 * r + 1) + dx + r] = Math.exp(-(dx * dx + dy * dy) / (2 * sigmaS * sigmaS));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const c0 = [data[i]!, data[i + 1]!, data[i + 2]!];
      let ws = 0;
      const acc = [0, 0, 0];
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const j = (yy * w + xx) * 4;
          const dr = data[j]! - c0[0]!;
          const dg = data[j + 1]! - c0[1]!;
          const db = data[j + 2]! - c0[2]!;
          const wt = spatial[(dy + r) * (2 * r + 1) + dx + r]! * Math.exp(-(dr * dr + dg * dg + db * db) / (2 * sigmaR * sigmaR));
          ws += wt;
          acc[0]! += data[j]! * wt;
          acc[1]! += data[j + 1]! * wt;
          acc[2]! += data[j + 2]! * wt;
        }
      }
      out.data[i] = acc[0]! / ws;
      out.data[i + 1] = acc[1]! / ws;
      out.data[i + 2] = acc[2]! / ws;
    }
  return mask ? blendMask(b, out, mask) : out;
}

/** Median filter (salt-and-pepper / dust removal). */
export function median(b: Bitmap, radius = 1, mask?: Mask): Bitmap {
  const { width: w, height: h, data } = b;
  const out = cloneBitmap(b);
  const vals: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        vals.length = 0;
        for (let dy = -radius; dy <= radius; dy++)
          for (let dx = -radius; dx <= radius; dx++) {
            const xx = Math.min(w - 1, Math.max(0, x + dx));
            const yy = Math.min(h - 1, Math.max(0, y + dy));
            vals.push(data[(yy * w + xx) * 4 + c]!);
          }
        vals.sort((a, z) => a - z);
        out.data[(y * w + x) * 4 + c] = vals[vals.length >> 1]!;
      }
  return mask ? blendMask(b, out, mask) : out;
}

/** Blends `edited` over `orig` through mask coverage. */
export function blendMask(orig: Bitmap, edited: Bitmap, mask: Mask): Bitmap {
  const out = createBitmap(orig.width, orig.height);
  for (let p = 0; p < orig.width * orig.height; p++) {
    const m = mask.data[p]!;
    for (let c = 0; c < 4; c++) out.data[p * 4 + c] = orig.data[p * 4 + c]! + (edited.data[p * 4 + c]! - orig.data[p * 4 + c]!) * m;
  }
  return out;
}
