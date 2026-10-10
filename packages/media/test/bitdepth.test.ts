import { describe, expect, it, afterAll } from 'vitest';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { decodeImage16, FrameServer, pixFmtDepth, probe } from '../src/node';

const dir = join(__dirname, '.tmp');
mkdirSync(dir, { recursive: true });
const frames = new FrameServer();
afterAll(() => frames.close());

/** Writes a 16-bit PNG whose red channel ramps across 2 8-bit levels: invisible at 8 bits, smooth at 16. */
function png16(file: string, w = 256, h = 2) {
  const raw = Buffer.alloc(w * h * 6);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 6;
      raw.writeUInt16LE(Math.round((0.5 + (x / (w - 1)) * (2 / 255)) * 65535), i);
      raw.writeUInt16LE(32768, i + 2);
      raw.writeUInt16LE(32768, i + 4);
    }
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb48le', '-s', `${w}x${h}`, '-i', '-', '-pix_fmt', 'rgb48be', file], { input: raw });
}

describe('high bit-depth decode', () => {
  it('reads bit depth from pixel formats', () => {
    expect(['rgba', 'rgb24', 'yuv420p', 'nv12', 'pal8'].map(pixFmtDepth)).toEqual([8, 8, 8, 8, 8]);
    expect(['rgb48be', 'rgba64le', 'gray16be', 'yuv420p10le', 'p010le', 'gbrp12le', 'gbrapf32le'].map(pixFmtDepth)).toEqual([16, 16, 16, 10, 10, 12, 32]);
  });

  it('decodes a 16-bit PNG without losing precision', async () => {
    const file = join(dir, 'ramp16.png');
    png16(file);
    expect((await probe(file)).bitDepth).toBe(16);
    const img = await decodeImage16(file);
    expect([img.width, img.height]).toEqual([256, 2]);
    const reds = new Set<number>();
    for (let x = 0; x < 256; x++) reds.add(img.data.readUInt16LE(x * 8));
    expect(reds.size).toBeGreaterThan(200);
    expect(img.data.readUInt16LE(6)).toBe(65535); // alpha
  });

  it('serves 16-bit frames from 10-bit video', async () => {
    const file = join(dir, 'ten.mkv');
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'gradients=s=128x72:r=10:d=1', '-c:v', 'ffv1', '-pix_fmt', 'yuv444p10le', file]);
    expect((await probe(file)).bitDepth).toBe(10);
    const f8 = await frames.frame(file, 0.2);
    const f16 = await frames.frame(file, 0.2, { depth: 16 });
    expect(f8.data.length).toBe(128 * 72 * 4);
    expect(f16.data.length).toBe(128 * 72 * 8);
    // A 10-bit source carries values between the 8-bit steps (not multiples of 257).
    let between = 0;
    for (let i = 0; i < f16.data.length; i += 2) if (f16.data.readUInt16LE(i) % 257 !== 0) between++;
    expect(between).toBeGreaterThan(1000);
  });
});
