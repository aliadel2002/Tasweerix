import { describe, expect, it, afterAll } from 'vitest';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { adjust, applyOps, autoLevels, autoWhiteBalance, createBitmap, crop, curves, heal, histogram, mask, op, perspective, resize, resolveMask, rotate, toRGBA8, type Bitmap } from '../src';
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

describe('bit depth', () => {
  // A dark gradient spanning only ~10 8-bit levels, stretched 8x by a curve: the shadow-lift case.
  const ramp = () => {
    const b = createBitmap(1024, 1);
    for (let x = 0; x < 1024; x++) b.data.set([(x / 1023) * 0.04, (x / 1023) * 0.04, (x / 1023) * 0.04, 1], x * 4);
    return b;
  };
  it('curves interpolate instead of snapping to 256 levels', () => {
    const out = curves(ramp(), { rgb: [[0, 0], [0.04, 0.32], [1, 1]] });
    const levels = new Set<number>();
    for (let x = 0; x < 1024; x++) levels.add(out.data[x * 4]!);
    expect(levels.size).toBeGreaterThan(500);
    for (let x = 1; x < 1024; x++) expect(out.data[x * 4]!).toBeGreaterThanOrEqual(out.data[(x - 1) * 4]! - 1e-6);
  });
  it('toRGBA8 dithers gradients but keeps exact values and alpha', () => {
    // A sky-like gradient spanning 4 levels over 1024 px: rounding makes 256 px wide flat bands.
    const lifted = createBitmap(1024, 1);
    for (let x = 0; x < 1024; x++) lifted.data.set([0.5 + (x / 1023) * (4 / 255), 0.5, 0.5, 1], x * 4);
    // Banding = local averages that sit off the true value. Box-average 32 px and compare with the float
    // ramp: plain rounding leaves a systematic step error, dither averages it out.
    const bandError = (d: Uint8ClampedArray) => {
      let err = 0;
      for (let x = 16; x < 1008; x++) {
        let sum = 0, ref = 0;
        for (let k = -16; k < 16; k++) (sum += d[(x + k) * 4]!), (ref += lifted.data[(x + k) * 4]! * 255);
        err += Math.abs(sum - ref) / 32;
      }
      return err / 992;
    };
    const plainErr = bandError(toRGBA8(lifted, { dither: false }));
    const ditherErr = bandError(toRGBA8(lifted));
    expect(ditherErr).toBeLessThan(plainErr / 2);
    // Dither stays within ±1 level and is deterministic.
    const plain = toRGBA8(lifted, { dither: false });
    const d = toRGBA8(lifted);
    for (let i = 0; i < d.length; i++) expect(Math.abs(d[i]! - plain[i]!)).toBeLessThanOrEqual(1);
    expect(toRGBA8(lifted)).toEqual(d);
    const solid = toRGBA8(createBitmap(8, 8, [0, 1, 0, 0.5]));
    for (let i = 0; i < solid.length; i += 4) expect(Array.from(solid.subarray(i, i + 4))).toEqual([0, 255, 0, 128]);
  });
});

describe('headroom', () => {
  const bright = () => {
    const b = createBitmap(64, 1);
    for (let x = 0; x < 64; x++) b.data.set([0.6 + (x / 63) * 0.3, 0.5, 0.4, 1], x * 4);
    return b;
  };
  it('a later op recovers highlights an earlier op pushed past white', () => {
    const src = bright();
    const out = applyOps(src, [op.adjust({ exposure: 1 }), op.sharpen(), op.clarity(0.2), op.curves({ r: [[0, 0], [1, 1]] }), op.adjust({ exposure: -1 })]);
    // Without headroom every pixel would clip to 1 after +1 EV and come back as one flat value.
    const reds = new Set<number>();
    for (let x = 0; x < 64; x++) reds.add(+out.data[x * 4]!.toFixed(3));
    expect(reds.size).toBeGreaterThan(50);
    expect(out.data[63 * 4]!).toBeCloseTo(0.9, 1);
  });
  it('keeps values above 1 between ops but clips them at the 8-bit output', () => {
    const over = adjust(bright(), { exposure: 1 });
    expect(Math.max(...Array.from(over.data))).toBeGreaterThan(1.2);
    expect(Math.min(...Array.from(over.data))).toBeGreaterThanOrEqual(0);
    expect(Math.max(...toRGBA8(over))).toBe(255);
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
  it('edits 16-bit sources at full depth', async () => {
    const dir = join(__dirname, '.tmp');
    mkdirSync(dir, { recursive: true });
    // Red ramps across just 2 8-bit levels; a curve stretches that range to full black..white.
    const w = 256;
    const raw = Buffer.alloc(w * 2 * 6);
    for (let i = 0; i < w * 2; i++) {
      raw.writeUInt16LE(Math.round((0.5 + ((i % w) / (w - 1)) * (2 / 255)) * 65535), i * 6);
      raw.writeUInt16LE(32768, i * 6 + 2);
      raw.writeUInt16LE(32768, i * 6 + 4);
    }
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb48le', '-s', `${w}x2`, '-i', '-', '-pix_fmt', 'rgb48be', join(dir, 'ramp16.png')], { input: raw });
    const { frames } = await renderFrames({
      dir,
      frames: [0],
      source: `import { still, photo, op } from 'tasweerix';
      export default still({ width: ${w}, height: 2 }, (c) => { c.add(photo('ramp16.png', [op.curves({ r: [[0.5, 0], [${0.5 + 2 / 255}, 1]] })], { size: [${w}, 2] })); });`,
    });
    // At 8 bits the source has 3 levels, so the stretched result would have a handful of values.
    const reds = new Set<number>();
    for (let x = 0; x < w; x++) reds.add(frames[0]!.at(x, 0)[0]);
    expect(reds.size).toBeGreaterThan(100);
  });
});
