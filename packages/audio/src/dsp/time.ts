import { Biquad } from './biquad';
import type { AudioProcessor } from './processor';

/** Circular delay line with fractional (linear) reads. */
class DelayLine {
  buf: Float32Array;
  pos = 0;
  constructor(size: number) {
    this.buf = new Float32Array(Math.max(2, size));
  }
  write(x: number) {
    this.buf[this.pos] = x;
    this.pos = (this.pos + 1) % this.buf.length;
  }
  read(delaySamples: number): number {
    const L = this.buf.length;
    const d = Math.min(Math.max(delaySamples, 0), L - 2);
    const p = this.pos - 1 - d;
    const i = Math.floor(p);
    const f = p - i;
    const a = this.buf[((i % L) + L) % L]!;
    const b = this.buf[(((i + 1) % L) + L) % L]!;
    return a + (b - a) * f;
  }
}

/** Echo / delay with feedback, damping and optional ping-pong. Params: time, feedback, mix, damping, pingPong. */
export function delayProcessor(sampleRate: number, channels: number): AudioProcessor {
  const lines = Array.from({ length: channels }, () => new DelayLine(Math.ceil(sampleRate * 4)));
  const damp = new Float64Array(channels);
  return {
    tail: (p) => Math.min(30, (p.time ?? 0.35) * Math.log(0.001) / Math.log(Math.max(1e-3, Math.min(0.99, p.feedback ?? 0.4)))),
    process(chs, off, n, p) {
      const d = (p.time ?? 0.35) * sampleRate;
      const fb = Math.min(0.98, p.feedback ?? 0.4);
      const mix = p.mix ?? 0.35;
      const dampK = p.damping ?? 0.3;
      const ping = !!p.pingPong && channels === 2;
      for (let i = off; i < off + n; i++) {
        const ins = chs.map((c) => c[i]!);
        const outs = lines.map((l) => l.read(d));
        for (let c = 0; c < channels; c++) {
          damp[c] = damp[c]! + (outs[c]! - damp[c]!) * (1 - dampK);
          const fbIn = ping ? damp[1 - c]! : damp[c]!;
          lines[c]!.write((ping ? (c === 0 ? (ins[0]! + ins[1]!) / 2 : 0) : ins[c]!) + fbIn * fb);
          chs[c]![i] = ins[c]! + outs[c]! * mix;
        }
      }
    },
  };
}

/** Chorus / flanger: LFO-modulated short delays. Params: rate, depth (s), delay (s), feedback, mix. */
export function modulationProcessor(sampleRate: number, channels: number, preset: 'chorus' | 'flanger'): AudioProcessor {
  const lines = Array.from({ length: channels }, () => new DelayLine(Math.ceil(sampleRate * 0.1)));
  let phase = 0;
  return {
    process(chs, off, n, p) {
      const rate = p.rate ?? (preset === 'chorus' ? 0.8 : 0.25);
      const depth = (p.depth ?? (preset === 'chorus' ? 0.004 : 0.002)) * sampleRate;
      const base = (p.delay ?? (preset === 'chorus' ? 0.02 : 0.003)) * sampleRate;
      const fb = p.feedback ?? (preset === 'chorus' ? 0 : 0.6);
      const mix = p.mix ?? 0.5;
      for (let i = off; i < off + n; i++) {
        phase += rate / sampleRate;
        for (let c = 0; c < channels; c++) {
          const lfo = Math.sin(2 * Math.PI * (phase + c * 0.25));
          const delayed = lines[c]!.read(base + depth * (lfo + 1) * 0.5);
          const x = chs[c]![i]!;
          lines[c]!.write(x + delayed * fb);
          chs[c]![i] = x * (1 - mix * 0.5) + delayed * mix;
        }
      }
    },
  };
}

/** Phaser: cascade of modulated allpass filters. Params: rate, depth, stages, feedback, mix. */
export function phaserProcessor(sampleRate: number, channels: number): AudioProcessor {
  let filters: Biquad[] = [];
  let phase = 0;
  const fbState = new Float64Array(channels);
  return {
    process(chs, off, n, p) {
      const stages = p.stages ?? 6;
      while (filters.length < stages) filters.push(new Biquad(channels, sampleRate));
      filters = filters.slice(0, stages);
      const rate = p.rate ?? 0.5;
      const lo = 300;
      const hi = 300 + (p.depth ?? 0.8) * 3000;
      const mix = p.mix ?? 0.5;
      const fb = p.feedback ?? 0.3;
      const B = 32;
      for (let s = off; s < off + n; s += B) {
        const m = Math.min(B, off + n - s);
        phase += (rate * m) / sampleRate;
        const f = lo + (hi - lo) * (0.5 + 0.5 * Math.sin(2 * Math.PI * phase));
        filters.forEach((bq) => bq.set('allpass', f, 0.7));
        for (let c = 0; c < channels; c++) {
          const dry = chs[c]!.slice(s, s + m);
          const wet = new Float32Array(m);
          for (let i = 0; i < m; i++) wet[i] = dry[i]! + fbState[c]! * fb;
          filters.forEach((bq) => bq.processChannel(c, wet, 0, m));
          fbState[c] = wet[m - 1]!;
          for (let i = 0; i < m; i++) chs[c]![s + i] = dry[i]! * (1 - mix) + wet[i]! * mix;
        }
      }
    },
  };
}

/** Stereo panner / width. Params: pan (-1..1), width (0..2). */
export function stereoProcessor(): AudioProcessor {
  return {
    process(chs, off, n, p) {
      if (chs.length < 2) return;
      const pan = Math.max(-1, Math.min(1, p.pan ?? 0));
      const width = p.width ?? 1;
      const a = ((pan + 1) * Math.PI) / 4;
      const gl = Math.cos(a) * Math.SQRT2;
      const gr = Math.sin(a) * Math.SQRT2;
      const [L, R] = chs as [Float32Array, Float32Array];
      for (let i = off; i < off + n; i++) {
        const mid = (L[i]! + R[i]!) / 2;
        const side = ((L[i]! - R[i]!) / 2) * width;
        L[i] = (mid + side) * gl;
        R[i] = (mid - side) * gr;
      }
    },
  };
}

/** Waveshaping distortion. Params: drive (dB), type ('soft'|'hard'|'fold'|'tube'), mix, tone (Hz lowpass). */
export function distortionProcessor(sampleRate: number, channels: number): AudioProcessor {
  const tone = new Biquad(channels, sampleRate);
  return {
    process(chs, off, n, p) {
      const drive = Math.pow(10, (p.drive ?? 12) / 20);
      const mix = p.mix ?? 1;
      const type = p.type ?? 'soft';
      tone.set('lowpass', p.tone ?? 9000, 0.7);
      const shape = (x: number) => {
        const y = x * drive;
        switch (type) {
          case 'hard':
            return Math.max(-1, Math.min(1, y));
          case 'fold':
            return Math.sin(y);
          case 'tube':
            return y >= 0 ? 1 - Math.exp(-y) : -1 + Math.exp(y) * 0.8;
          default:
            return Math.tanh(y);
        }
      };
      chs.forEach((c, ci) => {
        const wet = new Float32Array(n);
        for (let i = 0; i < n; i++) wet[i] = shape(c[off + i]!) / Math.tanh(drive);
        tone.processChannel(ci, wet, 0, n);
        for (let i = 0; i < n; i++) c[off + i] = c[off + i]! * (1 - mix) + wet[i]! * mix;
      });
    },
  };
}

/** Bitcrusher: reduces bit depth and sample rate. Params: bits, downsample. */
export function bitcrushProcessor(): AudioProcessor {
  const hold: number[] = [];
  let counter = 0;
  return {
    process(chs, off, n, p) {
      const levels = Math.pow(2, (p.bits ?? 8) - 1);
      const ds = Math.max(1, Math.round(p.downsample ?? 4));
      for (let i = off; i < off + n; i++) {
        if (counter++ % ds === 0) chs.forEach((c, ci) => (hold[ci] = Math.round(c[i]! * levels) / levels));
        chs.forEach((c, ci) => (c[i] = hold[ci] ?? 0));
      }
    },
  };
}

/** Plain gain (dB). */
export function gainProcessor(): AudioProcessor {
  return {
    process(chs, off, n, p) {
      const g = Math.pow(10, (p.gain ?? 0) / 20);
      for (const c of chs) for (let i = off; i < off + n; i++) c[i]! *= g;
    },
  };
}
