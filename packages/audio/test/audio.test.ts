import { describe, expect, it } from 'vitest';
import { composition, soundscape, audio } from '@tasweerix/core';
import {
  afx,
  biquadCoefs,
  biquadResponseDb,
  compressorGainDb,
  decodeWav,
  detectBeats,
  detectOnsets,
  detectSilence,
  encodeWav,
  filterProcessor,
  integratedLoudness,
  noteToHz,
  renderMix,
  resample,
  rms,
  sfx,
  timeStretch,
  tone,
  truePeakDb,
  type AudioData,
} from '../src';

const SR = 48000;
const sine = (freq: number, secs: number, amp = 1, sr = SR) => {
  const a = new Float32Array(Math.round(secs * sr));
  for (let i = 0; i < a.length; i++) a[i] = Math.sin((2 * Math.PI * freq * i) / sr) * amp;
  return a;
};
const zeroCrossings = (x: Float32Array) => {
  let n = 0;
  for (let i = 1; i < x.length; i++) if ((x[i - 1]! < 0) !== (x[i]! < 0)) n++;
  return n;
};

describe('filters & dynamics', () => {
  it('lowpass response matches design', () => {
    const c = biquadCoefs('lowpass', 1000, Math.SQRT1_2, 0, SR);
    expect(biquadResponseDb(c, 100, SR)).toBeCloseTo(0, 1);
    expect(biquadResponseDb(c, 1000, SR)).toBeCloseTo(-3.01, 1);
    expect(biquadResponseDb(c, 10000, SR)).toBeLessThan(-38);
  });
  it('filters a real signal', () => {
    const p = filterProcessor(SR, 1, 'lowpass');
    const hi = sine(8000, 0.5);
    const lo = sine(100, 0.5);
    p.process([hi], 0, hi.length, { frequency: 500 });
    const p2 = filterProcessor(SR, 1, 'lowpass');
    p2.process([lo], 0, lo.length, { frequency: 500 });
    expect(rms({ sampleRate: SR, channels: [hi] })).toBeLessThan(0.01);
    expect(rms({ sampleRate: SR, channels: [lo] })).toBeGreaterThan(0.69);
  });
  it('compressor gain computer', () => {
    expect(compressorGainDb(-10, -20, 4, 0)).toBeCloseTo(-7.5);
    expect(compressorGainDb(-30, -20, 4, 0)).toBe(0);
    expect(compressorGainDb(-20, -20, 4, 6)).toBeLessThan(0); // inside soft knee
  });
});

describe('formats & resampling', () => {
  it('round-trips WAV in all formats', () => {
    const a: AudioData = { sampleRate: SR, channels: [sine(440, 0.1, 0.5), sine(880, 0.1, 0.25)] };
    for (const f of ['pcm16', 'pcm24', 'float32'] as const) {
      const b = decodeWav(encodeWav(a, f));
      expect(b.sampleRate).toBe(SR);
      expect(b.channels).toHaveLength(2);
      expect(Math.abs(b.channels[0]![100]! - a.channels[0]![100]!)).toBeLessThan(f === 'pcm16' ? 2e-4 : 1e-6);
    }
  });
  it('resamples without changing pitch', () => {
    const x = sine(1000, 1);
    const y = resample({ sampleRate: SR, channels: [x] }, 44100 / 48000, 44100);
    expect(y.channels[0]!.length).toBe(44100);
    expect(Math.abs(zeroCrossings(y.channels[0]!) - 2000)).toBeLessThanOrEqual(3);
  });
  it('time-stretches keeping pitch', () => {
    const x = sine(440, 1, 0.5);
    const [y] = timeStretch([x], SR, 1.5);
    expect(y!.length).toBe(72000);
    expect(Math.abs(zeroCrossings(y!) / 1.5 - 880)).toBeLessThan(20);
  });
});

describe('loudness', () => {
  it('matches the BS.1770 reference (0 dBFS 1 kHz sine in one channel = -3.01 LKFS)', () => {
    const l = integratedLoudness({ sampleRate: SR, channels: [sine(997, 5)] });
    expect(l).toBeCloseTo(-3.01, 1);
    expect(truePeakDb({ sampleRate: SR, channels: [sine(997, 0.1, 0.5)] })).toBeCloseTo(-6.02, 1);
  });
});

describe('analysis', () => {
  it('finds silence ranges', () => {
    const x = new Float32Array(SR * 3);
    x.set(sine(300, 1, 0.5), 0);
    x.set(sine(300, 1, 0.5), SR * 2);
    const s = detectSilence({ sampleRate: SR, channels: [x] }, { threshold: -40, minDuration: 0.5, padding: 0 });
    expect(s).toHaveLength(1);
    expect(s[0]!.start).toBeCloseTo(1, 1);
    expect(s[0]!.end).toBeCloseTo(2, 1);
  });
  it('tracks tempo of a click track', () => {
    const sr = 22050;
    const x = new Float32Array(sr * 12);
    for (let b = 0; b < 24; b++) {
      const s = Math.round(b * 0.5 * sr);
      for (let i = 0; i < 400; i++) x[s + i] = Math.sin(i * 0.3) * Math.exp(-i / 80);
    }
    const info = detectBeats({ sampleRate: sr, channels: [x] });
    expect(info.bpm).toBeGreaterThan(117);
    expect(info.bpm).toBeLessThan(123);
    const onsets = detectOnsets({ sampleRate: sr, channels: [x] });
    expect(onsets.length).toBeGreaterThan(20);
    expect(onsets[1]! - onsets[0]!).toBeCloseTo(0.5, 1);
  });
  it('converts note names', () => {
    expect(noteToHz('A4')).toBe(440);
    expect(noteToHz(60)).toBeCloseTo(261.63, 1);
  });
});

describe('mixer', () => {
  const noLoad = async () => {
    throw new Error('no files');
  };
  it('mixes generator clips with fades, buses and master effects', async () => {
    const def = soundscape({ sampleRate: SR }, (c) => {
      c.audio(tone({ freq: 'A4', duration: 2, gain: 0.5 }).fadeIn(0.5, 'linear'));
      c.audio(sfx('kick', { start: 1 }));
      c.bus('fx', { effects: [afx.reverb({ mix: 0.5 })] });
      c.audio(sfx('click', { start: 0.2, bus: 'fx' }));
      c.master(afx.limiter({ ceiling: -1 }));
    });
    const comp = await def.create();
    const { master } = await renderMix(comp, { load: noLoad });
    expect(master.channels[0]!.length).toBe(comp.duration * SR);
    // fade-in: first 50ms quieter than 1.5s mark
    const early = rms(master, 0, 2400);
    const later = rms(master, SR * 1.5, SR * 1.5 + 2400);
    expect(early).toBeLessThan(later * 0.2);
    let pk = 0;
    for (const c of master.channels) for (const v of c) pk = Math.max(pk, Math.abs(v));
    expect(pk).toBeLessThanOrEqual(Math.pow(10, -1 / 20) + 1e-3);
  });
  it('ducks music under a voice clip', async () => {
    const def = composition({ width: 2, height: 2, fps: 30, duration: 3, sampleRate: SR }, (c) => {
      const voice = c.audio(tone({ freq: 300, duration: 1, start: 1, gain: 0.5 }));
      c.audio(tone({ freq: 1000, duration: 3, gain: 0.5 }).duck(voice, { amount: -20, attack: 0.01, release: 0.05 }));
    });
    const comp = await def.create();
    const { stems } = await renderMix(comp, { load: noLoad, stems: true });
    const music = [...stems!.entries()].find(([k]) => k.startsWith('clip:') && k !== [...stems!.keys()].find((x) => x.startsWith('clip:')))![1];
    const before = rms(music, SR * 0.5, SR * 0.9);
    const during = rms(music, SR * 1.3, SR * 1.8);
    expect(during).toBeLessThan(before * 0.2);
  });
  it('accepts file clips through the loader (trim + speed)', async () => {
    const def = soundscape({ sampleRate: SR }, (c) => void c.audio(audio('a.wav', { trim: [1, 3], speed: 2 })));
    const comp = await def.create({ env: { kind: 'none', probe: async () => ({ duration: 4, hasAudio: true }) } });
    const { master } = await renderMix(comp, { load: async () => [sine(100, 4), sine(100, 4)] });
    expect(master.channels[0]!.length).toBe(SR); // 2s of source at 2x = 1s
    expect(Math.abs(zeroCrossings(master.channels[0]!) - 400)).toBeLessThan(6); // pitch doubled
  });
});
