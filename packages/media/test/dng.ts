/**
 * Writes a minimal uncompressed DNG (16-bit RGGB Bayer mosaic) for RAW decode tests. The camera's
 * color matrix is the sRGB one, so a scene given in linear sRGB decodes back to the same colors.
 */
import { inv3, rgbToXyz } from '@tasweerix/core';

export interface DngScene {
  width: number;
  height: number;
  /** Linear sRGB (1 = white level) at a pixel. */
  color: (x: number, y: number) => [number, number, number];
  black?: number;
  white?: number;
  /** Camera response to white per channel (AsShotNeutral): the white balance the decoder undoes. */
  neutral?: [number, number, number];
  /** TIFF orientation (6 = rotate 90° clockwise to display). */
  orientation?: number;
}

export function writeDng(s: DngScene): Buffer {
  const black = s.black ?? 512;
  const white = s.white ?? 16383;
  const neutral = s.neutral ?? [1, 1, 1];
  const { width: w, height: h } = s;
  const data = Buffer.alloc(w * h * 2);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ch = y % 2 === 0 ? (x % 2 === 0 ? 0 : 1) : x % 2 === 0 ? 1 : 2;
      const v = s.color(x, y)[ch]! * neutral[ch]!;
      data.writeUInt16LE(Math.round(black + Math.min(1, Math.max(0, v)) * (white - black)), (y * w + x) * 2);
    }
  // XYZ (D65) → camera, with camera = linear sRGB.
  const cm = inv3(rgbToXyz('srgb'));
  type Entry = [tag: number, type: number, values: number[] | string];
  const SHORT = 3, LONG = 4, RATIONAL = 5, SRATIONAL = 10, BYTE = 1, ASCII = 2;
  const entries: Entry[] = [
    [254, LONG, [0]],
    [256, LONG, [w]],
    [257, LONG, [h]],
    [258, SHORT, [16]],
    [259, SHORT, [1]],
    [262, SHORT, [32803]],
    [271, ASCII, 'Tasweerix'],
    [272, ASCII, 'Test Camera'],
    [273, LONG, [0]], // strip offset, patched below
    [274, SHORT, [s.orientation ?? 1]],
    [277, SHORT, [1]],
    [278, LONG, [h]],
    [279, LONG, [data.length]],
    [284, SHORT, [1]],
    [33421, SHORT, [2, 2]],
    [33422, BYTE, [0, 1, 1, 2]],
    [50706, BYTE, [1, 4, 0, 0]],
    [50708, ASCII, 'Tasweerix Test Camera'],
    [50714, LONG, [black]],
    [50717, LONG, [white]],
    [50721, SRATIONAL, cm.flatMap((v) => [Math.round(v * 10000), 10000])],
    [50728, RATIONAL, neutral.flatMap((v) => [Math.round(v * 10000), 10000])],
    [50778, SHORT, [21]],
  ];
  const size = (t: number) => (t === SHORT ? 2 : t === LONG ? 4 : t === RATIONAL || t === SRATIONAL ? 8 : 1);
  const count = (e: Entry) => (typeof e[2] === 'string' ? e[2].length + 1 : e[1] === RATIONAL || e[1] === SRATIONAL ? e[2].length / 2 : e[2].length);
  const ifdSize = 2 + entries.length * 12 + 4;
  let extra = 8 + ifdSize;
  const ifd = Buffer.alloc(ifdSize);
  ifd.writeUInt16LE(entries.length, 0);
  const extraParts: Buffer[] = [];
  const dataOffsetFix: number[] = [];
  entries.forEach((e, i) => {
    const o = 2 + i * 12;
    const n = count(e);
    ifd.writeUInt16LE(e[0], o);
    ifd.writeUInt16LE(e[1], o + 2);
    ifd.writeUInt32LE(n, o + 4);
    const b = Buffer.alloc(Math.max(4, n * size(e[1])));
    if (typeof e[2] === 'string') b.write(e[2], 'latin1');
    else
      e[2].forEach((v, k) => {
        if (e[1] === SHORT) b.writeUInt16LE(v, k * 2);
        else if (e[1] === LONG || e[1] === RATIONAL) b.writeUInt32LE(v, k * 4);
        else if (e[1] === SRATIONAL) b.writeInt32LE(v, k * 4);
        else b.writeUInt8(v, k);
      });
    if (e[0] === 273) dataOffsetFix.push(o + 8);
    if (b.length <= 4) b.copy(ifd, o + 8);
    else {
      ifd.writeUInt32LE(extra, o + 8);
      extraParts.push(b);
      extra += b.length + (b.length & 1);
      if (b.length & 1) extraParts.push(Buffer.alloc(1));
    }
  });
  for (const o of dataOffsetFix) ifd.writeUInt32LE(extra, o);
  const header = Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
  return Buffer.concat([header, ifd, ...extraParts, data]);
}
