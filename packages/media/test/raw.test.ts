import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gamutMatrix } from '@tasweerix/core';
import { decodeRaw, isRawPath, probe } from '../src/node';
import { writeDng } from './dng';

const dir = join(__dirname, '.tmp-raw');
mkdirSync(dir, { recursive: true });

let hasLibRaw = true;
try {
  execFileSync('raw-identify', [], { stdio: 'ignore' });
} catch (e) {
  hasLibRaw = (e as NodeJS.ErrnoException).code !== 'ENOENT';
}

/** Linear sRGB at a pixel of decoded planes. */
function srgbAt(r: Awaited<ReturnType<typeof decodeRaw>>, x: number, y: number) {
  const n = r.width * r.height;
  const f = new Float32Array(r.planes.buffer, r.planes.byteOffset, n * 4);
  const i = y * r.width + x;
  const c = [f[2 * n + i]!, f[i]!, f[n + i]!];
  const m = gamutMatrix('rec2020', 'srgb');
  return [0, 1, 2].map((k) => m[k * 3]! * c[0]! + m[k * 3 + 1]! * c[1]! + m[k * 3 + 2]! * c[2]!);
}

const close = (a: number[], b: number[], tol: number) => a.forEach((v, i) => expect(Math.abs(v - b[i]!)).toBeLessThanOrEqual(tol));

describe('camera RAW', () => {
  it('recognizes RAW file names', () => {
    expect(['a.DNG', 'b.cr3', 'c.nef', 'd.arw?x=1', 'e.raf'].every(isRawPath)).toBe(true);
    expect(['a.png', 'b.tiff', 'raw.mp4'].some(isRawPath)).toBe(false);
  });

  it.skipIf(!hasLibRaw)('develops a DNG to linear light with the camera matrix, white balance and orientation', async () => {
    const file = join(dir, 'scene.dng');
    // Left: a warm color; right: 18% gray. The camera saw it through a green-heavy white balance.
    writeFileSync(file, writeDng({ width: 64, height: 32, neutral: [0.5, 1, 0.7], color: (x) => (x < 32 ? [0.5, 0.2, 0.1] : [0.18, 0.18, 0.18]) }));
    const r = await decodeRaw(file);
    expect([r.width, r.height, r.gamut]).toEqual([64, 32, 'rec2020']);
    close(srgbAt(r, 12, 16), [0.5, 0.2, 0.1], 0.004);
    close(srgbAt(r, 50, 16), [0.18, 0.18, 0.18], 0.004);
    expect(await probe(file)).toMatchObject({ width: 64, height: 32, codec: 'raw', bitDepth: 16 });

    const turned = join(dir, 'turned.dng');
    writeFileSync(turned, writeDng({ width: 64, height: 32, orientation: 6, color: (x) => (x < 32 ? [0.5, 0.2, 0.1] : [0.18, 0.18, 0.18]) }));
    const t = await decodeRaw(turned);
    expect([t.width, t.height]).toEqual([32, 64]);
    expect(await probe(turned)).toMatchObject({ width: 32, height: 64 });
    // Rotated clockwise: the left (warm) half is now on top.
    close(srgbAt(t, 16, 12), [0.5, 0.2, 0.1], 0.004);
  });
});
