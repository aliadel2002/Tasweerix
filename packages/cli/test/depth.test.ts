import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '../src/render';
import { dither16to8, FrameEncoder, storedDepth } from '../src/encode';

const dir = join(__dirname, '.tmp-depth');
mkdirSync(dir, { recursive: true });
const W = 512;
// A gray-blue sky gradient spanning 4 8-bit levels: classic banding at 8 bits.
writeFileSync(
  join(dir, 'sky.ts'),
  `import { still, rect } from 'tasweerix';
export default still({ width: ${W}, height: 16, background: '#000' }, (c) => {
  for (let x = 0; x < ${W}; x++) {
    const v = 0.5 + (x / ${W - 1}) * (4 / 255);
    c.add(rect({ size: [1, 16], at: [x + 0.5, 8], fill: \`color(srgb \${v} \${v} \${v})\` }));
  }
});`,
);

const pixFmt = (f: string) => execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=pix_fmt', '-of', 'csv=p=0', f]).toString().trim();
/** Red channel of row 8 as 0..1 floats (decoded at 16 bits). */
const row = (f: string) => {
  const b = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-frames:v', '1', '-vf', 'crop=iw:1:0:8', '-f', 'rawvideo', '-pix_fmt', 'rgb48le', '-']);
  return Array.from({ length: W }, (_, x) => b.readUInt16LE(x * 6) / 65535);
};
/** Mean distance between 32 px local averages and the true ramp (after removing a constant offset). */
const bandError = (r: number[]) => {
  const loc: number[] = [];
  const ref: number[] = [];
  for (let x = 16; x < W - 16; x++) {
    let s = 0, t = 0;
    for (let k = -16; k < 16; k++) (s += r[x + k]!), (t += 0.5 + ((x + k) / (W - 1)) * (4 / 255));
    loc.push((s / 32) * 255);
    ref.push((t / 32) * 255);
  }
  const off = loc.reduce((a, v, i) => a + v - ref[i]!, 0) / loc.length;
  return loc.reduce((a, v, i) => a + Math.abs(v - ref[i]! - off), 0) / loc.length;
};

describe('16-bit export (--depth 16)', () => {
  it('picks the stored depth per codec', () => {
    expect(storedDepth({ codec: 'h265', depth: 16 })).toBe(16);
    expect(storedDepth({ codec: 'h264', depth: 16 })).toBe(8);
    expect(storedDepth({ codec: 'vp9', depth: 16, alpha: true })).toBe(8);
    expect(storedDepth({ codec: 'png', depth: 16, keepDepth: false })).toBe(8);
    expect(storedDepth({ codec: 'prores' })).toBe(8);
  });

  it('dithers 16 → 8 bits within one level, keeping alpha and extremes exact', () => {
    const src = new Uint16Array([0, 65535, 32896, 40000, 65535, 0, 12345, 65535]);
    const out = dither16to8(new Uint8Array(src.buffer));
    expect([out[0], out[1], out[3], out[4], out[5], out[7]]).toEqual([0, 255, Math.round((40000 * 255) / 65535), 255, 0, 255]);
    expect(Math.abs(out[2]! - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs(out[6]! - (12345 * 255) / 65535)).toBeLessThan(1.5);
  });

  it('writes a 16-bit PNG and TIFF that keep the gradient', async () => {
    for (const ext of ['png', 'tif']) {
      const out = join(dir, `sky16.${ext}`);
      await render({ entry: join(dir, 'sky.ts'), output: out, depth: 16 });
      expect(pixFmt(out)).toMatch(/^rgba64/);
      expect(new Set(row(out).map((v) => Math.round(v * 65535))).size).toBeGreaterThan(30);
    }
  }, 60_000);

  it('dithers 16-bit frames written to 8-bit outputs instead of banding', async () => {
    // Same ramp as 16-bit frames straight into the encoder: plain 8-bit PNG vs dithered 8-bit PNG.
    const frame = Buffer.alloc(W * 16 * 8);
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < W; x++) {
        const v = Math.round((0.5 + (x / (W - 1)) * (4 / 255)) * 65535);
        for (let c = 0; c < 3; c++) frame.writeUInt16LE(v, (y * W + x) * 8 + c * 2);
        frame.writeUInt16LE(65535, (y * W + x) * 8 + 6);
      }
    const encode = async (out: string, keepDepth: boolean) => {
      const enc = new FrameEncoder({ width: W, height: 16, fps: 1, codec: 'png', output: out, depth: 16, keepDepth });
      await enc.write(frame);
      await enc.finish();
    };
    await encode(join(dir, 'ramp16.png'), true);
    await encode(join(dir, 'ramp8.png'), false);
    expect(pixFmt(join(dir, 'ramp16.png'))).toBe('rgba64be');
    expect(pixFmt(join(dir, 'ramp8.png'))).toBe('rgba');
    const truncated = Array.from({ length: W }, (_, x) => Math.round((0.5 + (x / (W - 1)) * (4 / 255)) * 255) / 255);
    expect(bandError(row(join(dir, 'ramp8.png')))).toBeLessThan(bandError(truncated) / 2);
  }, 60_000);

  it('encodes 10-bit h265 from 16-bit frames', async () => {
    writeFileSync(join(dir, 'clip.ts'), `import { composition, rect } from 'tasweerix';
export default composition({ width: 64, height: 64, fps: 10, duration: 0.5, background: '#336699' }, (c) => { c.add(rect({ size: [32, 32], fill: '#ffcc00' })); });`);
    const out = join(dir, 'clip.mp4');
    await render({ entry: join(dir, 'clip.ts'), output: out, codec: 'h265', depth: 16, muted: true });
    expect(pixFmt(out)).toBe('yuv420p10le');
  }, 60_000);
});
