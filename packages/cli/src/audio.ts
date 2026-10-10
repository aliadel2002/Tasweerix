import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeWav, renderMix } from '@tasweerix/audio';
import { loadComposition } from './project';

/** Renders the composition's mix to a WAV in workDir (undefined when there is no audio). */
export async function renderAudioForExport(o: { entry: string; root: string; comp?: string; props?: Record<string, unknown>; start: number; duration: number; workDir: string }): Promise<string | undefined> {
  const { comp, env } = await loadComposition(o.entry, { comp: o.comp, props: o.props, root: o.root });
  if (!comp.allAudioClips().some((c) => !c.muted)) return undefined;
  const { master } = await renderMix(comp, { load: (src, sr, ch) => env.loadPcm!(src, sr, ch), start: o.start, duration: o.duration });
  const file = join(o.workDir, 'mix.wav');
  writeFileSync(file, encodeWav(master, 'float32'));
  return file;
}
