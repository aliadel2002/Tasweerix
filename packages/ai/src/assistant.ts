import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandContext } from '@tasweerix/core';
import { aiProvider } from './providers';
import type { Effort } from './types';

const SYSTEM = `You are the code assistant of Tasweerix, a code-first media engine: TypeScript files describe videos, photos, audio, motion graphics and 3D scenes, and the studio renders them live.

You receive one project file and a change request. Return the complete new file.

Rules:
- Change what the request asks for and nothing else. Keep the author's formatting, comments, names and structure.
- Write literal values (numbers, strings, arrays) where you can: the studio can only edit literals two ways.
- Import only from 'tasweerix' (the umbrella package) unless the file already imports elsewhere.
- Use only assets listed in the project files, or say in the summary which file the user must add.
- Times are in seconds. Positions are composition pixels unless inside a 3D scene (world units, y up).
- If the request cannot be done with the documented API, return the file unchanged and explain why in the summary.`;

/** API documentation (docs/*.md), sent as cached context: the repository's, or the copy shipped in the published package. */
export function loadReference(): string {
  const built = /[\\/]dist[\\/][^\\/]*$/.test(fileURLToPath(import.meta.url));
  const dir = fileURLToPath(new URL(built ? '../docs/' : '../../../docs/', import.meta.url));
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => `<doc name="${f}">\n${readFileSync(join(dir, f), 'utf8')}\n</doc>`)
    .join('\n\n');
}

const SKIP = /(^|[\\/])(node_modules|\.git|\.tasweerix|out|dist)([\\/]|$)/;
function listFiles(root: string, dir = root, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    const rel = relative(root, full);
    if (SKIP.test(rel)) continue;
    const st = statSync(full);
    if (st.isDirectory()) listFiles(root, full, out);
    else out.push(rel.split(sep).join('/'));
    if (out.length > 400) break;
  }
  return out;
}

/** Line diff (LCS) with a little context, for --dry-run output. */
export function lineDiff(a: string, b: string, context = 2): string {
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const ops: { t: ' ' | '-' | '+'; s: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      ops.push({ t: ' ', s: x[i++]! });
      j++;
    } else if (j < m && (i >= n || dp[i]![j + 1]! > dp[i + 1]![j]!)) ops.push({ t: '+', s: y[j++]! });
    else ops.push({ t: '-', s: x[i++]! });
  }
  const keep = ops.map((o, k) => o.t !== ' ' || ops.slice(Math.max(0, k - context), k + context + 1).some((p) => p.t !== ' '));
  const lines: string[] = [];
  ops.forEach((o, k) => {
    if (keep[k]) lines.push(`${o.t} ${o.s}`);
    else if (k === 0 || keep[k - 1]) lines.push('  …');
  });
  return lines.join('\n');
}

export interface AssistantResult {
  summary: string;
  changed: boolean;
  file: string;
  diff: string;
}

/** Edits a project file from a natural-language request (the `ai` command and the studio Assistant). */
export async function runAssistant(ctx: CommandContext, instruction: string, file: string, o: { dryRun?: boolean; effort?: Effort } = {}): Promise<AssistantResult> {
  const source = await ctx.readFile(file);
  const provider = aiProvider('generate');
  const files = listFiles(ctx.cwd);
  const res = await provider.generate!({
    system: SYSTEM,
    context: `<reference>\n${loadReference()}\n</reference>`,
    prompt: `<project_files>\n${files.join('\n')}\n</project_files>\n\n<file path="${file}">\n${source}\n</file>\n\n<request>\n${instruction}\n</request>\n\nReturn the complete new content of ${file} in "code" and one or two sentences for the user in "summary".`,
    schema: { type: 'object', properties: { summary: { type: 'string' }, code: { type: 'string' } }, required: ['summary', 'code'], additionalProperties: false },
    effort: o.effort ?? 'high',
    maxTokens: 64000,
  });
  const out = JSON.parse(res.text) as { summary: string; code: string };
  const code = out.code.endsWith('\n') || !source.endsWith('\n') ? out.code : `${out.code}\n`;
  const changed = code.trim() !== source.trim() && code.trim().length > 0;
  const diff = changed ? lineDiff(source, code) : '';
  if (changed && !o.dryRun) await ctx.writeFile(file, code);
  return { summary: out.summary, changed, file, diff };
}
