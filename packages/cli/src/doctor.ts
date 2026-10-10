import { spawnSync } from 'node:child_process';
import { DCRAW_EMU, FFMPEG, FFPROBE } from '@tasweerix/media/node';
import { hostableFormats } from '@tasweerix/audio/node';
import { findChromium } from './browser';

export interface Check {
  name: string;
  /** Required checks fail the whole run; optional ones only turn features off. */
  required: boolean;
  ok: boolean;
  detail: string;
  /** What the check enables, for optional ones. */
  feature?: string;
  /** How to fix it when it fails. */
  fix?: string;
}

/** Runs `cmd args` and returns its first output line, or undefined when it can't start. */
function firstLine(cmd: string, args: string[]): string | undefined {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10_000 });
  if (r.error) return undefined;
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').find((l) => l.trim())?.trim() ?? '';
}

const INSTALL_FFMPEG = 'install FFmpeg (apt install ffmpeg, brew install ffmpeg, or winget install ffmpeg) or set TASWEERIX_FFMPEG and TASWEERIX_FFPROBE';

/** Checks the tools Tasweerix needs (and the optional ones behind some features) without rendering anything. */
export function runDoctor(): Check[] {
  const checks: Check[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({ name: 'Node.js', required: true, ok: major >= 20, detail: process.version, fix: 'install Node.js 20 or newer' });

  const ffmpeg = firstLine(FFMPEG, ['-version']);
  checks.push({ name: 'FFmpeg', required: true, ok: ffmpeg !== undefined, detail: ffmpeg ?? `${FFMPEG} not found`, fix: INSTALL_FFMPEG });
  const ffprobe = firstLine(FFPROBE, ['-version']);
  checks.push({ name: 'ffprobe', required: true, ok: ffprobe !== undefined, detail: ffprobe ?? `${FFPROBE} not found`, fix: INSTALL_FFMPEG });

  const chromium = findChromium();
  checks.push({
    name: 'Chromium',
    required: true,
    ok: !!chromium,
    detail: chromium ?? 'not found',
    feature: 'render, still and studio export',
    fix: 'run `npx playwright-core@1.56.1 install chromium`, or point TASWEERIX_CHROMIUM at Chrome or Chromium',
  });

  const dcraw = spawnSync(DCRAW_EMU, [], { timeout: 10_000 });
  checks.push({
    name: 'LibRaw (dcraw_emu)',
    required: false,
    ok: !dcraw.error,
    detail: dcraw.error ? `${DCRAW_EMU} not found` : DCRAW_EMU,
    feature: 'camera RAW photos (DNG, CR3, NEF, ARW …)',
    fix: 'apt install libraw-bin, or brew install libraw, or set TASWEERIX_DCRAW_EMU',
  });

  const whisperBin = process.env.TASWEERIX_WHISPER_BIN ?? 'whisper-cli';
  const whisper = !spawnSync(whisperBin, ['--help'], { timeout: 10_000 }).error;
  const model = process.env.TASWEERIX_WHISPER_MODEL;
  checks.push({
    name: 'whisper.cpp',
    required: false,
    ok: whisper && !!model,
    detail: !whisper ? `${whisperBin} not found` : model ? `${whisperBin}, model ${model}` : 'TASWEERIX_WHISPER_MODEL is not set',
    feature: 'transcribe, ai.captions and other speech-to-text',
    fix: 'install whisper.cpp and set TASWEERIX_WHISPER_MODEL to a ggml model file',
  });

  // Only whether credentials are present: the values are never printed.
  const key = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  checks.push({
    name: 'Anthropic credentials',
    required: false,
    ok: key,
    detail: key ? 'set in the environment' : 'ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are not set',
    feature: 'ai.generate, ai.describe and the `tasweerix ai` assistant',
    fix: 'set ANTHROPIC_API_KEY, or run `ant auth login` (a login profile works without the variables)',
  });

  const hosts = hostableFormats();
  const formats = Object.keys(hosts);
  checks.push({
    name: 'Audio plugin hosts',
    required: false,
    ok: formats.length > 0,
    detail: formats.length ? formats.map((f) => `${f} via ${hosts[f as keyof typeof hosts]}`).join(', ') : 'none',
    feature: 'afx.plugin() with VST3, CLAP, LV2 or LADSPA plugins',
    fix: 'LV2/LADSPA need an ffmpeg built with them; VST3/CLAP need `pnpm build:plugin-host` or TASWEERIX_PLUGIN_HOST',
  });
  return checks;
}

export function formatDoctor(checks: Check[]): string {
  const lines = checks.map((c) => {
    const mark = c.ok ? '✔' : c.required ? '✖' : '○';
    const why = c.feature && !c.ok ? ` (needed for ${c.feature})` : '';
    return `${mark} ${c.name.padEnd(22)} ${c.detail}${why}${c.ok ? '' : `\n  → ${c.fix}`}`;
  });
  const missing = checks.filter((c) => c.required && !c.ok);
  lines.push('', missing.length ? `✖ Missing: ${missing.map((c) => c.name).join(', ')}` : '✔ Ready to render');
  return lines.join('\n');
}
