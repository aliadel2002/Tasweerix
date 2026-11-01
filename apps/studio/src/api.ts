/** Studio ↔ server API and the dynamically loaded preview runtime. */
export interface CompInfo {
  name: string;
  kind: 'video' | 'still' | 'audio';
  width: number;
  height: number;
  fps: number;
  duration: number;
  frameCount: number;
  markers: { time: number; label: string; color?: string }[];
  hasAudio: boolean;
}

export interface TimelineRow {
  id: string;
  name: string;
  kind: string;
  depth: number;
  start: number;
  end: number;
  frames: string[];
  keyframes: { prop: string; times: number[]; frames: string[] }[];
  parent?: string;
}

export interface AudioRow {
  id: string;
  name: string;
  start: number;
  end: number;
  src: string | null;
  frames: string[];
}

export interface Inspection {
  id: string;
  kind: string;
  name?: string;
  start: number;
  duration: number | null;
  props: Record<string, unknown>;
  animated: string[];
  explicit: string[];
  frames: string[];
  trackFrames: Record<string, string[]>;
  filters: string[];
}

export interface PreviewApi {
  definitions(): string[];
  load(o: { comp?: string; props?: Record<string, unknown>; canvas: HTMLCanvasElement; scale: number }): Promise<CompInfo>;
  setScale(s: number): void;
  render(frame: number): Promise<void>;
  timeline(): { rows: TimelineRow[]; audio: AudioRow[] };
  inspect(id: string, frame: number): Inspection | null;
  hitTest(x: number, y: number, frame: number): string | null;
  bounds(id: string, frame: number): [number, number][] | null;
  parentMatrix(id: string, frame: number): number[] | null;
  audio(): Promise<{ sampleRate: number; channels: Float32Array[] } | null>;
  waveform(src: string, buckets: number): Promise<{ min: number[]; max: number[]; duration: number }>;
}

export async function loadRuntime(version: number): Promise<PreviewApi> {
  await import(/* @vite-ignore */ `/api/preview.js?v=${version}`);
  return (window as unknown as { __txPreview: PreviewApi }).__txPreview;
}

export interface ServerState {
  root: string;
  entry: string;
  files: { path: string; size: number }[];
  version: number;
  error: string | null;
  canUndo: boolean;
  canRedo: boolean;
}

export const api = {
  state: (): Promise<ServerState> => fetch('/api/state').then((r) => r.json()),
  readFile: (path: string): Promise<string> => fetch(`/api/file?path=${encodeURIComponent(path)}`).then((r) => r.text()),
  writeFile: (path: string, content: string) => fetch(`/api/file?path=${encodeURIComponent(path)}`, { method: 'PUT', body: content }),
  async edit(frames: string[], edit: Record<string, unknown>): Promise<{ file?: string; line?: number; error?: string }> {
    const r = await fetch('/api/edit', { method: 'POST', body: JSON.stringify({ frames, edit }) });
    return r.json();
  },
  locate: (frames: string[]): Promise<{ file: string; line: number; column: number } | null> => fetch('/api/locate', { method: 'POST', body: JSON.stringify({ frames }) }).then((r) => r.json()),
  undo: () => fetch('/api/undo', { method: 'POST' }).then((r) => r.json()),
  redo: () => fetch('/api/redo', { method: 'POST' }).then((r) => r.json()),
  setEntry: (entry: string) => fetch('/api/entry', { method: 'POST', body: JSON.stringify({ entry }) }),
  async upload(path: string, file: Blob): Promise<void> {
    const r = await fetch(`/api/upload?path=${encodeURIComponent(path)}`, { method: 'POST', body: file });
    if (!r.ok) throw new Error(`Upload of ${path} failed: ${(await r.text()) || r.status}`);
  },
  export: (o: Record<string, unknown>) => fetch('/api/export', { method: 'POST', body: JSON.stringify(o) }).then((r) => r.json()),
  /** Plugin commands that offer a studio action (e.g. the AI assistant). */
  commands: (): Promise<StudioCommand[]> => fetch('/api/commands').then((r) => r.json()),
  runCommand: (name: string, input: string, file: string): Promise<{ ok: boolean; log: string[]; error?: string }> =>
    fetch('/api/command', { method: 'POST', body: JSON.stringify({ name, input, file }) }).then((r) => r.json()),
};

export interface StudioCommand {
  name: string;
  label: string;
  prompt: string | null;
  description: string;
}

export function timecode(t: number, fps: number): string {
  const f = Math.round(t * fps);
  const ff = f % Math.round(fps);
  const s = Math.floor(f / Math.round(fps));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 60))}:${p(s % 60)}:${p(ff)}`;
}
