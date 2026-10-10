import type { Command } from 'commander';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { decodePcm, FFMPEG, run } from '@tasweerix/media/node';
import { detectBeats, detectSilence, encodeWav, integratedLoudness, renderMix, truePeakDb } from '@tasweerix/audio';
import { loadComposition } from './project';
import { toSVG } from '@tasweerix/illustrate';
import { loadFont, getFont, layoutWithFont } from '@tasweerix/type';
import { FONT_FILE_RE, type ResolvedText } from '@tasweerix/render';
import { render } from './render';

const parseProps = (s?: string) => (s ? (JSON.parse(s) as Record<string, unknown>) : undefined);

export function registerCommands(program: Command): void {
  program
    .command('audio')
    .description('Render the audio mix of a composition / soundscape (wav, mp3, flac, aac, ogg, opus)')
    .argument('<entry>')
    .option('-o, --output <file>', 'output file', 'out/mix.wav')
    .option('-c, --comp <name>')
    .option('--props <json>')
    .option('--stems', 'also write one file per bus and clip')
    .option('--sample-rate <n>', 'sample rate', Number)
    .option('--root <dir>', 'project root for assets')
    .action(async (entry: string, o) => {
      const t0 = Date.now();
      const { comp, env } = await loadComposition(entry, { comp: o.comp, props: parseProps(o.props), root: o.root });
      const res = await renderMix(comp, { load: (s, sr, ch) => env.loadPcm!(s, sr, ch), stems: !!o.stems, sampleRate: o.sampleRate });
      const out = resolve(o.output);
      mkdirSync(dirname(out), { recursive: true });
      await writeAudio(out, encodeWav(res.master, 'float32'));
      if (res.stems) {
        for (const [name, data] of res.stems) {
          const f = out.replace(/(\.[^.]+)$/, `.${name.replace(/[^\w.-]+/g, '_')}$1`);
          await writeAudio(f, encodeWav(data, 'float32'));
        }
      }
      const lufs = integratedLoudness(res.master);
      console.error(`✔ ${out} — ${comp.duration.toFixed(2)}s, ${lufs.toFixed(1)} LUFS, ${truePeakDb(res.master).toFixed(1)} dBTP (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    });

  program
    .command('analyze')
    .description('Analyze an audio/video file: loudness, peak, tempo, beats and silences')
    .argument('<file>')
    .option('--json', 'machine-readable output')
    .action(async (file: string, o) => {
      const sr = 44100;
      const chs = await decodePcm(resolve(file), sr, 2);
      const data = { sampleRate: sr, channels: chs };
      const beats = detectBeats({ sampleRate: sr, channels: [chs[0]!.map((v, i) => (v + chs[1]![i]!) / 2)] });
      const result = {
        duration: chs[0]!.length / sr,
        lufs: +integratedLoudness(data).toFixed(2),
        truePeak: +truePeakDb(data).toFixed(2),
        bpm: +beats.bpm.toFixed(1),
        beats: beats.beats.map((b) => +b.toFixed(3)),
        silences: detectSilence(data).map((s) => ({ start: +s.start.toFixed(3), end: +s.end.toFixed(3) })),
      };
      if (o.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`duration  ${result.duration.toFixed(2)}s`);
        console.log(`loudness  ${result.lufs} LUFS   true peak ${result.truePeak} dBTP`);
        console.log(`tempo     ${result.bpm} BPM (${result.beats.length} beats)`);
        console.log(`silences  ${result.silences.map((s) => `${s.start}–${s.end}`).join(', ') || 'none'}`);
      }
    });

  program
    .command('batch')
    .description('Apply one edit script to many files: renders the entry once per input with props { src, name, index }')
    .argument('<entry>')
    .requiredOption('-i, --input <pattern>', 'input directory or glob (e.g. "photos/*.jpg")')
    .option('-o, --out <dir>', 'output directory', 'out/batch')
    .option('-f, --format <ext>', 'output extension (png, jpg, webp, avif, mp4 …)', 'jpg')
    .option('--root <dir>', 'asset root (defaults to the current directory)')
    .option('--props <json>', 'extra props merged into each render')
    .action(async (entry: string, o) => {
      const files = expandInputs(o.input);
      if (!files.length) throw new Error(`No inputs match ${o.input}`);
      const root = resolve(o.root ?? process.cwd());
      mkdirSync(resolve(o.out), { recursive: true });
      const extra = parseProps(o.props) ?? {};
      for (const [index, file] of files.entries()) {
        const name = basename(file, extname(file));
        const output = join(resolve(o.out), `${name}.${o.format}`);
        const isVideo = ['mp4', 'mov', 'webm', 'gif'].includes(o.format);
        const res = await render({ entry, output, root, props: { ...extra, src: relative(root, file), name, index }, still: isVideo ? undefined : 0 });
        console.error(`✔ [${index + 1}/${files.length}] ${res.output}`);
      }
    });

  program
    .command('svg')
    .description('Export a frame as SVG (vector shapes, gradients, masks; text as glyph paths for font files)')
    .argument('<entry>')
    .option('-o, --output <file>', 'output file', 'out/frame.svg')
    .option('-f, --frame <n>', 'frame number', Number, 0)
    .option('-c, --comp <name>')
    .option('--props <json>')
    .option('--root <dir>', 'project root for assets')
    .action(async (entry: string, o) => {
      const { comp, env } = await loadComposition(entry, { comp: o.comp, props: parseProps(o.props), root: o.root });
      // Load font files used by text nodes so text becomes exact glyph outlines.
      const fonts = new Set<string>();
      comp.root.walk((n) => {
        // Compare by kind: the composition comes from a bundled copy of the core classes.
        if (n.kind === 'text' && typeof n.props.font === 'string' && FONT_FILE_RE.test(n.props.font)) fonts.add(n.props.font);
        return undefined;
      });
      for (const f of fonts) await loadFont(f, await env.loadBinary!(f));
      const svg = toSVG(comp, o.frame, {
        textToPath: (n, p) => {
          const font = getFont(p.font);
          if (!font) return null;
          const layout = layoutWithFont(font, { ...(p as ResolvedText), text: String(p.text), fontFamily: p.font });
          return layout.glyphs.map((g) => (g.pathData ? translate(g.pathData, g.x, g.y) : '')).join('');
        },
      });
      const out = resolve(o.output);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, svg);
      console.error(`✔ ${out}`);
    });

  program
    .command('cuts')
    .description('Suggest an edit for a media file and print it as code: silence jump-cuts, shots, or beats')
    .argument('<file>', 'media file (relative to --root)')
    .option('--mode <mode>', 'silence | shots | beats', 'silence')
    .option('--threshold <n>', 'silence dBFS or scene score', Number)
    .option('--min-silence <s>', 'minimum silence to cut', Number)
    .option('--padding <s>', 'audio kept around speech', Number)
    .option('--root <dir>', 'project root', '.')
    .option('--json', 'print JSON instead of code')
    .action(async (file: string, o) => {
      const { nodeEnv } = await import('@tasweerix/media/node');
      const { smart } = await import('@tasweerix/smart');
      const env = nodeEnv(resolve(o.root));
      if (o.mode === 'beats') {
        const b = await smart.beats(file, env);
        console.log(o.json ? JSON.stringify(b, null, 2) : `// ${b.bpm.toFixed(1)} BPM\nconst beats = [${b.beats.map((x) => x.toFixed(3)).join(', ')}];`);
        return;
      }
      const cuts = o.mode === 'shots' ? await smart.shots(file, { threshold: o.threshold }, env) : await smart.silenceCuts(file, { threshold: o.threshold, minSilence: o.minSilence, padding: o.padding }, env);
      console.log(o.json ? JSON.stringify(cuts, null, 2) : smart.cutsToCode(file, cuts));
    });

  program
    .command('studio')
    .description('Open the web studio for a project: live preview, timeline, inspector, code editor, two-way editing')
    .argument('[dir]', 'project directory', '.')
    .option('-e, --entry <file>', 'entry file (default: index.ts)')
    .option('-p, --port <n>', 'port', Number, 3000)
    .option('--host <host>', 'host to bind', '127.0.0.1')
    .action(async (dir: string, o) => {
      const { startStudio } = await import('./studio');
      await startStudio({ root: dir, entry: o.entry, port: o.port, host: o.host, log: (m) => console.error(m) });
    });

  program
    .command('export-timeline')
    .description('Export the edit as FCPXML (Final Cut Pro / DaVinci Resolve), OpenTimelineIO, FCP7 XML (Premiere Pro) or an EDL for finishing in a pro editor')
    .argument('<entry>')
    .option('-f, --format <fmt>', 'fcpxml | otio | xmeml | edl (or a plugin format)', 'fcpxml')
    .option('-o, --output <file>', 'output file')
    .option('-c, --comp <name>')
    .option('--root <dir>', 'project root for assets')
    .option('--graphics', 'also render non-media layers (shapes, text, effects) as a ProRes 4444 alpha clip on the top track')
    .action(async (entry: string, o) => {
      const { buildTimelineModel, getTimelineFormat, writeTimeline } = await import('@tasweerix/interchange');
      const fmt = getTimelineFormat(o.format);
      if (!fmt?.write) throw new Error(`Unknown timeline format "${o.format}"`);
      const { pathToFileURL } = await import('node:url');
      const { comp, root } = await loadComposition(entry, { comp: o.comp, root: o.root });
      const toUrl = (src: string) => (/^https?:/.test(src) ? src : pathToFileURL(resolve(root, src)).href);
      const model = buildTimelineModel(comp, toUrl);
      const out = resolve(o.output ?? `out/${(comp.name || 'timeline').replace(/[^\w-]+/g, '-')}.${fmt.extensions[0] ?? fmt.name}`);
      mkdirSync(dirname(out), { recursive: true });
      if (o.graphics && model.unsupported.length) {
        const gfx = out.replace(/\.[^.]+$/, '.graphics.mov');
        console.error(`Rendering graphics layer → ${gfx}`);
        await render({ entry, root, output: gfx, comp: o.comp, codec: 'prores', transparent: true, transparentBackground: true, hide: ['video', 'image', 'photo'], muted: true, concurrency: 2 });
        const { probe: probeFile } = await import('@tasweerix/media/node');
        const info = await probeFile(gfx);
        model.video.push({ kind: 'video', clips: [{ name: 'Tasweerix graphics', src: relative(root, gfx), url: pathToFileURL(gfx).href, kind: 'video', start: 0, duration: comp.duration, sourceIn: 0, speed: 1, info, withAudio: false }] });
      }
      writeFileSync(out, writeTimeline(model, fmt.name));
      console.error(`✔ ${out} — ${model.video.reduce((n, t) => n + t.clips.length, 0)} video clips on ${model.video.length} tracks, ${model.audio.reduce((n, t) => n + t.clips.length, 0)} audio clips`);
      if (model.unsupported.length && !o.graphics) console.error(`  not representable (use --graphics to render them): ${model.unsupported.slice(0, 6).join('; ')}${model.unsupported.length > 6 ? ' …' : ''}`);
    });

  program
    .command('init')
    .description('Create a new project from a template')
    .argument('[dir]', 'project directory', 'my-tasweerix-project')
    .option('-t, --template <name>', 'video | photo | audio | motion | arabic | 3d', 'video')
    .action(async (dir: string, o) => {
      const { scaffold } = await import('./templates');
      const files = scaffold(resolve(dir), o.template);
      console.error(`✔ Created ${dir} (${o.template}): ${files.join(', ')}`);
      console.error(`  Next: tasweerix studio ${dir}    or    tasweerix render ${dir}/index.ts -o ${dir}/out/video.mp4`);
    });

  program
    .command('inspect')
    .description('Print the composition tree as JSON (timing, props, audio)')
    .argument('<entry>')
    .option('-c, --comp <name>')
    .option('--props <json>')
    .option('--root <dir>', 'project root for assets')
    .action(async (entry: string, o) => {
      const { comp } = await loadComposition(entry, { comp: o.comp, props: parseProps(o.props), root: o.root });
      console.log(JSON.stringify(comp.toJSON(), null, 2));
    });
}

/** Writes WAV bytes, transcoding via ffmpeg when the extension isn't .wav. */
export async function writeAudio(path: string, wav: Uint8Array): Promise<void> {
  const ext = extname(path).toLowerCase();
  if (ext === '.wav') {
    writeFileSync(path, wav);
    return;
  }
  const codec: Record<string, string[]> = {
    '.mp3': ['-c:a', 'libmp3lame', '-q:a', '2'],
    '.flac': ['-c:a', 'flac'],
    '.aac': ['-c:a', 'aac', '-b:a', '256k'],
    '.m4a': ['-c:a', 'aac', '-b:a', '256k'],
    '.ogg': ['-c:a', 'libvorbis', '-q:a', '6'],
    '.opus': ['-c:a', 'libopus', '-b:a', '160k'],
  };
  await run(FFMPEG, ['-y', '-v', 'error', '-f', 'wav', '-i', '-', ...(codec[ext] ?? []), path], Buffer.from(wav));
}

/** Expands a directory or a simple glob (wildcards in the file name part). */
export function expandInputs(pattern: string): string[] {
  const full = resolve(pattern);
  try {
    if (statSync(full).isDirectory()) return readdirSync(full).filter((f) => !f.startsWith('.')).map((f) => join(full, f)).filter((f) => statSync(f).isFile()).sort();
  } catch {
    /* not a directory */
  }
  const dir = dirname(full);
  const re = new RegExp(`^${basename(full).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return readdirSync(dir).filter((f) => re.test(f)).map((f) => join(dir, f)).sort();
}

function translate(d: string, dx: number, dy: number): string {
  let i = 0;
  return d.replace(/-?\d*\.?\d+(?:e-?\d+)?/gi, (m) => String(+(Number(m) + (i++ % 2 === 0 ? dx : dy)).toFixed(2)));
}
