import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onPlugin } from '@tasweerix/core';
import type { AiProvider, GenerateRequest, GenerateResult, Transcript, TranscribeRequest } from './types';

/** The default Claude model for every AI feature (override with TASWEERIX_AI_MODEL). */
export const DEFAULT_MODEL = 'claude-opus-5-5';

const providers = new Map<string, AiProvider>();
const builtin = new Set<string>();

/** Registers an AI provider (later registrations win over built-ins for the capabilities they have). */
export function registerAiProvider(p: AiProvider): void {
  providers.set(p.name, p);
}

/**
 * The provider for a capability: TASWEERIX_AI_PROVIDER (generate) / TASWEERIX_STT_PROVIDER
 * (transcribe) when set, else the latest plugin provider that has it, else the built-in one.
 */
export function aiProvider(capability: 'generate' | 'transcribe'): AiProvider {
  const wanted = capability === 'generate' ? process.env.TASWEERIX_AI_PROVIDER : process.env.TASWEERIX_STT_PROVIDER;
  if (wanted) {
    const p = providers.get(wanted);
    if (!p?.[capability]) throw new Error(`AI provider "${wanted}" ${p ? `cannot ${capability}` : 'is not registered'} (registered: ${[...providers.keys()].join(', ')})`);
    return p;
  }
  const list = [...providers.values()].filter((p) => p[capability]);
  const custom = list.filter((p) => !builtin.has(p.name));
  const p = custom[custom.length - 1] ?? list[0];
  if (!p) throw new Error(`No AI provider can ${capability}`);
  return p;
}

onPlugin((plugin) => {
  for (const [name, p] of Object.entries(plugin.aiProviders ?? {})) registerAiProvider({ ...(p as AiProvider), name });
});

// ------------------------------------------------------------------ Claude (Anthropic API)

/**
 * Claude through the Anthropic API. Credentials come from the environment the usual way
 * (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile). Requests stream (long
 * answers never hit HTTP timeouts), use adaptive thinking with an effort level, return JSON through
 * structured outputs when a schema is given, and opt into server-side refusal fallbacks.
 */
export function anthropicProvider(o: { model?: string; client?: Anthropic } = {}): AiProvider {
  let client = o.client;
  return {
    name: 'anthropic',
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      client ??= new Anthropic();
      const content: Anthropic.Beta.BetaContentBlockParam[] = [];
      for (const img of req.images ?? []) content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
      // Stable reference material goes first and is cached across requests.
      if (req.context) content.push({ type: 'text', text: req.context, cache_control: { type: 'ephemeral' } });
      content.push({ type: 'text', text: req.prompt });
      const stream = client.beta.messages.stream({
        model: req.model ?? o.model ?? process.env.TASWEERIX_AI_MODEL ?? DEFAULT_MODEL,
        max_tokens: req.maxTokens ?? 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        ...(req.system ? { system: req.system } : {}),
        messages: [{ role: 'user', content }],
        output_config: { effort: req.effort ?? 'medium', ...(req.schema ? { format: { type: 'json_schema' as const, schema: req.schema } } : {}) },
      });
      const msg = await stream.finalMessage();
      if (msg.stop_reason === 'refusal') throw new Error(`The model declined this request${msg.stop_details?.category ? ` (${msg.stop_details.category})` : ''}${msg.stop_details?.explanation ? `: ${msg.stop_details.explanation}` : ''}`);
      if (msg.stop_reason === 'max_tokens') throw new Error(`The answer was cut off at ${req.maxTokens ?? 16000} tokens; raise maxTokens`);
      const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      return { text, model: msg.model, usage: { input: msg.usage.input_tokens, output: msg.usage.output_tokens, cacheRead: msg.usage.cache_read_input_tokens ?? 0 } };
    },
  };
}

// ------------------------------------------------------------------ whisper.cpp (local speech to text)

function runProcess(cmd: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('error', (e) => rej(new Error(`${cmd}: ${e.message}. Install whisper.cpp (https://github.com/ggml-org/whisper.cpp) or set TASWEERIX_WHISPER_BIN`)));
    p.on('close', (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited with ${code}: ${err.slice(-800)}`))));
  });
}

/** Turns whisper.cpp's full JSON output (-ojf) into a transcript with word timings. */
export function parseWhisperCppJson(json: any): Transcript {
  const segments = (json.transcription ?? []).map((seg: any) => {
    const words: { start: number; end: number; text: string }[] = [];
    for (const tok of seg.tokens ?? []) {
      const t = String(tok.text ?? '');
      if (!t || /^\[_?[A-Z_]+[^\]]*\]$/.test(t.trim())) continue; // special tokens like [_BEG_]
      const from = Number(tok.offsets?.from ?? 0) / 1000;
      const to = Number(tok.offsets?.to ?? 0) / 1000;
      // Tokens starting with a space start a new word; others continue the previous one.
      if (/^\s/.test(t) || !words.length) words.push({ start: from, end: to, text: t.trim() });
      else {
        const w = words[words.length - 1]!;
        w.text += t;
        w.end = to;
      }
    }
    return { start: Number(seg.offsets?.from ?? 0) / 1000, end: Number(seg.offsets?.to ?? 0) / 1000, text: String(seg.text ?? '').trim(), words: words.filter((w) => w.text).length ? words.filter((w) => w.text) : undefined };
  });
  return { language: json.result?.language, segments: segments.filter((s: { text: string }) => s.text) };
}

/**
 * Local speech recognition with whisper.cpp (`whisper-cli`). Needs a ggml model file:
 * TASWEERIX_WHISPER_MODEL=/path/to/ggml-large-v3-turbo.bin (TASWEERIX_WHISPER_BIN for the binary).
 */
export function whisperCppProvider(o: { bin?: string; model?: string; threads?: number } = {}): AiProvider {
  return {
    name: 'whisper-cpp',
    async transcribe(req: TranscribeRequest): Promise<Transcript> {
      const bin = o.bin ?? process.env.TASWEERIX_WHISPER_BIN ?? 'whisper-cli';
      const model = o.model ?? process.env.TASWEERIX_WHISPER_MODEL;
      if (!model) throw new Error('Speech to text needs a whisper.cpp model: set TASWEERIX_WHISPER_MODEL to a ggml model file (e.g. ggml-large-v3-turbo.bin), or register another provider in tasweerix.config.ts');
      const dir = mkdtempSync(join(tmpdir(), 'tasweerix-stt-'));
      try {
        const out = join(dir, 'out');
        const args = ['-m', model, '-f', req.file, '-ojf', '-of', out, '-l', req.language ?? 'auto', '-np'];
        if (o.threads) args.push('-t', String(o.threads));
        if (req.prompt) args.push('--prompt', req.prompt);
        await runProcess(bin, args);
        return parseWhisperCppJson(JSON.parse(readFileSync(`${out}.json`, 'utf8')));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

for (const p of [anthropicProvider(), whisperCppProvider()]) {
  registerAiProvider(p);
  builtin.add(p.name);
}
