import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { definePlugin, type CommandContext, type Plugin } from '@tasweerix/core';
import type { TClip, TimelineModel } from './model';
import { detectTimelineFormat, getTimelineFormat, readTimeline } from './formats';
import { relinkTimeline, timelineToCode } from './build';

/** Finds a file by name under some folders (depth-limited, skips heavy folders). */
function findByName(name: string, roots: string[], depth = 4): string | undefined {
  const want = name.toLowerCase();
  const visit = (dir: string, d: number): string | undefined => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return undefined;
    }
    for (const e of entries) if (e.toLowerCase() === want && statSync(join(dir, e)).isFile()) return join(dir, e);
    if (d <= 0) return undefined;
    for (const e of entries) {
      if (e.startsWith('.') || e === 'node_modules' || e === 'out') continue;
      const full = join(dir, e);
      try {
        if (statSync(full).isDirectory()) {
          const f = visit(full, d - 1);
          if (f) return f;
        }
      } catch {
        /* unreadable */
      }
    }
    return undefined;
  };
  for (const r of roots) {
    const f = visit(r, depth);
    if (f) return f;
  }
  return undefined;
}

export interface ImportProjectOptions {
  /** Project folder to create or update. */
  out: string;
  entry?: string;
  format?: string;
  fps?: number;
  /** Extra folders searched (by file name) for media that moved. */
  mediaDirs?: string[];
  /** How media outside the project is brought in: symlink (default), copy, or left as is. */
  media?: 'link' | 'copy' | 'keep';
}

export interface ImportProjectResult {
  entry: string;
  model: TimelineModel;
  missing: string[];
  linked: string[];
}

/**
 * Imports a timeline file into a Tasweerix project: relinks media into the project (assets/),
 * then writes an editable entry file.
 */
export function importTimelineProject(file: string, o: ImportProjectOptions): ImportProjectResult {
  const text = readFileSync(file, 'utf8');
  const fmt = o.format ? getTimelineFormat(o.format) : detectTimelineFormat(text, file);
  if (!fmt?.read) throw new Error(`Cannot read ${file} as ${o.format}`);
  const model = readTimeline(text, { format: fmt.name, fps: o.fps });
  const out = resolve(o.out);
  const assets = join(out, 'assets');
  mkdirSync(out, { recursive: true });
  const missing = new Set<string>();
  const linked: string[] = [];
  const done = new Map<string, string>();
  const relink = (c: TClip): string => {
    if (/^https?:/.test(c.src)) return c.src;
    const hit = done.get(c.src);
    if (hit) return hit;
    let found = c.src && isAbsolute(c.src) && existsSync(c.src) ? c.src : undefined;
    if (!found && c.src && !isAbsolute(c.src) && existsSync(resolve(dirname(file), c.src))) found = resolve(dirname(file), c.src);
    found ??= findByName(basename(c.src), [...(o.mediaDirs ?? []).map((d) => resolve(d)), dirname(resolve(file)), out]);
    let rel: string;
    if (!found) {
      missing.add(c.src);
      rel = `assets/${basename(c.src)}`;
    } else if (found.startsWith(out + sep)) rel = relative(out, found);
    else if (o.media === 'keep') rel = found;
    else {
      mkdirSync(assets, { recursive: true });
      let target = join(assets, basename(found));
      // Two different files with one name: keep both.
      for (let i = 2; existsSync(target) && resolve(target) !== resolve(found) && !sameFile(target, found); i++) target = join(assets, `${basename(found, extname(found))}-${i}${extname(found)}`);
      if (!existsSync(target)) {
        if (o.media === 'copy') copyFileSync(found, target);
        else symlinkSync(found, target);
        linked.push(relative(out, target));
      }
      rel = relative(out, target);
    }
    rel = rel.split(sep).join('/');
    done.set(c.src, rel);
    return rel;
  };
  relinkTimeline(model, relink);
  const entry = join(out, o.entry ?? 'index.ts');
  writeFileSync(entry, timelineToCode(model, { source: basename(file), format: fmt.label }));
  return { entry, model, missing: [...missing], linked };
}

function sameFile(a: string, b: string): boolean {
  try {
    const x = statSync(a);
    const y = statSync(b);
    return x.ino === y.ino && x.dev === y.dev;
  } catch {
    return false;
  }
}

/** The interchange commands: `tasweerix import-timeline`. */
export const interchangePlugin: Plugin = definePlugin({
  name: '@tasweerix/interchange',
  commands: {
    'import-timeline': {
      description: 'Import an edit from Final Cut Pro / Resolve (FCPXML), Premiere (FCP7 XML), OpenTimelineIO or an EDL as an editable Tasweerix project',
      args: ['<file>'],
      options: [
        { flags: '-o, --out <dir>', description: 'project folder (default: named after the file)' },
        { flags: '-e, --entry <file>', description: 'entry file name', default: 'index.ts' },
        { flags: '-f, --format <name>', description: 'fcpxml | otio | xmeml | edl (detected by default)' },
        { flags: '--fps <n>', description: 'frame rate for EDLs (default 30, 29.97 for drop frame)' },
        { flags: '--media <dirs>', description: 'comma-separated folders to search for moved media' },
        { flags: '--copy-media', description: 'copy media into assets/ instead of symlinking it' },
        { flags: '--keep-paths', description: 'reference media where it is (renders only work for media inside the project)' },
      ],
      run(ctx: CommandContext) {
        const file = resolve(ctx.cwd, ctx.args[0]!);
        const o = ctx.options;
        const out = resolve(ctx.cwd, o.out ?? basename(file, extname(file)).replace(/[^\w-]+/g, '-'));
        const res = importTimelineProject(file, { out, entry: o.entry, format: o.format, fps: o.fps ? Number(o.fps) : undefined, mediaDirs: o.media ? String(o.media).split(',') : undefined, media: o.copyMedia ? 'copy' : o.keepPaths ? 'keep' : 'link' });
        const clips = res.model.video.reduce((n, t) => n + t.clips.length, 0);
        ctx.log(`✔ ${relative(ctx.cwd, res.entry) || res.entry} — ${clips} video clips on ${res.model.video.length} tracks, ${res.model.audio.reduce((n, t) => n + t.clips.length, 0)} audio clips, ${res.model.markers.length} markers`);
        if (res.linked.length) ctx.log(`  media ${o.copyMedia ? 'copied' : 'linked'} into assets/: ${res.linked.length} files`);
        if (res.missing.length) ctx.log(`  missing media (place them in ${relative(ctx.cwd, out) || '.'}/assets/ or pass --media): ${res.missing.slice(0, 8).join(', ')}${res.missing.length > 8 ? ' …' : ''}`);
        if (res.model.unsupported.length) ctx.log(`  not imported: ${res.model.unsupported.slice(0, 6).join('; ')}${res.model.unsupported.length > 6 ? ' …' : ''}`);
        ctx.log(`  Next: tasweerix studio ${relative(ctx.cwd, out) || '.'}`);
        return res;
      },
    },
  },
});
