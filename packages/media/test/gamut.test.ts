import { describe, expect, it, afterAll } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  buildIcc,
  convertGamut,
  gamutMatrix,
  inv3,
  linearToSrgb,
  mul3,
  parseIcc,
  rgbToXyzD50,
} from '@tasweerix/core';
import { decodeImage16, embedIcc, extractIcc, FrameServer, probe } from '../src/node';

const dir = join(__dirname, '.tmp-gamut');
mkdirSync(dir, { recursive: true });
const frames = new FrameServer();
afterAll(() => frames.close());

const close = (a: number[], b: number[], tol: number) =>
  a.forEach((v, i) => expect(Math.abs(v - b[i]!)).toBeLessThanOrEqual(tol));

/** A minimal ICC v2 profile like Adobe RGB (1998): D50 colorants and a single-gamma 'curv' TRC. */
function adobeRgbV2(): Uint8Array {
  const tags: [string, number[]][] = [
    ['rXYZ', [0.6097, 0.3111, 0.0195]],
    ['gXYZ', [0.2053, 0.6257, 0.0609]],
    ['bXYZ', [0.1492, 0.0632, 0.7446]],
    ['wtpt', [0.9642, 1, 0.8249]],
  ];
  const size = 128 + 4 + 7 * 12 + 4 * 20 + 16;
  const b = Buffer.alloc(size);
  b.writeUInt32BE(size, 0);
  b.writeUInt32BE(0x02100000, 8);
  b.write('mntrRGB XYZ ', 12, 'latin1');
  b.write('acsp', 36, 'latin1');
  b.writeUInt32BE(7, 128);
  let off = 128 + 4 + 7 * 12;
  tags.forEach(([sig, v], i) => {
    b.write(sig, 132 + i * 12, 'latin1');
    b.writeUInt32BE(off, 136 + i * 12);
    b.writeUInt32BE(20, 140 + i * 12);
    b.write('XYZ ', off, 'latin1');
    v.forEach((c, k) => b.writeInt32BE(Math.round(c * 65536), off + 8 + k * 4));
    off += 20;
  });
  // One shared curv: gamma 563/256 (2.19921875).
  b.write('curv', off, 'latin1');
  b.writeUInt32BE(1, off + 8);
  b.writeUInt16BE(563, off + 12);
  ['rTRC', 'gTRC', 'bTRC'].forEach((sig, k) => {
    const i = 4 + k;
    b.write(sig, 132 + i * 12, 'latin1');
    b.writeUInt32BE(off, 136 + i * 12);
    b.writeUInt32BE(14, 140 + i * 12);
  });
  return b;
}

/** Writes a 16-bit RGB PNG filled with one color (0..1 channels). */
function solidPng16(file: string, rgb: [number, number, number], w = 8, h = 8) {
  const raw = Buffer.alloc(w * h * 6);
  for (let i = 0; i < w * h; i++)
    rgb.forEach((c, k) => raw.writeUInt16LE(Math.round(c * 65535), i * 6 + k * 2));
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-v',
      'error',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb48le',
      '-s',
      `${w}x${h}`,
      '-i',
      '-',
      '-pix_fmt',
      'rgb48be',
      file,
    ],
    { input: raw },
  );
}

const rgb16 = (d: Buffer, px = 0) => [0, 1, 2].map((k) => d.readUInt16LE(px * 8 + k * 2) / 65535);

describe('ICC profiles', () => {
  it('builds profiles that parse back to the same colorants and sRGB curve', () => {
    for (const g of ['srgb', 'display-p3', 'rec2020'] as const) {
      const p = parseIcc(buildIcc(g))!;
      close(p.matrix!, rgbToXyzD50(g), 1e-4);
      close([p.curves[0]!(0.5), p.curves[2]!(0.02)], [0.21404, 0.02 / 12.92], 1e-4);
    }
    expect(parseIcc(buildIcc('display-p3'))!.description).toBe('Display P3');
    expect(parseIcc(new Uint8Array(200))).toBeUndefined();
  });

  it('matches the standard sRGB → Display P3 matrix', () => {
    close(
      gamutMatrix('srgb', 'display-p3'),
      [0.8225, 0.1774, 0, 0.0332, 0.9669, 0, 0.0171, 0.0724, 0.9108],
      1e-3,
    );
  });

  it('converts sRGB red into P3 the way Chromium does, and back', () => {
    const px = new Uint16Array([65535, 0, 0, 65535]);
    convertGamut(px, 'srgb', 'display-p3');
    // Chromium's display-p3 canvas reads #ff0000 as (0.9175, 0.2003, 0.1385).
    close(
      Array.from(px.subarray(0, 3)).map((v) => v / 65535),
      [0.9175, 0.2003, 0.1385],
      0.002,
    );
    convertGamut(px, 'display-p3', 'srgb');
    close(Array.from(px), [65535, 0, 0, 65535], 40);
    const p3green = new Uint8Array([0, 255, 0, 128]);
    convertGamut(p3green, 'display-p3', 'srgb');
    expect(Array.from(p3green)).toEqual([0, 255, 0, 128]); // clipped, alpha kept
  });

  it('parses a v2 gamma-curve profile (Adobe RGB style)', () => {
    const p = parseIcc(adobeRgbV2())!;
    expect(p.curves[0]!(0.5)).toBeCloseTo(Math.pow(0.5, 2.19921875), 4);
    expect(p.matrix![4]).toBeCloseTo(0.6257, 4);
  });

  it('embeds and extracts profiles in PNG, JPEG, WebP and TIFF', () => {
    const icc = buildIcc('display-p3');
    for (const ext of ['png', 'jpg', 'webp', 'tiff']) {
      const f = join(dir, `solid.${ext}`);
      execFileSync('ffmpeg', [
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=0x3366cc:s=8x8',
        '-frames:v',
        '1',
        f,
      ]);
      expect(extractIcc(readFileSync(f))).toBeUndefined();
      const tagged = embedIcc(readFileSync(f), icc);
      expect(Buffer.from(extractIcc(tagged)!).equals(Buffer.from(icc))).toBe(true);
      // Re-embedding replaces the profile instead of adding a second one.
      expect(
        Buffer.from(extractIcc(embedIcc(tagged, buildIcc('rec2020')))!).equals(
          Buffer.from(buildIcc('rec2020')),
        ),
      ).toBe(true);
      // The file still decodes, with the same pixels.
      const out = join(dir, `solid-p3.${ext}`);
      writeFileSync(out, tagged);
      const a = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      const b = execFileSync('ffmpeg', [
        '-v',
        'error',
        '-i',
        out,
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-',
      ]);
      expect(b.equals(a)).toBe(true);
    }
  });
});

describe('wide-gamut decode', () => {
  it('applies an embedded profile on 16-bit decode', async () => {
    const file = join(dir, 'p3red16.png');
    solidPng16(file, [1, 0, 0]);
    writeFileSync(file, embedIcc(readFileSync(file), buildIcc('display-p3')));
    expect((await probe(file)).bitDepth).toBe(16);
    // Kept as P3 for a P3 renderer.
    const kept = await decodeImage16(file, 'display-p3');
    expect(kept.colorSpace).toBe('display-p3');
    close(rgb16(kept.data), [1, 0, 0], 5e-4);
    // Converted (and clipped) for an sRGB renderer instead of being read as sRGB red.
    const s = await decodeImage16(file, 'srgb');
    expect(s.colorSpace).toBe('srgb');
    close(rgb16(s.data), [1, 0, 0], 1e-3);
    // An in-gamut P3 color lands on its sRGB value.
    const mid = join(dir, 'p3mid16.png');
    const srgb = new Uint16Array([0.4 * 65535, 0.6 * 65535, 0.3 * 65535, 65535].map(Math.round));
    const p3 = Uint16Array.from(srgb);
    convertGamut(p3, 'srgb', 'display-p3');
    solidPng16(mid, [p3[0]! / 65535, p3[1]! / 65535, p3[2]! / 65535]);
    writeFileSync(mid, embedIcc(readFileSync(mid), buildIcc('display-p3')));
    close(rgb16((await decodeImage16(mid, 'srgb')).data), [0.4, 0.6, 0.3], 2e-3);
  });

  it('honors a v2 Adobe RGB profile and leaves untagged files alone', async () => {
    const file = join(dir, 'adobe16.png');
    solidPng16(file, [0, 1, 0]);
    writeFileSync(file, embedIcc(readFileSync(file), adobeRgbV2()));
    const img = await decodeImage16(file, 'display-p3');
    // Adobe RGB green lies outside P3: P3 red goes negative (clips to 0) and green drops below 1.
    const lin = mul3(inv3(rgbToXyzD50('display-p3')), parseIcc(adobeRgbV2())!.matrix!);
    const expected = [lin[1], lin[4], lin[7]].map((v) => linearToSrgb(Math.min(1, Math.max(0, v))));
    close(rgb16(img.data), expected, 1e-3);
    expect(expected[0]).toBe(0);
    const plain = join(dir, 'plain16.png');
    solidPng16(plain, [0.25, 0.5, 0.75]);
    const u = await decodeImage16(plain, 'display-p3');
    expect(u.colorSpace).toBe('srgb');
    close(rgb16(u.data), [0.25, 0.5, 0.75], 1e-4);
  });

  it('converts a BT.2020-tagged video to the requested gamut', async () => {
    const file = join(dir, 'red2020.mp4');
    // sRGB red re-expressed in BT.2020 primaries, tagged as such.
    execFileSync('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=0xff0000:s=64x64:d=0.2,format=gbrpf32le',
      '-vf',
      'zscale=primariesin=bt709:primaries=bt2020:transferin=bt709:transfer=bt709:matrixin=gbr:matrix=bt2020nc:range=tv,format=yuv420p10le',
      '-c:v',
      'libx265',
      '-x265-params',
      'log-level=error',
      '-color_primaries',
      'bt2020',
      '-color_trc',
      'bt709',
      '-colorspace',
      'bt2020nc',
      file,
    ]);
    const info = await probe(file);
    expect([info.colorPrimaries, info.colorTransfer]).toEqual(['bt2020', 'bt709']);
    const s = await frames.frame(file, 0, { gamut: 'srgb' });
    expect(s.colorSpace).toBe('srgb');
    const [r, g, b] = [s.data[0]!, s.data[1]!, s.data[2]!];
    expect(r).toBeGreaterThan(245);
    expect(Math.max(g, b)).toBeLessThan(20);
    const p = await frames.frame(file, 0, { gamut: 'display-p3', depth: 16 });
    expect(p.colorSpace).toBe('display-p3');
    close(rgb16(p.data), [0.9175, 0.2003, 0.1385], 0.05);
  });
});
