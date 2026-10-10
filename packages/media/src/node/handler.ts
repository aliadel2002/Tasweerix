import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, isAbsolute, normalize, resolve, sep } from 'node:path';
import type { CanvasGamut } from '@tasweerix/core';
import { decodeImage16, decodeImageLinear, decodePcm, interleave, isHdrSource, probe } from './ffmpeg';
import { FrameServer, linearPlanesToFrame } from './frames';
import { AnalysisCache, hostAnalyze } from './analysis';
import { decodeRaw, isRawPath } from './raw';
import { join } from 'node:path';

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.cube': 'text/plain',
  '.srt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

/** Resolves an asset path inside root (rejects traversal). URLs pass through for ffmpeg. */
export function resolveAsset(root: string, src: string): string {
  if (/^https?:\/\//.test(src)) return src;
  const clean = decodeURIComponent(src.replace(/^\/+/, ''));
  const full = isAbsolute(clean) && clean.startsWith(root) ? normalize(clean) : resolve(root, clean);
  const r = resolve(root);
  if (full !== r && !full.startsWith(r + sep)) throw new Error(`Path escapes project root: ${src}`);
  return full;
}

export interface MediaHandlerOptions {
  root: string;
  frames?: FrameServer;
}

/**
 * HTTP handler for the /__tx media API used by browser pages:
 *   /__tx/probe?src=   → MediaInfo JSON
 *   /__tx/frame?src=&t=&w=&h=&client=&depth=&gamut=&hdr=  → raw RGBA, rgba64le with depth=16, or half floats for HDR sources with hdr=1 (x-width / x-height / x-color-space / x-format headers)
 *   /__tx/image16?src=&gamut=&hdr=     → rgba64le first frame of a high bit-depth source (half floats for an HDR source with hdr=1); 204 when the source is 8-bit
 *   /__tx/pcm?src=&rate=&channels=     → interleaved float32 little-endian PCM
 *   /__tx/analyze (GET ?kind=&src=&params= or POST { kind, src, params }) → host analysis JSON
 *   /__tx/cache?key=&src=              → analysis cache (GET / PUT)
 * Returns true when the request was handled.
 */
export function createMediaHandler(opts: MediaHandlerOptions) {
  const frames = opts.frames ?? new FrameServer();
  const cache = new AnalysisCache(join(opts.root, '.tasweerix', 'cache'));
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!url.pathname.startsWith('/__tx/')) return false;
    try {
      if (url.pathname === '/__tx/cache') {
        const key = url.searchParams.get('key') ?? '';
        const srcParam = url.searchParams.get('src');
        const srcFile = srcParam ? resolveAsset(opts.root, srcParam) : undefined;
        if (req.method === 'PUT') {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          cache.set(key, JSON.parse(Buffer.concat(chunks).toString() || 'null'), srcFile);
          res.writeHead(204).end();
        } else {
          const v = cache.get(key, srcFile);
          if (v === undefined) res.writeHead(404).end();
          else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v));
        }
        return true;
      }
      if (url.pathname === '/__tx/analyze') {
        // GET with query parameters, or POST with a JSON body (large params such as AI prompts or images).
        let q: { kind?: string; src?: string; params?: Record<string, unknown> };
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          q = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        } else q = { kind: url.searchParams.get('kind') ?? '', src: url.searchParams.get('src') ?? '', params: JSON.parse(url.searchParams.get('params') ?? '{}') };
        const result = await hostAnalyze(q.kind ?? '', resolveAsset(opts.root, q.src ?? ''), q.params ?? {}, { root: opts.root, resolve: (s) => resolveAsset(opts.root, s) });
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
        return true;
      }
      const src = url.searchParams.get('src') ?? '';
      const file = resolveAsset(opts.root, src);
      if (url.pathname === '/__tx/probe') {
        const info = await probe(file);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(info));
        return true;
      }
      if (url.pathname === '/__tx/frame') {
        const t = Number(url.searchParams.get('t') ?? 0);
        const w = url.searchParams.get('w');
        const h = url.searchParams.get('h');
        const depth = url.searchParams.get('depth') === '16' ? 16 : 8;
        const f = await frames.frame(file, t, { width: w ? Number(w) : undefined, height: h ? Number(h) : undefined, client: url.searchParams.get('client') ?? '0', depth, gamut: gamutParam(url), hdr: url.searchParams.get('hdr') === '1' });
        res.writeHead(200, { ...pixelHeaders(f.width, f.height, f.colorSpace, f.format), 'cache-control': 'no-store' });
        res.end(f.data);
        return true;
      }
      if (url.pathname === '/__tx/image16') {
        if (isRawPath(file)) {
          // Camera RAW: developed linear by LibRaw, kept above white in HDR, not tone mapped in SDR
          // (the sensor's white level is 1.0, so nothing needs compressing).
          const raw = await decodeRaw(file);
          const f = linearPlanesToFrame(raw.planes, raw.width * raw.height, raw.gamut, { depth: 16, gamut: gamutParam(url), hdr: url.searchParams.get('hdr') === '1', toneMap: false });
          res.writeHead(200, { ...pixelHeaders(raw.width, raw.height, f.colorSpace, f.format), 'cache-control': 'no-store' });
          res.end(f.data);
          return true;
        }
        const info = await probe(file);
        if (isHdrSource(info)) {
          // HDR stills (PQ / HLG, OpenEXR, Radiance): half floats for an HDR render, tone mapped otherwise.
          const lin = await decodeImageLinear(file);
          const f = linearPlanesToFrame(lin.planes, lin.width * lin.height, lin.gamut, { depth: 16, gamut: gamutParam(url), hdr: url.searchParams.get('hdr') === '1' });
          res.writeHead(200, { ...pixelHeaders(lin.width, lin.height, f.colorSpace, f.format), 'cache-control': 'no-store' });
          res.end(f.data);
          return true;
        }
        // Only worth the extra bytes when the source has more than 8 bits; the browser decodes the rest.
        if ((info.bitDepth ?? 8) <= 8) {
          res.writeHead(204, { 'cache-control': 'no-store' }).end();
          return true;
        }
        const img = await decodeImage16(file, gamutParam(url));
        res.writeHead(200, { ...pixelHeaders(img.width, img.height, img.colorSpace, 'rgba64le'), 'cache-control': 'no-store' });
        res.end(img.data);
        return true;
      }
      if (url.pathname === '/__tx/pcm') {
        const rate = Number(url.searchParams.get('rate') ?? 48000);
        const ch = Number(url.searchParams.get('channels') ?? 2);
        const pcm = interleave(await decodePcm(file, rate, ch));
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-sample-rate': String(rate), 'x-channels': String(ch) });
        res.end(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
        return true;
      }
      res.writeHead(404).end('unknown endpoint');
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(String((e as Error).message ?? e));
    }
    return true;
  };
  return Object.assign(handler, { frames });
}

function pixelHeaders(width: number, height: number, colorSpace: CanvasGamut, format: string) {
  return {
    'content-type': 'application/octet-stream',
    'x-width': String(width),
    'x-height': String(height),
    'x-color-space': colorSpace,
    'x-format': format,
    'access-control-expose-headers': 'x-width, x-height, x-color-space, x-format',
  };
}

function gamutParam(url: URL): CanvasGamut {
  return url.searchParams.get('gamut') === 'display-p3' ? 'display-p3' : 'srgb';
}

/** Minimal static file handler (with range support for media seeking). */
export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse, pathname?: string): boolean {
  let file: string;
  try {
    file = resolveAsset(root, pathname ?? new URL(req.url ?? '/', 'http://x').pathname);
  } catch {
    res.writeHead(403).end();
    return true;
  }
  if (!existsSync(file) || !statSync(file).isFile()) return false;
  const size = statSync(file).size;
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m?.[1] ? Number(m[1]) : 0;
    const end = m?.[2] ? Number(m[2]) : size - 1;
    res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' });
    createReadStream(file).pipe(res);
  }
  return true;
}
