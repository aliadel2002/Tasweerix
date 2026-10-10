import { crc32, deflateSync, inflateSync } from 'node:zlib';

/**
 * Reads and writes embedded ICC profiles in PNG, JPEG, TIFF and WebP files. ffmpeg neither applies
 * nor writes them (this build has no LittleCMS), so the pipeline does both itself.
 */

type Format = 'png' | 'jpeg' | 'tiff' | 'webp';

function sniff(b: Uint8Array): Format | undefined {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 42) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 42))
    return 'tiff';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  return undefined;
}

function ascii(b: Uint8Array, o: number, n: number): string {
  return String.fromCharCode(...b.subarray(o, o + n));
}

const be = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** The ICC profile embedded in an image file, if any. */
export function extractIcc(file: Uint8Array): Uint8Array | undefined {
  try {
    switch (sniff(file)) {
      case 'png':
        for (const c of pngChunks(file)) {
          if (c.type === 'iCCP') {
            const nul = c.data.indexOf(0);
            return new Uint8Array(inflateSync(c.data.subarray(nul + 2)));
          }
          if (c.type === 'IDAT') return undefined;
        }
        return undefined;
      case 'jpeg': {
        const parts: [number, Uint8Array][] = [];
        for (const s of jpegSegments(file))
          if (s.marker === 0xe2 && ascii(s.data, 0, 12) === 'ICC_PROFILE\0')
            parts.push([s.data[12]!, s.data.subarray(14)]);
        if (!parts.length) return undefined;
        parts.sort((a, b) => a[0] - b[0]);
        return Buffer.concat(parts.map((p) => p[1]));
      }
      case 'tiff': {
        const t = tiffIfd(file);
        const e = t.entries.find((x) => x.tag === 34675);
        if (!e) return undefined;
        return file.subarray(e.value, e.value + e.count);
      }
      case 'webp':
        for (const c of riffChunks(file)) if (c.type === 'ICCP') return c.data;
        return undefined;
    }
  } catch {
    // Malformed metadata: treat as untagged.
  }
  return undefined;
}

/** Returns the file with `icc` embedded (replacing any profile and other color tags it had). */
export function embedIcc(file: Uint8Array, icc: Uint8Array): Buffer {
  switch (sniff(file)) {
    case 'png':
      return embedPng(file, icc);
    case 'jpeg':
      return embedJpeg(file, icc);
    case 'tiff':
      return embedTiff(file, icc);
    case 'webp':
      return embedWebp(file, icc);
    default:
      throw new Error('embedIcc: unsupported image format');
  }
}

// ---------------------------------------------------------------- PNG

function* pngChunks(
  b: Uint8Array,
): Generator<{ type: string; data: Uint8Array; start: number; end: number }> {
  const v = be(b);
  let o = 8;
  while (o + 12 <= b.length) {
    const len = v.getUint32(o);
    const type = ascii(b, o + 4, 4);
    yield { type, data: b.subarray(o + 8, o + 8 + len), start: o, end: o + 12 + len };
    o += 12 + len;
    if (type === 'IEND') return;
  }
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function embedPng(b: Uint8Array, icc: Uint8Array): Buffer {
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  for (const c of pngChunks(b)) {
    // An iCCP replaces sRGB, gAMA, cHRM and cICP, which would otherwise take precedence or conflict.
    if (c.type === 'iCCP' || c.type === 'sRGB' || c.type === 'gAMA' || c.type === 'cHRM' || c.type === 'cICP')
      continue;
    parts.push(b.subarray(c.start, c.end));
    if (c.type === 'IHDR')
      parts.push(
        pngChunk('iCCP', Buffer.concat([Buffer.from('ICC Profile\0\0', 'latin1'), deflateSync(icc)])),
      );
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- JPEG

function* jpegSegments(
  b: Uint8Array,
): Generator<{ marker: number; data: Uint8Array; start: number; end: number }> {
  const v = be(b);
  let o = 2;
  while (o + 4 <= b.length && b[o] === 0xff) {
    const marker = b[o + 1]!;
    if (marker === 0xda || marker === 0xd9) return;
    const len = v.getUint16(o + 2);
    yield { marker, data: b.subarray(o + 4, o + 2 + len), start: o, end: o + 2 + len };
    o += 2 + len;
  }
}

function embedJpeg(b: Uint8Array, icc: Uint8Array): Buffer {
  const max = 65519;
  const count = Math.ceil(icc.length / max);
  const app2 = Array.from({ length: count }, (_, i) => {
    const part = icc.subarray(i * max, (i + 1) * max);
    const seg = Buffer.alloc(4 + 14 + part.length);
    seg[0] = 0xff;
    seg[1] = 0xe2;
    seg.writeUInt16BE(2 + 14 + part.length, 2);
    seg.write('ICC_PROFILE\0', 4, 'latin1');
    seg[16] = i + 1;
    seg[17] = count;
    seg.set(part, 18);
    return seg;
  });
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let rest = 2;
  let inserted = false;
  for (const s of jpegSegments(b)) {
    // Keep JFIF / Exif (APP0 / APP1) first, then the profile.
    if (!inserted && s.marker !== 0xe0 && s.marker !== 0xe1) {
      parts.push(...app2);
      inserted = true;
    }
    if (!(s.marker === 0xe2 && ascii(s.data, 0, 12) === 'ICC_PROFILE\0'))
      parts.push(b.subarray(s.start, s.end));
    rest = s.end;
  }
  if (!inserted) parts.push(...app2);
  parts.push(b.subarray(rest));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- TIFF

interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  /** Raw 4-byte value field (inline value or offset). */
  raw: Uint8Array;
  value: number;
}

function tiffIfd(b: Uint8Array): { le: boolean; ifd: number; entries: IfdEntry[]; next: number } {
  const le = b[0] === 0x49;
  const v = be(b);
  const ifd = v.getUint32(4, le);
  const n = v.getUint16(ifd, le);
  const entries: IfdEntry[] = [];
  for (let i = 0; i < n; i++) {
    const o = ifd + 2 + i * 12;
    entries.push({
      tag: v.getUint16(o, le),
      type: v.getUint16(o + 2, le),
      count: v.getUint32(o + 4, le),
      raw: b.slice(o + 8, o + 12),
      value: v.getUint32(o + 8, le),
    });
  }
  return { le, ifd, entries, next: v.getUint32(ifd + 2 + n * 12, le) };
}

/** Appends the profile and a rewritten first IFD (with tag 34675) at the end; other data stays put. */
function embedTiff(b: Uint8Array, icc: Uint8Array): Buffer {
  const t = tiffIfd(b);
  const pad = (n: number) => (n + 1) & ~1;
  const iccAt = pad(b.length);
  const ifdAt = pad(iccAt + icc.length);
  const raw = new Uint8Array(4);
  new DataView(raw.buffer).setUint32(0, iccAt, t.le);
  const entries = [
    ...t.entries.filter((e) => e.tag !== 34675),
    { tag: 34675, type: 7, count: icc.length, raw, value: iccAt },
  ].sort((a, c) => a.tag - c.tag);
  const out = Buffer.alloc(ifdAt + 2 + entries.length * 12 + 4);
  out.set(b);
  out.set(icc, iccAt);
  const v = be(out);
  v.setUint16(ifdAt, entries.length, t.le);
  entries.forEach((e, i) => {
    const o = ifdAt + 2 + i * 12;
    v.setUint16(o, e.tag, t.le);
    v.setUint16(o + 2, e.type, t.le);
    v.setUint32(o + 4, e.count, t.le);
    out.set(e.raw, o + 8);
  });
  v.setUint32(ifdAt + 2 + entries.length * 12, t.next, t.le);
  v.setUint32(4, ifdAt, t.le);
  return out;
}

// ---------------------------------------------------------------- WebP

function* riffChunks(
  b: Uint8Array,
): Generator<{ type: string; data: Uint8Array; start: number; end: number }> {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 12;
  while (o + 8 <= b.length) {
    const len = v.getUint32(o + 4, true);
    const end = o + 8 + len + (len & 1);
    yield { type: ascii(b, o, 4), data: b.subarray(o + 8, o + 8 + len), start: o, end };
    o = end;
  }
}

function embedWebp(b: Uint8Array, icc: Uint8Array): Buffer {
  const chunks = [...riffChunks(b)];
  const riffChunk = (type: string, data: Uint8Array) => {
    const c = Buffer.alloc(8 + data.length + (data.length & 1));
    c.write(type, 0, 'latin1');
    c.writeUInt32LE(data.length, 4);
    c.set(data, 8);
    return c;
  };
  const vp8x = chunks.find((c) => c.type === 'VP8X');
  let header: Buffer;
  if (vp8x) {
    header = Buffer.from(vp8x.data);
    header[0] = header[0]! | 0x20;
  } else {
    // Simple (lossy or lossless) file: wrap it in an extended VP8X header that can carry ICCP.
    const img = chunks[0]!;
    let w: number,
      h: number,
      alpha = false;
    if (img.type === 'VP8L') {
      const bits = img.data[1]! | (img.data[2]! << 8) | (img.data[3]! << 16) | (img.data[4]! << 24);
      w = (bits & 0x3fff) + 1;
      h = ((bits >>> 14) & 0x3fff) + 1;
      alpha = ((bits >>> 28) & 1) === 1;
    } else {
      w = (img.data[6]! | (img.data[7]! << 8)) & 0x3fff;
      h = (img.data[8]! | (img.data[9]! << 8)) & 0x3fff;
    }
    header = Buffer.alloc(10);
    header[0] = 0x20 | (alpha ? 0x10 : 0);
    header.writeUIntLE(w - 1, 4, 3);
    header.writeUIntLE(h - 1, 7, 3);
  }
  const body = Buffer.concat([
    riffChunk('VP8X', header),
    riffChunk('ICCP', icc),
    ...chunks.filter((c) => c.type !== 'VP8X' && c.type !== 'ICCP').map((c) => b.subarray(c.start, c.end)),
  ]);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + body.length, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}
