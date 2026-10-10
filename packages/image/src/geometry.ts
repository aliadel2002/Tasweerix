import { createBitmap, sample, type Bitmap } from './bitmap';

export function crop(b: Bitmap, x: number, y: number, width: number, height: number): Bitmap {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const out = createBitmap(w, h);
  const ox = Math.round(x);
  const oy = Math.round(y);
  for (let yy = 0; yy < h; yy++)
    for (let xx = 0; xx < w; xx++) {
      const sx = xx + ox;
      const sy = yy + oy;
      if (sx < 0 || sy < 0 || sx >= b.width || sy >= b.height) continue;
      const si = (sy * b.width + sx) * 4;
      out.data.set(b.data.subarray(si, si + 4), (yy * w + xx) * 4);
    }
  return out;
}

export function flip(b: Bitmap, axis: 'x' | 'y'): Bitmap {
  const out = createBitmap(b.width, b.height);
  for (let y = 0; y < b.height; y++)
    for (let x = 0; x < b.width; x++) {
      const sx = axis === 'x' ? b.width - 1 - x : x;
      const sy = axis === 'y' ? b.height - 1 - y : y;
      const si = (sy * b.width + sx) * 4;
      out.data.set(b.data.subarray(si, si + 4), (y * b.width + x) * 4);
    }
  return out;
}

/**
 * Rotates by degrees (clockwise). `expand` grows the canvas to fit; `autoCrop` crops to the largest
 * axis-aligned rectangle without transparent corners (for straightening horizons).
 */
export function rotate(b: Bitmap, degrees: number, opts: { expand?: boolean; autoCrop?: boolean; background?: [number, number, number, number] } = {}): Bitmap {
  const a = (degrees * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const exact90 = Math.abs(((degrees % 90) + 90) % 90) < 1e-9;
  let w = b.width;
  let h = b.height;
  if (opts.expand || exact90) {
    w = Math.round(Math.abs(b.width * cos) + Math.abs(b.height * sin));
    h = Math.round(Math.abs(b.width * sin) + Math.abs(b.height * cos));
  }
  if (opts.autoCrop && !exact90) {
    // Largest inscribed rectangle with the original aspect ratio.
    const ar = b.width / b.height;
    const s = Math.abs(sin);
    const c = Math.abs(cos);
    const hFit = Math.min(b.height / (c + s * ar), b.width / (ar * c + s));
    h = Math.floor(hFit);
    w = Math.floor(hFit * ar);
  }
  const out = createBitmap(w, h, opts.background);
  const cx = b.width / 2;
  const cy = b.height / 2;
  const px: number[] = [0, 0, 0, 0];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - w / 2;
      const dy = y + 0.5 - h / 2;
      const sx = cos * dx + sin * dy + cx;
      const sy = -sin * dx + cos * dy + cy;
      if (sx < 0 || sy < 0 || sx > b.width || sy > b.height) continue;
      sample(b, sx, sy, px);
      out.data.set(px, (y * w + x) * 4);
    }
  return out;
}

function lanczos(x: number, a = 3): number {
  if (x === 0) return 1;
  if (Math.abs(x) >= a) return 0;
  const px = Math.PI * x;
  return (a * Math.sin(px) * Math.sin(px / a)) / (px * px);
}

/** High-quality separable Lanczos-3 resize (premultiplied to avoid dark halos). */
export function resize(b: Bitmap, width: number, height: number): Bitmap {
  const W = Math.max(1, Math.round(width));
  const H = Math.max(1, Math.round(height));
  const pass = (src: Float32Array, sw: number, sh: number, dw: number, horizontal: boolean): Float32Array => {
    const dh = horizontal ? sh : sw;
    const outW = horizontal ? dw : sw;
    const outH = horizontal ? sh : dw;
    const srcLen = horizontal ? sw : sh;
    const out = new Float32Array(outW * outH * 4);
    const scale = dw / srcLen;
    const support = scale < 1 ? 3 / scale : 3;
    const filterScale = Math.min(1, scale);
    // precompute weights
    const weights: { start: number; w: Float32Array }[] = [];
    for (let i = 0; i < dw; i++) {
      const center = (i + 0.5) / scale;
      const start = Math.max(0, Math.floor(center - support));
      const end = Math.min(srcLen - 1, Math.ceil(center + support));
      const w = new Float32Array(end - start + 1);
      let sum = 0;
      for (let k = start; k <= end; k++) {
        const v = lanczos((k + 0.5 - center) * filterScale);
        w[k - start] = v;
        sum += v;
      }
      for (let k = 0; k < w.length; k++) w[k]! /= sum || 1;
      weights.push({ start, w });
    }
    for (let line = 0; line < dh; line++) {
      for (let i = 0; i < dw; i++) {
        const { start, w } = weights[i]!;
        let r = 0, g = 0, bb = 0, a = 0;
        for (let k = 0; k < w.length; k++) {
          const sIdx = horizontal ? (line * sw + start + k) * 4 : ((start + k) * sw + line) * 4;
          const wt = w[k]!;
          r += src[sIdx]! * wt;
          g += src[sIdx + 1]! * wt;
          bb += src[sIdx + 2]! * wt;
          a += src[sIdx + 3]! * wt;
        }
        const dIdx = horizontal ? (line * outW + i) * 4 : (i * outW + line) * 4;
        out[dIdx] = r;
        out[dIdx + 1] = g;
        out[dIdx + 2] = bb;
        out[dIdx + 3] = a;
      }
    }
    return out;
  };
  // premultiply
  const pm = new Float32Array(b.data);
  for (let i = 0; i < pm.length; i += 4) {
    pm[i]! *= pm[i + 3]!;
    pm[i + 1]! *= pm[i + 3]!;
    pm[i + 2]! *= pm[i + 3]!;
  }
  const h1 = pass(pm, b.width, b.height, W, true);
  const v = pass(h1, W, b.height, H, false);
  for (let i = 0; i < v.length; i += 4) {
    const a = Math.min(1, Math.max(0, v[i + 3]!));
    v[i + 3] = a;
    if (a > 1e-6) {
      v[i] = Math.max(0, v[i]! / a);
      v[i + 1] = Math.max(0, v[i + 1]! / a);
      v[i + 2] = Math.max(0, v[i + 2]! / a);
    } else v[i] = v[i + 1] = v[i + 2] = 0;
  }
  return { width: W, height: H, data: v };
}

/** Solves the 3x3 homography mapping 4 src points → 4 dst points. */
export function homography(src: [number, number][], dst: [number, number][]): number[] {
  const A: number[][] = [];
  const bv: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]!;
    const [u, v] = dst[i]!;
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    bv.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    bv.push(v);
  }
  // Gaussian elimination
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[p]![c]!)) p = r;
    [A[c], A[p]] = [A[p]!, A[c]!];
    [bv[c], bv[p]] = [bv[p]!, bv[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r]![c]! / A[c]![c]!;
      for (let k = c; k < n; k++) A[r]![k]! -= f * A[c]![k]!;
      bv[r]! -= f * bv[c]!;
    }
  }
  const h = bv.map((v, i) => v / A[i]![i]!);
  return [...h, 1];
}

/**
 * Perspective correction / corner pin: maps the quad `corners` (tl, tr, br, bl in source pixels)
 * to a rectangle of the given output size.
 */
export function perspective(b: Bitmap, corners: [number, number][], width?: number, height?: number): Bitmap {
  const W = Math.round(width ?? Math.max(dist(corners[0]!, corners[1]!), dist(corners[3]!, corners[2]!)));
  const H = Math.round(height ?? Math.max(dist(corners[0]!, corners[3]!), dist(corners[1]!, corners[2]!)));
  // Map output rect → source quad.
  const h = homography([[0, 0], [W, 0], [W, H], [0, H]], corners);
  const out = createBitmap(W, H);
  const px: number[] = [0, 0, 0, 0];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const X = x + 0.5;
      const Y = y + 0.5;
      const d = h[6]! * X + h[7]! * Y + h[8]!;
      const sx = (h[0]! * X + h[1]! * Y + h[2]!) / d;
      const sy = (h[3]! * X + h[4]! * Y + h[5]!) / d;
      if (sx < 0 || sy < 0 || sx > b.width || sy > b.height) continue;
      sample(b, sx, sy, px);
      out.data.set(px, (y * W + x) * 4);
    }
  return out;
}

const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
