/** In-place iterative radix-2 complex FFT. `re`/`im` length must be a power of two. */
export function fft(re: Float64Array | Float32Array, im: Float64Array | Float32Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a]! += tr;
        im[a]! += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) {
    re[i]! /= n;
    im[i]! /= n;
  }
}

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

const windows = new Map<string, Float64Array>();
export function hann(n: number): Float64Array {
  const key = `hann${n}`;
  let w = windows.get(key);
  if (!w) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    windows.set(key, w);
  }
  return w;
}

/** Magnitude spectrum (n/2 bins) of a windowed frame starting at `start`. */
export function magnitudeSpectrum(signal: Float32Array, start: number, n: number): Float64Array {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const w = hann(n);
  for (let i = 0; i < n; i++) re[i] = (signal[start + i] ?? 0) * w[i]!;
  fft(re, im);
  const out = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) out[i] = Math.hypot(re[i]!, im[i]!) / (n / 4);
  return out;
}

/** FFT-based convolution (overlap-add) of a signal with an impulse response. */
export function convolve(signal: Float32Array, ir: Float32Array, block = 8192): Float32Array {
  const out = new Float32Array(signal.length + ir.length - 1);
  const n = nextPow2(block + ir.length - 1);
  const irRe = new Float64Array(n);
  const irIm = new Float64Array(n);
  irRe.set(ir);
  fft(irRe, irIm);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let s = 0; s < signal.length; s += block) {
    re.fill(0);
    im.fill(0);
    const end = Math.min(signal.length, s + block);
    for (let i = s; i < end; i++) re[i - s] = signal[i]!;
    fft(re, im);
    for (let i = 0; i < n; i++) {
      const r = re[i]! * irRe[i]! - im[i]! * irIm[i]!;
      const m = re[i]! * irIm[i]! + im[i]! * irRe[i]!;
      re[i] = r;
      im[i] = m;
    }
    fft(re, im, true);
    const lim = Math.min(n, out.length - s);
    for (let i = 0; i < lim; i++) out[s + i]! += re[i]!;
  }
  return out;
}
