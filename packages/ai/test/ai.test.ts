import Anthropic from '@anthropic-ai/sdk';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { composition, definePlugin, usePlugin } from '@tasweerix/core';
import { nodeEnv } from '@tasweerix/media/node';
import { ai, transcriptToCues, type AiProvider, type GenerateRequest, type Transcript } from '../src';
import { aiPlugin, anthropicProvider, lineDiff, parseWhisperCppJson, whisperCppProvider } from '../src/node';

const dir = join(__dirname, '.tmp');
const env = nodeEnv(dir);

// A deterministic provider registered the way third-party plugins do it.
const calls: GenerateRequest[] = [];
const transcribeCalls: string[] = [];
const TRANSCRIPT: Transcript = {
  language: 'en',
  segments: [
    { start: 0, end: 2, text: 'Welcome to the show.' },
    { start: 2, end: 4.5, text: 'Um, so, let me find my notes.' },
    { start: 4.5, end: 7, text: 'Our pricing starts at ten dollars.' },
    { start: 7, end: 9, text: 'It includes every feature.' },
  ],
};
const fake: AiProvider = {
  name: 'fake',
  async generate(req) {
    calls.push(req);
    if (req.schema && /Translate/.test(req.prompt)) return { text: JSON.stringify({ lines: req.prompt.split('\n').filter((l) => /^\d+\. /.test(l)).map((l) => `AR: ${l.replace(/^\d+\. /, '')}`) }) };
    if (req.schema && /Edit request/.test(req.prompt)) return { text: JSON.stringify({ keep: [0, 2, 3] }) };
    if (req.schema && /chapters/.test(req.prompt)) return { text: JSON.stringify({ chapters: [{ time: 0, label: 'Intro' }, { time: 4.5, label: 'Pricing' }] }) };
    return { text: `answer ${calls.length}${req.images?.length ? ` with ${req.images.length} image(s)` : ''}` };
  },
  async transcribe(req) {
    transcribeCalls.push(req.file);
    // The host extracted 16 kHz mono audio for us.
    const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', req.file]).toString());
    expect(info.streams[0]).toMatchObject({ sample_rate: '16000', channels: 1 });
    return TRANSCRIPT;
  },
};

beforeAll(() => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  usePlugin(aiPlugin, definePlugin({ name: 'fake-ai', aiProviders: { fake } }));
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=10:r=10', '-f', 'lavfi', '-i', 'sine=d=10', '-shortest', '-pix_fmt', 'yuv420p', join(dir, 'talk.mp4')]);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=2400x1200:d=1', '-frames:v', '1', join(dir, 'big.png')]);
});

describe('AI features through the host (plugin provider)', () => {
  it('generates text and JSON, cached for deterministic renders', async () => {
    const a = await ai.generate('A tagline', {}, env);
    const b = await ai.generate('A tagline', {}, env);
    expect(a).toBe(b);
    expect(calls).toHaveLength(1);
    const v = await ai.generate('A tagline', { variant: 2 }, env);
    expect(v).not.toBe(a);
  });

  it('shows images and video frames to the model (scaled JPEG)', async () => {
    const d = await ai.describe('talk.mp4', { time: 3 }, env);
    expect(d).toMatch(/with 1 image/);
    const img = calls[calls.length - 1]!.images![0]!;
    expect(img.mediaType).toBe('image/jpeg');
    expect(Buffer.from(img.data, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    await ai.generate('What is this?', { images: ['big.png'] }, env);
    const big = calls[calls.length - 1]!.images![0]!;
    const w = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', '-i', 'pipe:0'], { input: Buffer.from(big.data, 'base64') }).toString()).streams[0].width;
    expect(w).toBe(1568);
  });

  it('transcribes into captions, cuts by text, translates and finds chapters', async () => {
    const t = await ai.transcribe('talk.mp4', { language: 'en' }, env);
    expect(t.segments).toHaveLength(4);
    await ai.transcribe('talk.mp4', { language: 'en' }, env);
    expect(transcribeCalls).toHaveLength(1); // cached

    const cuts = await ai.textCuts('talk.mp4', 'Drop the filler', { language: 'en' }, env);
    expect(cuts).toEqual([{ in: 0, out: 2.08 }, { in: 4.42, out: 9.08 }]);

    const comp = await composition({ width: 640, height: 360 }, async (c) => {
      c.add(await ai.captions('talk.mp4', { language: 'en', start: 10, trimIn: 2, translateTo: 'Arabic' }));
      await ai.chapters('talk.mp4', { language: 'en' });
    }).create({ env });
    const caps = comp.root.children[0]!;
    // Source 2 s plays at composition 10 s.
    expect(caps.children[1]!.start).toBeCloseTo(10, 6);
    expect((caps.children[1]!.props as { text: string }).text).toBe('AR: Um, so, let me find my notes.');
    expect(comp.markers.map((m) => m.label)).toEqual(['Intro', 'Pricing']);
  });

  it('splits transcripts into caption-sized cues', () => {
    const cues = transcriptToCues({ segments: [{ start: 0, end: 6, text: 'one two three four five six seven eight nine ten eleven twelve' }] }, { maxChars: 20 });
    expect(cues.length).toBeGreaterThan(2);
    expect(cues.every((c) => c.text.length <= 20)).toBe(true);
    expect(cues[0]!.start).toBe(0);
    expect(cues[cues.length - 1]!.end).toBeCloseTo(6, 6);
  });
});

describe('Claude provider (Anthropic SDK against a local Messages API stub)', () => {
  it('streams with adaptive thinking defaults, structured output, refusal fallbacks and cached context', async () => {
    const seen: { headers: Record<string, string | string[] | undefined>; body: any }[] = [];
    let mode: 'ok' | 'refusal' = 'ok';
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      seen.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`);
      ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } });
      if (mode === 'ok') {
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '{"summary":"ok",' } });
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '"code":"x"}' } });
        ev('content_block_stop', { index: 0 });
      }
      ev('message_delta', { delta: { stop_reason: mode === 'ok' ? 'end_turn' : 'refusal', stop_sequence: null, ...(mode === 'refusal' ? { stop_details: { type: 'refusal', category: 'cyber', explanation: 'not allowed' } } : {}) }, usage: { output_tokens: 9 } });
      ev('message_stop', {});
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const client = new Anthropic({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, maxRetries: 0 });
      const p = anthropicProvider({ client });
      const res = await p.generate!({ prompt: 'Edit it', system: 'You edit files', context: 'API docs', images: [{ mediaType: 'image/jpeg', data: 'AAAA' }], schema: { type: 'object', properties: { code: { type: 'string' } } }, effort: 'high' });
      expect(JSON.parse(res.text)).toEqual({ summary: 'ok', code: 'x' });
      const { headers, body } = seen[0]!;
      expect(String(headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
      expect(body).toMatchObject({ model: 'claude-opus-5-5', stream: true, fallbacks: 'default', system: 'You edit files', output_config: { effort: 'high', format: { type: 'json_schema' } } });
      expect(body.thinking).toBeUndefined(); // adaptive by default on this model
      expect(body.messages[0].content.map((b: { type: string }) => b.type)).toEqual(['image', 'text', 'text']);
      expect(body.messages[0].content[1]).toMatchObject({ text: 'API docs', cache_control: { type: 'ephemeral' } });
      mode = 'refusal';
      await expect(p.generate!({ prompt: 'x' })).rejects.toThrow(/declined.*cyber/);
    } finally {
      server.close();
    }
  });
});

describe('whisper.cpp provider', () => {
  it('runs whisper-cli and reads word timings from its JSON', async () => {
    // A stand-in for whisper-cli that records its arguments and writes -ojf output.
    const bin = join(dir, 'fake-whisper.mjs');
    writeFileSync(
      bin,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const a = process.argv.slice(2);
writeFileSync(${JSON.stringify(join(dir, 'whisper-args.json'))}, JSON.stringify(a));
const out = a[a.indexOf('-of') + 1];
writeFileSync(out + '.json', JSON.stringify({ result: { language: 'ar' }, transcription: [{ offsets: { from: 0, to: 1500 }, text: ' مرحبا بكم', tokens: [{ text: '[_BEG_]', offsets: { from: 0, to: 0 } }, { text: ' مرح', offsets: { from: 0, to: 400 } }, { text: 'با', offsets: { from: 400, to: 700 } }, { text: ' بكم', offsets: { from: 700, to: 1500 } }] }] }));
`,
    );
    chmodSync(bin, 0o755);
    const p = whisperCppProvider({ bin, model: '/models/ggml-base.bin' });
    const t = await p.transcribe!({ file: '/tmp/a.wav', language: 'ar', prompt: 'تصوير' });
    expect(t.language).toBe('ar');
    expect(t.segments[0]!.words).toEqual([{ start: 0, end: 0.7, text: 'مرحبا' }, { start: 0.7, end: 1.5, text: 'بكم' }]);
    const args = JSON.parse(readFileSync(join(dir, 'whisper-args.json'), 'utf8'));
    expect(args).toEqual(expect.arrayContaining(['-m', '/models/ggml-base.bin', '-f', '/tmp/a.wav', '-ojf', '-l', 'ar', '--prompt', 'تصوير']));
    expect(parseWhisperCppJson({ transcription: [] }).segments).toEqual([]);
  });
});

describe('assistant command', () => {
  it('edits project code from a request (CLI, dry run and write)', () => {
    const proj = join(dir, 'proj');
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, 'index.ts'), `import { composition, text } from 'tasweerix';\nexport default composition({ width: 640, height: 360 }, (c) => {\n  c.add(text('Hello', { fill: '#ffffff' }));\n});\n`);
    // The provider sees the file, the docs and the request, and answers with the new file.
    writeFileSync(
      join(proj, 'tasweerix.config.ts'),
      `import { definePlugin } from 'tasweerix';
export default { plugins: [definePlugin({ name: 'echo-ai', aiProviders: { echo: { async generate(req) {
  const file = /<file path="index.ts">\\n([\\s\\S]*?)\\n<\\/file>/.exec(req.prompt)[1];
  if (!req.context.includes('<doc name="guide.md">')) throw new Error('missing docs');
  return { text: JSON.stringify({ summary: 'Made the title gold.', code: file.replace("'#ffffff'", "'#ffd400'") }) };
} } } })] };
`,
    );
    const bin = join(__dirname, '../../cli/bin/tasweerix.mjs');
    const dry = spawnSync(process.execPath, [bin, 'ai', 'make', 'the', 'title', 'gold', '--dry-run'], { cwd: proj });
    expect(dry.status, String(dry.stderr)).toBe(0);
    expect(String(dry.stdout)).toContain("+   c.add(text('Hello', { fill: '#ffd400' }));");
    expect(readFileSync(join(proj, 'index.ts'), 'utf8')).toContain('#ffffff');
    const real = spawnSync(process.execPath, [bin, 'ai', 'make the title gold'], { cwd: proj });
    expect(String(real.stderr)).toContain('✔ changed index.ts: Made the title gold.');
    expect(readFileSync(join(proj, 'index.ts'), 'utf8')).toContain('#ffd400');
  });

  it('prints compact line diffs', () => {
    expect(lineDiff('a\nb\nc\nd\ne\nf\ng', 'a\nb\nc\nX\ne\nf\ng', 1)).toBe('  …\n  c\n- d\n+ X\n  e\n  …');
  });
});
