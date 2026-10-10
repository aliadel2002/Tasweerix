import { AudioClip, buildingComposition, getEnv, group, image, keys, text, video, type Env, type GroupNode, type KeyInput, type SceneNode } from '@tasweerix/core';
import { transition } from '@tasweerix/render';
import { timeMapAt, type TClip, type TKeyed, type TimelineModel } from './model';
import { readTimeline, type ReadOptions } from './formats';
import { baseName } from './util';

const n4 = (x: number) => +x.toFixed(4);
const str = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;

/** Rewrites every clip's `src` (e.g. to project-relative paths). Returns the same model. */
export function relinkTimeline(m: TimelineModel, map: (clip: TClip) => string): TimelineModel {
  for (const t of [...m.video, ...m.audio]) for (const c of t.clips) if (c.kind !== 'title') c.src = map(c);
  return m;
}

/** Splits a track into runs of clips joined by transitions. */
function runs(clips: TClip[]): TClip[][] {
  const out: TClip[][] = [];
  for (const c of clips) {
    const run = out[out.length - 1];
    const prev = run?.[run.length - 1];
    const joined = prev && c.transitionIn && Math.abs(prev.start + prev.duration - c.transitionIn.duration - c.start) < 1e-3;
    if (joined) run!.push(c);
    else out.push([c]);
  }
  return out;
}

/** Keyframes in an option value: written as `keys([...])` in code, built as a Track for nodes. */
class KeyList {
  constructor(readonly list: [number, unknown, string?][]) {}
}

/** Clip-local keyframes (or a static value) from timeline keyframes, with values mapped through `f`. */
function keyed<T>(k: TKeyed<T>, c: TClip, f: (v: T) => unknown = (v) => v): unknown {
  if (!Array.isArray(k) || !k.length || typeof k[0] !== 'object' || Array.isArray(k[0])) return f(k as T);
  const list = k as { t: number; v: T; ease?: string }[];
  if (list.length === 1) return f(list[0]!.v);
  return new KeyList(list.map((x) => (x.ease && x.ease !== 'linear' ? [n4(x.t - c.start), f(x.v), x.ease] : [n4(x.t - c.start), f(x.v)])));
}

const vec = (v: [number, number]): number | [number, number] => (Math.abs(v[0] - v[1]) < 1e-9 ? n4(v[0]) : [n4(v[0]), n4(v[1])]);

/**
 * Remap keys of a variable-speed clip: node-local time → seconds after the trim in-point, with
 * keys at both ends of the clip.
 */
function remapKeys(c: TClip): { trimIn: number; trimOut: number; keys: [number, number][] } {
  const map = c.timeMap!;
  const t0 = c.start;
  const t1 = c.start + c.duration;
  const pts = [{ t: t0, v: timeMapAt(map, t0) }, ...map.filter((p) => p.t > t0 + 1e-6 && p.t < t1 - 1e-6), { t: t1, v: timeMapAt(map, t1) }];
  const trimIn = Math.max(0, pts[0]!.v);
  const trimOut = Math.max(...pts.map((p) => p.v));
  return { trimIn, trimOut, keys: pts.map((p) => [n4(p.t - t0), n4(p.v - trimIn)]) };
}

/**
 * Options of a video/image/text node for a clip (without timing inside transition chains).
 * `rooted`: the node sits directly in the composition root, so positions are absolute.
 */
function clipOptions(c: TClip, m: TimelineModel, timed: boolean, rooted = timed): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (timed) o.start = n4(c.start);
  if (c.kind === 'title') {
    o.duration = n4(c.duration);
    o.size = Math.round(m.height / 13.5);
    o.fill = '#ffffff';
    return { ...o, ...transformOptions(c, m, rooted, false) };
  }
  if (c.kind === 'image') o.duration = n4(c.duration);
  else if (c.timeMap && c.timeMap.length > 1) {
    const r = remapKeys(c);
    o.trim = [n4(r.trimIn), n4(r.trimOut)];
    o.duration = n4(c.duration);
    // Implicit audio follows `speed`, not a remap: variable-speed clips play silent.
    o.muted = true;
  } else if (c.speed === 0) {
    o.trim = [n4(c.sourceIn)];
    o.speed = 0;
    o.duration = n4(c.duration);
  } else {
    o.trim = [n4(c.sourceIn), n4(c.sourceIn + c.duration * c.speed)];
    if (c.speed !== 1) o.speed = n4(c.speed);
    if (!c.withAudio) o.muted = true;
    if (c.gainDb) o.volume = n4(Math.pow(10, c.gainDb / 20));
  }
  // Editors scale clips to fit the frame by default.
  o.size = [m.width, m.height];
  return { ...o, ...transformOptions(c, m, rooted, true) };
}

/** Position, scale, rotation, opacity and crop of a clip as node options. */
function transformOptions(c: TClip, m: TimelineModel, rooted: boolean, media: boolean): Record<string, unknown> {
  const x = c.transform;
  if (!x) return {};
  const o: Record<string, unknown> = {};
  let anchor: [number, number] = x.anchor ? [...x.anchor] : [0, 0];
  if (media && x.conform) o.fit = x.conform === 'fill' ? 'cover' : 'none';
  if (media && x.crop && x.crop.left + x.crop.right + x.crop.top + x.crop.bottom > 1e-6) {
    const { left: l, right: r, top: t, bottom: b } = x.crop;
    const nw = c.info.width ?? m.width;
    const nh = c.info.height ?? m.height;
    const k = x.conform === 'none' ? 1 : x.conform === 'fill' ? Math.max(m.width / nw, m.height / nh) : Math.min(m.width / nw, m.height / nh);
    const fw = nw * k;
    const fh = nh * k;
    o.crop = objLiteral({ x: n4(l * nw), y: n4(t * nh), width: n4(nw * (1 - l - r)), height: n4(nh * (1 - t - b)) });
    o.size = [n4(fw * (1 - l - r)), n4(fh * (1 - t - b))];
    // Keep the remaining part where it was in the uncropped picture.
    anchor = [anchor[0] - ((l - r) / 2) * fw, anchor[1] - ((t - b) / 2) * fh];
  }
  if (x.position !== undefined) {
    const [cx, cy] = rooted ? [m.width / 2, m.height / 2] : [0, 0];
    o.position = keyed(x.position, c, (p) => [n4(cx + p[0]), n4(cy + p[1])]);
  }
  // The anchor point of the (uncropped) picture lands on the position.
  if (anchor[0] || anchor[1]) o.anchor = [n4(anchor[0]), n4(anchor[1])];
  if (x.scale !== undefined) o.scale = keyed(x.scale, c, vec);
  if (x.rotation !== undefined) o.rotation = keyed(x.rotation, c, n4);
  if (x.opacity !== undefined) o.opacity = keyed(x.opacity, c, n4);
  return o;
}

/** A plain object written as an object literal in code. */
class ObjLiteral {
  constructor(readonly o: Record<string, unknown>) {}
}
const objLiteral = (o: Record<string, unknown>) => new ObjLiteral(o);

function audioOptions(c: TClip): Record<string, unknown> {
  const o: Record<string, unknown> = { start: n4(c.start), trim: [n4(c.sourceIn), n4(c.sourceIn + c.duration * (c.speed || 1))] };
  if (c.speed !== 1 && c.speed > 0) o.speed = n4(c.speed);
  if (c.gainDb) o.gain = n4(c.gainDb);
  return o;
}

function objCode(o: Record<string, unknown>): string {
  const v = (x: unknown): string =>
    x instanceof KeyList ? `keys(${v(x.list)})` : x instanceof ObjLiteral ? objCode(x.o) : Array.isArray(x) ? `[${x.map(v).join(', ')}]` : typeof x === 'string' ? str(x) : String(x);
  return `{ ${Object.entries(o).map(([k, x]) => `${k}: ${v(x)}`).join(', ')} }`;
}

/** Turns code-only option values (keyframes, literals) into runtime values. */
function liveOptions(o: Record<string, unknown>): Record<string, any> {
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) out[k] = x instanceof KeyList ? keys(x.list as KeyInput<unknown>[]) : x instanceof ObjLiteral ? x.o : x;
  return out;
}

const isRemapped = (c: TClip) => c.kind === 'video' && !!c.timeMap && c.timeMap.length > 1;

function clipCall(c: TClip, m: TimelineModel, timed: boolean, used: Set<string>): string {
  const opts = clipOptions(c, m, timed);
  if (Object.values(opts).some((x) => x instanceof KeyList)) used.add('keys');
  const o = objCode(opts);
  if (c.kind === 'title') return `text(${str(c.text ?? c.name)}, ${o})`;
  const call = `${c.kind === 'image' ? 'image' : 'video'}(${str(c.src)}, ${o})`;
  if (!isRemapped(c)) return call;
  used.add('keys');
  return `${call}.remap(keys(${JSON.stringify(remapKeys(c).keys).replace(/,/g, ', ')}))`;
}

/**
 * Turns a timeline into a Tasweerix project file: plain, editable calls (`video()`, `image()`,
 * `text()`, `transition.chain()`, `c.audio()`, `c.marker()`) with literal timing, so the studio can
 * keep editing it two ways.
 */
export function timelineToCode(m: TimelineModel, opts: { source?: string; format?: string } = {}): string {
  const used = new Set<string>(['composition']);
  const body: string[] = [];
  m.video.forEach((t, i) => {
    if (!t.clips.length) return;
    body.push(`  // V${i + 1}`);
    for (const run of runs(t.clips)) {
      run.forEach((c) => used.add(c.kind === 'title' ? 'text' : c.kind === 'image' ? 'image' : 'video'));
      if (run.length === 1) {
        body.push(`  c.add(${clipCall(run[0]!, m, true, used)});`);
        continue;
      }
      used.add('transition');
      const parts: string[] = [];
      run.forEach((c, k) => {
        if (k > 0) parts.push(`      { type: ${str(c.transitionIn!.type)}, duration: ${n4(c.transitionIn!.duration)} },`);
        parts.push(`      ${clipCall(c, m, false, used)},`);
      });
      body.push(`  c.add(\n    transition.chain(\n${parts.join('\n')}\n    ).startAt(${n4(run[0]!.start)}),\n  );`);
    }
  });
  m.audio.forEach((t, i) => {
    if (!t.clips.length) return;
    used.add('audio');
    body.push(`  // A${i + 1}`);
    for (const c of t.clips) body.push(`  c.audio(audio(${str(c.src)}, ${objCode(audioOptions(c))}));`);
  });
  for (const mk of m.markers) body.push(`  c.marker(${n4(mk.time)}, ${str(mk.label)}${mk.color ? `, ${str(mk.color)}` : ''});`);
  const header = [
    `import { ${[...used].sort().join(', ')} } from 'tasweerix';`,
    '',
    `// Imported${opts.source ? ` from ${opts.source}` : ''}${opts.format ? ` (${opts.format})` : ''} with tasweerix import-timeline.`,
    ...(m.unsupported.length ? ['// Not imported (rebuild these in code if you need them):', ...m.unsupported.slice(0, 30).map((u) => `//   - ${u}`)] : []),
  ];
  const options = objCode({ name: m.name, width: m.width, height: m.height, fps: m.fps, duration: n4(m.duration) });
  return `${header.join('\n')}\nexport default composition(${options}, (c) => {\n${body.join('\n')}\n});\n`;
}

/** Builds scene nodes (and audio clips) for a timeline. Media `src` values are used as they are. */
export function timelineToNodes(m: TimelineModel): { root: GroupNode; audio: AudioClip[] } {
  const children: SceneNode[] = [];
  // Nodes sit inside the returned group (centered on the frame), so positions are relative.
  const make = (c: TClip, timed: boolean): SceneNode => {
    const o = liveOptions(clipOptions(c, m, timed, false));
    const n = c.kind === 'title' ? text(c.text ?? c.name, o) : c.kind === 'image' ? image(c.src, o) : video(c.src, o);
    if (isRemapped(c)) n.remap(keys(remapKeys(c).keys));
    n.named(c.name);
    return n;
  };
  m.video.forEach((t, i) => {
    for (const run of runs(t.clips)) {
      if (run.length === 1) {
        children.push(make(run[0]!, true));
        continue;
      }
      const parts: (SceneNode | { type: string; duration: number })[] = [];
      run.forEach((c, k) => {
        if (k > 0) parts.push({ type: c.transitionIn!.type, duration: c.transitionIn!.duration });
        parts.push(make(c, false));
      });
      children.push(transition.chain(...parts).startAt(run[0]!.start).named(`V${i + 1} ${run[0]!.name}`));
    }
  });
  const root = group(...children, { name: m.name });
  root.layout = (node) => {
    let end = 0;
    for (const ch of node.children) end = Math.max(end, ch.end);
    if (node.duration === undefined) node.naturalDuration = Number.isFinite(end) ? Math.max(end, m.duration) : m.duration;
  };
  const audio = m.audio.flatMap((t) => t.clips.map((c) => new AudioClip(c.src, { ...(audioOptions(c) as object), name: c.name })));
  return { root, audio };
}

export interface ImportTimelineOptions extends ReadOptions {
  format?: string;
  /** Maps each media reference to a project path. Default: the file name inside `mediaDir`. */
  relink?: (clip: TClip) => string;
  /** Folder holding the media (default: the timeline file's folder). */
  mediaDir?: string;
  env?: Env;
}

/**
 * Imports an edit from another editor inside a composition build:
 *   c.add(await importTimeline('edits/cut.fcpxml'))
 * Audio clips and markers go to the composition being built. Formats: FCPXML, OTIO, FCP7 XML
 * (Premiere), CMX 3600 EDL and any format a plugin registers.
 */
export async function importTimeline(src: string, opts: ImportTimelineOptions = {}): Promise<GroupNode> {
  const env = opts.env ?? getEnv();
  if (!env.loadBinary) throw new Error('importTimeline(): this environment cannot load files');
  const textData = new TextDecoder().decode(await env.loadBinary(src));
  const m = readTimeline(textData, { fileName: src, format: opts.format, fps: opts.fps });
  const dir = opts.mediaDir ?? src.replace(/[^/\\]*$/, '');
  relinkTimeline(m, opts.relink ?? ((c) => (/^https?:/.test(c.src) ? c.src : `${dir.replace(/[\\/]?$/, dir ? '/' : '')}${baseName(c.src)}`)));
  const { root, audio } = timelineToNodes(m);
  const comp = buildingComposition();
  if (comp) {
    for (const a of audio) comp.audio(a);
    for (const mk of m.markers) comp.marker(mk.time, mk.label, mk.color);
  }
  root.meta.timeline = { unsupported: m.unsupported };
  return root;
}
