import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

/**
 * The command that runs the Tasweerix CLI: TASWEERIX_CLI when set, else the project's own
 * @tasweerix/cli (so renders match the version the project pins), else the one this package depends on.
 */
export function resolveCli(projectDir: string): string[] {
  const override = process.env.TASWEERIX_CLI;
  if (override) return /\.[cm]?[jt]s$/.test(override) ? [process.execPath, override] : [override];
  for (const base of [join(projectDir, 'package.json'), import.meta.url]) {
    try {
      const pkgPath = createRequire(base).resolve('@tasweerix/cli/package.json');
      const bin = JSON.parse(readFileSync(pkgPath, 'utf8')).bin;
      const rel = typeof bin === 'string' ? bin : bin?.tasweerix;
      if (rel) return [process.execPath, resolve(dirname(pkgPath), rel)];
    } catch {
      /* not installed there */
    }
  }
  throw new Error('Could not find @tasweerix/cli. Install it in the project (npm i -D @tasweerix/cli) or set TASWEERIX_CLI.');
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CliOptions {
  cwd: string;
  /** Called for each stderr line (progress bars, logs). */
  onStderrLine?: (line: string) => void;
  signal?: AbortSignal;
}

/** Runs `tasweerix <args>` and collects its output. Never throws for a non-zero exit: callers report it. */
export function runCli(args: string[], opts: CliOptions): Promise<CliResult> {
  const [cmd, ...pre] = resolveCli(opts.cwd);
  return new Promise((res, rej) => {
    const child = spawn(cmd!, [...pre, ...args], { cwd: opts.cwd, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let partial = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      stderr += d;
      if (!opts.onStderrLine) return;
      const lines = (partial + d).split(/\r?\n|\r/);
      partial = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) opts.onStderrLine(l);
    });
    const abort = () => child.kill('SIGTERM');
    opts.signal?.addEventListener('abort', abort, { once: true });
    child.on('error', rej);
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', abort);
      res({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** The last `n` non-empty lines of a log, for error messages that stay readable. */
export function tail(text: string, n = 20): string {
  return text.split(/\r?\n|\r/).filter((l) => l.trim()).slice(-n).join('\n');
}
