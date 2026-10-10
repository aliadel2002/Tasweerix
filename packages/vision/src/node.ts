import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { definePlugin, type CommandContext, type Plugin, type Vec2 } from '@tasweerix/core';
import { FFMPEG, nodeEnv, probe } from '@tasweerix/media/node';
import { gray, type Gray } from './image';
import { MotionEstimator, type MotionData } from './motion';
import { shakeStats } from './stabilize';
import { trackPointInFrames, type PointTrack } from './track';
import { analyzeMotion, ANALYSIS_WIDTH, trackPoint } from './index';

export interface GrayStreamOptions {
  /** Output width (height follows the aspect ratio, rounded to even). */
  width: number;
  /** Source range in seconds. */
  from?: number;
  to?: number | null;
}

/**
 * Decodes a video to 8-bit gray frames at analysis size with ffmpeg and calls `onFrame` for each
 * frame in order (streamed: memory stays flat for long clips).
 */
export interface GrayStreamInfo {
  width: number;
  height: number;
  fps: number;
  /** Source time of frame 0. */
  start: number;
}

export async function streamGrayFrames(file: string, o: GrayStreamOptions, onFrame: (frame: Uint8Array, index: number, info: GrayStreamInfo) => void): Promise<GrayStreamInfo & { count: number }> {
  const info = await probe(file);
  if (!info.width || !info.height) throw new Error(`${file} has no video stream`);
  const width = Math.max(16, Math.round(Math.min(o.width, info.width) / 2) * 2);
  const height = Math.max(16, Math.round((info.height * width) / info.width / 2) * 2);
  const fps = info.fps && info.fps < 240 ? info.fps : 30;
  const start = Math.max(0, o.from ?? 0);
  const args = ['-v', 'error', '-ss', start.toFixed(6), '-i', file];
  if (o.to !== undefined && o.to !== null) args.push('-t', Math.max(0, o.to - start).toFixed(6));
  args.push('-an', '-sn', '-dn', '-vf', `fps=${fps},scale=${width}:${height}:flags=area,format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-');
  const size = width * height;
  const meta: GrayStreamInfo = { width, height, fps, start };
  let count = 0;
  await new Promise<void>((res, rej) => {
    const p = spawn(FFMPEG, args);
    let buf = Buffer.alloc(0);
    let err = '';
    p.stdout.on('data', (d: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= size) {
        onFrame(new Uint8Array(buf.subarray(0, size)), count++, meta);
        buf = buf.subarray(size);
      }
    });
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('error', rej);
    p.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg failed decoding ${file}: ${err.slice(-500)}`))));
  });
  return { ...meta, count };
}

/** Host analysis: camera motion of a clip (see `analyzeMotion`). */
export async function motionAnalysis(file: string, params: Record<string, unknown>): Promise<MotionData> {
  let est: MotionEstimator | undefined;
  const meta = await streamGrayFrames(file, { width: Number(params.width ?? ANALYSIS_WIDTH), from: Number(params.from ?? 0), to: params.to as number | null }, (frame, _i, info) => {
    est ??= new MotionEstimator(info.width, info.height, { translationOnly: !!params.translationOnly, model: params.model === 'perspective' ? 'perspective' : 'similarity' });
    est.push(frame);
  });
  if (!est) throw new Error(`No frames decoded from ${file}`);
  return est.result(meta.fps, meta.start);
}

/** Host analysis: a tracked point (see `trackPoint`). */
export async function trackAnalysis(file: string, params: Record<string, unknown>): Promise<PointTrack> {
  const info = await probe(file);
  const srcW = info.width ?? 1;
  const srcH = info.height ?? 1;
  const time = Number(params.time ?? 0);
  const from = Math.max(0, Math.min(time, Number(params.from ?? Math.max(0, time - 2.5))));
  const to = info.duration !== undefined ? Math.min(info.duration, Number(params.to ?? time + 2.5)) : Number(params.to ?? time + 2.5);
  const frames: Gray[] = [];
  const meta = await streamGrayFrames(file, { width: Number(params.width ?? ANALYSIS_WIDTH), from, to }, (f, _i, info) => {
    if (frames.length < 20000) frames.push(gray(info.width, info.height, f));
  });
  if (!frames.length) throw new Error(`No frames decoded from ${file}`);
  const k = meta.width / srcW;
  const at = Math.min(frames.length - 1, Math.max(0, Math.round((time - meta.start) * meta.fps)));
  const radius = Math.max(4, (params.radius !== null && params.radius !== undefined ? Number(params.radius) : srcW * 0.04) * k);
  const r = trackPointInFrames(frames, at, [Number(params.x) * k, Number(params.y) * k], radius);
  return { version: 1, width: srcW, height: srcH, fps: meta.fps, start: meta.start, points: r.points.map((p) => [+(p[0] / k).toFixed(2), +(p[1] / k).toFixed(2)] as Vec2), lost: r.lost };
}

const num = (v: unknown, d?: number) => (v === undefined || v === null || v === '' ? d : Number(v));

/** Stabilization and tracking: host analyses plus the `stabilize` and `track` commands. */
export const visionPlugin: Plugin = definePlugin({
  name: '@tasweerix/vision',
  analyses: {
    'vision.motion': motionAnalysis,
    'vision.track': trackAnalysis,
  },
  commands: {
    stabilize: {
      description: 'Stabilize a shaky video (smooth the camera path or lock it like a tripod) and render the result',
      args: ['<file>'],
      options: [
        { flags: '-o, --output <file>', description: 'output video (default: <name>.stabilized.mp4)' },
        { flags: '--mode <mode>', description: 'smooth | lock', default: 'smooth' },
        { flags: '--smoothing <seconds>', description: 'camera path smoothing in smooth mode', default: '1' },
        { flags: '--max-zoom <n>', description: 'largest automatic zoom used to hide edges', default: '1.3' },
        { flags: '--crop <mode>', description: 'auto | none | <zoom>', default: 'auto' },
        { flags: '--no-rotation', description: 'do not correct rotation' },
        { flags: '--model <model>', description: 'similarity | perspective (also removes keystone wobble)', default: 'similarity' },
        { flags: '--analyze', description: 'only measure the shake and print it' },
      ],
      async run(ctx: CommandContext) {
        const file = resolve(ctx.cwd, ctx.args[0]!);
        const root = dirname(file);
        const env = nodeEnv(root);
        const src = basename(file);
        const o = ctx.options;
        const t0 = Date.now();
        const model = o.model === 'perspective' ? 'perspective' : 'similarity';
        const motion = await analyzeMotion(src, { model }, env);
        const s = shakeStats(motion);
        const k = (await probe(file)).width! / motion.width;
        ctx.log(`shake: ${s.frames} frames, mean ${(s.meanShift * k).toFixed(1)} px/frame, max ${(s.maxShift * k).toFixed(1)} px, max rotation ${s.maxRotation.toFixed(2)}° (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        if (o.analyze) return motion;
        const info = await probe(file);
        const opts = { mode: o.mode, smoothing: num(o.smoothing, 1), maxZoom: num(o.maxZoom, 1.3), crop: o.crop === 'auto' || o.crop === 'none' ? o.crop : num(o.crop), rotation: o.rotation !== false, model };
        // A small generated project renders the stabilized clip with the regular export pipeline.
        const dir = join(root, '.tasweerix');
        mkdirSync(dir, { recursive: true });
        const entry = join(dir, `stabilize-${createHash('sha1').update(file).digest('hex').slice(0, 8)}.ts`);
        const w = info.width!;
        const h = info.height!;
        writeFileSync(
          entry,
          `import { composition, video, stabilize } from 'tasweerix';\nexport default composition({ name: ${JSON.stringify(basename(file, extname(file)))}, width: ${w}, height: ${h}, fps: ${info.fps ?? 30} }, async (c) => {\n  c.add(await stabilize(video(${JSON.stringify(src)}, { size: [${w}, ${h}] }), ${JSON.stringify(opts)}));\n});\n`,
        );
        const output = resolve(ctx.cwd, o.output ?? join(root, `${basename(file, extname(file))}.stabilized.mp4`));
        const r = await ctx.render({ entry, output, root });
        ctx.log(`✔ ${relative(ctx.cwd, r.output) || r.output} (${r.seconds.toFixed(1)}s)`);
        return r;
      },
    },
    track: {
      description: 'Track a point of a video and print it as keyframes (source time → source pixels)',
      args: ['<file>'],
      options: [
        { flags: '--at <x,y>', description: 'point to follow, in source pixels' },
        { flags: '--time <s>', description: 'source time where the point is right', default: '0' },
        { flags: '--from <s>', description: 'start of the tracked range' },
        { flags: '--to <s>', description: 'end of the tracked range' },
        { flags: '--radius <px>', description: 'radius of the tracked region' },
        { flags: '--every <n>', description: 'keyframe every n frames', default: '1' },
        { flags: '--json', description: 'print JSON' },
      ],
      async run(ctx: CommandContext) {
        const file = resolve(ctx.cwd, ctx.args[0]!);
        const o = ctx.options;
        if (!o.at) throw new Error('track: pass --at x,y');
        const at = String(o.at).split(',').map(Number) as Vec2;
        const tr = await trackPoint(basename(file), { at, time: num(o.time, 0)!, from: num(o.from), to: num(o.to), radius: num(o.radius) }, nodeEnv(dirname(file)));
        if (o.json) {
          console.log(JSON.stringify(tr));
          return tr;
        }
        const every = Math.max(1, num(o.every, 1)!);
        const lines: string[] = [];
        for (let i = 0; i < tr.points.length; i += every) lines.push(`  [${+(tr.start + i / tr.fps).toFixed(4)}, [${tr.points[i]![0]}, ${tr.points[i]![1]}]],${tr.lost[i] ? ' // lost' : ''}`);
        console.log(`// ${basename(file)}: point (${at.join(', ')}) at ${o.time}s, source time → source pixels\nconst tracked = keys([\n${lines.join('\n')}\n]);`);
        return tr;
      },
    },
  },
});
