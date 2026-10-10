import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { FFMPEG } from './ffmpeg';

/** Scene-change times (seconds) using ffmpeg's scene score. */
export function detectScenes(file: string, threshold = 0.3): Promise<{ time: number; score: number }[]> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-an', '-vf', `scale=320:-2,select='gt(scene,${threshold})',metadata=print`, '-f', 'null', '-']);
    let err = '';
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`scene detection failed: ${err.slice(-500)}`));
      const out: { time: number; score: number }[] = [];
      const re = /pts_time:([\d.]+)[\s\S]*?lavfi\.scene_score=([\d.]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(err))) out.push({ time: Number(m[1]), score: Number(m[2]) });
      resolve(out);
    });
  });
}

/** File-backed JSON cache keyed by analysis key; entries are invalidated when the source changes. */
export class AnalysisCache {
  constructor(private dir: string) {}
  private file(key: string) {
    return join(this.dir, `${createHash('sha1').update(key).digest('hex')}.json`);
  }
  private stamp(src?: string): string {
    if (!src) return '';
    try {
      const s = statSync(src);
      return `${s.size}:${s.mtimeMs}`;
    } catch {
      return 'missing';
    }
  }
  get<T>(key: string, src?: string): T | undefined {
    const f = this.file(key);
    if (!existsSync(f)) return undefined;
    try {
      const e = JSON.parse(readFileSync(f, 'utf8')) as { stamp: string; value: T };
      return e.stamp === this.stamp(src) ? e.value : undefined;
    } catch {
      return undefined;
    }
  }
  set(key: string, value: unknown, src?: string): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file(key), JSON.stringify({ stamp: this.stamp(src), value }));
  }
}

/** Host-side analyses exposed through Env.analyze / the /__tx/analyze endpoint. */
export async function hostAnalyze(kind: string, file: string, params: Record<string, unknown>): Promise<unknown> {
  switch (kind) {
    case 'scenes':
      return detectScenes(file, Number(params.threshold ?? 0.3));
    default:
      throw new Error(`Unknown analysis "${kind}"`);
  }
}
