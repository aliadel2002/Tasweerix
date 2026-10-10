import {
  AudioClip,
  getEnv,
  group,
  keys,
  sequence,
  toSeconds,
  video,
  type AnimProps,
  type BaseProps,
  type Env,
  type GroupNode,
  type NodeOptions,
  type SceneNode,
  type TimeInput,
  type Track,
  type VideoOptions,
  type VideoProps,
} from '@tasweerix/core';
import { detectBeats, detectOnsets, detectSilence, integratedLoudness, loudnessCurve, mono, type BeatInfo, type SilenceRange } from '@tasweerix/audio';

/** A kept segment of a source: [in, out] in source seconds. */
export interface Cut {
  in: number;
  out: number;
}

const ANALYSIS_RATE = 16000;

async function pcm(src: string, env: Env, rate = ANALYSIS_RATE): Promise<{ sampleRate: number; channels: Float32Array[] }> {
  if (!env.loadPcm) throw new Error('smart: this environment cannot decode audio');
  return { sampleRate: rate, channels: [mono({ sampleRate: rate, channels: await env.loadPcm(src, rate, 1) })] };
}

/** Caches an async analysis through the environment's cache (disk in Node, server in browsers). */
async function cached<T>(env: Env, key: string, src: string, compute: () => Promise<T>): Promise<T> {
  const hit = await env.cache?.get<T>(key, src);
  if (hit !== undefined) return hit;
  const v = await compute();
  await env.cache?.set(key, v, src);
  return v;
}

const dBstr = (n: number) => n.toFixed(1);

export interface SilenceOptions {
  /** Level (dBFS) under which audio counts as silence. */
  threshold?: number;
  /** Minimum silence length to cut (seconds). */
  minSilence?: TimeInput;
  /** Audio kept around speech at each cut (seconds). */
  padding?: TimeInput;
}

/** Silent ranges of a media file. */
export async function silences(src: string, o: SilenceOptions = {}, env: Env = getEnv()): Promise<SilenceRange[]> {
  const threshold = o.threshold ?? -40;
  const min = toSeconds(o.minSilence ?? 0.5);
  return cached(env, `silence:${src}:${dBstr(threshold)}:${min}`, src, async () => detectSilence(await pcm(src, env), { threshold, minDuration: min, padding: 0 }));
}

/**
 * Cut list that removes silences (jump-cut editing for talks, podcasts, vlogs).
 * Returns plain data — paste it into code or feed it to `cutsToSequence`.
 */
export async function silenceCuts(src: string, o: SilenceOptions & { duration?: number } = {}, env: Env = getEnv()): Promise<Cut[]> {
  const pad = toSeconds(o.padding ?? 0.12);
  const ranges = await silences(src, o, env);
  const info = o.duration ?? (await env.probe(src)).duration ?? 0;
  const cuts: Cut[] = [];
  let pos = 0;
  for (const r of ranges) {
    const end = Math.max(pos, r.start + pad);
    if (end - pos > 0.05) cuts.push({ in: +pos.toFixed(3), out: +Math.min(info || end, end).toFixed(3) });
    pos = Math.max(pos, r.end - pad);
  }
  if ((info || pos) - pos > 0.05) cuts.push({ in: +pos.toFixed(3), out: +(info || pos).toFixed(3) });
  return cuts;
}

/** Builds a sequence of trimmed video clips from a cut list. */
export function cutsToSequence(src: string, cuts: Cut[], opts: VideoOptions & AnimProps<VideoProps & BaseProps> & { gap?: TimeInput; overlap?: TimeInput } = {}): GroupNode {
  const { gap, overlap, ...vopts } = opts;
  return sequence(
    cuts.map((c) => video(src, { ...vopts, trim: [c.in, c.out] })),
    { gap, overlap, name: `cuts:${src}` },
  );
}

/** One call: remove silences from a video and return the edited sequence. */
export async function autoCut(src: string, o: SilenceOptions & VideoOptions & AnimProps<VideoProps & BaseProps> = {}, env: Env = getEnv()): Promise<GroupNode> {
  const { threshold, minSilence, padding, ...vopts } = o;
  return cutsToSequence(src, await silenceCuts(src, { threshold, minSilence, padding }, env), vopts);
}

/** Tempo and beat times of a music file. */
export async function beats(src: string, env: Env = getEnv()): Promise<BeatInfo> {
  return cached(env, `beats:${src}`, src, async () => detectBeats(await pcm(src, env, 22050)));
}

/** Onsets (transients) of an audio file — good cue points for hits and flashes. */
export async function onsets(src: string, o: { sensitivity?: number } = {}, env: Env = getEnv()): Promise<number[]> {
  return cached(env, `onsets:${src}:${o.sensitivity ?? 0.5}`, src, async () => detectOnsets(await pcm(src, env, 22050), o));
}

/** Beat grid: every `every`-th beat (bars when every = 4), optionally offset. */
export async function beatGrid(src: string, o: { every?: number; offset?: number; from?: TimeInput; to?: TimeInput } = {}, env: Env = getEnv()): Promise<number[]> {
  const b = await beats(src, env);
  const from = toSeconds(o.from ?? 0);
  const to = o.to !== undefined ? toSeconds(o.to) : Infinity;
  return b.beats.filter((_, i) => (i - (o.offset ?? 0)) % (o.every ?? 1) === 0 && i >= (o.offset ?? 0)).filter((t) => t >= from && t <= to);
}

/**
 * Retimes consecutive items so every cut lands on a beat. Each item keeps at least `minBeats`
 * beats (and at most its natural length if `maxNatural`). Items must be children of a sequence.
 */
export function snapToBeats(items: SceneNode[], beatTimes: number[], o: { start?: number; minBeats?: number; beatsPerItem?: number | number[] } = {}): SceneNode[] {
  let t = o.start ?? beatTimes[0] ?? 0;
  let bi = beatTimes.findIndex((b) => b >= t - 1e-6);
  if (bi < 0) bi = 0;
  items.forEach((item, i) => {
    const per = Array.isArray(o.beatsPerItem) ? (o.beatsPerItem[i] ?? 1) : o.beatsPerItem;
    let next: number;
    if (per) next = bi + per;
    else {
      // As many beats as fit the item's natural duration (at least minBeats).
      const natural = item.effectiveDuration();
      next = bi + (o.minBeats ?? 1);
      while (Number.isFinite(natural) && beatTimes[next + 1] !== undefined && beatTimes[next + 1]! - t <= natural) next++;
    }
    const end = beatTimes[Math.min(next, beatTimes.length - 1)] ?? t + 1;
    item.duration = Math.max(1 / 60, end - t);
    t = end;
    bi = Math.min(next, beatTimes.length - 1);
  });
  return items;
}

/** Beat-synced montage: clips cut on beats of a music track. */
export async function beatMontage(music: string, clips: SceneNode[], o: { every?: number; beatsPerClip?: number; offset?: number } & NodeOptions = {}, env: Env = getEnv()): Promise<GroupNode> {
  const grid = await beatGrid(music, { every: o.every ?? 1, offset: o.offset }, env);
  snapToBeats(clips, grid, { beatsPerItem: o.beatsPerClip ?? 2 });
  const seq = sequence(clips, { name: o.name ?? 'beatMontage' });
  seq.start = grid[0] ?? 0;
  return seq;
}

/** Scene-change times of a video (ffmpeg scene score, host-side). */
export async function scenes(src: string, o: { threshold?: number } = {}, env: Env = getEnv()): Promise<number[]> {
  if (!env.analyze) throw new Error('smart.scenes(): environment has no host analysis (run through the Tasweerix server or CLI)');
  const res = await cached(env, `scenes:${src}:${o.threshold ?? 0.3}`, src, async () => (await env.analyze!('scenes', src, { threshold: o.threshold ?? 0.3 })) as { time: number }[]);
  return res.map((r) => r.time);
}

/** Splits a video into its shots (one trimmed node per scene). */
export async function shots(src: string, o: { threshold?: number; minLength?: number } = {}, env: Env = getEnv()): Promise<Cut[]> {
  const cuts = await scenes(src, o, env);
  const dur = (await env.probe(src)).duration ?? 0;
  const bounds = [0, ...cuts, dur];
  const out: Cut[] = [];
  for (let i = 0; i < bounds.length - 1; i++) if (bounds[i + 1]! - bounds[i]! >= (o.minLength ?? 0.3)) out.push({ in: bounds[i]!, out: bounds[i + 1]! });
  return out;
}

/** Measures a clip's integrated loudness (LUFS) from its source file. */
export async function loudness(src: string, env: Env = getEnv()): Promise<number> {
  return cached(env, `lufs:${src}`, src, async () => integratedLoudness({ sampleRate: 48000, channels: await env.loadPcm!(src, 48000, 2) }));
}

/** Sets each clip's gain so its source reaches a target loudness (e.g. −16 LUFS for podcasts). */
export async function matchLoudness(clips: AudioClip[], targetLufs = -16, env: Env = getEnv()): Promise<AudioClip[]> {
  for (const c of clips) {
    if (!c.src) continue;
    const l = await loudness(c.src, env);
    if (Number.isFinite(l)) c.gain = +(targetLufs - l).toFixed(2);
  }
  return clips;
}

/**
 * Leveler: gain automation that rides the short-term loudness toward a target (like a slow AGC),
 * returned as an editable keyframe track in dB.
 */
export async function loudnessFollow(src: string, o: { target?: number; maxBoost?: number; maxCut?: number; resolution?: number; trimIn?: number } = {}, env: Env = getEnv()): Promise<Track<number>> {
  const target = o.target ?? -18;
  const curve = await cached(env, `lcurve:${src}:${o.resolution ?? 0.5}`, src, async () => loudnessCurve({ sampleRate: 48000, channels: await env.loadPcm!(src, 48000, 2) }, o.resolution ?? 0.5, 3));
  const list = curve
    .filter((p) => Number.isFinite(p.lufs) && p.lufs > -60)
    .map((p) => [Math.max(0, p.time - (o.trimIn ?? 0)), Math.max(-(o.maxCut ?? 12), Math.min(o.maxBoost ?? 12, target - p.lufs))] as [number, number]);
  return keys(list.length ? list : [[0, 0]], { ease: 'inOutSine' });
}

/** Routes voice clips to a "voice" bus and ducks music under it. */
export function autoDuck(music: AudioClip | AudioClip[], voices: AudioClip[], o: { amount?: number; threshold?: number; attack?: number; release?: number; bus?: string } = {}): void {
  const bus = o.bus ?? 'voice';
  for (const v of voices) v.toBus(bus);
  for (const m of Array.isArray(music) ? music : [music]) m.duck(bus, { amount: o.amount ?? -14, threshold: o.threshold ?? -38, attack: o.attack ?? 0.05, release: o.release ?? 0.5 });
}

/** Formats a cut list as TypeScript you can paste into a project. */
export function cutsToCode(src: string, cuts: Cut[]): string {
  return `sequence([\n${cuts.map((c) => `  video('${src}', { trim: [${c.in}, ${c.out}] }),`).join('\n')}\n])`;
}

/** Groups helper re-export for convenience. */
export { group };

export const smart = { silences, silenceCuts, cutsToSequence, autoCut, beats, onsets, beatGrid, snapToBeats, beatMontage, scenes, shots, loudness, matchLoudness, loudnessFollow, autoDuck, cutsToCode };
