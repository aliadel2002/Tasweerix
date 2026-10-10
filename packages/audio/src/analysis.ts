import type { AudioData } from './buffer';
import { fft, hann, magnitudeSpectrum } from './dsp/fft';

/** Min/max peaks per bucket for waveform drawing. */
export function waveformPeaks(a: AudioData, buckets: number): { min: Float32Array; max: Float32Array } {
  const len = a.channels[0]?.length ?? 0;
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor((b / buckets) * len);
    const e = Math.max(s + 1, Math.floor(((b + 1) / buckets) * len));
    let lo = 0;
    let hi = 0;
    for (const c of a.channels)
      for (let i = s; i < e && i < len; i++) {
        if (c[i]! < lo) lo = c[i]!;
        if (c[i]! > hi) hi = c[i]!;
      }
    min[b] = lo;
    max[b] = hi;
  }
  return { min, max };
}

export function mono(a: AudioData): Float32Array {
  const len = a.channels[0]?.length ?? 0;
  if (a.channels.length === 1) return a.channels[0]!;
  const m = new Float32Array(len);
  for (const c of a.channels) for (let i = 0; i < len; i++) m[i]! += c[i]! / a.channels.length;
  return m;
}

/** RMS envelope sampled every `hop` seconds. */
export function rmsEnvelope(a: AudioData, hop = 0.01, window = 0.03): Float32Array {
  const m = mono(a);
  const H = Math.max(1, Math.round(hop * a.sampleRate));
  const W = Math.max(1, Math.round(window * a.sampleRate));
  const n = Math.ceil(m.length / H);
  const out = new Float32Array(n);
  // prefix sum of squares
  const ps = new Float64Array(m.length + 1);
  for (let i = 0; i < m.length; i++) ps[i + 1] = ps[i]! + m[i]! * m[i]!;
  for (let k = 0; k < n; k++) {
    const lo = Math.max(0, k * H - (W >> 1));
    const hi = Math.min(m.length, k * H + (W >> 1));
    out[k] = hi > lo ? Math.sqrt((ps[hi]! - ps[lo]!) / (hi - lo)) : 0;
  }
  return out;
}

/** Log-spaced band energies (0..1-ish) of the spectrum at time t. */
export function spectrumBands(signal: Float32Array, sampleRate: number, time: number, bands = 32, opts: { fftSize?: number; minFreq?: number; maxFreq?: number } = {}): number[] {
  const n = opts.fftSize ?? 2048;
  const start = Math.round(time * sampleRate - n / 2);
  const mag = magnitudeSpectrum(signal, start, n);
  const fmin = opts.minFreq ?? 40;
  const fmax = Math.min(opts.maxFreq ?? 16000, sampleRate / 2);
  const out: number[] = [];
  for (let b = 0; b < bands; b++) {
    const f0 = fmin * Math.pow(fmax / fmin, b / bands);
    const f1 = fmin * Math.pow(fmax / fmin, (b + 1) / bands);
    const i0 = Math.max(1, Math.floor((f0 / sampleRate) * n));
    const i1 = Math.max(i0 + 1, Math.ceil((f1 / sampleRate) * n));
    let s = 0;
    for (let i = i0; i < i1 && i < mag.length; i++) s = Math.max(s, mag[i]!);
    // to a perceptual 0..1 scale (−60 dB … 0 dB)
    const db = 20 * Math.log10(s + 1e-9);
    out.push(Math.max(0, Math.min(1, (db + 60) / 60)));
  }
  return out;
}

/** Spectral-flux onset strength envelope (hop seconds per value). */
export function onsetEnvelope(a: AudioData, hop = 512 / 44100): { env: Float32Array; hop: number } {
  const m = mono(a);
  const N = 1024;
  const H = Math.max(1, Math.round(hop * a.sampleRate));
  const frames = Math.max(0, Math.floor((m.length - N) / H));
  const env = new Float32Array(frames);
  let prev = new Float64Array(N / 2);
  const w = hann(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let f = 0; f < frames; f++) {
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < N; i++) re[i] = m[f * H + i]! * w[i]!;
    fft(re, im);
    const cur = new Float64Array(N / 2);
    let flux = 0;
    for (let b = 0; b < N / 2; b++) {
      cur[b] = Math.log1p(100 * Math.hypot(re[b]!, im[b]!));
      const d = cur[b]! - prev[b]!;
      if (d > 0) flux += d;
    }
    env[f] = flux;
    prev = cur;
  }
  // normalize
  let mx = 0;
  for (const v of env) mx = Math.max(mx, v);
  if (mx > 0) for (let i = 0; i < env.length; i++) env[i]! /= mx;
  return { env, hop: H / a.sampleRate };
}

/** Peak-picked onset times (seconds). */
export function detectOnsets(a: AudioData, opts: { sensitivity?: number; minInterval?: number } = {}): number[] {
  const { env, hop } = onsetEnvelope(a);
  const sens = opts.sensitivity ?? 0.5;
  const minGap = Math.round((opts.minInterval ?? 0.07) / hop);
  const out: number[] = [];
  const W = 8;
  let last = -Infinity;
  for (let i = 1; i < env.length - 1; i++) {
    let mean = 0;
    let cnt = 0;
    for (let k = Math.max(0, i - W); k <= Math.min(env.length - 1, i + W); k++) {
      mean += env[k]!;
      cnt++;
    }
    mean /= cnt;
    const v = env[i]!;
    if (v > env[i - 1]! && v >= env[i + 1]! && v > mean + (1 - sens) * 0.3 && v > 0.05 && i - last >= minGap) {
      out.push(i * hop);
      last = i;
    }
  }
  return out;
}

export interface BeatInfo {
  bpm: number;
  beats: number[];
  /** Offset of the first downbeat (seconds). */
  offset: number;
  confidence: number;
}

/**
 * Tempo + beat tracking: autocorrelation of the onset envelope for tempo, then dynamic-programming
 * beat placement (Ellis 2007 style).
 */
export function detectBeats(a: AudioData, opts: { minBpm?: number; maxBpm?: number } = {}): BeatInfo {
  const { env, hop } = onsetEnvelope(a);
  const minBpm = opts.minBpm ?? 60;
  const maxBpm = opts.maxBpm ?? 200;
  const lagMin = Math.floor(60 / maxBpm / hop);
  const lagMax = Math.ceil(60 / minBpm / hop);
  let bestLag = lagMin;
  let best = -Infinity;
  const scores: number[] = [];
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let s = 0;
    for (let i = lag; i < env.length; i++) s += env[i]! * env[i - lag]!;
    s /= env.length - lag || 1;
    // Prefer tempi around 120 BPM (log-gaussian prior).
    const bpm = 60 / (lag * hop);
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    s *= prior;
    scores.push(s);
    if (s > best) {
      best = s;
      bestLag = lag;
    }
  }
  const mean = scores.reduce((x, y) => x + y, 0) / (scores.length || 1);
  const period = bestLag;
  // DP beat tracking.
  const n = env.length;
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const tight = 100;
  for (let i = 0; i < n; i++) {
    let bestPrev = 0;
    let bestJ = -1;
    for (let j = i - Math.round(period * 2); j <= i - Math.round(period / 2); j++) {
      if (j < 0) continue;
      const d = Math.log((i - j) / period);
      const v = score[j]! - tight * d * d;
      if (v > bestPrev || bestJ < 0) {
        bestPrev = v;
        bestJ = j;
      }
    }
    score[i] = env[i]! + (bestJ >= 0 ? Math.max(0, bestPrev) : 0);
    back[i] = bestJ;
  }
  let end = 0;
  for (let i = Math.max(0, n - period); i < n; i++) if (score[i]! > score[end]!) end = i;
  const beats: number[] = [];
  for (let i = end; i >= 0; i = back[i]!) {
    beats.unshift(i * hop);
    if (back[i]! < 0) break;
  }
  return { bpm: 60 / (period * hop), beats, offset: beats[0] ?? 0, confidence: mean > 0 ? Math.min(1, best / mean / 4) : 0 };
}

export interface SilenceRange {
  start: number;
  end: number;
}

/** Ranges where the level stays under `threshold` dBFS for at least `minDuration` seconds. */
export function detectSilence(a: AudioData, opts: { threshold?: number; minDuration?: number; padding?: number } = {}): SilenceRange[] {
  const thr = Math.pow(10, (opts.threshold ?? -40) / 20);
  const minDur = opts.minDuration ?? 0.4;
  const pad = opts.padding ?? 0.05;
  const hop = 0.01;
  const env = rmsEnvelope(a, hop, 0.03);
  const out: SilenceRange[] = [];
  let s = -1;
  for (let i = 0; i <= env.length; i++) {
    const quiet = i < env.length && env[i]! < thr;
    if (quiet && s < 0) s = i;
    if (!quiet && s >= 0) {
      const start = s * hop;
      const end = i * hop;
      if (end - start >= minDur) out.push({ start: start + (s === 0 ? 0 : pad), end: end - (i === env.length ? 0 : pad) });
      s = -1;
    }
  }
  return out.filter((r) => r.end > r.start);
}
