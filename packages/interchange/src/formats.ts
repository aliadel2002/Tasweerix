import { onPlugin } from '@tasweerix/core';
import type { TimelineModel } from './model';
import { toFCPXML } from './fcpxml';
import { toOTIO } from './otio';
import { fromFCPXML } from './import-fcpxml';
import { fromOTIO } from './import-otio';
import { fromEDL, toEDL } from './edl';
import { fromXMEML, toXMEML } from './xmeml';

export interface ReadOptions {
  /** Frame rate for formats that do not store one (EDL). */
  fps?: number;
}

/** A timeline interchange format. Plugins add formats through their `importers` / `exporters` sections. */
export interface TimelineFormat {
  name: string;
  label: string;
  /** File extensions, lowercase without the dot. */
  extensions: string[];
  /** Recognizes the format from file content (used when the extension is ambiguous, e.g. .xml). */
  detect?(text: string): boolean;
  read?(text: string, opts: ReadOptions): TimelineModel;
  write?(model: TimelineModel): string;
}

const formats = new Map<string, TimelineFormat>();

export function registerTimelineFormat(f: TimelineFormat): void {
  const prev = formats.get(f.name);
  // Importers and exporters of one format may come from different plugin sections: merge them.
  formats.set(f.name, prev ? { ...prev, ...f, read: f.read ?? prev.read, write: f.write ?? prev.write } : f);
}
export function getTimelineFormat(name: string): TimelineFormat | undefined {
  return formats.get(name);
}
export function timelineFormats(): TimelineFormat[] {
  return [...formats.values()];
}

registerTimelineFormat({ name: 'fcpxml', label: 'Final Cut Pro X / DaVinci Resolve (FCPXML)', extensions: ['fcpxml'], detect: (t) => /<fcpxml[\s>]/.test(t.slice(0, 2000)), read: (t) => fromFCPXML(t), write: (m) => toFCPXML(m) });
registerTimelineFormat({ name: 'otio', label: 'OpenTimelineIO', extensions: ['otio'], detect: (t) => /^\s*\{[\s\S]{0,400}"OTIO_SCHEMA"/.test(t), read: (t) => fromOTIO(t), write: (m) => toOTIO(m) });
registerTimelineFormat({ name: 'xmeml', label: 'Final Cut Pro 7 XML (Premiere Pro)', extensions: ['xml'], detect: (t) => /<xmeml[\s>]/.test(t.slice(0, 2000)), read: (t) => fromXMEML(t), write: (m) => toXMEML(m) });
registerTimelineFormat({ name: 'edl', label: 'CMX 3600 EDL', extensions: ['edl'], detect: (t) => /^\s*(TITLE:|FCM:|\d{3,6}\s+\S+\s+\S+\s+[CDW])/m.test(t.slice(0, 2000)), read: (t, o) => fromEDL(t, o), write: (m) => toEDL(m) });

onPlugin((p) => {
  for (const [name, f] of Object.entries(p.importers ?? {})) registerTimelineFormat({ name, ...(f as Omit<TimelineFormat, 'name'>) });
  for (const [name, f] of Object.entries(p.exporters ?? {})) registerTimelineFormat({ name, ...(f as Omit<TimelineFormat, 'name'>) });
});

/** Picks the format of a timeline file from its name and content. */
export function detectTimelineFormat(text: string, fileName = ''): TimelineFormat {
  const ext = (/\.([^./\\]+)$/.exec(fileName)?.[1] ?? '').toLowerCase();
  const all = timelineFormats().filter((f) => f.read);
  const byContent = all.find((f) => f.detect?.(text));
  const byExt = all.filter((f) => f.extensions.includes(ext));
  const pick = byExt.length === 1 && (!byContent || byContent === byExt[0]) ? byExt[0] : (byContent ?? byExt[0]);
  if (!pick) throw new Error(`Unrecognized timeline format${fileName ? ` for ${fileName}` : ''} (known: ${all.map((f) => f.name).join(', ')})`);
  return pick;
}

/** Parses a timeline file of any registered format. */
export function readTimeline(text: string, opts: ReadOptions & { fileName?: string; format?: string } = {}): TimelineModel {
  const f = opts.format ? getTimelineFormat(opts.format) : detectTimelineFormat(text, opts.fileName);
  if (!f?.read) throw new Error(`Timeline format "${opts.format}" cannot be read`);
  return f.read(text, opts);
}

/** Writes a model in any registered format. */
export function writeTimeline(model: TimelineModel, format: string): string {
  const f = getTimelineFormat(format);
  if (!f?.write) throw new Error(`Timeline format "${format}" cannot be written (known: ${timelineFormats().filter((x) => x.write).map((x) => x.name).join(', ')})`);
  return f.write(model);
}
