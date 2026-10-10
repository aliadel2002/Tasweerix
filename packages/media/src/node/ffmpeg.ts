import { spawn } from 'node:child_process';
import type { MediaInfo } from '@tasweerix/core';

export const FFMPEG = process.env.TASWEERIX_FFMPEG ?? 'ffmpeg';
export const FFPROBE = process.env.TASWEERIX_FFPROBE ?? 'ffprobe';

/** Runs a command and returns stdout (as Buffer). Rejects with stderr on failure. */
export function run(cmd: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.stderr.on('data', (d: Buffer) => err.push(d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} ${args.join(' ')} exited with ${code}: ${Buffer.concat(err).toString().slice(-2000)}`));
    });
    if (input) p.stdin.end(input);
    else p.stdin.end();
  });
}

function parseRate(r: string | undefined): number | undefined {
  if (!r || r === '0/0') return undefined;
  const [a, b] = r.split('/').map(Number);
  return b ? a! / b : a;
}

/** Bits per channel implied by an ffmpeg pixel format name (rgb48be → 16, yuv420p10le → 10, rgbaf32le → 32, rgba → 8). */
export function pixFmtDepth(pixFmt: string | undefined): number | undefined {
  if (!pixFmt) return undefined;
  if (/^nv(12|16|21|24|42)$/.test(pixFmt)) return 8; // these name their chroma layout, not the depth
  if (/^nv20|^xv30/.test(pixFmt)) return 10;
  if (/^xv36/.test(pixFmt)) return 12;
  const m = /(f16|f32|48|64|16|14|12|10|9)(le|be)?$/.exec(pixFmt);
  if (!m) return 8;
  return m[1] === 'f32' ? 32 : m[1] === 'f16' || m[1] === '48' || m[1] === '64' ? 16 : Number(m[1]);
}

/** Decodes the first frame of an image or video as 16-bit straight RGBA (`rgba64le`, 8 bytes per pixel). */
export async function decodeImage16(file: string): Promise<{ data: Buffer; width: number; height: number }> {
  const info = await probe(file);
  const data = await run(FFMPEG, ['-v', 'error', '-i', file, '-frames:v', '1', '-an', '-sn', '-dn', '-f', 'rawvideo', '-pix_fmt', 'rgba64le', '-']);
  let width = info.width ?? 0;
  let height = info.height ?? 0;
  // ffmpeg applies display rotation; fall back to the stored size if the frame came out unrotated.
  if (width * height * 8 !== data.length && height * width * 8 === data.length) [width, height] = [height, width];
  if (!width || width * height * 8 !== data.length) throw new Error(`Unexpected 16-bit frame size for ${file}: ${data.length} bytes for ${width}x${height}`);
  return { data, width, height };
}

const probeCache = new Map<string, Promise<MediaInfo>>();

/** Probes a media file with ffprobe. */
export function probe(file: string): Promise<MediaInfo> {
  let p = probeCache.get(file);
  if (!p) {
    p = (async () => {
      const out = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
      const j = JSON.parse(out.toString()) as {
        streams: { codec_type: string; codec_name?: string; pix_fmt?: string; width?: number; height?: number; r_frame_rate?: string; avg_frame_rate?: string; duration?: string; sample_rate?: string; channels?: number; tags?: Record<string, string>; side_data_list?: { rotation?: number }[]; disposition?: { attached_pic?: number } }[];
        format: { duration?: string; format_name?: string };
      };
      const v = j.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
      const a = j.streams.find((s) => s.codec_type === 'audio');
      const isImage = !!v && /image2|png_pipe|jpeg_pipe|webp_pipe|bmp_pipe|gif|tiff_pipe|svg/.test(j.format.format_name ?? '') && !a;
      let width = v?.width;
      let height = v?.height;
      const rot = Number(v?.tags?.rotate ?? v?.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? 0);
      if (Math.abs(rot) === 90 || Math.abs(rot) === 270) [width, height] = [height, width];
      const dur = Number(j.format.duration ?? v?.duration ?? a?.duration);
      return {
        duration: isImage || !Number.isFinite(dur) ? undefined : dur,
        width,
        height,
        fps: parseRate(v?.avg_frame_rate) ?? parseRate(v?.r_frame_rate),
        hasVideo: !!v,
        hasAudio: !!a,
        sampleRate: a?.sample_rate ? Number(a.sample_rate) : undefined,
        channels: a?.channels,
        codec: v?.codec_name ?? a?.codec_name,
        rotation: rot || undefined,
        bitDepth: v ? pixFmtDepth(v.pix_fmt) : undefined,
      };
    })();
    probeCache.set(file, p);
    p.catch(() => probeCache.delete(file));
  }
  return p;
}

/** Decodes audio to planar float32 channels at a sample rate. */
const pcmCache = new Map<string, Promise<Float32Array[]>>();
export function decodePcm(file: string, sampleRate = 48000, channels = 2): Promise<Float32Array[]> {
  const key = `${file}|${sampleRate}|${channels}`;
  let p = pcmCache.get(key);
  if (!p) {
    p = (async () => {
      const buf = await run(FFMPEG, ['-v', 'error', '-i', file, '-vn', '-f', 'f32le', '-ac', String(channels), '-ar', String(sampleRate), '-']);
      const inter = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
      const n = Math.floor(inter.length / channels);
      const out = Array.from({ length: channels }, () => new Float32Array(n));
      for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) out[c]![i] = inter[i * channels + c]!;
      return out;
    })();
    pcmCache.set(key, p);
    p.catch(() => pcmCache.delete(key));
  }
  return p;
}

/** Interleaves planar channels. */
export function interleave(chs: Float32Array[]): Float32Array {
  const n = chs[0]?.length ?? 0;
  const out = new Float32Array(n * chs.length);
  for (let i = 0; i < n; i++) for (let c = 0; c < chs.length; c++) out[i * chs.length + c] = chs[c]![i]!;
  return out;
}
