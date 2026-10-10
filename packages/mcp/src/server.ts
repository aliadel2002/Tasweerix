import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { runCli, tail, type CliResult } from './cli';

export interface ServerOptions {
  /** Directory that relative paths resolve against and the CLI runs in (default: TASWEERIX_PROJECT_DIR or the cwd). */
  projectDir?: string;
}

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });
const failed = (what: string, r: CliResult) => text(`${what} failed (exit ${r.code}):\n${tail(r.stderr || r.stdout, 30)}`, true);

// Options shared by everything that loads a composition.
const compositionArgs = {
  entry: z.string().describe('Project file exporting the composition, e.g. index.ts (relative to the project directory)'),
  comp: z.string().optional().describe('Named export to use instead of the default export'),
  props: z.record(z.string(), z.unknown()).optional().describe('Input props, merged over the composition defaults'),
  root: z.string().optional().describe("Asset root (default: the entry's directory). Use '.' when assets are referenced from the repository root"),
};

function compositionFlags(a: { comp?: string; props?: Record<string, unknown>; root?: string }): string[] {
  const f: string[] = [];
  if (a.comp) f.push('--comp', a.comp);
  if (a.props) f.push('--props', JSON.stringify(a.props));
  if (a.root) f.push('--root', a.root);
  return f;
}

/** Keeps the parts of `inspect` output that describe the edit, dropping evaluated props. */
function compactTree(node: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: node.kind };
  for (const k of ['name', 'id', 'start', 'duration'] as const) if (node[k] !== undefined && node[k] !== null) out[k] = node[k];
  const props = (node.props ?? {}) as Record<string, unknown>;
  for (const k of ['src', 'text', 'trim']) if (props[k] !== undefined) out[k] = props[k];
  const children = (node.children ?? []) as Record<string, unknown>[];
  if (children.length) out.children = depth > 0 ? children.map((c) => compactTree(c, depth - 1)) : `${children.length} children (raise depth to see them)`;
  return out;
}

export function createServer(opts: ServerOptions = {}): McpServer {
  const projectDir = resolve(opts.projectDir ?? process.env.TASWEERIX_PROJECT_DIR ?? process.cwd());
  const cli = (args: string[], extra?: { signal?: AbortSignal; onStderrLine?: (l: string) => void }) => runCli(args, { cwd: projectDir, ...extra });
  const server = new McpServer({ name: 'tasweerix', version: '0.1.0' });

  server.registerTool(
    'doctor',
    {
      title: 'Check the Tasweerix setup',
      description: 'Checks Node, FFmpeg, ffprobe and Chromium (needed to render) and the optional tools: LibRaw for camera RAW, whisper.cpp for speech to text, Anthropic credentials for AI features, and audio plugin hosts. Says how to fix anything missing.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const r = await cli(['doctor']);
      return text(r.stdout.trim() || tail(r.stderr), false);
    },
  );

  server.registerTool(
    'read_docs',
    {
      title: 'Read the Tasweerix docs',
      description: 'Returns one page of the Tasweerix API documentation (guide, video, photo, audio, motion-and-type, illustration, smart, 3d, vision, ai, studio, export, plugins, architecture). Without a topic, lists the pages.',
      inputSchema: { topic: z.string().optional().describe('Page name, e.g. "video" or "3d"') },
      annotations: { readOnlyHint: true },
    },
    async ({ topic }) => {
      const docs = await loadDocs();
      if (!docs.size) return text('The Tasweerix docs are not available in this installation.', true);
      if (!topic) return text([...docs].map(([name, body]) => `${name}: ${body.match(/^#\s+(.+)$/m)?.[1] ?? ''}`).join('\n'));
      const key = topic.toLowerCase().replace(/\.md$/, '');
      const page = docs.get(key) ?? [...docs].find(([name]) => name.includes(key))?.[1];
      return page ? text(page) : text(`No page "${topic}". Pages: ${[...docs.keys()].join(', ')}`, true);
    },
  );

  server.registerTool(
    'inspect_composition',
    {
      title: 'Inspect a composition',
      description: 'Loads a composition and returns its size, fps, duration, markers and node tree (kinds, names, timing, sources, text). Use it to understand an existing project before editing, or to check an edit loads without errors.',
      inputSchema: {
        ...compositionArgs,
        depth: z.number().int().min(0).max(50).optional().describe('Tree depth to show (default 4)'),
        full: z.boolean().optional().describe('Return the raw tree with every evaluated prop (large)'),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const r = await cli(['inspect', a.entry, ...compositionFlags(a)]);
      if (r.code) return failed('Loading the composition', r);
      if (a.full) return text(r.stdout);
      const json = JSON.parse(r.stdout) as Record<string, unknown>;
      const { root, ...info } = json;
      return text(JSON.stringify({ ...info, root: compactTree(root as Record<string, unknown>, a.depth ?? 4) }, null, 2));
    },
  );

  server.registerTool(
    'render_still',
    {
      title: 'Render a frame and look at it',
      description: 'Renders one frame of a composition to an image file and returns a preview of it, so you can check layout, colors and text before a full render. Give `time` in seconds or `frame`.',
      inputSchema: {
        ...compositionArgs,
        time: z.number().min(0).optional().describe('Time in seconds (converted to a frame with the composition fps)'),
        frame: z.number().int().min(0).optional().describe('Frame number (default 0)'),
        output: z.string().optional().describe('Image to write (png, jpg, webp, avif, tiff). Default out/preview/<entry>-<frame>.png'),
        scale: z.number().positive().optional().describe('Resolution multiplier'),
      },
    },
    async (a, extra) => {
      let frame = a.frame ?? 0;
      if (a.time !== undefined) {
        const r = await cli(['inspect', a.entry, ...compositionFlags(a)], { signal: extra.signal });
        if (r.code) return failed('Loading the composition', r);
        frame = Math.round(a.time * (JSON.parse(r.stdout) as { fps: number }).fps);
      }
      const output = a.output ?? join('out', 'preview', `${basename(a.entry, extname(a.entry))}-${frame}.png`);
      const flags = [...compositionFlags(a), ...(a.scale ? ['--scale', String(a.scale)] : [])];
      const r = await cli(['still', a.entry, '-o', output, '-f', String(frame), ...flags], { signal: extra.signal });
      if (r.code) return failed('Rendering the frame', r);
      const file = resolve(projectDir, output);
      const preview = previewImage(file);
      const note = `Saved ${file} (frame ${frame}).`;
      if (!preview) return text(`${note} No preview could be made of this format.`);
      return { content: [{ type: 'image', data: preview.data, mimeType: preview.mimeType }, { type: 'text', text: note }] };
    },
  );

  server.registerTool(
    'render_video',
    {
      title: 'Render a video',
      description: 'Renders a composition to a video, animated image or PNG sequence. The codec follows the output extension (mp4 → h264, webm → vp9, mov → prores, gif, webp, apng) unless `codec` is set. Reports progress while it runs.',
      inputSchema: {
        ...compositionArgs,
        output: z.string().describe('Output file, e.g. out/video.mp4'),
        codec: z.enum(['h264', 'h265', 'vp9', 'av1', 'prores', 'gif', 'webp', 'apng', 'png']).optional(),
        range: z.string().regex(/^\d+-\d+$/).optional().describe('Frame range, e.g. 0-120'),
        scale: z.number().positive().optional().describe('Resolution multiplier, e.g. 0.5 for a quick draft'),
        concurrency: z.number().int().positive().optional().describe('Parallel browser workers (default one per core, up to 4)'),
        crf: z.number().optional().describe('Quality, lower is better'),
        preset: z.string().optional().describe('Encoder preset, e.g. veryfast'),
        transparent: z.boolean().optional().describe('Keep alpha (prores, vp9, png, webp)'),
        muted: z.boolean().optional().describe('Skip audio'),
        depth: z.union([z.literal(8), z.literal(16)]).optional().describe('16 removes banding (10-bit video, 16-bit png)'),
        gamut: z.enum(['srgb', 'p3', 'rec2020']).optional(),
        hdr: z.enum(['pq', 'hlg']).optional(),
        gpu: z.enum(['auto', 'on', 'off']).optional(),
      },
    },
    async (a, extra) => {
      const args = ['render', a.entry, '-o', a.output, ...compositionFlags(a)];
      const opt = (flag: string, v: unknown) => v !== undefined && args.push(flag, String(v));
      opt('--codec', a.codec);
      opt('--range', a.range);
      opt('--scale', a.scale);
      opt('-j', a.concurrency);
      opt('--crf', a.crf);
      opt('--preset', a.preset);
      opt('--depth', a.depth);
      opt('--gamut', a.gamut);
      opt('--hdr', a.hdr);
      opt('--gpu', a.gpu);
      if (a.transparent) args.push('--transparent');
      if (a.muted) args.push('--muted');
      const token = extra._meta?.progressToken;
      const r = await cli(args, {
        signal: extra.signal,
        onStderrLine: (line) => {
          const m = token !== undefined && line.match(/\]\s*(\d+)\/(\d+)\s*(.*)$/);
          if (m) void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: Number(m[1]), total: Number(m[2]), message: m[3] || undefined } }).catch(() => {});
        },
      });
      if (r.code) return failed('Rendering', r);
      const file = resolve(projectDir, a.output);
      const size = safeSize(file);
      return text(`${tail(r.stderr, 1)}\n${file}${size ? ` (${size})` : ''}`);
    },
  );

  server.registerTool(
    'render_audio',
    {
      title: 'Render the audio mix',
      description: 'Renders the audio of a composition or soundscape to wav, mp3, flac, aac, ogg or opus and reports its length, loudness (LUFS) and true peak. `stems` also writes one file per bus and clip.',
      inputSchema: {
        ...compositionArgs,
        output: z.string().describe('Output file, e.g. out/mix.mp3'),
        stems: z.boolean().optional(),
      },
    },
    async (a, extra) => {
      const r = await cli(['audio', a.entry, '-o', a.output, ...compositionFlags(a), ...(a.stems ? ['--stems'] : [])], { signal: extra.signal });
      return r.code ? failed('Rendering the audio', r) : text(tail(r.stderr, 3));
    },
  );

  server.registerTool(
    'probe_media',
    {
      title: 'Probe a media file',
      description: 'Returns size, duration, frame rate, codecs, rotation and audio streams of a video, image or audio file.',
      inputSchema: { file: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ file }) => {
      const r = await cli(['probe', file]);
      return r.code ? failed('Probing', r) : text(r.stdout);
    },
  );

  server.registerTool(
    'analyze_audio',
    {
      title: 'Analyze audio',
      description: 'Measures the audio of a media file: duration, integrated loudness (LUFS), true peak, tempo (BPM), beat times and silences.',
      inputSchema: {
        file: z.string(),
        allBeats: z.boolean().optional().describe('Return every beat time instead of the first 32'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ file, allBeats }) => {
      const r = await cli(['analyze', file, '--json']);
      if (r.code) return failed('Analyzing', r);
      const res = JSON.parse(r.stdout) as { beats: number[] } & Record<string, unknown>;
      const beats = allBeats ? res.beats : res.beats.slice(0, 32);
      return text(JSON.stringify({ ...res, beatCount: res.beats.length, beats }, null, 2));
    },
  );

  server.registerTool(
    'suggest_cuts',
    {
      title: 'Suggest cuts',
      description: 'Analyzes a media file and returns an edit as TypeScript to paste into a composition: silence jump-cuts that keep the speech, the shot list, or the beat times.',
      inputSchema: {
        file: z.string().describe('Media file, relative to root'),
        mode: z.enum(['silence', 'shots', 'beats']),
        threshold: z.number().optional().describe('Silence level in dBFS, or scene-change score for shots'),
        minSilence: z.number().optional().describe('Shortest pause to cut, in seconds'),
        padding: z.number().optional().describe('Seconds of audio kept around speech'),
        root: z.string().optional().describe('Project root (default: the project directory)'),
        json: z.boolean().optional().describe('Return the cut list as JSON instead of code'),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const args = ['cuts', a.file, '--mode', a.mode];
      if (a.threshold !== undefined) args.push('--threshold', String(a.threshold));
      if (a.minSilence !== undefined) args.push('--min-silence', String(a.minSilence));
      if (a.padding !== undefined) args.push('--padding', String(a.padding));
      if (a.root) args.push('--root', a.root);
      if (a.json) args.push('--json');
      const r = await cli(args);
      return r.code ? failed('Finding cuts', r) : text(r.stdout);
    },
  );

  server.registerTool(
    'list_audio_plugins',
    {
      title: 'List audio plugins',
      description: 'Lists installed VST3, CLAP, AU, LV2 and LADSPA plugins and which formats can be hosted, or with `describe` the parameters (ids and ranges) of one plugin, for use with afx.plugin().',
      inputSchema: {
        formats: z.array(z.enum(['vst3', 'clap', 'au', 'lv2', 'ladspa'])).optional(),
        describe: z.string().optional().describe('Plugin path or name to describe'),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const args = ['audio-plugins', '--json'];
      if (a.formats?.length) args.push('--format', a.formats.join(','));
      if (a.describe) args.push('--describe', a.describe);
      const r = await cli(args);
      return r.code ? failed('Listing plugins', r) : text(r.stdout);
    },
  );

  return server;
}

/** The docs pages, keyed by name without `.md`, from the copy @tasweerix/ai ships for its assistant. */
async function loadDocs(): Promise<Map<string, string>> {
  const { loadReference } = await import('@tasweerix/ai/node');
  const docs = new Map<string, string>();
  for (const m of loadReference().matchAll(/<doc name="([^"]+)\.md">\n([\s\S]*?)\n<\/doc>/g)) docs.set(m[1]!, m[2]!);
  return docs;
}

/** A JPEG no wider than 1280 px (what a model needs to judge a frame), or the file itself for small PNG/JPEG. */
function previewImage(file: string): { data: string; mimeType: string } | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'tasweerix-mcp-'));
  try {
    const out = join(dir, 'preview.jpg');
    const ffmpeg = process.env.TASWEERIX_FFMPEG ?? 'ffmpeg';
    const r = spawnSync(ffmpeg, ['-v', 'error', '-y', '-i', file, '-vf', "scale='min(1280,iw)':-2", '-frames:v', '1', '-q:v', '3', out]);
    if (r.status === 0) return { data: readFileSync(out).toString('base64'), mimeType: 'image/jpeg' };
    const ext = extname(file).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : undefined;
    if (mimeType && statSync(file).size < 4_000_000) return { data: readFileSync(file).toString('base64'), mimeType };
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function safeSize(file: string): string | undefined {
  try {
    const st = statSync(file);
    if (st.isDirectory()) return 'directory';
    return st.size > 1e6 ? `${(st.size / 1e6).toFixed(1)} MB` : `${Math.ceil(st.size / 1e3)} kB`;
  } catch {
    return undefined;
  }
}
