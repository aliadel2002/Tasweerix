import { describe, expect, it, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extendedSrgbToLinear, floatToHalf, halfToFloatTable, hlgDecode, hlgEncode, pqDecode, pqEncode } from '@tasweerix/core';
import { render } from '../src/render';
import { closeTestBrowser, renderFrames } from '../src/testing';

const dir = join(__dirname, '.tmp-hdr');
mkdirSync(dir, { recursive: true });
afterAll(() => closeTestBrowser());

// Reference white on the left, a highlight at sRGB 2.0 (about 5x white, ~1000 nits) on the right.
const body = `
  c.add(rect({ size: [32, 64], at: [16, 32], fill: '#ffffff' }));
  c.add(rect({ size: [32, 64], at: [48, 32], fill: 'color(srgb 2 2 2)' }));`;
writeFileSync(join(dir, 'clip.ts'), `import { composition, rect } from 'tasweerix';\nexport default composition({ width: 64, height: 64, fps: 10, duration: 0.3, background: '#000' }, (c) => {${body}\n});`);
writeFileSync(join(dir, 'still.ts'), `import { still, rect } from 'tasweerix';\nexport default still({ width: 64, height: 64, background: '#000' }, (c) => {${body}\n});`);

const tags = (f: string) =>
  execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=color_primaries,color_transfer,color_space', '-of', 'csv=p=0', f]).toString().trim();

/** Linear light at the centers of both halves, with 1.0 = 203 nits, decoded by zimg. */
function linear(f: string, transfer: 'smpte2084' | 'arib-std-b67') {
  const out = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-frames:v', '1', '-vf', `zscale=transferin=${transfer}:transfer=linear:npl=203:primariesin=bt2020:primaries=bt709,format=gbrpf32le`, '-f', 'rawvideo', '-']);
  const plane = 64 * 64 * 4;
  // gbrp planes: G, B, R.
  return [14, 46].map((x) => {
    const i = (32 * 64 + x) * 4;
    return [out.readFloatLE(2 * plane + i), out.readFloatLE(i), out.readFloatLE(plane + i)];
  });
}

describe('HDR transfer functions', () => {
  it('round trips half floats, PQ and HLG', () => {
    const t = halfToFloatTable();
    for (const v of [0, 1, -0.5, 2.5, 65504, 1e-5]) expect(t[floatToHalf(v)]).toBeCloseTo(v, 3);
    expect(pqEncode(203)).toBeCloseTo(0.5806, 3); // BT.2408: reference white at 58% PQ
    expect(pqDecode(pqEncode(1000))).toBeCloseTo(1000, 3);
    expect(hlgEncode(0.26496256)).toBeCloseTo(0.75, 3); // and at 75% HLG
    expect(hlgDecode(hlgEncode(0.5))).toBeCloseTo(0.5, 5);
  });
});

describe('HDR compositing and export (--hdr)', () => {
  it('composites above 1.0 through filters', async () => {
    const source = `import { still, rect, fx } from 'tasweerix';
export default still({ width: 4, height: 1, background: '#000' }, (c) => {
  c.add(rect({ size: [1, 1], at: [3.5, 0.5], fill: 'color(srgb 2 2 2)', filters: [fx.toneMap({ white: 3 })] }));
  c.add(rect({ size: [1, 1], at: [0.5, 0.5], fill: '#fff' }));
  c.add(rect({ size: [1, 1], at: [1.5, 0.5], fill: 'color(srgb 2 2 2)' }));
  c.add(rect({ size: [1, 1], at: [2.5, 0.5], fill: '#808080', filters: [fx.grade({ exposure: 3 })] }));
});`;
    const f = (await renderFrames({ source, dir, frames: [0], hdr: true })).frames[0]!;
    expect(f.at(0, 0)[0]).toBeCloseTo(1, 2);
    expect(f.at(1, 0)[0]).toBeCloseTo(2, 2);
    expect(f.at(2, 0)[0]).toBeGreaterThan(1.1);
    // fx.toneMap brings the highlight back under white, above the knee.
    expect(f.at(3, 0)[0]).toBeLessThan(0.995);
    expect(f.at(3, 0)[0]).toBeGreaterThan(0.95);
  }, 120_000);

  it('writes PQ and HLG video with BT.2020 tags, white at 203 nits', async () => {
    const pq = join(dir, 'pq.mp4');
    await render({ entry: join(dir, 'clip.ts'), output: pq, hdr: 'pq', muted: true });
    expect(tags(pq)).toBe('bt2020nc,smpte2084,bt2020');
    const hi = extendedSrgbToLinear(2);
    const [w, h] = linear(pq, 'smpte2084');
    w!.forEach((v) => expect(v).toBeCloseTo(1, 1));
    h!.forEach((v) => expect(Math.abs(v / hi - 1)).toBeLessThan(0.05));
    // HDR10 mastering metadata rides in the HEVC stream.
    const side = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_frames', '-read_intervals', '%+#1', '-show_entries', 'frame=side_data_list', pq]).toString();
    expect(side).toMatch(/Mastering display metadata/);

    const hlg = join(dir, 'hlg.mov');
    await render({ entry: join(dir, 'clip.ts'), output: hlg, codec: 'prores', hdr: 'hlg', muted: true });
    expect(tags(hlg)).toBe('bt2020nc,arib-std-b67,bt2020');
    const [hw, hh] = linear(hlg, 'arib-std-b67');
    // zimg's HLG decode applies the system OOTF, so only check order and that the highlight is well above white.
    expect(hh![0]! / hw![0]!).toBeGreaterThan(2.5);
  }, 240_000);

  it('writes HDR stills as cICP PNG and tagged AVIF, and refuses SDR-only formats', async () => {
    const png = join(dir, 'pq.png');
    await render({ entry: join(dir, 'still.ts'), output: png, hdr: 'pq' });
    const buf = readFileSync(png);
    const at = buf.indexOf('cICP');
    expect(at).toBeGreaterThan(0);
    expect(Array.from(buf.subarray(at + 4, at + 8))).toEqual([9, 16, 0, 1]);
    expect(buf[24]).toBe(16); // bit depth
    const avif = join(dir, 'hlg.avif');
    await render({ entry: join(dir, 'still.ts'), output: avif, hdr: 'hlg' });
    expect(tags(avif)).toBe('bt2020nc,arib-std-b67,bt2020');
    await expect(render({ entry: join(dir, 'still.ts'), output: join(dir, 'x.jpg'), hdr: 'pq' })).rejects.toThrow(/HDR stills/);
    await expect(render({ entry: join(dir, 'clip.ts'), output: join(dir, 'x.gif'), hdr: 'pq' })).rejects.toThrow(/HDR video/);
  }, 240_000);

  it('imports HDR video and float stills: kept above 1.0 in HDR, tone mapped for SDR', async () => {
    // pq.mp4 from the export test: white at 1.0, the highlight at ~5x.
    // A Radiance .hdr still at linear 3.0 (float formats are read as linear, 1.0 = reference white).
    const px = Buffer.alloc(8 * 8 * 4 * 3);
    for (let i = 0; i < px.length / 4; i++) px.writeFloatLE(3, i * 4);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'gbrpf32le', '-s', '8x8', '-i', '-', join(dir, 'bright.hdr')], { input: px });
    const source = `import { still, video, image } from 'tasweerix';
export default still({ width: 64, height: 72, background: '#000' }, (c) => {
  c.add(video('pq.mp4', { size: [64, 64], at: [32, 32] }));
  c.add(image('bright.hdr', { size: [64, 8], at: [32, 68] }));
});`;
    const hdr = (await renderFrames({ source, dir, frames: [0], hdr: true })).frames[0]!;
    expect(hdr.at(14, 32)[0]).toBeCloseTo(1, 1);
    const enc = (lin: number) => (lin <= 0.0031308 ? lin * 12.92 : 1.055 * lin ** (1 / 2.4) - 0.055);
    expect(Math.abs(hdr.at(46, 32)[0]! / 2 - 1)).toBeLessThan(0.05);
    expect(Math.abs(hdr.at(32, 68)[0]! / enc(3) - 1)).toBeLessThan(0.02);
    // SDR: highlights roll off below white instead of clipping flat, white stays near white.
    const sdr = (await renderFrames({ source, dir, frames: [0] })).frames[0]!;
    const [w, hi, still] = [sdr.at(14, 32)[0]!, sdr.at(46, 32)[0]!, sdr.at(32, 68)[0]!];
    expect(w).toBeGreaterThan(235);
    expect(hi).toBeGreaterThan(w);
    expect(still).toBeGreaterThan(w);
    expect(Math.max(hi, still)).toBeLessThanOrEqual(255);
  }, 240_000);
});
