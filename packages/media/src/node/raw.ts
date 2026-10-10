import { isRawPath } from '../formats';
import { run } from './ffmpeg';

/** LibRaw's `dcraw_emu` (package `libraw-bin` on Debian and Ubuntu, `libraw` on Homebrew). */
export const DCRAW_EMU = process.env.TASWEERIX_DCRAW_EMU ?? 'dcraw_emu';

export { isRawPath };

export interface RawDecodeOptions {
  /** White balance: the camera's as-shot setting (default) or LibRaw's automatic estimate. */
  whiteBalance?: 'camera' | 'auto';
  /** Highlight recovery: 'clip' (default), 'unclip' keeps clipped channels, 'blend' or 'rebuild' reconstruct them. */
  highlights?: 'clip' | 'unclip' | 'blend' | 'rebuild';
  /** Decode at half size (faster, no demosaic). */
  half?: boolean;
}

const HIGHLIGHT = { clip: '0', unclip: '1', blend: '2', rebuild: '5' } as const;

/**
 * Develops a camera RAW file with LibRaw into linear-light float `gbrap` planes in BT.2020
 * primaries: demosaiced, white balanced and color corrected by the camera's matrix, with no tone
 * curve, so the sensor's white level is 1.0. Orientation from the file is applied.
 */
export async function decodeRaw(file: string, opts: RawDecodeOptions = {}): Promise<{ planes: Buffer; width: number; height: number; gamut: 'rec2020' }> {
  const args = ['-4', '-o', '8', opts.whiteBalance === 'auto' ? '-a' : '-w', '-H', HIGHLIGHT[opts.highlights ?? 'clip'], ...(opts.half ? ['-h'] : []), '-Z', '-', file];
  let ppm: Buffer;
  try {
    ppm = await run(DCRAW_EMU, args);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`Decoding ${file} needs LibRaw's ${DCRAW_EMU} (apt install libraw-bin, or brew install libraw), or set TASWEERIX_DCRAW_EMU`);
    throw e;
  }
  // Binary PPM: "P6 <w> <h> <max>\n" then big-endian RGB samples.
  const head = /^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(ppm.subarray(0, 64).toString('latin1'));
  if (!head) throw new Error(`Unexpected LibRaw output for ${file}`);
  const [width, height, max] = [Number(head[1]), Number(head[2]), Number(head[3])];
  const n = width * height;
  const at = head[0].length;
  const wide = max > 255;
  const planes = Buffer.alloc(n * 16);
  const f = new Float32Array(planes.buffer, planes.byteOffset, n * 4);
  for (let i = 0; i < n; i++) {
    const rgb = [0, 1, 2].map((k) => (wide ? ppm.readUInt16BE(at + (i * 3 + k) * 2) : ppm[at + i * 3 + k]!) / max);
    f[i] = rgb[1]!;
    f[n + i] = rgb[2]!;
    f[2 * n + i] = rgb[0]!;
    f[3 * n + i] = 1;
  }
  return { planes, width, height, gamut: 'rec2020' };
}

/** LibRaw's `raw-identify`, which ships with `dcraw_emu`. */
export const RAW_IDENTIFY = process.env.TASWEERIX_RAW_IDENTIFY ?? 'raw-identify';

/** Size of a RAW file as `decodeRaw` will return it (after orientation), from LibRaw's identify pass. */
export async function probeRaw(file: string): Promise<{ width: number; height: number }> {
  const out = (await run(RAW_IDENTIFY, ['-v', file])).toString();
  const size = /Output size:\s*(\d+)\s*x\s*(\d+)/.exec(out);
  if (!size) throw new Error(`LibRaw can't read ${file}`);
  // Output size already accounts for the file's orientation.
  return { width: Number(size[1]), height: Number(size[2]) };
}
