import { describe, expect, it, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseIcc } from '@tasweerix/core';
import { extractIcc } from '@tasweerix/media/node';
import { render } from '../src/render';
import { outputGamut } from '../src/encode';
import { closeTestBrowser, renderFrames } from '../src/testing';

const dir = join(__dirname, '.tmp-gamut');
mkdirSync(dir, { recursive: true });
afterAll(() => closeTestBrowser());

// Left half sRGB red, right half the most saturated P3 green (outside sRGB), third column a P3
// color through a GPU filter.
const body = `
  c.add(rect({ size: [32, 64], at: [16, 32], fill: '#ff0000' }));
  c.add(rect({ size: [32, 64], at: [48, 32], fill: 'color(display-p3 0 1 0)' }));`;
writeFileSync(
  join(dir, 'still.ts'),
  `import { still, rect } from 'tasweerix';\nexport default still({ width: 64, height: 64, background: '#000' }, (c) => {${body}\n});`,
);
writeFileSync(
  join(dir, 'clip.ts'),
  `import { composition, rect } from 'tasweerix';\nexport default composition({ width: 64, height: 64, fps: 10, duration: 0.3, background: '#000' }, (c) => {${body}\n});`,
);

const tags = (f: string) =>
  execFileSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=color_primaries,color_space',
    '-of',
    'csv=p=0',
    f,
  ])
    .toString()
    .trim();
/** Raw decoded RGB (no color management) at the center of the left and right halves. */
const raw = (f: string) =>
  [14, 46].map((x) =>
    Array.from(
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-i',
        f,
        '-frames:v',
        '1',
        '-vf',
        `crop=2:2:${x}:30`,
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-',
      ]).subarray(0, 3),
    ),
  );
const near = (a: number[][], b: number[][], tol = 3) =>
  a.flat().forEach((v, i) => expect(Math.abs(v - b.flat()[i]!)).toBeLessThanOrEqual(tol));
/** sRGB #ff0000 expressed in Display P3, and P3 green, as stored values. */
const P3 = [
  [234, 51, 35],
  [0, 255, 0],
];

describe('wide-gamut compositing and export (--gamut)', () => {
  it('composites in Display P3 at 8 and 16 bits, through GPU filters too', async () => {
    const source = `import { still, rect, fx } from 'tasweerix';
export default still({ width: 4, height: 2, background: '#000' }, (c) => {
  c.add(rect({ size: [1, 2], at: [0.5, 1], fill: '#ff0000' }));
  c.add(rect({ size: [1, 2], at: [1.5, 1], fill: 'color(display-p3 0 1 0)' }));
  c.add(rect({ size: [1, 2], at: [2.5, 1], fill: 'color(display-p3 0.1 0.8 0.1)' }));
  c.add(rect({ size: [1, 2], at: [3.5, 1], fill: 'color(display-p3 0.1 0.8 0.1)', filters: [fx.grade({ exposure: 0.001 })] }));
});`;
    const srgb = (await renderFrames({ source, dir, frames: [0] })).frames[0]!;
    expect([0, 1].map((x) => srgb.at(x, 1))).toEqual([
      [255, 0, 0, 255],
      [0, 255, 0, 255],
    ]);
    const p3 = (await renderFrames({ source, dir, frames: [0], gamut: 'display-p3' })).frames[0]!;
    near(
      [0, 1, 2, 3].map((x) => p3.at(x, 1).slice(0, 3)),
      [...P3, [26, 204, 26], [26, 204, 26]],
      1,
    );
    const p316 = (await renderFrames({ source, dir, frames: [0], gamut: 'display-p3', depth: 16 }))
      .frames[0]!;
    near(
      [0, 3].map((x) => p316.at(x, 1).slice(0, 3)),
      [
        [60127, 13128, 9080],
        [6600, 52428, 6600],
      ],
      300,
    );
  }, 120_000);

  it('writes stills with an ICC profile (png, jpg, webp, tiff) or AVIF color tags', async () => {
    for (const ext of ['png', 'jpg', 'webp', 'tiff']) {
      const out = join(dir, `p3.${ext}`);
      await render({ entry: join(dir, 'still.ts'), output: out, gamut: 'display-p3' });
      expect(parseIcc(extractIcc(readFileSync(out))!)!.description).toBe('Display P3');
      near(raw(out), P3, ext === 'jpg' || ext === 'webp' ? 6 : 1);
    }
    const avif = join(dir, 'p3.avif');
    await render({ entry: join(dir, 'still.ts'), output: avif, gamut: 'display-p3', depth: 16 });
    expect(tags(avif)).toBe('bt709,smpte432');
    near(raw(avif), P3, 3);
    // sRGB output stays untagged, as before.
    const plain = join(dir, 'srgb.png');
    await render({ entry: join(dir, 'still.ts'), output: plain });
    expect(extractIcc(readFileSync(plain))).toBeUndefined();
  }, 180_000);

  it('tags video and converts to the output gamut', async () => {
    const def = join(dir, 'srgb.mp4');
    await render({ entry: join(dir, 'clip.ts'), output: def, muted: true });
    // Every video now carries BT.709 tags and an explicit BT.709 matrix, so red decodes as red.
    expect(tags(def)).toBe('bt709,bt709');
    near(
      raw(def),
      [
        [255, 0, 0],
        [0, 255, 0],
      ],
      4,
    );

    const p3 = join(dir, 'p3.mp4');
    await render({
      entry: join(dir, 'clip.ts'),
      output: p3,
      codec: 'h265',
      gamut: 'display-p3',
      depth: 16,
      muted: true,
    });
    expect(tags(p3)).toBe('bt709,smpte432');
    near(raw(p3), P3, 4);

    const r2020 = join(dir, 'r2020.mov');
    await render({
      entry: join(dir, 'clip.ts'),
      output: r2020,
      codec: 'prores',
      gamut: 'rec2020',
      depth: 16,
      muted: true,
    });
    expect(tags(r2020)).toBe('bt2020nc,bt2020');
    // sRGB red in BT.2020 primaries is about (0.815, 0.29, 0.13).
    near(raw(r2020).slice(0, 1), [[208, 74, 34]], 4);

    // GIF can't carry a tag: frames go back to sRGB (P3 green clips).
    const gif = join(dir, 'p3.gif');
    await render({ entry: join(dir, 'clip.ts'), output: gif, gamut: 'display-p3' });
    near(
      raw(gif),
      [
        [255, 0, 0],
        [0, 255, 0],
      ],
      2,
    );
    expect(outputGamut({ codec: 'gif', gamut: 'display-p3' })).toBe('srgb');
    expect(outputGamut({ codec: 'h264', inputGamut: 'display-p3' })).toBe('display-p3');
  }, 240_000);
});
