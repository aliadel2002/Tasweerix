import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTestBrowser, renderFrames } from '../../cli/src/testing';
import { filterKinds, transitionKinds } from '../src';

const dir = join(__dirname, '.tmp');
const close = (a: number[], b: number[], tol = 6) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

beforeAll(() => {
  mkdirSync(dir, { recursive: true });
  // 2s, 30fps test video where frame N has gray level N*4 (frame-accuracy check).
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', "nullsrc=s=64x64:r=30:d=2,geq=lum='N*4':cb=128:cr=128", '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv444p', join(dir, 'ramp.mp4')]);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30:d=1', '-frames:v', '1', join(dir, 'image.png')]);
});
afterAll(closeTestBrowser);

const src = (body: string) => `import { composition, still, rect, ellipse, text, group, image, video, solid, keys, gradient, fx, transition, adjustment, comp, canvas } from 'tasweerix';\n${body}`;

describe('renderer (headless Chromium)', () => {
  it('draws shapes, positions and blend modes', async () => {
    const { frames } = await renderFrames({
      dir,
      frames: [0],
      source: src(`export default composition({ width: 200, height: 100, fps: 10, duration: 1, background: '#000000' }, (c) => {
        c.add(rect({ size: [100, 100], fill: '#ff0000', at: [50, 50] }));
        c.add(rect({ size: [100, 100], fill: '#00ff00', at: [150, 50], opacity: 0.5 }));
        c.add(rect({ size: [40, 40], fill: '#0000ff', at: [50, 50], blend: 'screen' }));
      });`),
    });
    const f = frames[0]!;
    expect(close(f.at(10, 10), [255, 0, 0, 255])).toBe(true);
    expect(close(f.at(150, 10), [0, 128, 0, 255])).toBe(true);
    expect(close(f.at(50, 50), [255, 0, 255, 255])).toBe(true);
  });

  it('animates with keyframes deterministically and out of order', async () => {
    const s = src(`export default composition({ width: 100, height: 100, fps: 10, duration: 2, background: '#000' }, (c) => {
      c.add(rect({ size: [100, 100], fill: '#ffffff', opacity: keys([[0, 0], [1, 1]]) }));
    });`);
    const { frames } = await renderFrames({ dir, frames: [10, 5, 0], source: s });
    expect(frames[0]!.at(50, 50)[0]).toBe(255);
    expect(Math.abs(frames[1]!.at(50, 50)[0] - 128)).toBeLessThanOrEqual(2);
    expect(frames[2]!.at(50, 50)[0]).toBe(0);
  });

  it('applies alpha and luma masks, nested comps and adjustment layers', async () => {
    const { frames } = await renderFrames({
      dir,
      frames: [0],
      source: src(`
      const inner = composition({ width: 50, height: 50, fps: 10, duration: 1, background: '#00ff00' }, () => {});
      export default composition({ width: 200, height: 100, fps: 10, duration: 1, background: '#000' }, (c) => {
        c.add(rect({ size: [100, 100], fill: '#ffffff', at: [50, 50] }).mask(rect({ size: [50, 100], at: [-25, 0] }), 'alpha'));
        c.add(comp(inner, { at: [150, 50] }));
        c.add(adjustment(fx.invert()));
      });`),
    });
    const f = frames[0]!;
    expect(close(f.at(10, 50), [0, 0, 0, 255])).toBe(true); // white masked in, then inverted
    expect(close(f.at(80, 50), [255, 255, 255, 255])).toBe(true); // masked out (black) then inverted
    expect(close(f.at(150, 50), [255, 0, 255, 255])).toBe(true); // nested green comp inverted
  });

  it('runs every registered filter', async () => {
    const kinds = filterKinds().filter((k) => !['lut', 'shader'].includes(k));
    const body = kinds.map((k, i) => `c.add(image('image.png', { at: [80, 45], start: ${i / 10}, duration: 0.1 }).filter(fx.custom('${k}')));`).join('\n');
    const { frames } = await renderFrames({
      dir,
      frames: kinds.map((_, i) => i),
      source: src(`export default composition({ width: 160, height: 90, fps: 10, duration: ${kinds.length / 10}, background: '#000' }, (c) => {\n${body}\n});`),
    });
    for (const f of frames) {
      let sum = 0;
      for (let i = 0; i < f.data.length; i += 4) sum += f.data[i]! + f.data[i + 1]! + f.data[i + 2]!;
      expect(sum).toBeGreaterThan(0);
    }
  });

  it('runs every transition', async () => {
    const kinds = transitionKinds();
    const body = kinds.map((k) => `transition.sequence([solid('#ff0000').lasting(1), solid('#0000ff').lasting(1)], { type: '${k}', duration: 1 })`).join(',\n');
    const { frames } = await renderFrames({
      dir,
      frames: kinds.map((_, i) => i * 10 + 3),
      source: src(`import { sequence } from 'tasweerix';\nexport default composition({ width: 64, height: 64, fps: 10, background: '#000' }, (c) => {
        c.add(sequence([${body}]));
      });`),
    });
    frames.forEach((f, i) => {
      let red = 0;
      let blue = 0;
      for (let p = 0; p < f.data.length; p += 4) {
        red += f.data[p]!;
        blue += f.data[p + 2]!;
      }
      expect(red + blue, kinds[i]).toBeGreaterThan(0);
    });
  });

  it('decodes exact video frames through the ffmpeg frame server', async () => {
    const { frames } = await renderFrames({
      dir,
      frames: [0, 1, 7, 30, 12, 59],
      source: src(`export default composition({ width: 64, height: 64, fps: 30, background: '#000' }, (c) => { c.add(video('ramp.mp4')); });`),
    });
    // Y = N*4 (limited range) → R = (Y - 16) * 255 / 219
    const ids = [0, 1, 7, 30, 12, 59];
    const toR = (n: number) => Math.max(0, Math.min(255, ((n * 4 - 16) * 255) / 219));
    frames.forEach((f, i) => expect(Math.abs(f.at(32, 32)[0] - toR(ids[i]!)), `frame ${ids[i]} got ${f.at(32, 32)[0]}`).toBeLessThanOrEqual(3));
  });

  it('renders LTR and RTL text', async () => {
    const { frames } = await renderFrames({
      dir,
      frames: [0],
      source: src(`export default composition({ width: 400, height: 200, fps: 10, duration: 1, background: '#000' }, (c) => {
        c.add(text('Hello', { size: 60, fill: '#fff', at: [200, 50], font: 'DejaVu Sans' }));
        c.add(text('مرحبا بالعالم', { size: 60, fill: '#fff', at: [200, 150], font: 'DejaVu Sans' }));
      });`),
    });
    const f = frames[0]!;
    const lit = (y0: number, y1: number) => {
      let n = 0;
      for (let y = y0; y < y1; y++) for (let x = 0; x < 400; x++) if (f.at(x, y)[0] > 128) n++;
      return n;
    };
    expect(lit(0, 100)).toBeGreaterThan(300);
    expect(lit(100, 200)).toBeGreaterThan(300);
  });
});
