import { describe, expect, it, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeDng } from '../../media/test/dng';
import { closeTestBrowser, renderFrames } from '../src/testing';

const dir = join(__dirname, '.tmp-raw');
mkdirSync(dir, { recursive: true });
afterAll(() => closeTestBrowser());

let hasLibRaw = true;
try {
  execFileSync('dcraw_emu', [], { stdio: 'ignore' });
} catch (e) {
  hasLibRaw = (e as NodeJS.ErrnoException).code !== 'ENOENT';
}

writeFileSync(join(dir, 'scene.dng'), writeDng({ width: 64, height: 32, color: (x) => (x < 32 ? [0.5, 0.2, 0.1] : [0.18, 0.18, 0.18]) }));
const enc = (l: number) => (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055);

describe.skipIf(!hasLibRaw)('RAW in compositions', () => {
  it('shows a DNG as an image and a photo at 8 and 16 bits', async () => {
    const source = `import { still, image, photo, op } from 'tasweerix';
export default still({ width: 64, height: 64, background: '#000' }, (c) => {
  c.add(image('scene.dng', { size: [64, 32], at: [32, 16] }));
  c.add(photo('scene.dng', [op.adjust({ exposure: 0 })], { size: [64, 32], at: [32, 48] }));
});`;
    for (const depth of [8, 16] as const) {
      const f = (await renderFrames({ source, dir, frames: [0], depth })).frames[0]!;
      const s = depth === 16 ? 65535 : 255;
      for (const y of [16, 48]) {
        const warm = f.at(12, y).slice(0, 3).map((v) => v / s);
        const gray = f.at(50, y).slice(0, 3).map((v) => v / s);
        [0.5, 0.2, 0.1].forEach((l, i) => expect(Math.abs(warm[i]! - enc(l)), `depth ${depth} y ${y}`).toBeLessThan(0.012));
        gray.forEach((v) => expect(Math.abs(v - enc(0.18))).toBeLessThan(0.012));
      }
    }
  }, 120_000);

  it('keeps pushed RAW highlights above white in HDR', async () => {
    const source = `import { still, photo, op } from 'tasweerix';
export default still({ width: 64, height: 32, background: '#000' }, (c) => {
  c.add(photo('scene.dng', [op.adjust({ exposure: 2 })], { size: [64, 32] }));
});`;
    const hdr = (await renderFrames({ source, dir, frames: [0], hdr: true })).frames[0]!;
    // 0.5 linear pushed two stops is 2.0 linear, about 1.35 in extended sRGB.
    expect(hdr.at(12, 16)[0]).toBeGreaterThan(1.25);
    const sdr = (await renderFrames({ source, dir, frames: [0] })).frames[0]!;
    expect(sdr.at(12, 16)[0]).toBe(255);
  }, 120_000);
});
