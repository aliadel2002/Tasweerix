import type { Composition, MediaInfo, SceneNode } from '@tasweerix/core';

/** A keyframe on the timeline: `t` in timeline seconds, `ease` a Tasweerix easing name (default linear). */
export interface TKey<T> {
  t: number;
  v: T;
  ease?: string;
}
/** A static value or keyframes. */
export type TKeyed<T> = T | TKey<T>[];

/**
 * Spatial adjustments of a clip, applied after it is fitted to the frame. Distances are in
 * sequence pixels, y pointing down.
 */
export interface TTransform {
  /** Offset of the picture's center from the frame center. */
  position?: TKeyed<[number, number]>;
  scale?: TKeyed<[number, number]>;
  /** Degrees, clockwise. */
  rotation?: TKeyed<number>;
  /** Pivot of scale and rotation, relative to the picture's center. */
  anchor?: [number, number];
  /** 0 – 1. */
  opacity?: TKeyed<number>;
  /** How the picture fits the frame before the transform (default: fit inside it). */
  conform?: 'fill' | 'none';
  /** Edges trimmed off the picture, as fractions of its width / height. */
  crop?: { left: number; right: number; top: number; bottom: number };
}

/** Editor-agnostic timeline model extracted from a composition. */
export interface TClip {
  name: string;
  /** Source path (as written in the project) and absolute URL for the editor. */
  src: string;
  url: string;
  kind: 'video' | 'image' | 'audio' | 'title';
  /** Global timeline start / duration (seconds). */
  start: number;
  duration: number;
  /** Source in-point (seconds) and playback speed. */
  sourceIn: number;
  speed: number;
  info: MediaInfo;
  /** Gain in dB (audio). */
  gainDb?: number;
  /** Transition into this clip from the previous one on the same track. */
  transitionIn?: { type: string; duration: number };
  /** Video clip carries its own audio (not exported separately to FCPXML). */
  withAudio?: boolean;
  /** Text of a title clip (kind 'title'). */
  text?: string;
  /** Position, scale, rotation, opacity and crop. */
  transform?: TTransform;
  /**
   * Variable speed: timeline time (seconds) → source time (seconds, same reference as `sourceIn`),
   * linear between keys and extended along the end segments. `speed` holds the average rate.
   */
  timeMap?: { t: number; v: number }[];
}

export interface TTrack {
  kind: 'video' | 'audio';
  clips: TClip[];
}

export interface TimelineModel {
  name: string;
  width: number;
  height: number;
  fps: number;
  sampleRate: number;
  duration: number;
  video: TTrack[];
  audio: TTrack[];
  markers: { time: number; label: string; color?: string }[];
  /** Export: nodes that could not be represented. Import: elements that were skipped or simplified. */
  unsupported: string[];
}

const MEDIA = new Set(['video', 'image', 'photo']);

/** Absolute global duration factor through parent speed changes. */
function speedChain(n: SceneNode): number {
  let s = 1;
  for (let p = n.parent; p; p = p.parent) s *= p.speed || 1;
  return s;
}

export function buildTimelineModel(comp: Composition, toUrl: (src: string) => string): TimelineModel {
  const items: { group: TClip[]; start: number; end: number }[] = [];
  const unsupported = new Set<string>();

  const leafClip = (n: SceneNode): TClip | null => {
    const props = n.props as Record<string, unknown>;
    const src = String(props.src ?? '');
    const info = ((n as unknown as { info?: MediaInfo }).info ?? {}) as MediaInfo;
    const start = n.globalStart();
    const d = n.effectiveDuration();
    const duration = Number.isFinite(d) ? d / speedChain(n) : Math.max(0, comp.duration - start);
    if (n.kind === 'video') {
      const v = n as unknown as { trimIn: number; speed: number; muted: boolean };
      return { name: n.name ?? src.split('/').pop()!, src, url: toUrl(src), kind: 'video', start, duration, sourceIn: v.trimIn, speed: Math.abs(v.speed * speedChain(n)), info, withAudio: !v.muted && !!info.hasAudio };
    }
    return { name: n.name ?? src.split('/').pop()!, src, url: toUrl(src), kind: 'image', start, duration, sourceIn: 0, speed: 1, info };
  };

  const visit = (n: SceneNode) => {
    if (n.kind === 'xseq') {
      // Transition sequence: children go to one track joined by transitions.
      const t = n as unknown as { transitions: { type: string; duration: number }[] };
      const group: TClip[] = [];
      n.children.forEach((c, i) => {
        const leaf = MEDIA.has(c.kind) ? leafClip(c) : null;
        if (!leaf) {
          unsupported.add(`${c.kind}:${c.name ?? c.id} (inside transition sequence)`);
          return;
        }
        if (i > 0 && t.transitions[i - 1] && t.transitions[i - 1]!.type !== 'cut') leaf.transitionIn = { type: t.transitions[i - 1]!.type, duration: t.transitions[i - 1]!.duration };
        group.push(leaf);
      });
      if (group.length) items.push({ group, start: group[0]!.start, end: Math.max(...group.map((g) => g.start + g.duration)) });
      return;
    }
    if (MEDIA.has(n.kind)) {
      const c = leafClip(n);
      if (c) items.push({ group: [c], start: c.start, end: c.start + c.duration });
      if (n.filters.length) unsupported.add(`filters on ${n.name ?? n.id}: ${n.filters.map((f) => f.kind).join(', ')}`);
      return;
    }
    if (n.kind !== 'group' && n.kind !== 'comp' && n.kind !== 'adjustment') unsupported.add(`${n.kind}:${n.name ?? n.id}`);
    n.children.forEach(visit);
  };
  comp.root.children.forEach(visit);

  // Lane assignment: an item goes above every earlier item it overlaps (keeps z-order).
  const trackOf: number[] = [];
  items.forEach((it, i) => {
    let t = 0;
    for (let j = 0; j < i; j++) {
      const o = items[j]!;
      if (o.start < it.end - 1e-6 && it.start < o.end - 1e-6) t = Math.max(t, trackOf[j]! + 1);
    }
    trackOf.push(t);
  });
  const video: TTrack[] = [];
  items.forEach((it, i) => {
    const k = trackOf[i]!;
    while (video.length <= k) video.push({ kind: 'video', clips: [] });
    video[k]!.clips.push(...it.group);
  });
  video.forEach((t) => t.clips.sort((a, b) => a.start - b.start));

  // Audio: explicit clips (implicit video audio stays attached to its video clip).
  const audioItems = comp.allAudioClips().filter((a) => !a.implicit && a.src && !a.muted);
  const audio: TTrack[] = [];
  for (const a of audioItems) {
    const dur = Number.isFinite(a.effectiveDuration()) ? a.effectiveDuration() : Math.max(0, comp.duration - a.start);
    const clip: TClip = { name: a.name ?? a.src!.split('/').pop()!, src: a.src!, url: toUrl(a.src!), kind: 'audio', start: a.start, duration: dur, sourceIn: a.trimIn, speed: Math.abs(a.speed), info: a.info ?? {}, gainDb: typeof a.gain === 'number' ? a.gain : undefined };
    let track = audio.find((t) => t.clips.every((c) => c.start + c.duration <= clip.start + 1e-6 || clip.start + clip.duration <= c.start + 1e-6));
    if (!track) {
      track = { kind: 'audio', clips: [] };
      audio.push(track);
    }
    track.clips.push(clip);
  }
  audio.forEach((t) => t.clips.sort((a, b) => a.start - b.start));

  return {
    name: comp.name,
    width: comp.width,
    height: comp.height,
    fps: comp.fps,
    sampleRate: comp.sampleRate,
    duration: comp.duration,
    video,
    audio,
    markers: comp.markers.map((m) => ({ time: m.time, label: m.label })),
    unsupported: [...unsupported],
  };
}

/**
 * Converts a track's overlapping transition pairs into end-to-end edits:
 * each transition cut lands at the middle of the overlap (media handles cover the rest).
 */
export function resolveTransitions(clips: TClip[]): { clip: TClip; start: number; duration: number; sourceIn: number; transition?: { duration: number; type: string; at: number } }[] {
  const out: { clip: TClip; start: number; duration: number; sourceIn: number; transition?: { duration: number; type: string; at: number } }[] = [];
  clips.forEach((c, i) => {
    let start = c.start;
    let end = c.start + c.duration;
    let sourceIn = c.sourceIn;
    const next = clips[i + 1];
    if (c.transitionIn && i > 0) {
      const half = c.transitionIn.duration / 2;
      start += half;
      sourceIn += half * c.speed;
    }
    if (next?.transitionIn) end -= next.transitionIn.duration / 2;
    out.push({ clip: c, start, duration: Math.max(0, end - start), sourceIn, transition: c.transitionIn && i > 0 ? { duration: c.transitionIn.duration, type: c.transitionIn.type, at: c.start } : undefined });
  });
  return out;
}

/** Source time of a variable-speed clip at timeline time `t` (linear, extended along the end segments). */
export function timeMapAt(map: { t: number; v: number }[], t: number): number {
  if (map.length === 1) return map[0]!.v;
  let i = 0;
  while (i < map.length - 2 && t > map[i + 1]!.t) i++;
  const a = map[i]!;
  const b = map[i + 1]!;
  return b.t > a.t ? a.v + ((t - a.t) * (b.v - a.v)) / (b.t - a.t) : a.v;
}
