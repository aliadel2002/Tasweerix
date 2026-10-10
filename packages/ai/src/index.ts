import { buildingComposition, getEnv, toSeconds, type Env, type GroupNode, type TimeInput } from '@tasweerix/core';
import { captions, type CaptionStyle, type Cue } from '@tasweerix/media';
import type { Effort, Transcript } from './types';

export * from './types';

/** A kept range of a source, as in @tasweerix/smart: [in, out] in source seconds. */
export interface Cut {
  in: number;
  out: number;
}

async function cached<T>(env: Env, key: string, src: string | undefined, compute: () => Promise<T>): Promise<T> {
  const hit = await env.cache?.get<T>(key, src);
  if (hit !== undefined) return hit;
  const v = await compute();
  await env.cache?.set(key, v, src);
  return v;
}

function host(env: Env, what: string): NonNullable<Env['analyze']> {
  if (!env.analyze) throw new Error(`${what}: this environment has no host analysis (run it through the Tasweerix CLI or studio, or a Node env with @tasweerix/ai/node loaded)`);
  return env.analyze;
}

/** Stable short hash for cache keys (FNV-1a). */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** An image for a model: a project image file, or a video frame at a source time. */
export type ImageRef = string | { src: string; time: number };

export interface GenerateOptions {
  system?: string;
  /** Project images (or video frames) to show the model. */
  images?: ImageRef[];
  effort?: Effort;
  maxTokens?: number;
  model?: string;
  /** Change it to get a different (but again cached) answer for the same prompt. */
  variant?: string | number;
}

async function run(kind: 'text' | 'json', prompt: string, o: GenerateOptions & { schema?: Record<string, unknown> }, env: Env): Promise<string> {
  const params = { prompt, system: o.system, images: o.images, schema: o.schema, effort: o.effort, maxTokens: o.maxTokens, model: o.model };
  const key = `ai.generate:${hash(JSON.stringify({ ...params, kind, v: o.variant ?? 0 }))}`;
  const call = host(env, 'ai.generate()');
  // With images, the first image's file stamp invalidates the cached answer when it changes.
  const first = o.images?.[0];
  return cached(env, key, first === undefined ? undefined : typeof first === 'string' ? first : first.src, async () => (await call('ai.generate', '', params)) as string);
}

/**
 * Generates text with the configured AI provider (Claude by default). The answer is cached on
 * disk, so every render (and every parallel export worker) sees the same text.
 *   const tagline = await ai.generate('A five-word tagline for a summer surf trip video');
 */
export async function generate(prompt: string, o: GenerateOptions = {}, env: Env = getEnv()): Promise<string> {
  return run('text', prompt, o, env);
}

/** Generates JSON matching a JSON Schema (structured output). */
export async function generateJSON<T = unknown>(prompt: string, schema: Record<string, unknown>, o: GenerateOptions = {}, env: Env = getEnv()): Promise<T> {
  return JSON.parse(await run('json', prompt, { ...o, schema }, env)) as T;
}

/** Describes an image or a video frame (`time` in source seconds). */
export async function describe(src: string, o: { time?: TimeInput; prompt?: string; effort?: Effort } = {}, env: Env = getEnv()): Promise<string> {
  const image: ImageRef = o.time !== undefined ? { src, time: toSeconds(o.time) } : src;
  return generate(o.prompt ?? 'Describe this picture for a video editor in two sentences: subject, setting, light, framing and mood.', { images: [image], effort: o.effort ?? 'low' }, env);
}

export interface TranscribeOptions {
  /** Spoken language (helps accuracy; detected otherwise). */
  language?: string;
  /** Names and terms that appear in the speech. */
  prompt?: string;
  /** Source range (seconds). */
  from?: TimeInput;
  to?: TimeInput;
}

/** Speech to text with timings (host-side, cached). */
export async function transcribe(src: string, o: TranscribeOptions = {}, env: Env = getEnv()): Promise<Transcript> {
  const params = { language: o.language ?? null, prompt: o.prompt ?? null, from: o.from !== undefined ? toSeconds(o.from) : 0, to: o.to !== undefined ? toSeconds(o.to) : null };
  const call = host(env, 'ai.transcribe()');
  return cached(env, `ai.transcribe:${src}:${JSON.stringify(params)}`, src, async () => (await call('ai.transcribe', src, params)) as Transcript);
}

/**
 * Splits a transcript into caption-sized cues (by words when timings exist, otherwise by
 * proportionally timed phrases).
 */
export function transcriptToCues(t: Transcript, o: { maxChars?: number; maxDuration?: number; offset?: number } = {}): Cue[] {
  const maxChars = o.maxChars ?? 42;
  const maxDur = o.maxDuration ?? 6;
  const off = o.offset ?? 0;
  const cues: Cue[] = [];
  for (const s of t.segments) {
    const words = s.words?.length ? s.words : splitWords(s);
    let cur: { start: number; end: number; text: string }[] = [];
    const flush = () => {
      if (!cur.length) return;
      cues.push({ start: cur[0]!.start + off, end: cur[cur.length - 1]!.end + off, text: cur.map((w) => w.text).join(' ').replace(/\s+([,.!?،؟])/g, '$1'), words: cur.map((w) => ({ ...w, start: w.start + off, end: w.end + off })) });
      cur = [];
    };
    for (const w of words) {
      const len = cur.map((x) => x.text).join(' ').length + w.text.length + 1;
      if (cur.length && (len > maxChars || w.end - cur[0]!.start > maxDur)) flush();
      cur.push(w);
      if (/[.!?؟]$/.test(w.text)) flush();
    }
    flush();
  }
  return cues;
}

/** Words of a segment without word timings, timed by character count. */
function splitWords(s: { start: number; end: number; text: string }): { start: number; end: number; text: string }[] {
  const words = s.text.trim().split(/\s+/).filter(Boolean);
  const total = words.reduce((n, w) => n + w.length + 1, 0) || 1;
  let t = s.start;
  return words.map((w) => {
    const d = ((w.length + 1) / total) * (s.end - s.start);
    const out = { start: t, end: t + d, text: w };
    t += d;
    return out;
  });
}

/** Translates cues (keeps timings), e.g. Arabic captions for English speech. */
export async function translateCues(cues: Cue[], language: string, o: { effort?: Effort } = {}, env: Env = getEnv()): Promise<Cue[]> {
  if (!cues.length) return [];
  const res = await generateJSON<{ lines: string[] }>(
    `Translate each subtitle line into ${language}. Keep the meaning, keep each line short enough to read on screen, and return exactly ${cues.length} lines in the same order.\n\n${cues.map((c, i) => `${i + 1}. ${c.text}`).join('\n')}`,
    { type: 'object', properties: { lines: { type: 'array', items: { type: 'string' } } }, required: ['lines'], additionalProperties: false },
    { effort: o.effort ?? 'low' },
    env,
  );
  return cues.map((c, i) => ({ start: c.start, end: c.end, text: res.lines[i] ?? c.text }));
}

export interface AutoCaptionOptions extends TranscribeOptions {
  style?: CaptionStyle;
  /** Composition time where source time `trimIn` plays (default 0). */
  start?: TimeInput;
  /** Source in-point of the clip the captions belong to. */
  trimIn?: TimeInput;
  /** Translate the captions into this language. */
  translateTo?: string;
  maxChars?: number;
}

/**
 * Captions from speech, ready to add: transcribes, splits into cues, optionally translates.
 *   c.add(await ai.captions('interview.mp4', { language: 'ar', style: { highlight: '#ffd400' } }))
 */
export async function autoCaptions(src: string, o: AutoCaptionOptions = {}, env: Env = getEnv()): Promise<GroupNode> {
  const t = await transcribe(src, o, env);
  const trimIn = o.trimIn !== undefined ? toSeconds(o.trimIn) : 0;
  let cues = transcriptToCues(t, { maxChars: o.maxChars, offset: (o.start !== undefined ? toSeconds(o.start) : 0) - trimIn }).filter((c) => c.end > 0);
  if (o.translateTo) cues = await translateCues(cues, o.translateTo, {}, env);
  const g = captions(cues, o.style);
  g.name = `captions:${src}`;
  return g;
}

/**
 * Transcript-based editing: describe the edit in words and get a cut list.
 *   const cuts = await ai.textCuts('talk.mp4', 'Keep only the part about pricing, drop the ums');
 *   c.add(smart.cutsToSequence('talk.mp4', cuts))
 */
export async function textCuts(src: string, instruction: string, o: TranscribeOptions & { padding?: number; effort?: Effort } = {}, env: Env = getEnv()): Promise<Cut[]> {
  const t = await transcribe(src, o, env);
  if (!t.segments.length) return [];
  const listing = t.segments.map((s, i) => `[${i}] ${s.start.toFixed(2)}–${s.end.toFixed(2)} ${s.text.trim()}`).join('\n');
  const res = await generateJSON<{ keep: number[] }>(
    `You are editing a video from its transcript. Numbered segments with source times follow.\n\nEdit request: ${instruction}\n\nReturn the numbers of the segments to keep, in playback order. Prefer whole thoughts; never cut a sentence in half.\n\n${listing}`,
    { type: 'object', properties: { keep: { type: 'array', items: { type: 'integer' } } }, required: ['keep'], additionalProperties: false },
    { effort: o.effort ?? 'medium' },
    env,
  );
  const pad = o.padding ?? 0.08;
  const cuts: Cut[] = [];
  let prev = -2;
  for (const i of res.keep) {
    const s = t.segments[i];
    if (!s) continue;
    const last = cuts[cuts.length - 1];
    // Consecutive segments merge into one cut.
    if (last && i === prev + 1) last.out = +(s.end + pad).toFixed(3);
    else cuts.push({ in: +Math.max(0, s.start - pad).toFixed(3), out: +(s.end + pad).toFixed(3) });
    prev = i;
  }
  return cuts;
}

/** Chapter markers from speech: [{ time, label }] — also added to the composition being built. */
export async function chapters(src: string, o: TranscribeOptions & { max?: number; effort?: Effort; addMarkers?: boolean } = {}, env: Env = getEnv()): Promise<{ time: number; label: string }[]> {
  const t = await transcribe(src, o, env);
  if (!t.segments.length) return [];
  const listing = t.segments.map((s) => `${s.start.toFixed(1)}: ${s.text.trim()}`).join('\n');
  const res = await generateJSON<{ chapters: { time: number; label: string }[] }>(
    `Split this transcript into at most ${o.max ?? 8} chapters. For each, give the start time (one of the listed times) and a short title in the transcript's language.\n\n${listing}`,
    { type: 'object', properties: { chapters: { type: 'array', items: { type: 'object', properties: { time: { type: 'number' }, label: { type: 'string' } }, required: ['time', 'label'], additionalProperties: false } } }, required: ['chapters'], additionalProperties: false },
    { effort: o.effort ?? 'low' },
    env,
  );
  const comp = buildingComposition();
  if (comp && o.addMarkers !== false) for (const ch of res.chapters) comp.marker(ch.time, ch.label);
  return res.chapters;
}

/** Everything in one namespace: `ai.generate(...)`, `ai.captions(...)`. */
export const ai = { generate, generateJSON, describe, transcribe, transcriptToCues, translateCues, captions: autoCaptions, textCuts, chapters };
