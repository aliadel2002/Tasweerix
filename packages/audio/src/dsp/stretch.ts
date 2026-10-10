import { resample, type AudioData } from '../buffer';
import { fft, hann } from './fft';
import type { OfflineProcessor } from './processor';

/**
 * WSOLA time-stretch (tempo change without pitch change).
 * factor > 1 makes audio longer (slower), < 1 shorter (faster).
 */
export function timeStretch(chs: Float32Array[], sampleRate: number, factor: number): Float32Array[] {
  if (Math.abs(factor - 1) < 1e-6) return chs.map((c) => new Float32Array(c));
  const N = Math.round(sampleRate * 0.04); // 40 ms frames
  const Ha = Math.round(N / 2 / factor); // analysis hop
  const Hs = Math.round(N / 2); // synthesis hop
  const tol = Math.round(sampleRate * 0.01); // ±10 ms search
  const len = chs[0]!.length;
  const outLen = Math.round(len * factor);
  const w = hann(N);
  // Use mono mix for alignment search.
  const mono = new Float32Array(len);
  for (const c of chs) for (let i = 0; i < len; i++) mono[i]! += c[i]! / chs.length;
  const out = chs.map(() => new Float32Array(outLen + N));
  const norm = new Float32Array(outLen + N);
  let prevStart = 0;
  for (let k = 0, outPos = 0; outPos < outLen; k++, outPos += Hs) {
    const nominal = Math.round(k * Ha);
    let best = nominal;
    if (k > 0) {
      // The natural continuation of the previous frame:
      const target = prevStart + Hs;
      let bestScore = -Infinity;
      for (let d = -tol; d <= tol; d += 2) {
        const cand = nominal + d;
        if (cand < 0 || cand + N > len) continue;
        let s = 0;
        for (let i = 0; i < N; i += 4) s += mono[cand + i]! * (mono[target + i] ?? 0);
        if (s > bestScore) {
          bestScore = s;
          best = cand;
        }
      }
    }
    best = Math.max(0, Math.min(len - 1, best));
    for (let i = 0; i < N; i++) {
      const src = best + i;
      if (src >= len || outPos + i >= out[0]!.length) break;
      for (let c = 0; c < chs.length; c++) out[c]![outPos + i]! += chs[c]![src]! * w[i]!;
      norm[outPos + i]! += w[i]!;
    }
    prevStart = best;
  }
  return out.map((o) => {
    const r = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) r[i] = norm[i]! > 1e-3 ? o[i]! / norm[i]! : 0;
    return r;
  });
}

/** Pitch shift by semitones keeping duration (stretch + resample). */
export function pitchShift(a: AudioData, semitones: number): AudioData {
  if (!semitones) return a;
  const ratio = Math.pow(2, semitones / 12);
  const stretched = timeStretch(a.channels, a.sampleRate, ratio);
  const r = resample({ sampleRate: a.sampleRate, channels: stretched }, 1 / ratio, a.sampleRate);
  const len = a.channels[0]!.length;
  return { sampleRate: a.sampleRate, channels: r.channels.map((c) => (c.length === len ? c : (() => { const o = new Float32Array(len); o.set(c.subarray(0, len)); return o; })())) };
}

/**
 * Spectral-gating noise reduction. A noise profile is estimated from the quietest frames
 * (or a given time range); bins under profile × threshold are attenuated.
 * Params: amount (0..1), threshold (multiplier, default 2), profile: [startSec, endSec].
 */
export function denoiseProcessor(): OfflineProcessor {
  return {
    offline(chs, sampleRate, p) {
      const N = 2048;
      const H = N / 4;
      const w = hann(N);
      const amount = p.amount ?? 0.8;
      const thr = p.threshold ?? 2;
      return chs.map((sig) => {
        const frames = Math.max(1, Math.ceil(sig.length / H));
        // Noise profile.
        const prof = new Float64Array(N / 2 + 1);
        const pickFrames: number[] = [];
        if (p.profile) {
          const [a, b] = p.profile as [number, number];
          for (let f = Math.floor((a * sampleRate) / H); f < Math.floor((b * sampleRate) / H); f++) pickFrames.push(f);
        } else {
          const energies: [number, number][] = [];
          for (let f = 0; f < frames; f++) {
            let e = 0;
            for (let i = 0; i < N; i++) e += (sig[f * H + i] ?? 0) ** 2;
            energies.push([e, f]);
          }
          energies.sort((x, y) => x[0] - y[0]);
          pickFrames.push(...energies.slice(0, Math.max(1, Math.floor(frames * 0.1))).map((e) => e[1]));
        }
        const re = new Float64Array(N);
        const im = new Float64Array(N);
        for (const f of pickFrames) {
          re.fill(0);
          im.fill(0);
          for (let i = 0; i < N; i++) re[i] = (sig[f * H + i] ?? 0) * w[i]!;
          fft(re, im);
          for (let b = 0; b <= N / 2; b++) prof[b]! += Math.hypot(re[b]!, im[b]!) / pickFrames.length;
        }
        const out = new Float32Array(sig.length + N);
        const norm = new Float32Array(sig.length + N);
        let prevMask = new Float64Array(N / 2 + 1).fill(1);
        for (let f = 0; f < frames; f++) {
          re.fill(0);
          im.fill(0);
          for (let i = 0; i < N; i++) re[i] = (sig[f * H + i] ?? 0) * w[i]!;
          fft(re, im);
          const mask = new Float64Array(N / 2 + 1);
          for (let b = 0; b <= N / 2; b++) {
            const mag = Math.hypot(re[b]!, im[b]!);
            const g = mag > prof[b]! * thr ? 1 : 1 - amount;
            mask[b] = 0.7 * prevMask[b]! + 0.3 * g; // temporal smoothing reduces musical noise
          }
          prevMask = mask;
          for (let b = 0; b <= N / 2; b++) {
            const m = mask[b]!;
            re[b]! *= m;
            im[b]! *= m;
            if (b > 0 && b < N / 2) {
              re[N - b] = re[b]!;
              im[N - b] = -im[b]!;
            }
          }
          fft(re, im, true);
          for (let i = 0; i < N; i++) {
            out[f * H + i]! += re[i]! * w[i]!;
            norm[f * H + i]! += w[i]! * w[i]!;
          }
        }
        const r = new Float32Array(sig.length);
        for (let i = 0; i < sig.length; i++) r[i] = norm[i]! > 1e-6 ? out[i]! / norm[i]! : 0;
        return r;
      });
    },
  };
}
