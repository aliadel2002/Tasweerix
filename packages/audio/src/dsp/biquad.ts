import type { AudioProcessor } from './processor';

export type BiquadType = 'lowpass' | 'highpass' | 'bandpass' | 'notch' | 'peaking' | 'lowshelf' | 'highshelf' | 'allpass';

export interface BiquadCoefs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** RBJ Audio-EQ-Cookbook coefficients. */
export function biquadCoefs(type: BiquadType, freq: number, q: number, gainDb: number, sampleRate: number): BiquadCoefs {
  const f = Math.min(Math.max(freq, 1), sampleRate * 0.499);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const Q = Math.max(q, 1e-4);
  const alpha = sin / (2 * Q);
  const A = Math.pow(10, gainDb / 40);
  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
  switch (type) {
    case 'lowpass':
      b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case 'highpass':
      b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case 'bandpass':
      b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case 'notch':
      b0 = 1; b1 = -2 * cos; b2 = 1; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case 'allpass':
      b0 = 1 - alpha; b1 = -2 * cos; b2 = 1 + alpha; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case 'peaking':
      b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
      break;
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cos + s); b1 = 2 * A * (A - 1 - (A + 1) * cos); b2 = A * (A + 1 - (A - 1) * cos - s);
      a0 = A + 1 + (A - 1) * cos + s; a1 = -2 * (A - 1 + (A + 1) * cos); a2 = A + 1 + (A - 1) * cos - s;
      break;
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cos + s); b1 = -2 * A * (A - 1 + (A + 1) * cos); b2 = A * (A + 1 + (A - 1) * cos - s);
      a0 = A + 1 - (A - 1) * cos + s; a1 = 2 * (A - 1 - (A + 1) * cos); a2 = A + 1 - (A - 1) * cos - s;
      break;
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Magnitude response (dB) of coefficients at a frequency. */
export function biquadResponseDb(c: BiquadCoefs, freq: number, sampleRate: number): number {
  const w = (2 * Math.PI * freq) / sampleRate;
  const cr = (k: number) => Math.cos(k * w);
  const ci = (k: number) => -Math.sin(k * w);
  const nr = c.b0 + c.b1 * cr(1) + c.b2 * cr(2);
  const ni = c.b1 * ci(1) + c.b2 * ci(2);
  const dr = 1 + c.a1 * cr(1) + c.a2 * cr(2);
  const di = c.a1 * ci(1) + c.a2 * ci(2);
  return 20 * Math.log10(Math.hypot(nr, ni) / Math.hypot(dr, di));
}

/** Transposed direct form II biquad with per-channel state. */
export class Biquad {
  private z1: Float64Array;
  private z2: Float64Array;
  c: BiquadCoefs = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
  private key = '';
  constructor(channels: number, private sampleRate: number) {
    this.z1 = new Float64Array(channels);
    this.z2 = new Float64Array(channels);
  }
  set(type: BiquadType, freq: number, q: number, gain = 0): void {
    const k = `${type}|${freq}|${q}|${gain}`;
    if (k === this.key) return;
    this.key = k;
    this.c = biquadCoefs(type, freq, q, gain, this.sampleRate);
  }
  processChannel(ch: number, buf: Float32Array, offset: number, n: number): void {
    const { b0, b1, b2, a1, a2 } = this.c;
    let z1 = this.z1[ch]!;
    let z2 = this.z2[ch]!;
    for (let i = offset; i < offset + n; i++) {
      const x = buf[i]!;
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      buf[i] = y;
    }
    this.z1[ch] = Math.abs(z1) < 1e-30 ? 0 : z1;
    this.z2[ch] = Math.abs(z2) < 1e-30 ? 0 : z2;
  }
}

/** Single filter processor (`filter`, `lowpass`, `highpass` …). */
export function filterProcessor(sampleRate: number, channels: number, fixedType?: BiquadType): AudioProcessor {
  const bq = new Biquad(channels, sampleRate);
  return {
    process(chs, off, n, p) {
      bq.set(fixedType ?? p.type ?? 'lowpass', p.frequency ?? 1000, p.q ?? Math.SQRT1_2, p.gain ?? 0);
      // Steeper slopes: cascade (12 dB/oct per stage).
      const stages = Math.max(1, Math.round((p.slope ?? 12) / 12));
      chs.forEach((c, i) => {
        for (let s = 0; s < stages; s++) bq.processChannel(i, c, off, n);
      });
    },
  };
}

export interface EqBand {
  type?: BiquadType;
  frequency: number;
  gain?: number;
  q?: number;
}

/** Multi-band parametric EQ. */
export function eqProcessor(sampleRate: number, channels: number): AudioProcessor {
  let filters: Biquad[] = [];
  return {
    process(chs, off, n, p) {
      const bands = (p.bands ?? []) as EqBand[];
      while (filters.length < bands.length) filters.push(new Biquad(channels, sampleRate));
      filters = filters.slice(0, bands.length);
      bands.forEach((b, i) => filters[i]!.set(b.type ?? 'peaking', b.frequency, b.q ?? 1, b.gain ?? 0));
      chs.forEach((c, ci) => filters.forEach((f) => f.processChannel(ci, c, off, n)));
    },
  };
}
