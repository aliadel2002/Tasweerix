import { parseXml, type MediaInfo, type XmlNode } from '@tasweerix/core';
import type { TEffect, TKey, TKeyed, TTransform, TimelineModel } from './model';
import { mapEffect } from './effects';
import { applyEdgeFade, applyTimeMap, applyTransition, baseName, emptyModel, find, findAll, finishModel, isAudioPath, isImagePath, kid, kids, textOf, transitionKind, urlToPath, type PlacedClip, type TransitionMark } from './util';

/** Parses an FCPXML rational time ("1001/30000s", "5s", "0s"). */
export function fcpTime(v: string | undefined): number {
  if (!v) return 0;
  const m = /^(-?\d+(?:\.\d+)?)(?:\/(\d+))?s?$/.exec(v.trim());
  if (!m) return 0;
  return Number(m[1]) / (m[2] ? Number(m[2]) : 1);
}

/** A span of the timeline [start, end). */
type Window = [number, number];

interface Asset {
  id: string;
  name: string;
  url: string;
  start: number;
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  format?: string;
  info: MediaInfo;
}

const HANDLED_ADJUSTMENTS = new Set(['adjust-volume', 'adjust-conform', 'adjust-transform', 'adjust-crop', 'adjust-blend']);

/** Parses "x y" pairs. */
const pair = (v: string | undefined): [number, number] | undefined => {
  if (!v) return undefined;
  const [x, y] = v.trim().split(/\s+/).map(Number);
  return Number.isFinite(x) && Number.isFinite(y) ? [x!, y!] : undefined;
};

/** FCPXML keyframe interpolation → Tasweerix easing. */
const easeOf = (interp: string | undefined): string | undefined => (interp === 'ease' ? 'inOutSine' : interp === 'easeIn' ? 'inSine' : interp === 'easeOut' ? 'outSine' : undefined);

/** A single number ("20", "-3.5"); vectors and colors are not numeric parameters. */
const num1 = (v: string): number | undefined => (/^\s*-?\d+(\.\d+)?(e-?\d+)?\s*$/i.test(v) ? Number(v) : undefined);

const STORY = new Set(['asset-clip', 'clip', 'video', 'audio', 'gap', 'title', 'ref-clip', 'sync-clip', 'mc-clip', 'audition', 'spine', 'transition', 'generator', 'live-drawing']);

/** Frame rates of `conform-rate srcFrameRate` and of sequences: nominal rate, NTSC (×1000/1001), drop frame. */
interface Rate {
  nominal: number;
  ntsc: boolean;
  drop: boolean;
}
const rateOf = (fps: number, drop = false): Rate => ({ nominal: Math.round(fps), ntsc: Math.abs(fps - Math.round(fps)) > 0.001, drop });
const parseSrcRate = (v: string): Rate | undefined => {
  const m = /^(\d+(?:\.\d+)?)(d)?$/.exec(v.trim());
  return m ? rateOf(Number(m[1]) === 23.98 ? 24000 / 1001 : Number(m[1]), !!m[2]) : undefined;
};
const seconds = (r: Rate) => (r.ntsc ? 1001 / (r.nominal * 1000) : 1 / r.nominal);

/**
 * How much a clip's local time stretches on the timeline when Final Cut conforms its media rate
 * (`conform-rate` with scaling on): timeline time = local time × factor, so the media plays at
 * 1 / factor. Final Cut speeds NTSC media up to whole rates (23.98 → 24, 30, 60, also inside
 * 29.97 and 59.94 sequences), and plays 25 fps media at 24 (and the reverse) frame for frame.
 * Checked against marker positions read from Final Cut for 23.98 – 60 fps exports.
 */
export function conformFactor(media: Rate, timeline: Rate): number {
  const t = seconds(timeline);
  const m = seconds(media);
  if (media.ntsc && !media.drop) {
    if (timeline.drop) return 1;
    if (!timeline.ntsc) return 1 / 1.001;
    if (media.nominal % 24 === 0) return timeline.nominal % 24 === 0 ? 1 : 1 / 1.001;
    return timeline.nominal % 24 === 0 ? 1.001 : 1;
  }
  if (media.drop) return timeline.drop ? 1 : t / m;
  // Whole media rate.
  if (timeline.drop) return m / t;
  if (timeline.ntsc) return t / m;
  const pair = [media.nominal, timeline.nominal].sort().join('/');
  return pair === '24/25' ? t / m : 1;
}

/**
 * Reads FCPXML (1.6 – 1.13, also .fcpxmld bundles' Info.fcpxml): the project's spine, connected
 * clips and secondary storylines (lanes), compound clips, transitions, linear retimes, volume,
 * titles and markers.
 */
export function fromFCPXML(text: string): TimelineModel {
  const doc = parseXml(text);
  if (doc.tag !== 'fcpxml') throw new Error('FCPXML: missing <fcpxml> root');
  const resources = kid(doc, 'resources');
  const formats = new Map<string, XmlNode>();
  const assets = new Map<string, Asset>();
  const media = new Map<string, XmlNode>();
  const effectNames = new Map<string, string>();
  for (const r of kids(resources)) {
    const id = r.attrs.id ?? '';
    if (r.tag === 'effect') effectNames.set(id, r.attrs.name ?? '');
    if (r.tag === 'format') formats.set(id, r);
    else if (r.tag === 'media') media.set(id, r);
    else if (r.tag === 'asset') {
      const rep = kid(r, 'media-rep');
      const url = rep?.attrs.src ?? r.attrs.src ?? '';
      const fmt = formats.get(r.attrs.format ?? '');
      assets.set(id, {
        id,
        name: r.attrs.name ?? baseName(urlToPath(url)),
        url,
        start: fcpTime(r.attrs.start),
        duration: fcpTime(r.attrs.duration),
        hasVideo: r.attrs.hasVideo === '1',
        hasAudio: r.attrs.hasAudio === '1',
        format: r.attrs.format,
        info: {
          duration: fcpTime(r.attrs.duration) || undefined,
          width: fmt?.attrs.width ? Number(fmt.attrs.width) : undefined,
          height: fmt?.attrs.height ? Number(fmt.attrs.height) : undefined,
          hasVideo: r.attrs.hasVideo === '1',
          hasAudio: r.attrs.hasAudio === '1',
          channels: r.attrs.audioChannels ? Number(r.attrs.audioChannels) : undefined,
          sampleRate: r.attrs.audioRate ? Number(r.attrs.audioRate) : undefined,
        },
      });
    }
  }
  const project = find(doc, 'project');
  // Without a project the file holds browser clips (a clip or compound clip exported on its own):
  // they become a timeline of those clips, end to end.
  const sequence = project ? kid(project, 'sequence') : standaloneSequence(doc, assets, media);
  if (!sequence) throw new Error('FCPXML: no <project> or clip found');
  const fmt = formats.get(sequence.attrs.format ?? '');
  const m = emptyModel({ name: project?.attrs.name ?? sequence.attrs.name ?? 'Imported timeline' });
  if (fmt) {
    const fd = fcpTime(fmt.attrs.frameDuration);
    if (fd > 0) m.fps = +(1 / fd).toFixed(3);
    if (fmt.attrs.width) m.width = Number(fmt.attrs.width);
    if (fmt.attrs.height) m.height = Number(fmt.attrs.height);
  }
  const timelineRate = rateOf(m.fps, sequence.attrs.tcFormat === 'DF');
  /** Conform factor of an element with a `conform-rate` child (1 without one). */
  const conformOf = (el: XmlNode): number => {
    const c = kid(el, 'conform-rate');
    if (!c || c.attrs.scaleEnabled === '0') return 1;
    const media = parseSrcRate(c.attrs.srcFrameRate ?? '');
    return media ? conformFactor(media, timelineRate) : 1;
  };
  const rate = sequence.attrs.audioRate;
  if (rate) m.sampleRate = rate.startsWith('96') ? 96000 : rate.startsWith('44') ? 44100 : 48000;

  const placed: PlacedClip[] = [];
  const transitions: TransitionMark[] = [];
  const notes = new Set<string>();

  /** The time map of a retimed element: element-local time → value in its content's time. */
  const timeMapOf = (el: XmlNode): { t: number; v: number }[] | null => {
    const map = kid(el, 'timeMap');
    if (!map) return null;
    const pts = kids(map, 'timept').map((p) => ({ t: fcpTime(p.attrs.time), v: fcpTime(p.attrs.value) }));
    return pts.length >= 2 ? pts : null;
  };

  const linearSpeed = (el: XmlNode): { speed: number; sourceAt: (t: number) => number } | null => {
    const pts = timeMapOf(el);
    if (!pts) return null;
    const a = pts[0]!;
    const b = pts[pts.length - 1]!;
    const speed = b.t > a.t ? (b.v - a.v) / (b.t - a.t) : 1;
    return { speed, sourceAt: (t) => a.v + (t - a.t) * speed };
  };

  const gainOf = (el: XmlNode): number | undefined => {
    const v = kid(el, 'adjust-volume');
    if (!v?.attrs.amount) return undefined;
    const n = parseFloat(v.attrs.amount);
    return Number.isFinite(n) ? n : undefined;
  };

  /**
   * Markers of an element whose local time `t` sits at global `toGlobal(t)`. Markers outside the
   * visible window (trimmed off, or outside a compound clip's range) are hidden in Final Cut too.
   */
  const markersOf = (el: XmlNode, toGlobal: (t: number) => number, win: Window) => {
    for (const mk of kids(el)) {
      if (mk.tag !== 'marker' && mk.tag !== 'chapter-marker') continue;
      const time = toGlobal(fcpTime(mk.attrs.start));
      if (time < win[0] - 1e-6 || time >= win[1] - 1e-6) continue;
      m.markers.push({ time: Math.max(0, time), label: mk.attrs.value ?? 'Marker', color: mk.tag === 'chapter-marker' ? 'orange' : undefined });
    }
  };

  const unsupportedChildren = (el: XmlNode) => {
    for (const c of kids(el)) {
      if (c.tag === 'filter-audio') notes.add(`${c.attrs.name ?? c.tag} effect on ${el.attrs.name ?? el.tag}`);
      else if (c.tag === 'adjust-colorConform') {
        // HDR ↔ SDR tone mapping; Final Cut writes it on every clip, mostly as "none".
        if (c.attrs.enabled !== '0' && c.attrs.conformType && c.attrs.conformType !== 'conformNone') notes.add(`HDR color conform (${c.attrs.conformType}) on ${el.attrs.name ?? el.tag}`);
      } else if (c.tag.startsWith('adjust-') && !HANDLED_ADJUSTMENTS.has(c.tag)) notes.add(`${c.tag} on ${el.attrs.name ?? el.tag}`);
    }
  };

  /** Adds a media clip that references an asset. `sourceIn` is in the asset's own timecode. */
  const addAsset = (el: XmlNode, ref: string, lane: number, start: number, duration: number, sourceStart: number, forceAudio = false, retimed?: { el: XmlNode; toGlobal: (t: number) => number; toAsset: (v: number) => number }, conform = 1) => {
    const asset = assets.get(ref);
    if (!asset) {
      // A video element can also reference a generator (Clouds, Gradient …), which has no media.
      notes.add(effectNames.has(ref) ? `generator ${effectNames.get(ref) || el.attrs.name || ref}` : `missing asset ${ref} (${el.attrs.name ?? el.tag})`);
      return;
    }
    const path = urlToPath(asset.url);
    const retime = linearSpeed(el);
    const speed = (retime?.speed ?? 1) / conform;
    const image = !forceAudio && asset.hasVideo && (isImagePath(path) || asset.duration === 0);
    const audioOnly = forceAudio || (!asset.hasVideo && (asset.hasAudio || isAudioPath(path)));
    const kind: PlacedClip['kind'] = image ? 'image' : audioOnly ? 'audio' : 'video';
    const srcEnable = el.attrs.srcEnable;
    placed.push({
      lane: kind === 'audio' && lane >= 0 ? -1 : lane,
      name: el.attrs.name ?? asset.name,
      src: path,
      url: asset.url,
      kind,
      start,
      duration,
      sourceIn: Math.max(0, (retime ? retime.sourceAt(sourceStart) : sourceStart) - asset.start),
      speed,
      info: asset.info,
      gainDb: gainOf(el),
      withAudio: kind === 'video' && asset.hasAudio && srcEnable !== 'video' && el.attrs.audioRole !== 'none',
    });
    const pts = retimed && timeMapOf(retimed.el);
    if (pts && pts.length > 2 && kind !== 'image') {
      const added = placed[placed.length - 1]!;
      applyTimeMap(added, pts.map((p) => ({ t: retimed.toGlobal(p.t), v: retimed.toAsset(p.v) - asset.start })), notes);
      if (added.timeMap && kind === 'audio') {
        notes.add(`variable speed ramp on audio ${added.name} (imported at its average speed)`);
        added.timeMap = undefined;
      }
    }
  };

  /** Video filters of an element (color corrections included) as Tasweerix filters. */
  const effectsOf = (el: XmlNode, toGlobal: (t: number) => number): TEffect[] | undefined => {
    const out: TEffect[] = [];
    for (const f of kids(el, 'filter-video')) {
      const name = f.attrs.name ?? effectNames.get(f.attrs.ref ?? '') ?? 'effect';
      const where = `${name} effect on ${el.attrs.name ?? el.tag}`;
      if (f.attrs.enabled === '0') continue;
      // Parameters can nest (Color Board groups them); match them by name anywhere inside.
      const params = findAll(f, 'param');
      const reader = (...names: string[]): TKeyed<number> | undefined => {
        const param = params.find((x) => names.includes((x.attrs.name ?? '').toLowerCase().trim()));
        return param ? paramOf(param, 'value', num1, toGlobal) : undefined;
      };
      const mapped = mapEffect(name, reader);
      if (!mapped) notes.add(where);
      else {
        out.push(mapped.effect);
        if (mapped.approximate) notes.add(`${where} (approximated with fx.${mapped.effect.kind}, check the look)`);
      }
    }
    return out.length ? out : undefined;
  };

  /** Reads a parameter's static value or keyframes (times in element-local time). */
  const paramOf = <T>(adj: XmlNode, name: string, parse: (v: string) => T | undefined, toGlobal: (t: number) => number): TKeyed<T> | undefined => {
    const param = adj.tag === 'param' ? adj : kids(adj, 'param').find((p) => p.attrs.name === name);
    const anim = kid(param, 'keyframeAnimation');
    const keys: TKey<T>[] = [];
    for (const k of kids(anim, 'keyframe')) {
      const v = parse(k.attrs.value ?? '');
      if (v !== undefined) keys.push({ t: toGlobal(fcpTime(k.attrs.time)), v, ease: easeOf(k.attrs.interp) });
    }
    if (keys.length > 1) return keys;
    if (keys.length === 1) return keys[0]!.v;
    const attr = param?.attrs.value ?? (adj.tag === 'param' ? undefined : adj.attrs[name]);
    return attr === undefined ? undefined : parse(attr);
  };

  /**
   * Spatial adjustments of an element. FCPXML measures distances in percent of the frame height,
   * with y pointing up and rotation counterclockwise.
   */
  const transformOf = (el: XmlNode, toGlobal: (t: number) => number): TTransform | undefined => {
    const x: TTransform = {};
    const unit = m.height / 100;
    const toPx = (p: [number, number]): [number, number] => [p[0] * unit + 0, -p[1] * unit + 0];
    const num = (v: string) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : undefined);
    const mapKeyed = <A, B>(k: TKeyed<A> | undefined, f: (a: A) => B): TKeyed<B> | undefined =>
      k === undefined ? undefined : Array.isArray(k) && typeof k[0] === 'object' && !Array.isArray(k[0]) ? (k as TKey<A>[]).map((q) => ({ ...q, v: f(q.v) })) : f(k as A);
    const tr = kid(el, 'adjust-transform');
    if (tr) {
      const position = mapKeyed(paramOf(tr, 'position', pair, toGlobal), toPx);
      const scale = paramOf(tr, 'scale', pair, toGlobal);
      const rotation = mapKeyed(paramOf(tr, 'rotation', num, toGlobal), (r) => -r);
      const anchor = pair(tr.attrs.anchor);
      if (position !== undefined && !isZero(position)) x.position = position;
      if (scale !== undefined && !isValue(scale, [1, 1])) x.scale = scale;
      if (rotation !== undefined && !isValue(rotation, 0)) x.rotation = rotation;
      if (anchor && (anchor[0] || anchor[1])) x.anchor = toPx(anchor);
    }
    const blend = kid(el, 'adjust-blend');
    if (blend) {
      const opacity = paramOf(blend, 'amount', num, toGlobal);
      if (opacity !== undefined && !isValue(opacity, 1)) x.opacity = opacity;
      if (blend.attrs.mode && blend.attrs.mode !== '0' && !/normal/i.test(blend.attrs.mode)) notes.add(`blend mode ${blend.attrs.mode} on ${el.attrs.name ?? el.tag}`);
    }
    const crop = kid(el, 'adjust-crop');
    if (crop) {
      const mode = crop.attrs.mode ?? 'trim';
      const rect = kid(crop, mode === 'crop' ? 'crop-rect' : 'trim-rect');
      if (mode === 'pan' || kid(crop, 'pan-rect')) notes.add(`Ken Burns crop on ${el.attrs.name ?? el.tag}`);
      else if (rect) {
        // Edges in percent of the frame height, as fractions of the (frame-fitted) picture.
        const e = (k: string, size: number) => Math.min(0.49, Math.max(0, (parseFloat(rect.attrs[k] ?? '0') || 0) * unit / size));
        const c = { left: e('left', m.width), right: e('right', m.width), top: e('top', m.height), bottom: e('bottom', m.height) };
        if (kids(rect, 'param').length) notes.add(`animated crop on ${el.attrs.name ?? el.tag} (imported at its first value)`);
        if (c.left + c.right + c.top + c.bottom > 1e-6) {
          x.crop = c;
          if (mode === 'crop') {
            // Crop mode scales the remaining region up to fill the frame, around its center.
            const k = Math.min(1 / (1 - c.left - c.right), 1 / (1 - c.top - c.bottom));
            const center: [number, number] = [((c.left - c.right) / 2) * m.width, ((c.top - c.bottom) / 2) * m.height];
            x.anchor = [center[0] + (x.anchor?.[0] ?? 0), center[1] + (x.anchor?.[1] ?? 0)];
            const s = x.scale ?? [1, 1];
            x.scale = Array.isArray(s) && typeof s[0] === 'object' ? (s as TKey<[number, number]>[]).map((q) => ({ ...q, v: [q.v[0] * k, q.v[1] * k] as [number, number] })) : [(s as [number, number])[0] * k, (s as [number, number])[1] * k];
          }
        }
      }
    }
    const conform = kid(el, 'adjust-conform')?.attrs.type;
    if (conform === 'fill' || conform === 'none') x.conform = conform;
    return Object.keys(x).length ? x : undefined;
  };

  /**
   * Walks the story elements of a container. `toGlobal` maps the container's local time to the
   * timeline; `lane` is the container's absolute lane.
   */
  const walkChildren = (container: XmlNode, toGlobal: (t: number) => number, lane: number, isSpine: boolean, win: Window, origin = 0) => {
    const els = kids(container).filter((c) => STORY.has(c.tag));
    for (const el of els) {
      const relLane = el.attrs.lane !== undefined && !isSpine ? Number(el.attrs.lane) : 0;
      // Connected items (with lane) attach to their parent; spine items are on the spine's lane.
      if (!isSpine && el.attrs.lane === undefined) continue;
      walkElement(el, toGlobal, lane + relLane, win, origin);
    }
  };

  /** `origin` is the time of the container where its story begins (where transitions count from). */
  const walkElement = (el: XmlNode, toGlobal: (t: number) => number, lane: number, win: Window, origin = 0) => {
    const offset = fcpTime(el.attrs.offset);
    const duration = fcpTime(el.attrs.duration);
    const localStart = fcpTime(el.attrs.start);
    const g0 = toGlobal(offset);
    const conform = conformOf(el);
    // Element-local time → timeline time.
    const local = (t: number) => g0 + (t - localStart) * conform;
    // What of the element shows on the timeline (bounds markers of nested content).
    const inner: Window = [Math.max(win[0], g0), Math.min(win[1], g0 + duration)];
    if (el.attrs.enabled === '0') {
      notes.add(`disabled ${el.attrs.name ?? el.tag}`);
      return;
    }
    switch (el.tag) {
      case 'transition':
        transitions.push({ lane, start: g0, end: g0 + duration, type: transitionKind(el.attrs.name) });
        // Transition markers count from the container's origin, not from the transition.
        markersOf(el, (t) => g0 + (t - origin), win);
        return;
      case 'spine':
        // A storyline runs in timeline time from where it sits in its parent (a conformed parent
        // stretches the parent's local time, not the storyline's).
        walkChildren(el, (t) => g0 + t, lane, true, win);
        return;
      case 'asset-clip':
      case 'video':
      case 'audio': {
        unsupportedChildren(el);
        const before = placed.length;
        addAsset(el, el.attrs.ref ?? '', lane, g0, duration, localStart, el.tag === 'audio', { el, toGlobal: local, toAsset: (v) => v }, conform);
        const added = placed[before];
        if (added && added.kind !== 'audio') {
          added.transform = transformOf(el, local);
          added.effects = effectsOf(el, local);
        }
        break;
      }
      case 'clip': {
        unsupportedChildren(el);
        // The clip's own content: a video (with audio) or audio element in the clip's local time.
        const isMedia = (c: XmlNode) => c.tag === 'video' || c.tag === 'audio' || c.tag === 'asset-clip';
        // Usually a direct child; some writers wrap it in a gap.
        const content = kids(el).find((c) => isMedia(c) && c.attrs.lane === undefined) ?? kids(el, 'gap').flatMap((g) => kids(g).filter(isMedia))[0];
        if (content) {
          const cOff = fcpTime(content.attrs.offset);
          const cStart = fcpTime(content.attrs.start);
          // Source time at the clip's start: the content's start plus how far into it the clip begins.
          const retime = linearSpeed(el);
          const before = placed.length;
          addAsset(content, content.attrs.ref ?? '', lane, g0, duration, cStart + (localStart - cOff) * (retime?.speed ?? 1), content.tag === 'audio', { el, toGlobal: local, toAsset: (v) => cStart + (v - cOff) }, conform);
          const added = placed[before];
          if (added) {
            added.name = el.attrs.name ?? added.name;
            if (retime && !added.timeMap) added.speed = retime.speed / conform;
            if (added.kind !== 'audio') {
              added.transform = transformOf(el, local) ?? transformOf(content, local);
              added.effects = [...(effectsOf(content, local) ?? []), ...(effectsOf(el, local) ?? [])];
              if (!added.effects.length) added.effects = undefined;
            }
            added.gainDb ??= gainOf(el);
            // A sibling audio element of a video clip carries its sound.
            if (added.kind === 'video' && kids(el).some((c) => c.tag === 'audio' && c.attrs.lane === undefined)) added.withAudio = true;
          }
        } else notes.add(`clip without media: ${el.attrs.name ?? ''}`);
        break;
      }
      case 'title': {
        const t = kids(el, 'text')
          .map((x) => textOf(x))
          .join('\n');
        placed.push({ lane, name: el.attrs.name ?? 'Title', src: '', url: '', kind: 'title', start: g0, duration, sourceIn: 0, speed: 1, info: {}, text: t || el.attrs.name || 'Title', transform: transformOf(el, local), effects: effectsOf(el, local) });
        break;
      }
      case 'ref-clip':
      case 'sync-clip': {
        // Compound clip: flatten its content, trimmed to the visible range.
        const before = placed.length;
        if (el.tag === 'ref-clip') {
          const mres = media.get(el.attrs.ref ?? '');
          const seq = mres ? kid(mres, 'sequence') : undefined;
          const spine = seq ? kid(seq, 'spine') : undefined;
          // Without a start, the compound clip shows its sequence from the beginning.
          const seqStart = el.attrs.start === undefined ? fcpTime(seq?.attrs.tcStart) : localStart;
          if (spine) walkChildren(spine, (t) => g0 + (t - seqStart) * conform, lane, true, inner, fcpTime(seq?.attrs.tcStart));
          else notes.add(`compound clip without sequence: ${el.attrs.name ?? ''}`);
        } else {
          for (const c of kids(el).filter((x) => STORY.has(x.tag) && x.attrs.lane === undefined)) walkElement(c, local, lane, inner);
        }
        trimToWindow(placed.splice(before), g0, g0 + duration);
        break;
      }
      case 'mc-clip': {
        // Multicam clip: the active video angle's pictures and the active audio angle's sound.
        const mres = media.get(el.attrs.ref ?? '');
        const multicam = mres ? kid(mres, 'multicam') : undefined;
        if (!multicam) {
          notes.add(`multicam clip without angles: ${el.attrs.name ?? ''}`);
          break;
        }
        const angles = kids(multicam, 'mc-angle');
        const sources = kids(el, 'mc-source');
        const active = (kind: 'video' | 'audio') => {
          if (!sources.length) return angles[0];
          const src = sources.find((x) => (x.attrs.srcEnable ?? 'all') === 'all' || x.attrs.srcEnable === kind);
          return src ? angles.find((a) => a.attrs.angleID === src.attrs.angleID) : undefined;
        };
        const videoAngle = active('video');
        const audioAngle = active('audio');
        const walkAngle = (angle: XmlNode | undefined) => {
          const before = placed.length;
          for (const c of kids(angle).filter((x) => STORY.has(x.tag) && x.attrs.lane === undefined)) walkElement(c, local, lane, inner);
          return placed.splice(before);
        };
        const out: PlacedClip[] = [];
        for (const c of walkAngle(videoAngle)) {
          if (c.kind === 'audio') {
            if (audioAngle === videoAngle) out.push(c);
          } else out.push({ ...c, withAudio: audioAngle === videoAngle && c.withAudio });
        }
        if (audioAngle && audioAngle !== videoAngle) {
          for (const c of walkAngle(audioAngle)) {
            if (c.kind === 'audio') out.push(c);
            else if (c.kind === 'video' && c.withAudio) out.push({ ...c, kind: 'audio', lane: c.lane >= 0 ? -1 : c.lane, withAudio: undefined, transform: undefined, effects: undefined, timeMap: undefined });
          }
        }
        const unused = angles.length - new Set([videoAngle, audioAngle].filter(Boolean)).size;
        if (unused > 0) notes.add(`${unused} inactive angle${unused > 1 ? 's' : ''} of multicam ${el.attrs.name ?? ''} (only the active angles are imported)`);
        trimToWindow(out, g0, g0 + duration);
        break;
      }
      case 'audition': {
        // The first story element is the active pick; the others are alternatives.
        const pick = kids(el).find((c) => STORY.has(c.tag));
        if (pick) walkElement(pick, (t) => g0 + t - fcpTime(pick.attrs.offset), lane, win);
        const alternatives = kids(el).filter((c) => STORY.has(c.tag)).length - 1;
        if (alternatives > 0) notes.add(`${alternatives} alternative${alternatives > 1 ? 's' : ''} of audition ${pick?.attrs.name ?? ''} (only the active pick is imported)`);
        return;
      }
      case 'gap':
        break;
      default:
        notes.add(`${el.tag} ${el.attrs.name ?? ''}`.trim());
    }
    markersOf(el, local, inner);
    // Connected clips and secondary storylines.
    walkChildren(el, local, lane, false, win);
  };

  /** Keeps the parts of flattened clips inside [g0, end] (compound and multicam clips). */
  function trimToWindow(clips: PlacedClip[], g0: number, end: number) {
    for (const c of clips) {
      let s = c.start;
      let e = c.start + c.duration;
      if (s < g0) {
        c.sourceIn += (g0 - s) * c.speed;
        s = g0;
      }
      e = Math.min(e, end);
      if (e - s > 1e-6) placed.push({ ...c, start: s, duration: e - s });
    }
  }

  const spine = kid(sequence, 'spine');
  // Sequence time starts at its timecode start (01:00:00:00 in most projects).
  const tcStart = fcpTime(sequence.attrs.tcStart);
  if (spine) walkChildren(spine, (t) => t - tcStart, 0, true, [-Infinity, Infinity], tcStart);
  for (const t of transitions) if (!applyTransition(placed, t) && !applyEdgeFade(placed, t)) notes.add('a transition that is not between two clips');
  m.duration = fcpTime(sequence.attrs.duration);
  m.unsupported = [...notes];
  return finishModel(m, placed);
}

/** A sequence holding the story elements found outside resources and projects, end to end. */
function standaloneSequence(doc: XmlNode, assets: Map<string, { format?: string }>, media: Map<string, XmlNode>): XmlNode | undefined {
  const clips: XmlNode[] = [];
  const visit = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.tag === 'library' || c.tag === 'event') visit(c);
      else if (STORY.has(c.tag) && c.tag !== 'transition' && c.tag !== 'spine') clips.push(c);
    }
  };
  visit(doc);
  if (!clips.length) return undefined;
  let at = 0;
  const spine: XmlNode = { tag: 'spine', attrs: {}, text: '', children: [] };
  for (const c of clips) {
    spine.children.push({ ...c, attrs: { ...c.attrs, offset: `${at}s` } });
    at += fcpTime(c.attrs.duration);
  }
  // The first clip's format, or that of its compound clip's sequence or asset.
  const first = clips[0]!;
  const mediaSeq = media.get(first.attrs.ref ?? '');
  const format = first.attrs.format ?? (mediaSeq ? kid(mediaSeq, 'sequence')?.attrs.format : undefined) ?? assets.get(first.attrs.ref ?? '')?.format;
  return { tag: 'sequence', attrs: { name: first.attrs.name ?? 'Imported clip', duration: `${at}s`, ...(format ? { format } : {}) }, text: '', children: [spine] };
}

const isZero = (k: TKeyed<[number, number]>): boolean => !Array.isArray(k[0]) && typeof k[0] !== 'object' && (k as [number, number])[0] === 0 && (k as [number, number])[1] === 0;
function isValue<T>(k: TKeyed<T>, v: T): boolean {
  if (Array.isArray(k) && typeof k[0] === 'object' && !Array.isArray(k[0])) return false;
  return JSON.stringify(k) === JSON.stringify(v);
}
