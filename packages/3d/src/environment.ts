/**
 * Environments for image-based lighting: Radiance .hdr decoding and the built-in procedural
 * environments ('studio', 'sky') that need no file.
 */

/** Linear RGB float image (3 floats per pixel, top row first). */
export interface HDRImage {
  width: number;
  height: number;
  data: Float32Array;
}

/** Built-in environments, rendered procedurally on the GPU. */
export const BUILTIN_ENVIRONMENTS = ['studio', 'sky'] as const;
export type BuiltinEnvironment = (typeof BUILTIN_ENVIRONMENTS)[number];

export function isBuiltinEnvironment(src: string): src is BuiltinEnvironment {
  return (BUILTIN_ENVIRONMENTS as readonly string[]).includes(src);
}

/** Decodes a Radiance RGBE (.hdr) file: flat or new-style run-length encoded scanlines. */
export function parseHDR(buf: ArrayBuffer): HDRImage {
  const bytes = new Uint8Array(buf);
  let pos = 0;
  const line = () => {
    let s = '';
    while (pos < bytes.length && bytes[pos] !== 0x0a) s += String.fromCharCode(bytes[pos++]!);
    pos++;
    return s;
  };
  const magic = line();
  if (!magic.startsWith('#?')) throw new Error('Not a Radiance .hdr file');
  for (let l = line(); l !== ''; l = line()) {
    if (l.startsWith('FORMAT=') && !l.includes('32-bit_rle_rgbe')) throw new Error(`Unsupported .hdr format: ${l.slice(7)}`);
    if (pos >= bytes.length) throw new Error('Truncated .hdr header');
  }
  const res = /^-Y (\d+) \+X (\d+)$/.exec(line().trim());
  if (!res) throw new Error('Unsupported .hdr orientation (expected "-Y h +X w")');
  const height = Number(res[1]);
  const width = Number(res[2]);
  const rgbe = new Uint8Array(width * height * 4);
  const scan = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    const rle = width >= 8 && width < 32768 && bytes[pos] === 2 && bytes[pos + 1] === 2 && ((bytes[pos + 2]! << 8) | bytes[pos + 3]!) === width;
    if (!rle) {
      // Flat scanline.
      rgbe.set(bytes.subarray(pos, pos + width * 4), y * width * 4);
      pos += width * 4;
      continue;
    }
    pos += 4;
    // Four planes (R, G, B, E), each run-length encoded.
    for (let c = 0; c < 4; c++) {
      let x = 0;
      while (x < width) {
        let n = bytes[pos++]!;
        if (n > 128) {
          n -= 128;
          const v = bytes[pos++]!;
          for (let i = 0; i < n; i++) scan[(x++) * 4 + c] = v;
        } else for (let i = 0; i < n; i++) scan[(x++) * 4 + c] = bytes[pos++]!;
      }
    }
    rgbe.set(scan, y * width * 4);
  }
  const data = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const e = rgbe[i * 4 + 3]!;
    const f = e ? Math.pow(2, e - 136) : 0;
    data[i * 3] = rgbe[i * 4]! * f;
    data[i * 3 + 1] = rgbe[i * 4 + 1]! * f;
    data[i * 3 + 2] = rgbe[i * 4 + 2]! * f;
  }
  return { width, height, data };
}

/** Equirectangular texture coordinates of a direction (−Z at the center, +Y at the top). */
export function equirectUv(d: [number, number, number]): [number, number] {
  return [Math.atan2(d[0], -d[2]) / (2 * Math.PI) + 0.5, Math.acos(Math.max(-1, Math.min(1, d[1]))) / Math.PI];
}
