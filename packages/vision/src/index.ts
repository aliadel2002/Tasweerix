import { fitRect, getEnv, keys, resolve, toSeconds, type Driver, type Env, type FrameContext, type TimeInput, type Track, type Vec2, type VideoNode } from '@tasweerix/core';
import type { MotionData } from './motion';
import { computeStabilization, correctionAt, type StabilizeData, type StabilizeOptions } from './stabilize';
import { pointAt, type PointTrack } from './track';
import { apply } from './similarity';

export * from './image';
export * from './features';
export * from './flow';
export * from './similarity';
export * from './motion';
export * from './stabilize';
export * from './track';

/** Analysis width used when none is given (pixels). */
export const ANALYSIS_WIDTH = 480;

async function cached<T>(env: Env, key: string, src: string, compute: () => Promise<T>): Promise<T> {
  const hit = await env.cache?.get<T>(key, src);
  if (hit !== undefined) return hit;
  const v = await compute();
  await env.cache?.set(key, v, src);
  return v;
}

function host(env: Env, what: string): NonNullable<Env['analyze']> {
  if (!env.analyze) throw new Error(`${what}: this environment has no host analysis (run it through the Tasweerix CLI, studio or a Node env with @tasweerix/vision/node loaded)`);
  return env.analyze;
}

export interface AnalyzeMotionOptions {
  /** Source range to analyse (seconds). Defaults to the whole file. */
  from?: TimeInput;
  to?: TimeInput;
  /** Analysis width in pixels (default 480). */
  width?: number;
  translationOnly?: boolean;
}

/** Measures frame-to-frame camera motion of a video (host-side, cached on disk). */
export async function analyzeMotion(src: string, o: AnalyzeMotionOptions = {}, env: Env = getEnv()): Promise<MotionData> {
  const params = { from: o.from !== undefined ? toSeconds(o.from) : 0, to: o.to !== undefined ? toSeconds(o.to) : null, width: o.width ?? ANALYSIS_WIDTH, translationOnly: !!o.translationOnly };
  const run = host(env, 'analyzeMotion()');
  return cached(env, `vision.motion:${src}:${JSON.stringify(params)}`, src, async () => (await run('vision.motion', src, params)) as MotionData);
}

/**
 * Stabilizes a video clip: measures the camera shake, smooths (or locks) the camera path and
 * applies the correction while rendering, zooming in just enough to hide the edges.
 *
 *   c.add(await stabilize(video('handheld.mp4', { trim: [3, 9] }), { smoothing: 1.5 }))
 *   c.add(await stabilize(video('shaky.mp4'), { mode: 'lock' }))   // tripod look
 */
export async function stabilize<N extends VideoNode>(node: N, o: StabilizeOptions & { analysisWidth?: number; translationOnly?: boolean } = {}, env: Env = getEnv()): Promise<N> {
  // Analyse the trimmed range only (looping or reversed clips use the whole file).
  const whole = node.loop || node.speed < 0;
  const motion = await analyzeMotion(node.src, { from: whole ? 0 : node.trimIn, to: whole ? undefined : node.trimOut, width: o.analysisWidth, translationOnly: o.translationOnly }, env);
  const data = computeStabilization(motion, o);
  return applyStabilization(node, data);
}

/** Applies precomputed corrections to a video node. */
export function applyStabilization<N extends VideoNode>(node: N, data: StabilizeData): N {
  node.mediaTransform = (t) => correctionAt(data, t);
  node.meta.stabilization = { zoom: data.zoom, frames: data.frames.length };
  return node;
}

export interface TrackPointOptions {
  /** The point to follow, in source pixels. */
  at: Vec2;
  /** Source time at which `at` is right. */
  time: TimeInput;
  /** Source range to track (default: 5 s around `time`, clamped to the file). */
  from?: TimeInput;
  to?: TimeInput;
  /** Radius of the tracked region in source pixels (default: 4 % of the width). */
  radius?: number;
  /** Analysis width in pixels (default 480). */
  width?: number;
}

/** Follows a point of a video over time (host-side, cached). Positions are in source pixels. */
export async function trackPoint(src: string, o: TrackPointOptions, env: Env = getEnv()): Promise<PointTrack> {
  const time = toSeconds(o.time);
  const params = { x: o.at[0], y: o.at[1], time, from: o.from !== undefined ? toSeconds(o.from) : Math.max(0, time - 2.5), to: o.to !== undefined ? toSeconds(o.to) : time + 2.5, radius: o.radius ?? null, width: o.width ?? ANALYSIS_WIDTH };
  const run = host(env, 'trackPoint()');
  return cached(env, `vision.track:${src}:${JSON.stringify(params)}`, src, async () => (await run('vision.track', src, params)) as PointTrack);
}

/**
 * A position driver that keeps a child of `video` on a tracked point (through trim, speed,
 * fitting and stabilization). Add the follower to the video itself:
 *   const v = video('street.mp4', { trim: [2, 8] });
 *   v.add(text('Bus 42', { at: follow(v, await trackPoint('street.mp4', { at: [812, 440], time: 3 })) }));
 */
export function follow(video: VideoNode, track: PointTrack, offset: Vec2 = [0, 0]): Driver<Vec2> {
  return (ctx: FrameContext) => {
    // Children run on the video's content time; the source time adds the in-point.
    const st = video.trimIn + ctx.time;
    const p = pointAt(track, st);
    const natW = video.info?.width ?? track.width;
    const natH = video.info?.height ?? track.height;
    const size = (resolve(video.props.size as Vec2 | null | undefined, ctx) ?? null) ?? [natW, natH];
    const fit = fitRect(natW, natH, size[0], size[1], (resolve(video.props.fit as never, ctx) as 'contain' | undefined) ?? 'contain');
    // Centered frame coordinates in frame widths, through the media transform, then box space.
    let q: Vec2 = [p[0] / natW - 0.5, (p[1] - natH / 2) / natW];
    const xf = video.mediaTransform?.(st);
    if (xf) q = apply(xf, q);
    const cx = -size[0] / 2 + fit.x + fit.width / 2;
    const cy = -size[1] / 2 + fit.y + fit.height / 2;
    return [cx + q[0] * fit.width + offset[0], cy + q[1] * fit.width + offset[1]];
  };
}

/** A tracked point as editable keyframes (source time → source pixels), every `every` frames. */
export function trackToKeys(track: PointTrack, o: { every?: number; timeOffset?: number } = {}): Track<Vec2> {
  const every = Math.max(1, o.every ?? 1);
  const list: [number, Vec2][] = [];
  for (let i = 0; i < track.points.length; i += every) list.push([+(track.start + i / track.fps + (o.timeOffset ?? 0)).toFixed(4), track.points[i]!.map((v) => +v.toFixed(2)) as Vec2]);
  return keys(list);
}

/** Everything in one namespace: `vision.stabilize(...)`. */
export const vision = { analyzeMotion, stabilize, applyStabilization, trackPoint, follow, trackToKeys, computeStabilization, correctionAt, pointAt };
