import type { XmlNode } from '@tasweerix/core';
import { timeMapAt, type TClip, type TimelineModel, type TTrack } from './model';

const IMAGE_RE = /\.(png|jpe?g|webp|gif|avif|bmp|tiff?|psd|exr|dpx|svg)$/i;
const AUDIO_RE = /\.(mp3|wav|aiff?|aac|m4a|ogg|opus|flac|caf)$/i;

export const isImagePath = (p: string): boolean => IMAGE_RE.test(p);
export const isAudioPath = (p: string): boolean => AUDIO_RE.test(p);

/** Decodes a media reference (file:// URL, Windows path, plain path) into a file path. */
export function urlToPath(url: string): string {
  if (!url) return url;
  if (/^file:/i.test(url)) {
    let p = url.replace(/^file:/i, '');
    // file:///x and file://localhost/x are local; file://server/share/x is a UNC path.
    const host = /^\/\/([^/]*)/.exec(p);
    if (host) p = !host[1] || /^localhost$/i.test(host[1]) ? p.slice(2 + host[1]!.length) : `//${host[1]}${p.slice(2 + host[1]!.length)}`;
    p = decodeURIComponent(p);
    // file:///C:/x → C:/x (Premiere on Windows writes file://localhost/C%3a/x)
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
    return p;
  }
  return url;
}

export const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;

/** An empty model to fill while parsing. */
export function emptyModel(partial: Partial<TimelineModel> = {}): TimelineModel {
  return { name: 'Imported timeline', width: 1920, height: 1080, fps: 30, sampleRate: 48000, duration: 0, video: [], audio: [], markers: [], unsupported: [], ...partial };
}

/** A clip as produced by parsers, before track assignment. */
export interface PlacedClip extends TClip {
  /** Lane (FCPXML), track index (OTIO/EDL/xmeml) — used to keep tracks apart and ordered. */
  lane: number;
}

export interface TransitionMark {
  lane: number;
  /** Start and end of the transition on the timeline. */
  start: number;
  end: number;
  type: string;
}

const EPS = 1e-6;

/**
 * Turns an edit point with a transition into the overlapping layout used by Tasweerix
 * (`transition.sequence`): the outgoing clip runs to the transition's end and the incoming clip
 * starts at the transition's start (using media handles on both sides). Accepts both cut-based
 * layouts (clips meet inside the transition: FCPXML, OTIO, EDL) and already overlapping clips
 * (FCP7 XML).
 */
export function applyTransition(clips: PlacedClip[], t: TransitionMark): boolean {
  const lane = clips.filter((c) => c.lane === t.lane).sort((a, b) => a.start - b.start);
  const near = (x: number, y: number) => Math.abs(x - y) < 1e-3;
  for (let i = 0; i < lane.length - 1; i++) {
    const a = lane[i]!;
    const b = lane[i + 1]!;
    const aEnd = a.start + a.duration;
    if (near(aEnd, t.end) && near(b.start, t.start) && t.end > t.start) {
      b.transitionIn = { type: t.type, duration: t.end - t.start };
      return true;
    }
    // The cut is the boundary between two contiguous clips inside the transition span.
    if (!near(b.start, aEnd) || aEnd < t.start - 1e-3 || aEnd > t.end + 1e-3) continue;
    const before = aEnd - t.start;
    const after = t.end - aEnd;
    a.duration += after;
    b.start -= before;
    b.duration += before;
    b.sourceIn -= before * b.speed;
    b.transitionIn = { type: t.type, duration: t.end - t.start };
    return true;
  }
  return false;
}

/**
 * A transition at the head or tail of a run of clips (nothing on the other side) fades the clip in
 * from, or out to, nothing. It becomes opacity keyframes on that clip; sound is left as is.
 */
export function applyEdgeFade(clips: PlacedClip[], t: TransitionMark): boolean {
  const near = (x: number, y: number) => Math.abs(x - y) < 1e-3;
  const lane = clips.filter((c) => c.lane === t.lane && c.kind !== 'audio');
  const head = lane.find((c) => near(c.start, t.start) && !lane.some((o) => near(o.start + o.duration, c.start)));
  const tail = lane.find((c) => near(c.start + c.duration, t.end) && !lane.some((o) => o !== c && near(o.start, t.end)));
  const clip = head ?? tail;
  if (!clip || t.end <= t.start) return false;
  const prior = clip.transform?.opacity;
  if (prior !== undefined && typeof prior !== 'number') return false;
  const o = prior ?? 1;
  const keys = head ? [{ t: t.start, v: 0 }, { t: t.end, v: o }] : [{ t: t.start, v: o }, { t: t.end, v: 0 }];
  clip.transform = { ...clip.transform, opacity: keys };
  return true;
}

/** Maps editor transition names to Tasweerix transition kinds. */
export function transitionKind(name: string | undefined): string {
  const n = (name ?? '').toLowerCase();
  if (/dip|fade to (black|color|white)/.test(n)) return 'dip';
  if (/wipe/.test(n)) return 'wipe';
  if (/iris|circle/.test(n)) return 'iris';
  if (/slide|push/.test(n)) return 'slide';
  if (/zoom/.test(n)) return 'zoom';
  if (/blur/.test(n)) return 'blur';
  if (/clock/.test(n)) return 'clock';
  if (/flash/.test(n)) return 'flash';
  // Cross dissolve, SMPTE_Dissolve, additive dissolve … and anything unknown.
  if (['crossfade', 'dip', 'wipe', 'iris', 'slide', 'zoom', 'blur', 'clock', 'flash', 'glitch'].includes(n)) return n;
  return 'crossfade';
}

/**
 * Assigns placed clips to tracks. Clips keep their lane order (lower lanes are lower tracks); clips
 * that overlap inside a lane (other than transition overlaps) spill onto an extra track above.
 */
function toTracks(clips: PlacedClip[], kind: 'video' | 'audio', laneOrder: (a: number, b: number) => number): TTrack[] {
  const lanes = [...new Set(clips.map((c) => c.lane))].sort(laneOrder);
  const tracks: TTrack[] = [];
  for (const lane of lanes) {
    const own: TTrack[] = [];
    for (const c of clips.filter((x) => x.lane === lane).sort((a, b) => a.start - b.start)) {
      const { lane: _lane, ...clip } = c;
      const fits = (t: TTrack) => {
        const last = t.clips[t.clips.length - 1];
        if (!last) return true;
        const overlap = last.start + last.duration - clip.start;
        return overlap <= EPS || (clip.transitionIn !== undefined && Math.abs(overlap - clip.transitionIn.duration) < 1e-3);
      };
      let t = own.find(fits);
      if (!t) {
        t = { kind, clips: [] };
        own.push(t);
      }
      if (t.clips.length && !fits(t)) clip.transitionIn = undefined;
      t.clips.push(clip);
    }
    tracks.push(...own);
  }
  return tracks;
}

/**
 * Finishes a parsed model: drops empty clips, folds audio that duplicates a video clip's own sound
 * back into that clip, assigns tracks and computes the duration.
 */
export function finishModel(m: TimelineModel, placed: PlacedClip[]): TimelineModel {
  const clips = placed.filter((c) => c.duration > EPS);
  const videos = clips.filter((c) => c.kind !== 'audio');
  const audios = clips.filter((c) => c.kind === 'audio');
  // OTIO / EDL / xmeml carry a video clip's sound as a separate audio clip of the same media.
  const keptAudio = audios.filter((a) => {
    const v = videos.find((x) => x.kind === 'video' && x.src === a.src && Math.abs(x.start - a.start) < 1e-3 && Math.abs(x.duration - a.duration) < 1e-3 && Math.abs(x.sourceIn - a.sourceIn) < 1e-3 && Math.abs(x.speed - a.speed) < 1e-6);
    if (v && !v.withAudio && a.gainDb === undefined) {
      v.withAudio = true;
      return false;
    }
    return true;
  });
  m.video = toTracks(videos, 'video', (a, b) => a - b);
  // Audio lanes: FCPXML uses negative lanes below the video (-1 first), other formats 0, 1, 2 …
  m.audio = toTracks(keptAudio, 'audio', (a, b) => (a < 0 && b < 0 ? b - a : a - b));
  let end = 0;
  for (const t of [...m.video, ...m.audio]) for (const c of t.clips) end = Math.max(end, c.start + c.duration);
  m.duration = Math.max(m.duration || 0, end);
  m.markers.sort((a, b) => a.time - b.time);
  return m;
}

// ------------------------------------------------------------------ XML helpers

export const kids = (n: XmlNode | undefined, tag?: string): XmlNode[] => (n ? n.children.filter((c) => (tag ? c.tag === tag : true)) : []);
export const kid = (n: XmlNode | undefined, tag: string): XmlNode | undefined => n?.children.find((c) => c.tag === tag);
export function find(n: XmlNode | undefined, tag: string): XmlNode | undefined {
  if (!n) return undefined;
  for (const c of n.children) {
    if (c.tag === tag) return c;
    const f = find(c, tag);
    if (f) return f;
  }
  return undefined;
}
export function findAll(n: XmlNode | undefined, tag: string, out: XmlNode[] = []): XmlNode[] {
  if (!n) return out;
  for (const c of n.children) {
    if (c.tag === tag) out.push(c);
    findAll(c, tag, out);
  }
  return out;
}
/** Concatenated text content of an element and its descendants. */
export function textOf(n: XmlNode | undefined): string {
  if (!n) return '';
  return (n.text + n.children.map(textOf).join('')).trim();
}
export const kidText = (n: XmlNode | undefined, tag: string): string | undefined => {
  const k = kid(n, tag);
  return k ? textOf(k) : undefined;
};

// ------------------------------------------------------------------ retiming

/**
 * Applies a time map (timeline seconds → source seconds) to a clip. A map with one constant
 * forward rate stays a plain `speed`; ramps, freezes inside the clip and reverse playback keep
 * the map, with `speed` set to the average rate.
 */
export function applyTimeMap(c: PlacedClip, pts: { t: number; v: number }[], notes: Set<string>): void {
  const map = pts.filter((p, i) => i === 0 || p.t > pts[i - 1]!.t + 1e-9);
  if (map.length < 2) return;
  const slopes = map.slice(1).map((p, i) => (p.v - map[i]!.v) / (p.t - map[i]!.t));
  const at = (t: number) => timeMapAt(map, t);
  const end = c.start + c.duration;
  c.sourceIn = Math.max(0, at(c.start));
  if (slopes.every((s) => Math.abs(s - slopes[0]!) < 1e-6) && slopes[0]! >= 0) {
    c.speed = slopes[0]!;
    c.timeMap = undefined;
    return;
  }
  c.timeMap = map;
  c.speed = c.duration > 0 ? Math.abs(at(end) - at(c.start)) / c.duration : 1;
  if (c.withAudio) notes.add(`sound of variable-speed clip ${c.name} (imported silent)`);
}
