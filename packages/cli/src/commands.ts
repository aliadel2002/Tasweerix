import type { Command } from 'commander';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { decodePcm, FFMPEG, run } from '@tasweerix/media/node';
import { detectBeats, detectSilence, encodeWav, integratedLoudness, renderMix, truePeakDb } from '@tasweerix/audio';
import { loadComposition } from './project';

const parseProps = (s?: string) => (s ? (JSON.parse(s) as Record<string, unknown>) : undefined);

export function registerCommands(program: Command): void {
  program
    .command('audio')
    .description('Render the audio mix of a composition / soundscape (wav, mp3, flac, aac, ogg, opus)')
    .argument('<entry>')
    .option('-o, --output <file>', 'output file', 'out/mix.wav')
    .option('-c, --comp <name>')
    .option('--props <json>')
    .option('--stems', 'also write one file per bus and clip')
    .option('--sample-rate <n>', 'sample rate', Number)
    .action(async (entry: string, o) => {
      const t0 = Date.now();
      const { comp, env } = await loadComposition(entry, { comp: o.comp, props: parseProps(o.props) });
      const res = await renderMix(comp, { load: (s, sr, ch) => env.loadPcm!(s, sr, ch), stems: !!o.stems, sampleRate: o.sampleRate });
      const out = resolve(o.output);
      mkdirSync(dirname(out), { recursive: true });
      await writeAudio(out, encodeWav(res.master, 'float32'));
      if (res.stems) {
        for (const [name, data] of res.stems) {
          const f = out.replace(/(\.[^.]+)$/, `.${name.replace(/[^\w.-]+/g, '_')}$1`);
          await writeAudio(f, encodeWav(data, 'float32'));
        }
      }
      const lufs = integratedLoudness(res.master);
      console.error(`✔ ${out} — ${comp.duration.toFixed(2)}s, ${lufs.toFixed(1)} LUFS, ${truePeakDb(res.master).toFixed(1)} dBTP (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    });

  program
    .command('analyze')
    .description('Analyze an audio/video file: loudness, peak, tempo, beats and silences')
    .argument('<file>')
    .option('--json', 'machine-readable output')
    .action(async (file: string, o) => {
      const sr = 44100;
      const chs = await decodePcm(resolve(file), sr, 2);
      const data = { sampleRate: sr, channels: chs };
      const beats = detectBeats({ sampleRate: sr, channels: [chs[0]!.map((v, i) => (v + chs[1]![i]!) / 2)] });
      const result = {
        duration: chs[0]!.length / sr,
        lufs: +integratedLoudness(data).toFixed(2),
        truePeak: +truePeakDb(data).toFixed(2),
        bpm: +beats.bpm.toFixed(1),
        beats: beats.beats.map((b) => +b.toFixed(3)),
        silences: detectSilence(data).map((s) => ({ start: +s.start.toFixed(3), end: +s.end.toFixed(3) })),
      };
      if (o.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`duration  ${result.duration.toFixed(2)}s`);
        console.log(`loudness  ${result.lufs} LUFS   true peak ${result.truePeak} dBTP`);
        console.log(`tempo     ${result.bpm} BPM (${result.beats.length} beats)`);
        console.log(`silences  ${result.silences.map((s) => `${s.start}–${s.end}`).join(', ') || 'none'}`);
      }
    });

  program
    .command('inspect')
    .description('Print the composition tree as JSON (timing, props, audio)')
    .argument('<entry>')
    .option('-c, --comp <name>')
    .option('--props <json>')
    .action(async (entry: string, o) => {
      const { comp } = await loadComposition(entry, { comp: o.comp, props: parseProps(o.props) });
      console.log(JSON.stringify(comp.toJSON(), null, 2));
    });
}

/** Writes WAV bytes, transcoding via ffmpeg when the extension isn't .wav. */
export async function writeAudio(path: string, wav: Uint8Array): Promise<void> {
  const ext = extname(path).toLowerCase();
  if (ext === '.wav') {
    writeFileSync(path, wav);
    return;
  }
  const codec: Record<string, string[]> = {
    '.mp3': ['-c:a', 'libmp3lame', '-q:a', '2'],
    '.flac': ['-c:a', 'flac'],
    '.aac': ['-c:a', 'aac', '-b:a', '256k'],
    '.m4a': ['-c:a', 'aac', '-b:a', '256k'],
    '.ogg': ['-c:a', 'libvorbis', '-q:a', '6'],
    '.opus': ['-c:a', 'libopus', '-b:a', '160k'],
  };
  await run(FFMPEG, ['-y', '-v', 'error', '-f', 'wav', '-i', '-', ...(codec[ext] ?? []), path], Buffer.from(wav));
}
