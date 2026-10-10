import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { definePlugin, type CommandContext, type Plugin } from '@tasweerix/core';
import { toSrt, toVtt } from '@tasweerix/media';
import { FFMPEG, nodeEnv, run, type HostAnalysisContext } from '@tasweerix/media/node';
import { runAssistant } from './assistant';
import { transcribe, transcriptToCues, translateCues, type ImageRef } from './index';
import { aiProvider } from './providers';
import type { AiImage, Effort, Transcript } from './types';

export * from './providers';
export { runAssistant, lineDiff, loadReference, type AssistantResult } from './assistant';

const VIDEO_RE = /\.(mp4|mov|m4v|webm|mkv|avi|mxf)$/i;

/** Encodes an image file or a video frame as a JPEG no larger than 1568 px (what vision models use). */
export async function imageForModel(ref: ImageRef, resolveSrc: (src: string) => string): Promise<AiImage> {
  const src = typeof ref === 'string' ? ref : ref.src;
  const file = resolveSrc(src);
  const time = typeof ref === 'string' ? (VIDEO_RE.test(src) ? 0 : undefined) : ref.time;
  const args = ['-v', 'error', ...(time !== undefined ? ['-ss', time.toFixed(3)] : []), '-i', file, '-frames:v', '1', '-vf', "scale='if(gte(iw,ih),min(1568,iw),-2)':'if(gte(iw,ih),-2,min(1568,ih))'", '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '3', '-'];
  const buf = await run(FFMPEG, args);
  return { mediaType: 'image/jpeg', data: buf.toString('base64') };
}

/** Host analysis behind `ai.generate()`, `ai.generateJSON()` and `ai.describe()`. */
export async function generateAnalysis(_file: string, params: Record<string, unknown>, ctx: HostAnalysisContext): Promise<string> {
  const images = await Promise.all(((params.images as ImageRef[] | undefined) ?? []).map((r) => imageForModel(r, ctx.resolve)));
  const res = await aiProvider('generate').generate!({
    prompt: String(params.prompt),
    system: (params.system as string | undefined) ?? undefined,
    images,
    schema: (params.schema as Record<string, unknown> | undefined) ?? undefined,
    effort: (params.effort as Effort | undefined) ?? undefined,
    maxTokens: (params.maxTokens as number | undefined) ?? undefined,
    model: (params.model as string | undefined) ?? undefined,
  });
  if (params.schema) JSON.parse(res.text); // fail here (not in the browser) on malformed JSON
  return res.text;
}

/** Host analysis behind `ai.transcribe()`: extracts 16 kHz mono audio, runs the STT provider. */
export async function transcribeAnalysis(file: string, params: Record<string, unknown>): Promise<Transcript> {
  const dir = mkdtempSync(join(tmpdir(), 'tasweerix-audio-'));
  try {
    const wav = join(dir, 'audio.wav');
    const from = Number(params.from ?? 0);
    const to = params.to === null || params.to === undefined ? undefined : Number(params.to);
    await run(FFMPEG, ['-y', '-v', 'error', ...(from > 0 ? ['-ss', from.toFixed(3)] : []), '-i', file, ...(to !== undefined ? ['-t', Math.max(0, to - from).toFixed(3)] : []), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
    const t = await aiProvider('transcribe').transcribe!({ file: wav, language: (params.language as string | null) ?? undefined, prompt: (params.prompt as string | null) ?? undefined });
    // Back to source time.
    const shift = (x: number) => +(x + from).toFixed(3);
    return { language: t.language, segments: t.segments.map((s) => ({ ...s, start: shift(s.start), end: shift(s.end), words: s.words?.map((w) => ({ ...w, start: shift(w.start), end: shift(w.end) })) })) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function findEntry(cwd: string): string {
  for (const f of ['index.ts', 'main.ts', 'index.tsx', 'composition.ts']) if (existsSync(join(cwd, f))) return f;
  throw new Error('No entry file found: pass --entry <file>');
}

/** AI features: host analyses for generation and speech, the `ai` assistant and `transcribe`. */
export const aiPlugin: Plugin = definePlugin({
  name: '@tasweerix/ai',
  analyses: {
    'ai.generate': generateAnalysis,
    'ai.transcribe': transcribeAnalysis,
  },
  commands: {
    ai: {
      description: 'Ask the AI assistant to change a project file ("make the title gold and slower", "add Arabic captions from the voiceover")',
      args: ['<request...>'],
      options: [
        { flags: '-e, --entry <file>', description: 'file to edit (default: the project entry)' },
        { flags: '--dry-run', description: 'print the change instead of writing it' },
        { flags: '--effort <level>', description: 'low | medium | high | xhigh | max', default: 'high' },
      ],
      studio: { label: 'Assistant', prompt: 'Describe a change, e.g. "make the title gold and fade it in over 1s"' },
      async run(ctx: CommandContext) {
        // CLI: variadic words form the request. Studio: [request, current file].
        const [request, file] = ctx.host === 'studio' ? [ctx.args[0] ?? '', ctx.args[1] ?? ctx.entry ?? findEntry(ctx.cwd)] : [ctx.args.join(' '), ctx.options.entry ?? findEntry(ctx.cwd)];
        if (!request.trim()) throw new Error('Describe the change you want');
        const r = await runAssistant(ctx, request, file, { dryRun: !!ctx.options.dryRun, effort: ctx.options.effort });
        ctx.log(r.changed ? `${ctx.options.dryRun ? '○ would change' : '✔ changed'} ${r.file}: ${r.summary}` : `No changes: ${r.summary}`);
        if (r.changed && ctx.options.dryRun) console.log(r.diff);
        return r;
      },
    },
    transcribe: {
      description: 'Transcribe speech in a video or audio file to captions (.srt, .vtt or .json), optionally translated',
      args: ['<file>'],
      options: [
        { flags: '-o, --output <file>', description: 'output file (default: <name>.srt next to the input)' },
        { flags: '-l, --language <code>', description: 'spoken language, e.g. ar, en (detected by default)' },
        { flags: '--translate <language>', description: 'translate the captions (uses the generate provider)' },
        { flags: '--max-chars <n>', description: 'characters per caption', default: '42' },
        { flags: '--prompt <text>', description: 'names and terms that appear in the speech' },
      ],
      async run(ctx: CommandContext) {
        const file = resolve(ctx.cwd, ctx.args[0]!);
        const env = nodeEnv(dirname(file));
        const o = ctx.options;
        const t = await transcribe(basename(file), { language: o.language, prompt: o.prompt }, env);
        let cues = transcriptToCues(t, { maxChars: Number(o.maxChars ?? 42) });
        if (o.translate) cues = await translateCues(cues, o.translate, {}, env);
        const out = resolve(ctx.cwd, o.output ?? join(dirname(file), `${basename(file, extname(file))}${o.translate ? `.${o.translate}` : ''}.srt`));
        const ext = extname(out).toLowerCase();
        writeFileSync(out, ext === '.vtt' ? toVtt(cues) : ext === '.json' ? JSON.stringify({ ...t, cues }, null, 2) : toSrt(cues));
        ctx.log(`✔ ${relative(ctx.cwd, out) || out} — ${cues.length} captions${t.language ? ` (${t.language})` : ''}`);
        return { transcript: t, cues };
      },
    },
  },
});
