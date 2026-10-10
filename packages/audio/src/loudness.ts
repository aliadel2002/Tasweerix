import type { AudioData } from './buffer';
import { Biquad } from './dsp/biquad';

/** K-weighting filter coefficients (ITU-R BS.1770-4), derived for any sample rate. */
function kWeightCoefs(fs: number) {
  // Stage 1: high-shelf
  let K = Math.tan((Math.PI * 1681.974450955533) / fs);
  const Q1 = 0.7071752369554196;
  const Vh = Math.pow(10, 3.999843853973347 / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q1 + K * K;
  const shelf = {
    b0: (Vh + (Vb * K) / Q1 + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q1 + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q1 + K * K) / a0,
  };
  // Stage 2: RLB high-pass
  K = Math.tan((Math.PI * 38.13547087602444) / fs);
  const Q2 = 0.5003270373238773;
  a0 = 1 + K / Q2 + K * K;
  const hp = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q2 + K * K) / a0 };
  return [shelf, hp];
}

/** K-weighting (ITU-R BS.1770): high-shelf pre-filter + RLB high-pass. */
function kWeight(a: AudioData): Float32Array[] {
  const stages = kWeightCoefs(a.sampleRate);
  return a.channels.map((c) => {
    const x = new Float32Array(c);
    for (const st of stages) {
      const bq = new Biquad(1, a.sampleRate);
      bq.c = st;
      bq.processChannel(0, x, 0, x.length);
    }
    return x;
  });
}

/** Integrated loudness in LUFS (EBU R128 gating). Returns -Infinity for silence. */
export function integratedLoudness(a: AudioData): number {
  const k = kWeight(a);
  const sr = a.sampleRate;
  const block = Math.round(0.4 * sr);
  const hop = Math.round(0.1 * sr);
  const len = k[0]!.length;
  const powers: number[] = [];
  for (let s = 0; s + block <= len; s += hop) {
    let sum = 0;
    for (const c of k) {
      let e = 0;
      for (let i = s; i < s + block; i++) e += c[i]! * c[i]!;
      sum += e / block;
    }
    powers.push(sum);
  }
  if (!powers.length) return -Infinity;
  const lufs = (p: number) => -0.691 + 10 * Math.log10(p);
  const abs = powers.filter((p) => lufs(p) > -70);
  if (!abs.length) return -Infinity;
  const relThresh = lufs(abs.reduce((x, y) => x + y, 0) / abs.length) - 10;
  const rel = abs.filter((p) => lufs(p) > relThresh);
  return lufs(rel.reduce((x, y) => x + y, 0) / rel.length);
}

/** Short-term loudness (3 s window) sampled every `hop` seconds. */
export function loudnessCurve(a: AudioData, hop = 0.1, window = 3): { time: number; lufs: number }[] {
  const k = kWeight(a);
  const sr = a.sampleRate;
  const W = Math.round(window * sr);
  const H = Math.round(hop * sr);
  const out: { time: number; lufs: number }[] = [];
  for (let s = 0; s < k[0]!.length; s += H) {
    let sum = 0;
    for (const c of k) {
      let e = 0;
      const lo = Math.max(0, s - W / 2);
      const hi = Math.min(c.length, s + W / 2);
      for (let i = lo; i < hi; i++) e += c[i]! * c[i]!;
      sum += e / Math.max(1, hi - lo);
    }
    out.push({ time: s / sr, lufs: sum > 0 ? -0.691 + 10 * Math.log10(sum) : -Infinity });
  }
  return out;
}

/** Approximate true peak (dBTP) using 4× linear oversampling of the inter-sample curve. */
export function truePeakDb(a: AudioData): number {
  let p = 0;
  for (const c of a.channels) {
    for (let i = 0; i < c.length - 1; i++) {
      const x0 = c[i - 1] ?? c[i]!;
      const x1 = c[i]!;
      const x2 = c[i + 1]!;
      const x3 = c[i + 2] ?? x2;
      for (let k = 0; k < 4; k++) {
        const t = k / 4;
        // Catmull-Rom interpolation between samples
        const v = 0.5 * (2 * x1 + (-x0 + x2) * t + (2 * x0 - 5 * x1 + 4 * x2 - x3) * t * t + (-x0 + 3 * x1 - 3 * x2 + x3) * t * t * t);
        p = Math.max(p, Math.abs(v));
      }
    }
  }
  return p > 0 ? 20 * Math.log10(p) : -Infinity;
}

/** Gain (dB) needed to reach a target integrated loudness. */
export function gainToLoudness(a: AudioData, targetLufs: number): number {
  const l = integratedLoudness(a);
  return Number.isFinite(l) ? targetLufs - l : 0;
}
