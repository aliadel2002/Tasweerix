import { Command } from 'commander';
import { resolve } from 'node:path';
import { probe } from '@tasweerix/media/node';
import { render } from './render';
import { progressBar } from './progress';
import type { Codec } from './encode';

const program = new Command();
program.name('tasweerix').description('Code-first video, audio, photo and motion graphics').version('0.1.0');

const parseProps = (s?: string) => (s ? (JSON.parse(s) as Record<string, unknown>) : undefined);

program
  .command('render')
  .description('Render a composition to a video / animated image / PNG sequence')
  .argument('<entry>', 'TypeScript/JavaScript file exporting a composition')
  .option('-o, --output <file>', 'output file', 'out/video.mp4')
  .option('-c, --comp <name>', 'named export to render (default export otherwise)')
  .option('--codec <codec>', 'h264 | h265 | vp9 | av1 | prores | gif | webp | apng | png')
  .option('--crf <n>', 'quality (lower is better)', Number)
  .option('--preset <name>', 'encoder preset')
  .option('--scale <n>', 'resolution multiplier', Number)
  .option('--range <a-b>', 'frame range, e.g. 0-120')
  .option('-j, --concurrency <n>', 'parallel browser workers', Number, 1)
  .option('--transparent', 'keep alpha (prores/vp9/png/webp)')
  .option('--muted', 'skip audio')
  .option('--props <json>', 'input props JSON')
  .option('--root <dir>', 'project root for assets')
  .option('--motion-blur-samples <n>', 'sub-frame samples for motion blur', Number)
  .action(async (entry: string, o) => {
    const bar = progressBar('Rendering');
    const range = o.range ? (o.range.split('-').map(Number) as [number, number]) : undefined;
    const { renderAudioForExport } = await import('./audio').catch(() => ({ renderAudioForExport: undefined }));
    const res = await render({
      entry,
      output: o.output,
      comp: o.comp,
      codec: o.codec as Codec | undefined,
      crf: o.crf,
      preset: o.preset,
      scale: o.scale,
      range,
      concurrency: o.concurrency,
      transparent: o.transparent,
      muted: o.muted,
      props: parseProps(o.props),
      root: o.root,
      motionBlurSamples: o.motionBlurSamples,
      renderAudio: renderAudioForExport,
      log: (m) => console.error(m),
      onProgress: (p) => bar.update(p.done, p.total, `${p.fps.toFixed(1)} fps, ETA ${p.eta.toFixed(0)}s`),
    });
    bar.done();
    console.error(`✔ ${res.output} (${res.seconds.toFixed(1)}s)`);
  });

program
  .command('still')
  .description('Render one frame (photo edits, illustrations, thumbnails) to png/jpg/webp/avif')
  .argument('<entry>')
  .option('-o, --output <file>', 'output image', 'out/still.png')
  .option('-f, --frame <n>', 'frame number', Number, 0)
  .option('-c, --comp <name>')
  .option('--scale <n>', 'resolution multiplier', Number)
  .option('--props <json>', 'input props JSON')
  .option('--root <dir>', 'project root for assets')
  .action(async (entry: string, o) => {
    const res = await render({ entry, output: o.output, still: o.frame, comp: o.comp, scale: o.scale, props: parseProps(o.props), root: o.root, log: (m) => console.error(m) });
    console.error(`✔ ${res.output} (${res.seconds.toFixed(1)}s)`);
  });

program
  .command('probe')
  .description('Show media information')
  .argument('<file>')
  .action(async (file: string) => {
    console.log(JSON.stringify(await probe(resolve(file)), null, 2));
  });

await import('./commands').then((m) => m.registerCommands(program)).catch((e) => {
  if (!String(e?.message).includes('Cannot find module')) throw e;
});

program.parseAsync(process.argv).catch((e) => {
  console.error(`✖ ${e?.stack ?? e}`);
  process.exit(1);
});
