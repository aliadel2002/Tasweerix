import { makeContext, resolve, type AudioClip, type AudioEffectSpec, type BusSpec, type Composition, type FadeCurve, type FrameContext } from '@tasweerix/core';
import { createAudio, resample, reverseAudio, type AudioData } from './buffer';
import { isOffline } from './dsp/processor';
import { pitchShift, timeStretch } from './dsp/stretch';
import { getAudioEffect } from './effects';
import { getGenerator } from './synth';

export type PcmLoader = (src: string, sampleRate: number, channels: number) => Promise<Float32Array[]>;

export interface MixOptions {
  /** Loads decoded audio for a source path. */
  load: PcmLoader;
  /** Render window (seconds, composition time). */
  start?: number;
  duration?: number;
  sampleRate?: number;
  channels?: number;
  /** Return per-bus/per-clip stems in addition to the master mix. */
  stems?: boolean;
}

export interface MixResult {
  master: AudioData;
  stems?: Map<string, AudioData>;
}

const BLOCK = 256;

export function fadeGain(x: number, curve: FadeCurve): number {
  x = Math.min(1, Math.max(0, x));
  switch (curve) {
    case 'linear':
      return x;
    case 'exponential':
      return x * x * x;
    case 'logarithmic':
      return Math.sqrt(x);
    case 's-curve':
      return x * x * (3 - 2 * x);
    default:
      return Math.sin((x * Math.PI) / 2);
  }
}

function clipCtx(base: FrameContext, t: number, duration: number): FrameContext {
  return { ...base, time: t, duration, progress: duration > 0 && Number.isFinite(duration) ? Math.min(1, Math.max(0, t / duration)) : 0 };
}

function resolveParams(spec: AudioEffectSpec, ctx: FrameContext): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(spec.params)) out[k] = resolve(v, ctx);
  return out;
}

/** Applies an effect chain to a buffer in place (returns possibly-new channel arrays). */
export function applyEffects(
  chs: Float32Array[],
  effects: AudioEffectSpec[],
  sampleRate: number,
  base: FrameContext,
  sidechains: (spec: AudioEffectSpec) => Float32Array[] | undefined,
  timeOffset = 0,
): Float32Array[] {
  for (const spec of effects) {
    const factory = getAudioEffect(spec.kind);
    if (!factory) {
      console.warn(`[tasweerix] unknown audio effect "${spec.kind}"`);
      continue;
    }
    const proc = factory(sampleRate, chs.length);
    const side = spec.sidechain ? sidechains(spec) : undefined;
    const dry = spec.mix !== undefined ? chs.map((c) => c.slice()) : null;
    if (isOffline(proc)) {
      chs = proc.offline(chs, sampleRate, resolveParams(spec, clipCtx(base, timeOffset, Infinity)), side);
    } else {
      const len = chs[0]!.length;
      for (let off = 0; off < len; off += BLOCK) {
        const n = Math.min(BLOCK, len - off);
        const ctx = clipCtx(base, timeOffset + off / sampleRate, Infinity);
        proc.process(chs, off, n, resolveParams(spec, ctx), side);
      }
    }
    if (dry) {
      const len = chs[0]!.length;
      for (let off = 0; off < len; off += BLOCK) {
        const m = resolve(spec.mix!, clipCtx(base, timeOffset + off / sampleRate, Infinity));
        for (let c = 0; c < chs.length; c++)
          for (let i = off; i < Math.min(len, off + BLOCK); i++) chs[c]![i] = (dry[c]![i] ?? 0) * (1 - m) + chs[c]![i]! * m;
      }
    }
  }
  return chs;
}

function effectTail(effects: AudioEffectSpec[], sampleRate: number, ctx: FrameContext): number {
  let t = 0;
  for (const e of effects) {
    const f = getAudioEffect(e.kind);
    const p = f?.(sampleRate, 2);
    if (p?.tail) t += p.tail(resolveParams(e, ctx));
  }
  return t;
}

/** Produces the clip's source signal (after trim/speed/pitch/reverse/loop) for its full duration. */
async function clipSource(clip: AudioClip, sr: number, channels: number, load: PcmLoader): Promise<AudioData> {
  const dur = clip.effectiveDuration();
  if (clip.generator) {
    const gen = getGenerator(clip.generator.kind);
    if (!gen) throw new Error(`Unknown audio generator "${clip.generator.kind}"`);
    const len = Math.round((Number.isFinite(dur) ? dur : 10) * sr);
    return { sampleRate: sr, channels: gen(clip.generator.params, sr, len).slice(0, channels) };
  }
  let data: AudioData = { sampleRate: sr, channels: await load(clip.src!, sr, channels) };
  const total = data.channels[0]!.length;
  // Trim
  const inS = Math.round(clip.trimIn * sr);
  const outS = clip.trimOut !== undefined ? Math.round(clip.trimOut * sr) : total;
  data = { sampleRate: sr, channels: data.channels.map((c) => c.slice(Math.max(0, inS), Math.min(total, outS))) };
  if (clip.reverse) data = reverseAudio(data);
  const speed = Math.abs(clip.speed || 1);
  if (speed !== 1) {
    if (clip.preservePitch) data = { sampleRate: sr, channels: timeStretch(data.channels, sr, 1 / speed) };
    else data = resample(data, 1 / speed, sr);
  }
  if (clip.pitch) data = pitchShift(data, clip.pitch);
  // Loop / fit to duration
  if (Number.isFinite(dur)) {
    const want = Math.round(dur * sr);
    const have = data.channels[0]!.length;
    if (have !== want) {
      data = {
        sampleRate: sr,
        channels: data.channels.map((c) => {
          const o = new Float32Array(want);
          if (clip.loop && have > 0) for (let i = 0; i < want; i++) o[i] = c[i % have]!;
          else o.set(c.subarray(0, Math.min(have, want)));
          return o;
        }),
      };
    }
  }
  return data;
}

/**
 * Renders the composition's audio: clips (incl. audio of video nodes) → clip FX → buses → master.
 * Pure TypeScript: produces identical results in Node and in the browser.
 */
export async function renderMix(comp: Composition, opts: MixOptions): Promise<MixResult> {
  const sr = opts.sampleRate ?? comp.sampleRate;
  const nch = opts.channels ?? 2;
  const winStart = opts.start ?? 0;
  const winDur = opts.duration ?? comp.duration;
  const winLen = Math.round(winDur * sr);
  const base = comp.contextAt(0);
  const clips = comp.allAudioClips().filter((c) => !c.muted);

  // 1. Render every clip's processed signal (pre-bus), placed on the composition timeline.
  interface Rendered {
    clip: AudioClip;
    data: Float32Array[];
    /** Sample offset of data[0] relative to the window start. */
    offset: number;
  }
  const rendered = new Map<string, Rendered>();
  const pendingDucks: { r: Rendered; spec: AudioEffectSpec }[] = [];
  for (const clip of clips) {
    const dur = clip.effectiveDuration();
    const clipStart = clip.start;
    if (clipStart >= winStart + winDur) continue;
    if (Number.isFinite(dur) && clipStart + dur + 30 < winStart) continue;
    const src = await clipSource(clip, sr, nch, opts.load);
    const clipDur = src.channels[0]!.length / sr;
    const tail = effectTail(clip.effects.filter((e) => e.kind !== 'duck'), sr, base);
    const len = Math.round((clipDur + tail) * sr);
    let chs = src.channels.map((c) => {
      const o = new Float32Array(len);
      o.set(c.subarray(0, len));
      return o;
    });
    // Gain envelope, fades, pan (block-rate automation with per-sample interpolation).
    const srcLen = src.channels[0]!.length;
    const fadeIn = Math.round(clip.fadeInDur * sr);
    const fadeOut = Math.round(clip.fadeOutDur * sr);
    for (let off = 0; off < srcLen; off += BLOCK) {
      const n = Math.min(BLOCK, srcLen - off);
      const ctx = clipCtx({ ...base, globalTime: clipStart + off / sr }, off / sr, clipDur);
      const ctx2 = clipCtx({ ...base, globalTime: clipStart + (off + n) / sr }, (off + n) / sr, clipDur);
      const g0 = Math.pow(10, resolve(clip.gain, ctx) / 20) * resolve(clip.volume, ctx);
      const g1 = Math.pow(10, resolve(clip.gain, ctx2) / 20) * resolve(clip.volume, ctx2);
      const pan = Math.max(-1, Math.min(1, resolve(clip.pan, ctx)));
      const a = ((pan + 1) * Math.PI) / 4;
      const pg = nch === 2 ? [Math.cos(a) * Math.SQRT2, Math.sin(a) * Math.SQRT2] : [1];
      for (let i = 0; i < n; i++) {
        const k = off + i;
        let g = g0 + ((g1 - g0) * i) / n;
        if (k < fadeIn) g *= fadeGain(k / fadeIn, clip.fadeInCurve);
        if (k > srcLen - fadeOut) g *= fadeGain((srcLen - k) / fadeOut, clip.fadeOutCurve);
        for (let c = 0; c < nch; c++) chs[c]![k]! *= g * Math.min(1, pg[c] ?? 1);
      }
    }
    const r: Rendered = { clip, data: chs, offset: Math.round((clipStart - winStart) * sr) };
    // Clip effects except ducks (ducks need other clips' signals).
    const normal = clip.effects.filter((e) => e.kind !== 'duck');
    chs = applyEffects(chs, normal, sr, { ...base, globalTime: clipStart }, () => undefined);
    r.data = chs;
    for (const d of clip.effects.filter((e) => e.kind === 'duck')) pendingDucks.push({ r, spec: d });
    rendered.set(clip.id, r);
  }

  // 2. Ducking (sidechain from other clips or buses' pre-fx sums).
  const busPreSum = (name: string): { data: Float32Array[]; offset: number } => {
    const out = Array.from({ length: nch }, () => new Float32Array(winLen));
    for (const r of rendered.values()) if (r.clip.bus === name) addInto(out, r.data, r.offset);
    return { data: out, offset: 0 };
  };
  for (const { r, spec } of pendingDucks) {
    const sc = spec.sidechain!;
    let side: { data: Float32Array[]; offset: number } | undefined;
    if (typeof sc === 'string') side = busPreSum(sc);
    else {
      const other = rendered.get(sc.id) ?? [...rendered.values()].find((x) => x.clip === sc);
      if (other) side = { data: other.data, offset: other.offset };
    }
    if (!side) continue;
    // Align sidechain to the clip's local sample index.
    const len = r.data[0]!.length;
    const aligned = side.data.map((c) => {
      const o = new Float32Array(len);
      for (let i = 0; i < len; i++) o[i] = c[i + r.offset - side!.offset] ?? 0;
      return o;
    });
    r.data = applyEffects(r.data, [spec], sr, { ...base, globalTime: r.clip.start }, () => aligned);
  }

  // 3. Buses → master.
  const busOrder = orderBuses(comp.buses);
  const busBuffers = new Map<string, Float32Array[]>();
  const getBus = (name: string) => {
    let b = busBuffers.get(name);
    if (!b) {
      b = Array.from({ length: nch }, () => new Float32Array(winLen));
      busBuffers.set(name, b);
    }
    return b;
  };
  for (const r of rendered.values()) addInto(getBus(comp.buses.has(r.clip.bus) ? r.clip.bus : 'master'), r.data, r.offset);
  const stems = opts.stems ? new Map<string, AudioData>() : undefined;
  for (const bus of busOrder) {
    let data = getBus(bus.name);
    data = applyEffects(data, bus.effects, sr, { ...base, globalTime: winStart }, (spec) => (typeof spec.sidechain === 'string' ? busBuffers.get(spec.sidechain) : undefined), winStart);
    // Bus gain/pan automation.
    for (let off = 0; off < winLen; off += BLOCK) {
      const ctx = clipCtx({ ...base, globalTime: winStart + off / sr }, winStart + off / sr, comp.duration);
      const g = Math.pow(10, resolve(bus.gain, ctx) / 20);
      const pan = resolve(bus.pan, ctx);
      const a = ((pan + 1) * Math.PI) / 4;
      const pg = nch === 2 && pan !== 0 ? [Math.cos(a) * Math.SQRT2, Math.sin(a) * Math.SQRT2] : [1, 1];
      for (let c = 0; c < nch; c++) for (let i = off; i < Math.min(winLen, off + BLOCK); i++) data[c]![i]! *= g * Math.min(1, pg[c]!);
    }
    busBuffers.set(bus.name, data);
    stems?.set(bus.name, { sampleRate: sr, channels: data });
    if (bus.name !== 'master') addInto(getBus(bus.output || 'master'), data, 0);
  }
  if (stems) for (const r of rendered.values()) stems.set(`clip:${r.clip.name ?? r.clip.id}`, { sampleRate: sr, channels: r.data });
  return { master: { sampleRate: sr, channels: getBus('master') }, stems };
}

function addInto(dst: Float32Array[], src: Float32Array[], offset: number) {
  const len = dst[0]!.length;
  for (let c = 0; c < dst.length; c++) {
    const s = src[Math.min(c, src.length - 1)]!;
    const d = dst[c]!;
    const from = Math.max(0, -offset);
    const to = Math.min(s.length, len - offset);
    for (let i = from; i < to; i++) d[i + offset]! += s[i]!;
  }
}

/** Topological order so buses feeding others are processed first; master last. */
function orderBuses(buses: Map<string, BusSpec>): BusSpec[] {
  const out: BusSpec[] = [];
  const seen = new Set<string>();
  const visit = (b: BusSpec) => {
    if (seen.has(b.name)) return;
    seen.add(b.name);
    for (const other of buses.values()) if (other.output === b.name && other.name !== b.name) visit(other);
    out.push(b);
  };
  for (const b of buses.values()) if (b.name !== 'master') visit(b);
  visit(buses.get('master')!);
  return out;
}

/** Offline render helper with a silent loader (for synth-only projects and tests). */
export function silentLoader(): PcmLoader {
  return async () => {
    throw new Error('No audio loader configured');
  };
}

export { createAudio, makeContext };
