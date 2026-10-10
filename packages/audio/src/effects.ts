import type { Animatable, AudioClip, AudioEffectSpec } from '@tasweerix/core';
import { eqProcessor, filterProcessor, type EqBand } from './dsp/biquad';
import { compressorProcessor, duckProcessor, gateProcessor, limiterProcessor } from './dsp/dynamics';
import type { ProcessorFactory } from './dsp/processor';
import { convolverProcessor, reverbProcessor } from './dsp/reverb';
import { denoiseProcessor, timeStretch } from './dsp/stretch';
import { bitcrushProcessor, delayProcessor, distortionProcessor, gainProcessor, modulationProcessor, phaserProcessor, stereoProcessor } from './dsp/time';
import { integratedLoudness } from './loudness';

const registry = new Map<string, ProcessorFactory>();
export function registerAudioEffect(kind: string, factory: ProcessorFactory): void {
  registry.set(kind, factory);
}
export function getAudioEffect(kind: string): ProcessorFactory | undefined {
  return registry.get(kind);
}
export function audioEffectKinds(): string[] {
  return [...registry.keys()];
}

registerAudioEffect('filter', (sr, ch) => filterProcessor(sr, ch));
registerAudioEffect('lowpass', (sr, ch) => filterProcessor(sr, ch, 'lowpass'));
registerAudioEffect('highpass', (sr, ch) => filterProcessor(sr, ch, 'highpass'));
registerAudioEffect('bandpass', (sr, ch) => filterProcessor(sr, ch, 'bandpass'));
registerAudioEffect('notch', (sr, ch) => filterProcessor(sr, ch, 'notch'));
registerAudioEffect('eq', (sr, ch) => eqProcessor(sr, ch));
registerAudioEffect('compressor', (sr, ch) => compressorProcessor(sr, ch));
registerAudioEffect('limiter', (sr, ch) => limiterProcessor(sr, ch));
registerAudioEffect('gate', (sr, ch) => gateProcessor(sr, ch));
registerAudioEffect('duck', (sr, ch) => duckProcessor(sr, ch));
registerAudioEffect('delay', (sr, ch) => delayProcessor(sr, ch));
registerAudioEffect('chorus', (sr, ch) => modulationProcessor(sr, ch, 'chorus'));
registerAudioEffect('flanger', (sr, ch) => modulationProcessor(sr, ch, 'flanger'));
registerAudioEffect('phaser', (sr, ch) => phaserProcessor(sr, ch));
registerAudioEffect('reverb', (sr, ch) => reverbProcessor(sr, ch));
registerAudioEffect('convolver', (sr) => convolverProcessor(sr));
registerAudioEffect('distortion', (sr, ch) => distortionProcessor(sr, ch));
registerAudioEffect('bitcrush', () => bitcrushProcessor());
registerAudioEffect('gain', () => gainProcessor());
registerAudioEffect('stereo', () => stereoProcessor());
registerAudioEffect('denoise', () => denoiseProcessor());
registerAudioEffect('deesser', (sr, ch) => {
  // Sidechain from the sibilant band (high-passed copy) into a fast compressor.
  const comp = compressorProcessor(sr, ch);
  const hp = filterProcessor(sr, ch, 'highpass');
  return {
    process(chs, off, n, p) {
      const side = chs.map((c) => c.slice());
      hp.process(side, off, n, { frequency: p.frequency ?? 6000, q: 0.7 });
      comp.process(chs, off, n, { threshold: p.threshold ?? -30, ratio: p.ratio ?? 6, attack: 0.001, release: 0.05, knee: 3 }, side);
    },
  };
});
registerAudioEffect('normalize', () => ({
  offline(chs, sr, p) {
    let gain = 1;
    if (p.mode === 'loudness' || p.lufs !== undefined) {
      const l = integratedLoudness({ sampleRate: sr, channels: chs });
      if (Number.isFinite(l)) gain = Math.pow(10, ((p.lufs ?? -14) - l) / 20);
    } else {
      let pk = 0;
      for (const c of chs) for (let i = 0; i < c.length; i++) pk = Math.max(pk, Math.abs(c[i]!));
      if (pk > 0) gain = Math.pow(10, (p.peak ?? -1) / 20) / pk;
    }
    return chs.map((c) => c.map((x) => x * gain));
  },
}));
registerAudioEffect('stretch', () => ({
  offline(chs, sr, p) {
    return timeStretch(chs, sr, p.factor ?? 1);
  },
}));
registerAudioEffect('reverse', () => ({ offline: (chs) => chs.map((c) => c.slice().reverse()) }));

type A<T> = Animatable<T>;
const fxSpec = (kind: string, params: Record<string, unknown>, mix?: A<number>): AudioEffectSpec => ({ kind, params: params as AudioEffectSpec['params'], mix });

/**
 * Audio effect builders (all params animatable):
 *   clip.effect(afx.eq([{ type: 'highpass', frequency: 80 }, { frequency: 3000, gain: 3 }]), afx.compressor({ threshold: -20 }))
 */
export const afx = {
  lowpass: (frequency: A<number>, q: A<number> = Math.SQRT1_2, slope: 12 | 24 | 36 | 48 = 12) => fxSpec('lowpass', { frequency, q, slope }),
  highpass: (frequency: A<number>, q: A<number> = Math.SQRT1_2, slope: 12 | 24 | 36 | 48 = 12) => fxSpec('highpass', { frequency, q, slope }),
  bandpass: (frequency: A<number>, q: A<number> = 1) => fxSpec('bandpass', { frequency, q }),
  notch: (frequency: A<number>, q: A<number> = 10) => fxSpec('notch', { frequency, q }),
  eq: (bands: A<EqBand[]>) => fxSpec('eq', { bands }),
  compressor: (p: { threshold?: A<number>; ratio?: A<number>; attack?: A<number>; release?: A<number>; knee?: A<number>; makeup?: A<number>; detector?: 'peak' | 'rms' } = {}) => fxSpec('compressor', p),
  limiter: (p: { ceiling?: A<number>; release?: A<number>; lookahead?: number } = {}) => fxSpec('limiter', p),
  gate: (p: { threshold?: A<number>; range?: A<number>; attack?: A<number>; release?: A<number>; hold?: A<number> } = {}) => fxSpec('gate', p),
  deesser: (p: { frequency?: number; threshold?: number; ratio?: number } = {}) => fxSpec('deesser', p),
  delay: (p: { time?: A<number>; feedback?: A<number>; mix?: A<number>; damping?: A<number>; pingPong?: boolean } = {}) => fxSpec('delay', p),
  chorus: (p: { rate?: A<number>; depth?: A<number>; delay?: A<number>; mix?: A<number> } = {}) => fxSpec('chorus', p),
  flanger: (p: { rate?: A<number>; depth?: A<number>; delay?: A<number>; feedback?: A<number>; mix?: A<number> } = {}) => fxSpec('flanger', p),
  phaser: (p: { rate?: A<number>; depth?: A<number>; stages?: number; feedback?: A<number>; mix?: A<number> } = {}) => fxSpec('phaser', p),
  reverb: (p: { size?: A<number>; damping?: A<number>; mix?: A<number>; width?: A<number>; predelay?: A<number> } = {}) => fxSpec('reverb', p),
  convolver: (p: { ir?: Float32Array[]; seconds?: number; decay?: number; mix?: number } = {}) => fxSpec('convolver', p),
  distortion: (p: { drive?: A<number>; type?: 'soft' | 'hard' | 'fold' | 'tube'; mix?: A<number>; tone?: A<number> } = {}) => fxSpec('distortion', p),
  bitcrush: (p: { bits?: A<number>; downsample?: A<number> } = {}) => fxSpec('bitcrush', p),
  gain: (db: A<number>) => fxSpec('gain', { gain: db }),
  stereo: (p: { pan?: A<number>; width?: A<number> } = {}) => fxSpec('stereo', p),
  /** Spectral noise reduction. `profile` = [start, end] seconds of noise-only audio (auto when omitted). */
  denoise: (p: { amount?: number; threshold?: number; profile?: [number, number] } = {}) => fxSpec('denoise', p),
  normalize: (p: { peak?: number; lufs?: number; mode?: 'peak' | 'loudness' } = {}) => fxSpec('normalize', p),
  stretch: (factor: number) => fxSpec('stretch', { factor }),
  /** Sidechain ducking under another clip or bus. */
  duck: (under: AudioClip | string, p: { amount?: number; threshold?: number; attack?: number; release?: number } = {}): AudioEffectSpec => ({ ...fxSpec('duck', p), sidechain: under }),
  custom: (kind: string, params: Record<string, unknown> = {}) => fxSpec(kind, params),
};
