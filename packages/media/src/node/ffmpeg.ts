import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { convertRGBA16, gamutProfile, parseIcc, type CanvasGamut, type Gamut, type IccProfile, type MediaInfo } from '@tasweerix/core';
import { extractIcc } from './icc';


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

/**
 * Decodes the first frame of an image or video as straight 16-bit RGBA (rgba64le), keeping more than
 * 8 bits per channel. Colors are converted from the embedded ICC profile (or the stream's primaries
 * tag) into `gamut`; untagged sources are taken as sRGB and returned unchanged. `colorSpace` says
 * which space the pixels are in.
 */
export async function decodeImage16(file: string, gamut: CanvasGamut = 'srgb'): Promise<{ data: Buffer; width: number; height: number; colorSpace: CanvasGamut }> {
  const info = await probe(file);
  const data = await run(FFMPEG, ['-v', 'error', '-i', file, '-frames:v', '1', '-an', '-sn', '-dn', '-f', 'rawvideo', '-pix_fmt', 'rgba64le', '-']);
  let width = info.width ?? 0;
  let height = info.height ?? 0;
  // ffmpeg applies display rotation; fall back to the stored size if the frame came out unrotated.
  if (width * height * 8 !== data.length && height * width * 8 === data.length) [width, height] = [height, width];
  if (!width || width * height * 8 !== data.length) throw new Error(`Unexpected 16-bit frame size for ${file}: ${data.length} bytes for ${width}x${height}`);
  const px = new Uint16Array(data.buffer, data.byteOffset, data.length / 2);
  const colorSpace = toGamut(px, sourceProfile(file, info), gamut);
  return { data, width, height, colorSpace };
}

/** True for HDR stills and frames: PQ / HLG transfer, or float pixels (OpenEXR, Radiance .hdr), which are linear. */
export function isHdrSource(info: MediaInfo): boolean {
  return info.colorTransfer === 'smpte2084' || info.colorTransfer === 'arib-std-b67' || /f(16|32)(le|be)?$/.test(info.pixFmt ?? '');
}

/**
 * Decodes the first frame of an HDR source to linear float `gbrap` planes (1.0 = reference white,
 * 203 nits). Float formats are taken as linear already.
 */
export async function decodeImageLinear(file: string): Promise<{ planes: Buffer; width: number; height: number; gamut: Gamut }> {
  const info = await probe(file);
  const t = info.colorTransfer;
  const lin = t === 'smpte2084' || t === 'arib-std-b67';
  // zimg converts float formats without clamping (swscale clamps them to 0..1).
  const planes = await run(FFMPEG, ['-v', 'error', '-i', file, '-frames:v', '1', '-an', '-sn', '-dn', '-vf', `zscale${lin ? `=transferin=${t}:transfer=linear:npl=203` : ''},format=gbrapf32le`, '-f', 'rawvideo', '-pix_fmt', 'gbrapf32le', '-']);
  let width = info.width ?? 0;
  let height = info.height ?? 0;
  if (width * height * 16 !== planes.length) [width, height] = [height, width];
  if (!width || width * height * 16 !== planes.length) throw new Error(`Unexpected float frame size for ${file}: ${planes.length} bytes for ${width}x${height}`);
  return { planes, width, height, gamut: primariesGamut(info.colorPrimaries) ?? (lin ? 'rec2020' : 'srgb') };
}

/** Where a source's colors are defined: an embedded ICC profile, a primaries tag, or nothing (sRGB). */
function sourceProfile(file: string, info: MediaInfo): IccProfile | Gamut | undefined {
  let bytes: Uint8Array | undefined;
  try {
    bytes = readFileSync(file);
  } catch {
    bytes = undefined;
  }
  const icc = bytes && extractIcc(bytes);
  if (icc) {
    const p = parseIcc(icc);
    if (p) return p;
    console.warn(`[tasweerix] ${file}: embedded ICC profile is not a matrix/TRC profile; colors are taken as sRGB`);
  }
  return primariesGamut(info.colorPrimaries);
}

/** The gamut a primaries tag names, when the pipeline knows it. */
export function primariesGamut(tag: string | undefined): Gamut | undefined {
  return tag === 'bt2020' ? 'rec2020' : tag === 'smpte432' ? 'display-p3' : tag === 'bt709' ? 'srgb' : undefined;
}

/** Converts pixels in place into `target` and returns the space they end up in. */
function toGamut(px: Uint16Array, source: IccProfile | Gamut | undefined, target: CanvasGamut): CanvasGamut {
  if (source === undefined || source === 'srgb') return 'srgb';
  if (source === target) return target;
  convertRGBA16(px, typeof source === 'string' ? gamutProfile(source) : source, target);
  return target;
}

const probeCache = new Map<string, Promise<MediaInfo>>();

/** Probes a media file with ffprobe. */
export function probe(file: string): Promise<MediaInfo> {
  let p = probeCache.get(file);
  if (!p) {
    p = (async () => {
      const out = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
      const j = JSON.parse(out.toString()) as {
        streams: { codec_type: string; codec_name?: string; pix_fmt?: string; width?: number; height?: number; r_frame_rate?: string; avg_frame_rate?: string; duration?: string; sample_rate?: string; channels?: number; tags?: Record<string, string>; side_data_list?: { rotation?: number }[]; color_primaries?: string; color_transfer?: string; disposition?: { attached_pic?: number } }[];
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
        pixFmt: v?.pix_fmt,
        colorPrimaries: v?.color_primaries && v.color_primaries !== 'unknown' ? v.color_primaries : undefined,
        colorTransfer: v?.color_transfer && v.color_transfer !== 'unknown' ? v.color_transfer : undefined,
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
