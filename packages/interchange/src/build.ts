import { AudioClip, buildingComposition, getEnv, group, image, text, video, type Env, type GroupNode, type SceneNode } from '@tasweerix/core';
import { transition } from '@tasweerix/render';
import type { TClip, TimelineModel } from './model';
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

/** Options of a video/image/text node for a clip (without timing inside transition chains). */
function clipOptions(c: TClip, m: TimelineModel, timed: boolean): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (timed) o.start = n4(c.start);
  if (c.kind === 'title') {
    o.duration = n4(c.duration);
    o.size = Math.round(m.height / 13.5);
    o.fill = '#ffffff';
    return o;
  }
  if (c.kind === 'image') o.duration = n4(c.duration);
  else if (c.speed === 0) {
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
  return o;
}

function audioOptions(c: TClip): Record<string, unknown> {
  const o: Record<string, unknown> = { start: n4(c.start), trim: [n4(c.sourceIn), n4(c.sourceIn + c.duration * (c.speed || 1))] };
  if (c.speed !== 1 && c.speed > 0) o.speed = n4(c.speed);
  if (c.gainDb) o.gain = n4(c.gainDb);
  return o;
}

function objCode(o: Record<string, unknown>): string {
  const v = (x: unknown): string => (Array.isArray(x) ? `[${x.map(v).join(', ')}]` : typeof x === 'string' ? str(x) : String(x));
  return `{ ${Object.entries(o).map(([k, x]) => `${k}: ${v(x)}`).join(', ')} }`;
}

function clipCall(c: TClip, m: TimelineModel, timed: boolean): string {
  const o = objCode(clipOptions(c, m, timed));
  if (c.kind === 'title') return `text(${str(c.text ?? c.name)}, ${o})`;
  return `${c.kind === 'image' ? 'image' : 'video'}(${str(c.src)}, ${o})`;
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
        body.push(`  c.add(${clipCall(run[0]!, m, true)});`);
        continue;
      }
      used.add('transition');
      const parts: string[] = [];
      run.forEach((c, k) => {
        if (k > 0) parts.push(`      { type: ${str(c.transitionIn!.type)}, duration: ${n4(c.transitionIn!.duration)} },`);
        parts.push(`      ${clipCall(c, m, false)},`);
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
  const make = (c: TClip, timed: boolean): SceneNode => {
    const o = clipOptions(c, m, timed) as Record<string, any>;
    const n = c.kind === 'title' ? text(c.text ?? c.name, o) : c.kind === 'image' ? image(c.src, o) : video(c.src, o);
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
