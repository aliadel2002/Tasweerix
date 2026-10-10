import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gpuFlagSets, launchBrowser, webglRenderer } from '../src/browser';
import { render } from '../src/render';

/**
 * Renders the same frames with SwiftShader (the software fallback every export can use) and with
 * each GPU flag set export tries, and checks the pictures agree. On a machine with a GPU the flag
 * sets reach the hardware driver; on Linux without one they reach Mesa's llvmpipe / lavapipe if
 * installed, which still runs the same ANGLE backends (Vulkan, EGL). Backends that fall back to
 * SwiftShader are skipped. Set TASWEERIX_GPU_TEST=require to fail when no hardware GPU answered.
 */
const dir = join(__dirname, '.tmp-gpu');
mkdirSync(dir, { recursive: true });
const W = 480;
const H = 270;

writeFileSync(
  join(dir, 'filters.ts'),
  `import { composition, ellipse, fx, gradient, group, keys, rect, star, text, transition } from 'tasweerix';
export default composition({ width: ${W}, height: ${H}, fps: 30, duration: 3, background: '#0b1020' }, (c) => {
  const a = group(
    rect({ size: [${W}, ${H}], fill: gradient.linear([-${W / 2}, 0], [${W / 2}, 0], ['#ff3d6e', '#ffb03d']) }),
    text('Tasweerix', { size: 56, weight: 800, fill: '#fff' }).filter(fx.dropShadow({ blur: 6, offset: [4, 4] })),
  ).lasting(1.6);
  const b = group(
    rect({ size: [${W}, ${H}], fill: gradient.radial([0, 0], 260, ['#1d4ed8', '#020617']) }),
    star({ outerRadius: 80, innerRadius: 36, fill: '#fde047', rotation: keys([[0, 0], [3, 180]]) }).filter(fx.blur({ radius: 3 })),
  ).lasting(1.8);
  const ring = ellipse({ size: [70, 70], fill: null, stroke: '#fff', strokeWidth: 6, at: [420, 220] }).filter(fx.glow({ radius: 12, threshold: 0.3 }));
  c.add(group(transition.sequence([a, b], { type: 'wipe', duration: 0.6, angle: 30 }), ring)).filter(fx.grade({ contrast: 0.15, saturation: 0.2, temperature: 0.1 }), fx.chromaticAberration({ amount: 2 }), fx.vignette({ amount: 0.4 }));
});`,
);

writeFileSync(
  join(dir, 'scene.ts'),
  `import { box, camera3d, composition, layer3d, light, plane, rect, scene3d, sphere, text, torus, group } from 'tasweerix';
export default composition({ width: ${W}, height: ${H}, fps: 30, duration: 1, background: '#05070d' }, (c) => {
  const card = group(rect({ size: [640, 360], radius: 32, fill: '#f8fafc' }), text('3D', { size: 160, weight: 800, fill: '#0f172a' }));
  c.add(
    scene3d(
      { ambientIntensity: 0.3 },
      camera3d({ position: [3, 2.5, 6], target: [0, 0.5, 0], fov: 45 }),
      light.directional({ position: [4, 7, 5], intensity: 1.3, castShadow: true }),
      light.point({ position: [-3, 1.5, 2], color: '#38bdf8', intensity: 3, range: 8 }),
      plane({ size: [20, 20], rotation: [-90, 0, 0], position: [0, -0.6, 0], color: '#1e293b', roughness: 0.9 }),
      box({ size: [1, 1, 1], position: [-1.2, 0, 0], rotation: [0, 30, 0], color: '#22d3ee' }),
      sphere({ radius: 0.6, position: [0.6, 0, 0.6], color: '#f472b6', metalness: 0.6, roughness: 0.3 }),
      torus({ radius: 1.6, tube: 0.06, position: [0, 0.8, -0.8], rotation: [70, 0, 0], color: '#fbbf24', metalness: 1, roughness: 0.2 }),
      layer3d(card, { size: [1.6, 0.9], position: [1.8, 1.2, -1], rotation: [0, -25, 0] }),
    ),
  );
});`,
);

/** The frames to compare: [name, entry, frame, depth]. */
const FRAMES: [string, string, number, 8 | 16][] = [
  ['filters-a', 'filters.ts', 15, 8],
  ['filters-wipe', 'filters.ts', 48, 8],
  ['filters-b', 'filters.ts', 75, 8],
  ['filters-16bit', 'filters.ts', 48, 16],
  ['scene', 'scene.ts', 0, 8],
];

const rgb = (f: string) => execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);

/** PSNR (dB) and the share of pixels where some channel differs by more than 24 levels. */
export function compare(a: Buffer, b: Buffer): { psnr: number; outliers: number } {
  if (a.length !== b.length) throw new Error(`size mismatch: ${a.length} vs ${b.length}`);
  let se = 0;
  let out = 0;
  for (let i = 0; i < a.length; i += 3) {
    let worst = 0;
    for (let k = 0; k < 3; k++) {
      const d = a[i + k]! - b[i + k]!;
      se += d * d;
      worst = Math.max(worst, Math.abs(d));
    }
    if (worst > 24) out++;
  }
  const mse = se / a.length;
  return { psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse), outliers: out / (a.length / 3) };
}

async function renderAll(name: string, glFlags: string[]): Promise<{ renderer: string; files: Record<string, string> }> {
  mkdirSync(join(dir, name), { recursive: true });
  let renderer = '';
  const files: Record<string, string> = {};
  for (const [frame, entry, at, depth] of FRAMES) {
    const output = join(dir, name, `${frame}.png`);
    await render({ entry: join(dir, entry), output, still: at, depth, glFlags, concurrency: 1, log: (m) => {
        const r = /^WebGL on GPU: (.*)$|^WebGL in software \((.*)\): heavy/.exec(m);
        if (r) renderer = r[1] ?? r[2]!;
      } });
    files[frame] = output;
  }
  return { renderer, files };
}

describe('GPU export renders like the software renderer', () => {
  let baseline: { renderer: string; files: Record<string, string> };
  const backends: { flags: string[]; renderer: string; hardware: boolean }[] = [];

  beforeAll(async () => {
    baseline = await renderAll('swiftshader', []);
    for (const flags of gpuFlagSets()) {
      const b = await launchBrowser(flags).catch(() => undefined);
      const renderer = b ? await webglRenderer(b).catch(() => '') : '';
      await b?.close();
      if (renderer && !/swiftshader/i.test(renderer)) backends.push({ flags, renderer, hardware: !/llvmpipe|lavapipe|softpipe|software/i.test(renderer) });
    }
  }, 600_000);

  afterAll(() => {
    // eslint-disable-next-line no-console
    console.log(`GPU parity: baseline ${baseline?.renderer}; compared ${backends.map((b) => b.renderer).join(', ') || 'nothing (no GL backend besides SwiftShader)'}`);
  });

  it('compares itself sensibly', () => {
    const a = Buffer.from([10, 20, 30, 200, 200, 200]);
    expect(compare(a, a)).toEqual({ psnr: Infinity, outliers: 0 });
    const b = Buffer.from([10, 20, 30, 200, 160, 200]);
    expect(compare(a, b).outliers).toBe(0.5);
    expect(compare(a, b).psnr).toBeCloseTo(10 * Math.log10((255 * 255 * 6) / 1600), 6);
  });

  it('renders the test frames in software', () => {
    expect(baseline.renderer).toMatch(/swiftshader/i);
    for (const f of Object.values(baseline.files)) expect(rgb(f).length).toBe(W * H * 3);
  });

  it('matches on every other GL backend', async (ctx) => {
    if (process.env.TASWEERIX_GPU_TEST === 'require') expect(backends.filter((b) => b.hardware).map((b) => b.renderer), 'no hardware GPU answered').not.toEqual([]);
    if (!backends.length) ctx.skip();
    const report: string[] = [];
    for (const b of backends) {
      const name = b.flags.find((f) => f.startsWith('--use-angle='))!.slice('--use-angle='.length);
      const got = await renderAll(name, b.flags);
      expect(got.renderer).toBe(b.renderer);
      for (const [frame, file] of Object.entries(got.files)) {
        const { psnr, outliers } = compare(rgb(baseline.files[frame]!), rgb(file));
        report.push(`${b.renderer} ${frame}: ${psnr.toFixed(1)} dB, ${(outliers * 100).toFixed(2)}% pixels off`);
        if (psnr < 32 || outliers > 0.01) {
          execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', baseline.files[frame]!, '-i', file, '-filter_complex', 'blend=all_mode=difference,eq=brightness=0.1:contrast=4', join(dir, name, `${frame}-diff.png`)]);
        }
        expect.soft(psnr, `${frame} on ${b.renderer} (diff image in ${join(dir, name)})`).toBeGreaterThanOrEqual(32);
        expect.soft(outliers, `${frame} on ${b.renderer}`).toBeLessThanOrEqual(0.01);
      }
    }
    // eslint-disable-next-line no-console
    console.log(report.join('\n'));
  }, 600_000);
});
