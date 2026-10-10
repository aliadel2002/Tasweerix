import type { AudioProcessor } from './processor';

const dbToLin = (db: number) => Math.pow(10, db / 20);
const linToDb = (x: number) => (x <= 1e-12 ? -240 : 20 * Math.log10(x));

/** Static gain computer with soft knee (returns gain reduction in dB, ≤ 0). */
export function compressorGainDb(inputDb: number, threshold: number, ratio: number, knee: number): number {
  const over = inputDb - threshold;
  if (knee > 0 && Math.abs(over) <= knee / 2) {
    return ((1 / ratio - 1) * Math.pow(over + knee / 2, 2)) / (2 * knee);
  }
  if (over <= 0) return 0;
  return over * (1 / ratio - 1);
}

/**
 * Feed-forward compressor with peak/RMS detection, soft knee, makeup and optional sidechain.
 * Params: threshold (dB), ratio, attack (s), release (s), knee (dB), makeup (dB), detector ('peak'|'rms').
 */
export function compressorProcessor(sampleRate: number, channels: number): AudioProcessor {
  let env = 0;
  let rmsAcc = 0;
  let gainDbState = 0;
  void channels;
  return {
    process(chs, off, n, p, side) {
      const threshold = p.threshold ?? -18;
      const ratio = Math.max(1, p.ratio ?? 4);
      const knee = p.knee ?? 6;
      const makeup = p.makeup ?? 0;
      const att = Math.exp(-1 / (Math.max(1e-4, p.attack ?? 0.01) * sampleRate));
      const rel = Math.exp(-1 / (Math.max(1e-4, p.release ?? 0.15) * sampleRate));
      const rmsCoef = Math.exp(-1 / (0.01 * sampleRate));
      const det = side ?? chs;
      const rmsMode = p.detector === 'rms';
      for (let i = off; i < off + n; i++) {
        let x = 0;
        for (const c of det) x = Math.max(x, Math.abs(c[i] ?? 0));
        if (rmsMode) {
          rmsAcc = rmsCoef * rmsAcc + (1 - rmsCoef) * x * x;
          x = Math.sqrt(rmsAcc);
        }
        env = x > env ? att * env + (1 - att) * x : rel * env + (1 - rel) * x;
        const target = compressorGainDb(linToDb(env), threshold, ratio, knee);
        // smooth gain changes
        gainDbState = target < gainDbState ? att * gainDbState + (1 - att) * target : rel * gainDbState + (1 - rel) * target;
        const g = dbToLin(gainDbState + makeup);
        for (const c of chs) c[i]! *= g;
      }
    },
  };
}

/**
 * Lookahead brickwall limiter. Params: ceiling (dB), release (s), lookahead (s).
 * Introduces no latency: the gain envelope is computed with a forward-looking window.
 */
export function limiterProcessor(sampleRate: number, channels: number): AudioProcessor {
  let gain = 1;
  void channels;
  return {
    process(chs, off, n, p) {
      const ceiling = dbToLin(p.ceiling ?? -1);
      const look = Math.max(1, Math.round((p.lookahead ?? 0.005) * sampleRate));
      const rel = Math.exp(-1 / (Math.max(1e-3, p.release ?? 0.08) * sampleRate));
      const len = chs[0]!.length;
      // Precompute per-sample peaks for lookahead (block + look).
      const end = Math.min(len, off + n + look);
      const peaks = new Float32Array(end - off);
      for (let i = off; i < end; i++) {
        let m = 0;
        for (const c of chs) m = Math.max(m, Math.abs(c[i]!));
        peaks[i - off] = m;
      }
      // Sliding max over lookahead window.
      for (let i = off; i < off + n; i++) {
        let m = 0;
        const hi = Math.min(end, i + look);
        for (let k = i; k < hi; k++) m = Math.max(m, peaks[k - off]!);
        const target = m > ceiling ? ceiling / m : 1;
        gain = target < gain ? target : rel * gain + (1 - rel) * target;
        for (const c of chs) c[i] = Math.max(-ceiling, Math.min(ceiling, c[i]! * gain));
      }
    },
  };
}

/** Noise gate / downward expander. Params: threshold (dB), range (dB), attack, release, hold. */
export function gateProcessor(sampleRate: number, channels: number): AudioProcessor {
  let env = 0;
  let g = 0;
  let holdLeft = 0;
  void channels;
  return {
    process(chs, off, n, p, side) {
      const thr = dbToLin(p.threshold ?? -45);
      const floor = dbToLin(p.range ?? -60);
      const att = Math.exp(-1 / (Math.max(1e-4, p.attack ?? 0.002) * sampleRate));
      const rel = Math.exp(-1 / (Math.max(1e-4, p.release ?? 0.1) * sampleRate));
      const envCoef = Math.exp(-1 / (0.005 * sampleRate));
      const hold = Math.round((p.hold ?? 0.05) * sampleRate);
      const det = side ?? chs;
      for (let i = off; i < off + n; i++) {
        let x = 0;
        for (const c of det) x = Math.max(x, Math.abs(c[i] ?? 0));
        env = Math.max(x, envCoef * env);
        let target: number;
        if (env >= thr) {
          target = 1;
          holdLeft = hold;
        } else if (holdLeft > 0) {
          holdLeft--;
          target = 1;
        } else target = floor;
        g = target > g ? att * g + (1 - att) * target : rel * g + (1 - rel) * target;
        for (const c of chs) c[i]! *= g;
      }
    },
  };
}

/**
 * Sidechain ducker: lowers the signal by `amount` dB while the sidechain is above `threshold`.
 * Params: amount (dB, negative), threshold (dB), attack, release.
 */
export function duckProcessor(sampleRate: number, channels: number): AudioProcessor {
  let env = 0;
  let g = 1;
  void channels;
  return {
    process(chs, off, n, p, side) {
      if (!side) return;
      const thr = dbToLin(p.threshold ?? -40);
      const depth = dbToLin(p.amount ?? -12);
      const att = Math.exp(-1 / (Math.max(1e-4, p.attack ?? 0.08) * sampleRate));
      const rel = Math.exp(-1 / (Math.max(1e-4, p.release ?? 0.4) * sampleRate));
      const envCoef = Math.exp(-1 / (0.02 * sampleRate));
      for (let i = off; i < off + n; i++) {
        let x = 0;
        for (const c of side) x = Math.max(x, Math.abs(c[i] ?? 0));
        env = Math.max(x, envCoef * env);
        const target = env > thr ? depth : 1;
        g = target < g ? att * g + (1 - att) * target : rel * g + (1 - rel) * target;
        for (const c of chs) c[i]! *= g;
      }
    },
  };
}


export { dbToLin, linToDb };
