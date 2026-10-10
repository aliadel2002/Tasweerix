import { createRandom, generator, type AudioClip, type AudioClipOptions } from '@tasweerix/core';

export type Wave = 'sine' | 'square' | 'saw' | 'triangle' | 'noise' | 'pink' | 'brown';

export interface Envelope {
  attack?: number;
  decay?: number;
  sustain?: number;
  release?: number;
}

export interface Note {
  /** MIDI note number or frequency in Hz (when > 127) or name like "C4", "F#3". */
  note: number | string;
  start: number;
  duration: number;
  velocity?: number;
}

export function noteToHz(n: number | string): number {
  if (typeof n === 'number') return n > 127 ? n : 440 * Math.pow(2, (n - 69) / 12);
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(n.trim());
  if (!m) throw new Error(`Bad note "${n}"`);
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1]!.toLowerCase() as 'c']!;
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return 440 * Math.pow(2, (base + acc + (Number(m[3]) + 1) * 12 - 69) / 12);
}

function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

/** Band-limited oscillator sample generator. */
export function oscillator(wave: Wave, sampleRate: number, seed = 1) {
  let phase = 0;
  let tri = 0;
  const rnd = createRandom(seed);
  let b0 = 0, b1 = 0, b2 = 0, brown = 0;
  return (freq: number): number => {
    const dt = freq / sampleRate;
    let v: number;
    switch (wave) {
      case 'sine':
        v = Math.sin(2 * Math.PI * phase);
        break;
      case 'saw':
        v = 2 * phase - 1 - polyBlep(phase, dt);
        break;
      case 'square': {
        v = phase < 0.5 ? 1 : -1;
        v += polyBlep(phase, dt);
        v -= polyBlep((phase + 0.5) % 1, dt);
        break;
      }
      case 'triangle': {
        let sq = phase < 0.5 ? 1 : -1;
        sq += polyBlep(phase, dt);
        sq -= polyBlep((phase + 0.5) % 1, dt);
        tri = dt * sq + (1 - dt) * tri;
        v = tri * 4;
        break;
      }
      case 'noise':
        v = rnd() * 2 - 1;
        break;
      case 'pink': {
        const w = rnd() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        v = (b0 + b1 + b2 + w * 0.1848) * 0.25;
        break;
      }
      case 'brown':
        brown = (brown + 0.02 * (rnd() * 2 - 1)) / 1.02;
        v = brown * 3.5;
        break;
    }
    phase += dt;
    if (phase >= 1) phase -= Math.floor(phase);
    return v;
  };
}

export function adsr(t: number, dur: number, e: Envelope = {}): number {
  const a = e.attack ?? 0.01;
  const d = e.decay ?? 0.1;
  const s = e.sustain ?? 0.7;
  const r = e.release ?? 0.2;
  if (t < 0) return 0;
  if (t < a) return t / a;
  if (t < a + d) return 1 - ((t - a) / d) * (1 - s);
  if (t < dur) return s;
  if (t < dur + r) return s * (1 - (t - dur) / r);
  return 0;
}

// --------------------------------------------------------------- generator specs (data) → clips

/** A tone. `freq` may be a note name; `to` sweeps the pitch. */
export function tone(opts: { freq: number | string; to?: number | string; duration: number; wave?: Wave; envelope?: Envelope; gain?: number } & AudioClipOptions): AudioClip {
  const { freq, to, duration, wave, envelope, gain: amp, ...rest } = opts;
  return generator('tone', { freq: noteToHz(freq), to: to !== undefined ? noteToHz(to) : undefined, duration, wave: wave ?? 'sine', envelope, amp: amp ?? 0.5 }, { duration, ...rest });
}

/** Melodic / chord sequence played by a simple synth voice. */
export function sequenceSynth(notes: Note[], opts: { wave?: Wave; envelope?: Envelope; gain?: number } & AudioClipOptions = {}): AudioClip {
  const { wave, envelope, gain: amp, ...rest } = opts;
  const end = Math.max(0, ...notes.map((n) => n.start + n.duration)) + (envelope?.release ?? 0.2);
  return generator('notes', { notes: notes.map((n) => ({ ...n, freq: noteToHz(n.note) })), wave: wave ?? 'saw', envelope, amp: amp ?? 0.3, duration: end }, { duration: end, ...rest });
}

/** Sound-design presets for motion graphics: whoosh, riser, impact, click, pop, kick, snare, hat. */
export function sfx(kind: 'whoosh' | 'riser' | 'impact' | 'click' | 'pop' | 'kick' | 'snare' | 'hat' | 'ding', opts: { duration?: number; seed?: number } & AudioClipOptions = {}): AudioClip {
  const defaults: Record<string, number> = { whoosh: 0.8, riser: 3, impact: 1.5, click: 0.05, pop: 0.15, kick: 0.5, snare: 0.3, hat: 0.1, ding: 1.5 };
  const { duration = defaults[kind]!, seed = 1, ...rest } = opts;
  return generator('sfx', { kind, duration, seed }, { duration, ...rest });
}

// --------------------------------------------------------------- generator implementations

export type GeneratorImpl = (params: Record<string, any>, sampleRate: number, length: number) => Float32Array[];

const generators = new Map<string, GeneratorImpl>();
export function registerGenerator(kind: string, impl: GeneratorImpl): void {
  generators.set(kind, impl);
}
export function getGenerator(kind: string): GeneratorImpl | undefined {
  return generators.get(kind);
}

registerGenerator('tone', (p, sr, len) => {
  const osc = oscillator(p.wave, sr);
  const out = new Float32Array(len);
  const dur = p.duration as number;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const f = p.to ? p.freq * Math.pow(p.to / p.freq, Math.min(1, t / dur)) : p.freq;
    out[i] = osc(f) * adsr(t, dur - (p.envelope?.release ?? 0.05), p.envelope ?? { attack: 0.005, release: 0.05, sustain: 1 }) * p.amp;
  }
  return [out, new Float32Array(out)];
});

registerGenerator('notes', (p, sr, len) => {
  const out = new Float32Array(len);
  for (const n of p.notes as (Note & { freq: number })[]) {
    const osc = oscillator(p.wave, sr);
    const s = Math.round(n.start * sr);
    const e = Math.min(len, Math.round((n.start + n.duration + (p.envelope?.release ?? 0.2)) * sr));
    for (let i = s; i < e; i++) out[i]! += osc(n.freq) * adsr((i - s) / sr, n.duration, p.envelope) * (n.velocity ?? 1) * p.amp;
  }
  return [out, new Float32Array(out)];
});

registerGenerator('sfx', (p, sr, len) => {
  const rnd = createRandom(p.seed);
  const L = new Float32Array(len);
  const R = new Float32Array(len);
  const dur = p.duration as number;
  let lp = 0, lp2 = 0, bp = 0, bp2 = 0;
  const noise = () => rnd() * 2 - 1;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const x = t / dur;
    let v = 0;
    let pan = 0;
    switch (p.kind) {
      case 'whoosh': {
        // band-passed noise sweeping up then down with a swelling envelope
        const f = 300 + 3500 * Math.sin(Math.PI * x);
        const k = Math.min(1, (2 * Math.PI * f) / sr);
        bp += k * (noise() - bp);
        bp2 += k * (bp - bp2);
        v = (bp - bp2) * 3 * Math.pow(Math.sin(Math.PI * x), 2);
        pan = Math.sin(Math.PI * (x - 0.5));
        break;
      }
      case 'riser': {
        const f = 200 * Math.pow(30, x);
        const k = Math.min(1, (2 * Math.PI * f) / sr);
        lp += k * (noise() - lp);
        v = (lp * 0.6 + Math.sin(2 * Math.PI * (110 * Math.pow(4, x)) * t) * 0.2) * x * x;
        break;
      }
      case 'impact': {
        const body = Math.sin(2 * Math.PI * (45 + 80 * Math.exp(-t * 18)) * t) * Math.exp(-t * 3.5);
        lp += 0.08 * (noise() - lp);
        v = body * 0.9 + lp * Math.exp(-t * 8) * 0.9;
        break;
      }
      case 'kick':
        v = Math.sin(2 * Math.PI * (50 + 120 * Math.exp(-t * 30)) * t) * Math.exp(-t * 9);
        break;
      case 'snare': {
        lp2 += 0.5 * (noise() - lp2);
        v = (noise() - lp2) * Math.exp(-t * 22) * 0.8 + Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 30) * 0.5;
        break;
      }
      case 'hat': {
        lp += 0.7 * (noise() - lp);
        v = (noise() - lp) * Math.exp(-t * 60) * 0.6;
        break;
      }
      case 'click':
        v = (i < sr * 0.002 ? noise() : 0) + Math.sin(2 * Math.PI * 2000 * t) * Math.exp(-t * 300) * 0.5;
        break;
      case 'pop':
        v = Math.sin(2 * Math.PI * (300 + 900 * Math.exp(-t * 40)) * t) * Math.exp(-t * 25);
        break;
      case 'ding':
        v = (Math.sin(2 * Math.PI * 1318.5 * t) + 0.5 * Math.sin(2 * Math.PI * 2637 * t) + 0.25 * Math.sin(2 * Math.PI * 3951 * t)) * Math.exp(-t * 3) * 0.4;
        break;
    }
    const a = ((pan + 1) * Math.PI) / 4;
    L[i] = v * Math.cos(a) * Math.SQRT2 * 0.7;
    R[i] = v * Math.sin(a) * Math.SQRT2 * 0.7;
  }
  return [L, R];
});
