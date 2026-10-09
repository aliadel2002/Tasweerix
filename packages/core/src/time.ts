/**
 * Time handling. Internally Tasweerix measures time in **seconds** (floating point).
 * Users may write times as:
 *   - numbers                → seconds            (2.5)
 *   - '2.5s' | '250ms' | '1.5m' | '1h'
 *   - '90f'                  → frames at the active fps
 *   - '01:02.5' | '00:01:02.5' (clock)  |  '00:01:02:15' (SMPTE timecode, last field = frames)
 */
export type TimeInput = number | string;

let activeFps = 30;

/** Sets the fps used to interpret frame-based time strings while a composition is being built. */
export function withFps<T>(fps: number, fn: () => T): T {
  const prev = activeFps;
  activeFps = fps;
  try {
    const out = fn();
    if (out instanceof Promise) {
      return out.finally(() => {
        activeFps = prev;
      }) as T;
    }
    activeFps = prev;
    return out;
  } catch (e) {
    activeFps = prev;
    throw e;
  }
}

export function getActiveFps(): number {
  return activeFps;
}

const UNIT_RE = /^\s*(-?\d*\.?\d+(?:e-?\d+)?)\s*(ms|s|m|h|f|fr|frames?)?\s*$/i;

export function toSeconds(input: TimeInput | undefined | null, fps: number = activeFps): number {
  if (input === undefined || input === null) return 0;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return input;
    return input;
  }
  const s = input.trim();
  const m = UNIT_RE.exec(s);
  if (m) {
    const v = parseFloat(m[1]!);
    switch ((m[2] ?? 's').toLowerCase()) {
      case 'ms':
        return v / 1000;
      case 's':
        return v;
      case 'm':
        return v * 60;
      case 'h':
        return v * 3600;
      default:
        return v / fps;
    }
  }
  if (s.includes(':')) {
    const neg = s.startsWith('-');
    const parts = (neg ? s.slice(1) : s).split(':');
    if (parts.some((p) => p === '' || isNaN(Number(p)))) throw new Error(`Invalid time "${input}"`);
    let secs: number;
    if (parts.length === 4) {
      const [h, mm, ss, ff] = parts.map(Number) as [number, number, number, number];
      secs = h * 3600 + mm * 60 + ss + ff / fps;
    } else if (parts.length === 3) {
      const [h, mm, ss] = parts.map(Number) as [number, number, number];
      secs = h * 3600 + mm * 60 + ss;
    } else if (parts.length === 2) {
      const [mm, ss] = parts.map(Number) as [number, number];
      secs = mm * 60 + ss;
    } else throw new Error(`Invalid time "${input}"`);
    return neg ? -secs : secs;
  }
  throw new Error(`Invalid time "${input}"`);
}

/** Frame index (integer) for a time in seconds. Uses a tiny epsilon so 1/3 * 3 lands on frame 1. */
export function toFrame(seconds: number, fps: number): number {
  return Math.floor(seconds * fps + 1e-6);
}

export function frameToSeconds(frame: number, fps: number): number {
  return frame / fps;
}

/** Number of whole frames covering a duration. */
export function frameCount(durationSeconds: number, fps: number): number {
  return Math.max(0, Math.round(durationSeconds * fps));
}

/** SMPTE-like timecode HH:MM:SS:FF */
export function formatTimecode(seconds: number, fps: number): string {
  const totalFrames = Math.round(seconds * fps);
  const f = totalFrames % Math.round(fps);
  const totalSecs = Math.floor(totalFrames / Math.round(fps));
  const s = totalSecs % 60;
  const m = Math.floor(totalSecs / 60) % 60;
  const h = Math.floor(totalSecs / 3600);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}:${p(f)}`;
}

/** Clock format M:SS.mmm */
export function formatClock(seconds: number): string {
  const neg = seconds < 0;
  const a = Math.abs(seconds);
  const m = Math.floor(a / 60);
  const s = a - m * 60;
  return `${neg ? '-' : ''}${m}:${s.toFixed(3).padStart(6, '0')}`;
}

export const sec = (n: number): number => n;
export const ms = (n: number): number => n / 1000;
export const frames = (n: number, fps: number = activeFps): number => n / fps;
