import { resolveTransitions, type TClip, type TimelineModel } from './model';

const rt = (seconds: number, rate: number) => ({ OTIO_SCHEMA: 'RationalTime.1', rate, value: Math.round(seconds * rate) });
const range = (start: number, dur: number, rate: number) => ({ OTIO_SCHEMA: 'TimeRange.1', start_time: rt(start, rate), duration: rt(dur, rate) });

function clipJson(c: TClip, sourceIn: number, duration: number, rate: number) {
  const effects = c.speed !== 1 ? [{ OTIO_SCHEMA: 'LinearTimeWarp.1', name: 'speed', effect_name: 'LinearTimeWarp', time_scalar: c.speed, metadata: {} }] : [];
  const available = c.info.duration !== undefined ? range(0, c.info.duration, rate) : null;
  return {
    OTIO_SCHEMA: 'Clip.2',
    name: c.name,
    // OTIO lays clips out by source_range duration; speed is carried by the LinearTimeWarp effect.
    source_range: range(sourceIn, duration, rate),
    media_references: {
      DEFAULT_MEDIA:
        c.kind === 'title'
          ? { OTIO_SCHEMA: 'GeneratorReference.1', name: c.name, generator_kind: 'Text', parameters: { text: c.text ?? '' }, available_range: null, metadata: {} }
          : { OTIO_SCHEMA: 'ExternalReference.1', target_url: c.url, available_range: available, metadata: {}, name: c.src.split('/').pop() },
    },
    active_media_reference_key: 'DEFAULT_MEDIA',
    effects,
    markers: [],
    enabled: true,
    metadata: { tasweerix: { src: c.src, kind: c.kind, gainDb: c.gainDb, ...(c.kind === 'title' ? { text: c.text ?? '' } : {}) } },
  };
}

function gap(duration: number, rate: number) {
  return { OTIO_SCHEMA: 'Gap.1', name: '', source_range: range(0, duration, rate), effects: [], markers: [], enabled: true, metadata: {} };
}

/** Exports a timeline as OpenTimelineIO JSON (.otio). */
export function toOTIO(m: TimelineModel): string {
  const rate = m.fps;
  const track = (kind: 'Video' | 'Audio', clips: TClip[], name: string) => {
    const children: unknown[] = [];
    let cursor = 0;
    // Overlapping transition pairs become cuts with Transition items (video, and the sync sound of video clips).
    const parts = resolveTransitions(clips);
    for (const p of parts) {
      if (p.start - cursor > 1e-6) children.push(gap(p.start - cursor, rate));
      if (p.transition) {
        const half = p.transition.duration / 2;
        children.push({ OTIO_SCHEMA: 'Transition.1', name: p.transition.type, transition_type: 'SMPTE_Dissolve', in_offset: rt(half, rate), out_offset: rt(half, rate), metadata: { tasweerix: { type: p.transition.type } } });
      }
      children.push(clipJson(p.clip, p.sourceIn, p.duration, rate));
      cursor = p.start + p.duration;
    }
    return { OTIO_SCHEMA: 'Track.1', name, kind, children, source_range: null, effects: [], markers: [], enabled: true, metadata: {} };
  };
  // Video audio as separate audio tracks, one per video track (OTIO clips reference a single media stream).
  const embedded = m.video.map((t) => t.clips.filter((c) => c.withAudio && c.kind === 'video').map((c) => ({ ...c, kind: 'audio' as const }))).filter((t) => t.length);
  const tracks = [
    ...m.video.map((t, i) => track('Video', t.clips, `V${i + 1}`)),
    ...embedded.map((clips, i) => track('Audio', clips, `A-sync${embedded.length > 1 ? i + 1 : ''}`)),
    ...m.audio.map((t, i) => track('Audio', t.clips, `A${i + 1}`)),
  ];
  const timeline = {
    OTIO_SCHEMA: 'Timeline.1',
    name: m.name,
    global_start_time: rt(0, rate),
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      children: tracks,
      source_range: null,
      effects: [],
      markers: m.markers.map((mk) => ({ OTIO_SCHEMA: 'Marker.2', name: mk.label, marked_range: range(mk.time, 0, rate), color: 'RED', comment: '', metadata: {} })),
      enabled: true,
      metadata: {},
    },
    metadata: { tasweerix: { width: m.width, height: m.height, fps: m.fps, unsupported: m.unsupported } },
  };
  return JSON.stringify(timeline, null, 2);
}
