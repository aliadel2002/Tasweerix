/** Source location of an API call (used by the studio for two-way code editing). */
export interface SourceRef {
  /** Raw stack frames ("url:line:col"), innermost first. The studio maps them through source maps. */
  frames: string[];
  /** Resolved user-code location (filled in by tooling that has source maps). */
  file?: string;
  line?: number;
  column?: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __TASWEERIX_TRACE__: boolean | undefined;
}

const FRAME_RE = /((?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s()]*?):(\d+):(\d+)\)?\s*$/i;

/**
 * Captures the call stack of an API call. Only active when tracing is on (the studio enables it),
 * so production renders pay nothing. The first frames belong to Tasweerix itself; tooling picks the
 * first frame that maps back to a user project file.
 */
export function captureSource(): SourceRef | undefined {
  if (!globalThis.__TASWEERIX_TRACE__) return undefined;
  const stack = new Error().stack ?? '';
  const frames: string[] = [];
  for (const l of stack.split('\n').slice(2, 30)) {
    const m = FRAME_RE.exec(l.trim());
    if (m) frames.push(`${m[1]}:${m[2]}:${m[3]}`);
  }
  return { frames };
}
