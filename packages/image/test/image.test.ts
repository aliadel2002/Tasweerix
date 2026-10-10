import { describe, expect, it, afterAll } from 'vitest';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { adjust, applyOps, autoLevels, autoWhiteBalance, createBitmap, crop, curves, heal, histogram, mask, op, perspective, resize, resolveMask, rotate, type Bitmap } from '../src';
import { closeTestBrowser, renderFrames } from '../../cli/src/testing';

const px = (b: Bitmap, x: number, y: number) => Array.from(b.data.subarray((y * b.width + x) * 4, (y * b.width + x) * 4 + 4));
const gradient = (w: number, h: number) => {
  const b = createBitmap(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b.data.set([x / (w - 1), y / (h - 1), 0.5, 1], (y * w + x) * 4);
  return b;
};

afterAll(closeTestBrowser);

describe('geometry', () => {
  it('crops, rotates 90° exactly and resizes', () => {
    const g = gradient(40, 20);
    const c = crop(g, 10, 5, 20, 10);
    expect([c.width, c.height]).toEqual([20, 10]);
    expect(px(c, 0, 0)[0]).toBeCloseTo(10 / 39);
    const r = rotate(g, 90);
    expect([r.width, r.height]).toEqual([20, 40]);
    const solid = createBitmap(64, 64, [0.2, 0.4, 0.6, 1]);
    const s = resize(solid, 23, 17);
    expect(px(s, 11, 8).map((v) => +v.toFixed(3))).toEqual([0.2, 0.4, 0.6, 1]);
  });
  it('perspective with identity corners keeps the image', () => {
    const g = gradient(30, 30);
    const p = perspective(g, [[0, 0], [30, 0], [30, 30], [0, 30]], 30, 30);
    expect(px(p, 15, 15)[0]).toBeCloseTo(px(g, 15, 15)[0]!, 2);
  });
});

describe('tone', () => {
  it('auto levels stretches the histogram', () => {
    const b = createBitmap(50, 1);
    for (let x = 0; x < 50; x++) b.data.set([0.3 + (x / 49) * 0.3, 0.3 + (x / 49) * 0.3, 0.3 + (x / 49) * 0.3, 1], x * 4);
    const out = autoLevels(b, { clip: 0 });
    expect(px(out, 0, 0)[0]).toBeLessThan(0.02);
    expect(px(out, 49, 0)[0]).toBeGreaterThan(0.98);
  });
  it('auto white balance removes a color cast', () => {
    const b = createBitmap(10, 10, [0.6, 0.5, 0.4, 1]);
    const out = autoWhiteBalance(b);
    const [r, g, bl] = px(out, 5, 5);
    expect(Math.abs(r! - bl!)).toBeLessThan(0.01);
    expect(Math.abs(r! - g!)).toBeLessThan(0.01);
  });
  it('curves can invert and masked adjust only touches the selection', () => {
    const b = createBitmap(4, 4, [0.25, 0.25, 0.25, 1]);
    expect(px(curves(b, { rgb: [[0, 1], [1, 0]] }), 0, 0)[0]).toBeCloseTo(0.75, 1);
    const m = resolveMask(mask.rect(0, 0, 2, 4), b);
    const a = adjust(b, { exposure: 1 }, m);
    expect(px(a, 0, 0)[0]).toBeGreaterThan(0.3);
    expect(px(a, 3, 0)[0]).toBeCloseTo(0.25);
  });
  it('histogram counts pixels', () => {
    const h = histogram(createBitmap(8, 8, [1, 0, 0, 1]));
    expect(h.count).toBe(64);
    expect(h.r[255]).toBe(64);
  });
});

describe('selections & retouch', () => {
  it('magic wand selects only the contiguous region', () => {
    const b = createBitmap(10, 10, [1, 1, 1, 1]);
    for (let y = 0; y < 10; y++) b.data.set([0, 0, 0, 1], (y * 10 + 5) * 4); // black wall at x=5
    b.data.set([1, 1, 1, 1], (0 * 10 + 9) * 4);
    const m = resolveMask(mask.wand(1, 1, 0.1), b);
    expect(m.data[1 * 10 + 1]).toBe(1);
    expect(m.data[1 * 10 + 8]).toBe(0);
    const g = resolveMask(mask.wand(1, 1, 0.1, false), b);
    expect(g.data[1 * 10 + 8]).toBe(1);
  });
  it('heal removes a blemish', () => {
    const b = createBitmap(60, 60, [0.6, 0.5, 0.4, 1]);
    for (let y = 28; y < 32; y++) for (let x = 28; x < 32; x++) b.data.set([0.1, 0.1, 0.1, 1], (y * 60 + x) * 4);
    const out = heal(b, { from: [15, 15], to: [30, 30], radius: 6 });
    expect(px(out, 30, 30)[0]).toBeGreaterThan(0.5);
  });
  it('runs a full op pipeline', () => {
    const out = applyOps(gradient(80, 60), [op.autoWhiteBalance(), op.straighten(3), op.resize({ maxSize: 40 }), op.sharpen(), op.clarity(0.2), op.denoise({ radius: 1 }), op.vignette(0.3)]);
    expect(out.width).toBeLessThanOrEqual(40);
  });
});

describe('photo node (browser)', () => {
  it('renders an edited photo', async () => {
    const dir = join(__dirname, '.tmp');
    mkdirSync(dir, { recursive: true });
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x404040:s=64x64', '-frames:v', '1', join(dir, 'gray.png')]);
    const { frames } = await renderFrames({
      dir,
      frames: [0],
      source: `import { still, photo, op } from 'tasweerix';
      export default still({ width: 64, height: 64 }, (c) => { c.add(photo('gray.png', [op.curves({ rgb: [[0, 1], [1, 0]] })])); });`,
    });
    const [r] = frames[0]!.at(32, 32);
    expect(Math.abs(r - (255 - 64))).toBeLessThanOrEqual(3);
  });
});
