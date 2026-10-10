/** A single-channel float image (0–255 range), row-major. */
export interface Gray {
  width: number;
  height: number;
  data: Float32Array;
}

export function gray(width: number, height: number, data?: ArrayLike<number>): Gray {
  const d = new Float32Array(width * height);
  if (data) for (let i = 0; i < d.length; i++) d[i] = data[i]!;
  return { width, height, data: d };
}

/** Separable 5-tap binomial blur (1 4 6 4 1)/16 with clamped edges. */
export function blur(img: Gray): Gray {
  const { width: w, height: h, data } = img;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - 2);
      const x1 = Math.max(0, x - 1);
      const x3 = Math.min(w - 1, x + 1);
      const x4 = Math.min(w - 1, x + 2);
      tmp[row + x] = (data[row + x0]! + 4 * data[row + x1]! + 6 * data[row + x]! + 4 * data[row + x3]! + data[row + x4]!) / 16;
    }
  }
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - 2) * w;
    const y1 = Math.max(0, y - 1) * w;
    const y2 = y * w;
    const y3 = Math.min(h - 1, y + 1) * w;
    const y4 = Math.min(h - 1, y + 2) * w;
    for (let x = 0; x < w; x++) out[y2 + x] = (tmp[y0 + x]! + 4 * tmp[y1 + x]! + 6 * tmp[y2 + x]! + 4 * tmp[y3 + x]! + tmp[y4 + x]!) / 16;
  }
  return { width: w, height: h, data: out };
}

/** Half-resolution image (blurred, then every second pixel). */
export function downsample(img: Gray): Gray {
  const b = blur(img);
  const w = Math.max(1, Math.floor(img.width / 2));
  const h = Math.max(1, Math.floor(img.height / 2));
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = b.data[y * 2 * img.width + x * 2]!;
  return { width: w, height: h, data: out };
}

/** Gaussian pyramid: level 0 is the image itself. Stops when a level gets smaller than 16 px. */
export function pyramid(img: Gray, levels: number): Gray[] {
  const out = [img];
  while (out.length < levels) {
    const last = out[out.length - 1]!;
    if (last.width < 32 || last.height < 32) break;
    out.push(downsample(last));
  }
  return out;
}

/** Bilinear sample with clamped coordinates. */
export function sample(img: Gray, x: number, y: number): number {
  const { width: w, height: h, data } = img;
  if (x < 0) x = 0;
  else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0;
  else if (y > h - 1) y = h - 1;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = data[y0 * w + x0]!;
  const b = data[y0 * w + x1]!;
  const c = data[y1 * w + x0]!;
  const d = data[y1 * w + x1]!;
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Scharr gradients (normalized to intensity units per pixel). */
export function gradients(img: Gray): { gx: Gray; gy: Gray } {
  const { width: w, height: h, data } = img;
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const at = (x: number, y: number) => data[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]!;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tl = at(x - 1, y - 1);
      const t = at(x, y - 1);
      const tr = at(x + 1, y - 1);
      const l = at(x - 1, y);
      const r = at(x + 1, y);
      const bl = at(x - 1, y + 1);
      const b = at(x, y + 1);
      const br = at(x + 1, y + 1);
      gx[y * w + x] = (3 * (tr - tl) + 10 * (r - l) + 3 * (br - bl)) / 32;
      gy[y * w + x] = (3 * (bl - tl) + 10 * (b - t) + 3 * (br - tr)) / 32;
    }
  }
  return { gx: { width: w, height: h, data: gx }, gy: { width: w, height: h, data: gy } };
}

/**
 * Bilinear samples of a (2r+1)² window centered at (cx, cy) into `out` (row-major). All samples
 * share one fractional offset, so the weights are computed once; borders fall back to clamping.
 */
export function samplePatch(img: Gray, cx: number, cy: number, r: number, out: Float32Array): void {
  const { width: w, height: h, data } = img;
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const fx = cx - x0;
  const fy = cy - y0;
  if (x0 - r < 0 || y0 - r < 0 || x0 + r + 1 > w - 1 || y0 + r + 1 > h - 1) {
    let i = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) out[i++] = sample(img, cx + dx, cy + dy);
    return;
  }
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  let i = 0;
  for (let dy = -r; dy <= r; dy++) {
    let k = (y0 + dy) * w + x0 - r;
    for (let dx = -r; dx <= r; dx++, k++) out[i++] = data[k]! * w00 + data[k + 1]! * w10 + data[k + w]! * w01 + data[k + w + 1]! * w11;
  }
}
