import { AudioClip, buildingComposition, type Env, type FrameContext, type Preparable } from '@tasweerix/core';
import { detectBeats, detectOnsets, mono, rmsEnvelope, spectrumBands, waveformPeaks, type BeatInfo } from './analysis';

/**
 * Audio analysis for audio-reactive visuals. Create it while building a composition; it loads and
 * analyzes the audio before the first frame renders, then answers synchronously per frame.
 *
 *   const music = c.audio('track.mp3');
 *   const a = analyze(music);
 *   c.add(circle(100, { scale: (f) => 1 + a.level(f) * 0.5 }));
 */
export class AudioAnalysis implements Preparable {
  private signal?: Float32Array;
  private sampleRate = 22050;
  private env?: Float32Array;
  private envHop = 0.01;
  private envMax = 1;
  private beatInfo?: BeatInfo;
  private onsets?: number[];
  private spectrumCache = new Map<string, number[]>();

  constructor(readonly source: AudioClip | string, readonly opts: { sampleRate?: number; beats?: boolean; onsets?: boolean } = {}) {
    this.sampleRate = opts.sampleRate ?? 22050;
  }

  async prepare(env: Env): Promise<void> {
    const src = typeof this.source === 'string' ? this.source : this.source.src;
    if (!src) throw new Error('analyze(): clip has no file source');
    if (!env.loadPcm) throw new Error('analyze(): this environment cannot decode audio');
    const chs = await env.loadPcm(src, this.sampleRate, 1);
    this.signal = mono({ sampleRate: this.sampleRate, channels: chs });
    const data = { sampleRate: this.sampleRate, channels: [this.signal] };
    this.env = rmsEnvelope(data, this.envHop, 0.05);
    this.envMax = Math.max(1e-6, ...Array.from(this.env).sort((a, b) => b - a).slice(0, Math.max(1, Math.floor(this.env.length * 0.01))));
    if (this.opts.beats !== false) this.beatInfo = detectBeats(data);
    if (this.opts.onsets !== false) this.onsets = detectOnsets(data);
  }

  /** Maps composition time (seconds) to source time, honoring clip start/trim/speed. */
  sourceTime(compTime: number): number {
    if (typeof this.source === 'string') return compTime;
    const c = this.source;
    return c.trimIn + (compTime - c.start) * Math.abs(c.speed || 1);
  }

  private t(x: FrameContext | number): number {
    return this.sourceTime(typeof x === 'number' ? x : x.globalTime);
  }

  /** Normalized loudness 0..1 at a time (frame context or composition seconds). */
  level(at: FrameContext | number, smoothing = 0.06): number {
    if (!this.env) return 0;
    const t = this.t(at);
    const k = Math.max(1, Math.round(smoothing / this.envHop));
    const i = Math.round(t / this.envHop);
    let s = 0;
    let n = 0;
    for (let j = i - k; j <= i; j++) {
      if (j >= 0 && j < this.env.length) {
        s += this.env[j]!;
        n++;
      }
    }
    return n ? Math.min(1, s / n / this.envMax) : 0;
  }

  /** Log-spaced spectrum band levels (0..1) at a time. */
  spectrum(at: FrameContext | number, bands = 32): number[] {
    if (!this.signal) return new Array(bands).fill(0);
    const t = this.t(at);
    const key = `${t.toFixed(4)}|${bands}`;
    let s = this.spectrumCache.get(key);
    if (!s) {
      s = spectrumBands(this.signal, this.sampleRate, t, bands);
      if (this.spectrumCache.size > 4000) this.spectrumCache.clear();
      this.spectrumCache.set(key, s);
    }
    return s;
  }

  /** Pulse that jumps to 1 on each beat and decays (seconds half-life). */
  beat(at: FrameContext | number, decay = 0.15): number {
    const beats = this.beatInfo?.beats ?? [];
    return pulse(beats, this.t(at), decay);
  }

  /** Pulse on detected onsets (transients). */
  onset(at: FrameContext | number, decay = 0.1): number {
    return pulse(this.onsets ?? [], this.t(at), decay);
  }

  /** Index of the current beat (−1 before the first). Useful to switch visuals per beat. */
  beatIndex(at: FrameContext | number): number {
    const beats = this.beatInfo?.beats ?? [];
    const t = this.t(at);
    let i = -1;
    while (i + 1 < beats.length && beats[i + 1]! <= t) i++;
    return i;
  }

  get bpm(): number {
    return this.beatInfo?.bpm ?? 0;
  }
  get beats(): number[] {
    return this.beatInfo?.beats ?? [];
  }
  get transients(): number[] {
    return this.onsets ?? [];
  }
  get duration(): number {
    return this.signal ? this.signal.length / this.sampleRate : 0;
  }

  /** Waveform min/max peaks for drawing. */
  waveform(buckets: number, from = 0, to = this.duration): { min: Float32Array; max: Float32Array } {
    if (!this.signal) return { min: new Float32Array(buckets), max: new Float32Array(buckets) };
    const s = Math.floor(from * this.sampleRate);
    const e = Math.floor(to * this.sampleRate);
    return waveformPeaks({ sampleRate: this.sampleRate, channels: [this.signal.subarray(s, e)] }, buckets);
  }
}

function pulse(times: number[], t: number, decay: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let last = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) {
      last = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (last < 0) return 0;
  const dt = t - times[last]!;
  return Math.pow(0.5, dt / Math.max(1e-3, decay));
}

/** Creates and registers an audio analysis for the composition being built. */
export function analyze(source: AudioClip | string, opts?: ConstructorParameters<typeof AudioAnalysis>[1]): AudioAnalysis {
  const a = new AudioAnalysis(source, opts);
  const comp = buildingComposition();
  if (comp) comp.preparables.push(a);
  return a;
}
