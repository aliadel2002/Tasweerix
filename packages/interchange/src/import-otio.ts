import type { MediaInfo } from '@tasweerix/core';
import type { TEffect, TimelineModel } from './model';
import { mapEffect } from './effects';
import { applyTransition, baseName, emptyModel, finishModel, isImagePath, transitionKind, urlToPath, type PlacedClip, type TransitionMark } from './util';

type Json = Record<string, any>;

const schema = (o: Json | null | undefined): string => String(o?.OTIO_SCHEMA ?? '').split('.')[0]!;
const secs = (rt: Json | null | undefined): number => (rt && rt.rate ? Number(rt.value) / Number(rt.rate) : 0);
const rangeOf = (r: Json | null | undefined): { start: number; duration: number } | null => (r ? { start: secs(r.start_time), duration: secs(r.duration) } : null);

function mediaRef(clip: Json): Json | null {
  if (clip.media_references && clip.active_media_reference_key) return clip.media_references[clip.active_media_reference_key] ?? null;
  return clip.media_reference ?? null;
}

/** Duration an item occupies on its track. */
function itemDuration(item: Json): number {
  const sr = rangeOf(item.source_range);
  if (sr) return sr.duration;
  if (schema(item) === 'Clip') {
    const ar = rangeOf(mediaRef(item)?.available_range);
    if (ar) return ar.duration;
  }
  if (schema(item) === 'Stack') return Math.max(0, ...(item.children ?? []).map((t: Json) => (t.children ?? []).reduce((s: number, c: Json) => s + (schema(c) === 'Transition' ? 0 : itemDuration(c)), 0)));
  return 0;
}

/**
 * Reads an OpenTimelineIO (.otio JSON) timeline: tracks, clips, gaps, transitions, linear time
 * warps, freeze frames, nested stacks and markers.
 */
export function fromOTIO(text: string): TimelineModel {
  const root = JSON.parse(text) as Json;
  const timeline = schema(root) === 'Timeline' ? root : schema(root) === 'SerializableCollection' ? (root.children ?? []).find((c: Json) => schema(c) === 'Timeline') : null;
  if (!timeline) throw new Error('OTIO: no Timeline found');
  const meta = (timeline.metadata?.tasweerix ?? {}) as Json;
  const m = emptyModel({ name: timeline.name || 'Imported timeline' });
  let rate = Number(timeline.global_start_time?.rate) || 0;
  const placed: PlacedClip[] = [];
  const transitions: TransitionMark[] = [];
  const notes = new Set<string>();

  const markersOf = (item: Json, toGlobal: (t: number) => number) => {
    for (const mk of item.markers ?? []) {
      const r = rangeOf(mk.marked_range);
      m.markers.push({ time: Math.max(0, toGlobal(r?.start ?? 0)), label: mk.name || mk.comment || 'Marker', color: mk.color ? String(mk.color).toLowerCase() : undefined });
    }
  };

  /** Walks a stack; `offset` maps stack time to timeline time, `window` clips to the visible range. */
  const walkStack = (stack: Json, offset: number, laneBase: number, scale: number, window: [number, number]) => {
    const tracks = (stack.children ?? []) as Json[];
    let videoIndex = 0;
    let audioIndex = 0;
    for (const track of tracks) {
      if (schema(track) !== 'Track') continue;
      const isAudio = String(track.kind).toLowerCase() === 'audio';
      const lane = laneBase + (isAudio ? audioIndex++ : videoIndex++) * scale;
      if (track.enabled === false) {
        notes.add(`disabled track ${track.name || lane}`);
        continue;
      }
      markersOf(track, (t) => offset + t);
      let pos = 0;
      const items = (track.children ?? []) as Json[];
      items.forEach((item, i) => {
        const kind = schema(item);
        if (kind === 'Transition') {
          const cut = offset + pos;
          const tin = secs(item.in_offset);
          const tout = secs(item.out_offset);
          if (i > 0 && i < items.length - 1) transitions.push({ lane: isAudio ? -1000 - lane : lane, start: cut - tin, end: cut + tout, type: transitionKind(item.metadata?.tasweerix?.type ?? item.transition_type ?? item.name) });
          return;
        }
        const dur = itemDuration(item);
        const start = offset + pos;
        pos += dur;
        if (kind === 'Gap') return;
        if (item.enabled === false) {
          notes.add(`disabled ${item.name || kind}`);
          return;
        }
        const sr = rangeOf(item.source_range) ?? { start: rangeOf(mediaRef(item)?.available_range)?.start ?? 0, duration: dur };
        if (kind === 'Stack') {
          // Nested stack (compound clip): its own time sr.start maps to `start` on this track.
          // Its tracks sit between this track and the next one (scaled lanes keep the stacking order).
          walkStack(item, start - sr.start, lane, scale / 100, [Math.max(window[0], start), Math.min(window[1], start + dur)]);
          return;
        }
        if (kind !== 'Clip') {
          notes.add(`unsupported item ${item.OTIO_SCHEMA}`);
          return;
        }
        const ref = mediaRef(item) ?? {};
        const tx = (item.metadata?.tasweerix ?? {}) as Json;
        let speed = 1;
        const effects: TEffect[] = [];
        for (const fx of item.effects ?? []) {
          const fk = schema(fx);
          if (fk === 'LinearTimeWarp') speed *= Number(fx.time_scalar ?? 1);
          else if (fk === 'FreezeFrame') speed = 0;
          else {
            // Parameters live in the effect's metadata, usually under the writing application's key.
            const values = new Map<string, number>();
            const collect = (o: unknown) => {
              if (!o || typeof o !== 'object') return;
              for (const [k, v] of Object.entries(o as Json)) {
                if (typeof v === 'number') values.set(k.toLowerCase().replace(/_/g, ' '), v);
                else collect(v);
              }
            };
            collect(fx.metadata);
            const label = fx.effect_name || fx.name || fk;
            const mapped = !isAudio ? mapEffect(label, (...names) => names.map((n) => values.get(n)).find((v) => v !== undefined)) : null;
            if (!mapped) notes.add(`effect ${label} on ${item.name}`);
            else {
              effects.push(mapped.effect);
              if (mapped.approximate) notes.add(`effect ${label} on ${item.name} (approximated with fx.${mapped.effect.kind}, check the look)`);
            }
          }
        }
        markersOf(item, (t) => start + (t - sr.start));
        const refKind = schema(ref);
        let src = '';
        let url = '';
        let clipKind: PlacedClip['kind'] = isAudio ? 'audio' : 'video';
        let text: string | undefined;
        if (refKind === 'ExternalReference') {
          url = String(ref.target_url ?? '');
          src = tx.src ?? urlToPath(url);
        } else if (refKind === 'GeneratorReference' || tx.text !== undefined) {
          if (tx.text === undefined) {
            notes.add(`generator ${ref.generator_kind ?? ''} (${item.name})`);
            return;
          }
          clipKind = 'title';
          text = String(tx.text);
        } else {
          notes.add(`missing media for ${item.name || 'clip'}`);
          src = tx.src ?? item.name ?? '';
          url = src;
        }
        if (clipKind === 'video' && (tx.kind === 'image' || isImagePath(src))) clipKind = 'image';
        const avail = rangeOf(ref.available_range);
        const info: MediaInfo = avail ? { duration: avail.start + avail.duration } : {};
        // Trim to the visible window of an enclosing stack.
        let s = start;
        let e = start + dur;
        let srcIn = sr.start;
        if (s < window[0]) {
          srcIn += (window[0] - s) * speed;
          s = window[0];
        }
        e = Math.min(e, window[1]);
        if (e - s <= 1e-6) return;
        placed.push({ lane: isAudio ? -1000 - lane : lane, name: item.name || baseName(src) || 'clip', src, url: url || src, kind: clipKind, start: s, duration: e - s, sourceIn: srcIn, speed, info, gainDb: typeof tx.gainDb === 'number' ? tx.gainDb : undefined, text, effects: effects.length ? effects : undefined });
        if (!rate) rate = Number(item.source_range?.duration?.rate) || 0;
      });
    }
  };

  walkStack(timeline.tracks ?? { children: [] }, 0, 0, 1, [-Infinity, Infinity]);
  markersOf(timeline.tracks ?? {}, (t) => t);
  for (const t of transitions) if (!applyTransition(placed, t)) notes.add('a transition that is not between two clips');
  // Audio lanes were tagged negative so they never mix with video lanes; restore 0, 1, 2 …
  for (const c of placed) if (c.lane <= -1000) c.lane = -1000 - c.lane;
  m.fps = Number(meta.fps) || rate || 30;
  if (meta.width) m.width = Number(meta.width);
  if (meta.height) m.height = Number(meta.height);
  m.unsupported = [...notes];
  return finishModel(m, placed);
}
