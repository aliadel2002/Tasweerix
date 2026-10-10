import { createRandom } from '@tasweerix/core';
import { convolve } from './fft';
import type { AudioProcessor, OfflineProcessor } from './processor';

class Comb {
  buf: Float32Array;
  i = 0;
  store = 0;
  constructor(size: number) {
    this.buf = new Float32Array(size);
  }
  tick(x: number, feedback: number, damp: number): number {
    const y = this.buf[this.i]!;
    this.store = y * (1 - damp) + this.store * damp;
    this.buf[this.i] = x + this.store * feedback;
    this.i = (this.i + 1) % this.buf.length;
    return y;
  }
}
class Allpass {
  buf: Float32Array;
  i = 0;
  constructor(size: number) {
    this.buf = new Float32Array(size);
  }
  tick(x: number): number {
    const b = this.buf[this.i]!;
    const y = -x + b;
    this.buf[this.i] = x + b * 0.5;
    this.i = (this.i + 1) % this.buf.length;
    return y;
  }
}

const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS = [556, 441, 341, 225];

/**
 * Algorithmic reverb (Schroeder/Moorer network with stereo spread and pre-delay).
 * Params: size (0..1), damping (0..1), mix, width, predelay (s).
 */
export function reverbProcessor(sampleRate: number, channels: number): AudioProcessor {
  const k = sampleRate / 44100;
  const nets = Array.from({ length: Math.max(2, channels) }, (_, c) => ({
    combs: COMBS.map((s) => new Comb(Math.round((s + c * 23) * k))),
    aps: ALLPASS.map((s) => new Allpass(Math.round((s + c * 23) * k))),
  }));
  const pre = new Float32Array(Math.ceil(sampleRate * 0.5));
  let preI = 0;
  return {
    tail: (p) => 1 + (p.size ?? 0.6) * 5,
    process(chs, off, n, p) {
      const size = p.size ?? 0.6;
      const fb = 0.7 + size * 0.28;
      const damp = (p.damping ?? 0.4) * 0.4;
      const mix = p.mix ?? 0.3;
      const width = p.width ?? 1;
      const pd = Math.min(pre.length - 1, Math.round((p.predelay ?? 0.02) * sampleRate));
      for (let i = off; i < off + n; i++) {
        let mono = 0;
        for (const c of chs) mono += c[i]!;
        mono /= chs.length;
        pre[preI] = mono;
        const x = pre[(preI - pd + pre.length) % pre.length]! * 0.015;
        preI = (preI + 1) % pre.length;
        const outs = nets.map((net) => {
          let s = 0;
          for (const cb of net.combs) s += cb.tick(x, fb, damp);
          for (const ap of net.aps) s = ap.tick(s);
          return s;
        });
        const L = outs[0]!;
        const R = outs[1]!;
        const wl = L * (0.5 + width / 2) + R * (0.5 - width / 2);
        const wr = R * (0.5 + width / 2) + L * (0.5 - width / 2);
        if (chs.length === 1) chs[0]![i] = chs[0]![i]! * (1 - mix) + ((wl + wr) / 2) * mix * 3;
        else {
          chs[0]![i] = chs[0]![i]! * (1 - mix) + wl * mix * 3;
          chs[1]![i] = chs[1]![i]! * (1 - mix) + wr * mix * 3;
        }
      }
    },
  };
}

/** Synthesizes a stereo impulse response (exponentially decaying filtered noise). */
export function synthImpulse(sampleRate: number, seconds = 2.5, decay = 3, seed = 1): Float32Array[] {
  const len = Math.round(sampleRate * seconds);
  const rnd = createRandom(seed);
  return [0, 1].map(() => {
    const ir = new Float32Array(len);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      lp = lp * 0.6 + (rnd() * 2 - 1) * 0.4;
      ir[i] = lp * Math.pow(1 - t, decay);
    }
    return ir;
  });
}

/**
 * Convolution reverb (offline, FFT overlap-add). Params: ir (Float32Array[] or uses a synthetic IR),
 * seconds/decay for the synthetic IR, mix.
 */
export function convolverProcessor(sampleRate: number): OfflineProcessor {
  return {
    tail: (p) => (p.ir ? (p.ir as Float32Array[])[0]!.length / sampleRate : (p.seconds ?? 2.5)),
    offline(chs, sr, p) {
      const ir = (p.ir as Float32Array[] | undefined) ?? synthImpulse(sr, p.seconds ?? 2.5, p.decay ?? 3, p.seed ?? 1);
      const mix = p.mix ?? 0.3;
      let norm = 0;
      for (const c of ir) for (let i = 0; i < c.length; i++) norm += c[i]! * c[i]!;
      const g = 1 / Math.sqrt(norm / ir.length || 1);
      return chs.map((c, ci) => {
        const wet = convolve(c, ir[Math.min(ci, ir.length - 1)]!);
        const out = new Float32Array(c.length);
        for (let i = 0; i < c.length; i++) out[i] = c[i]! * (1 - mix) + wet[i]! * g * mix * 0.25;
        return out;
      });
    },
  };
}
