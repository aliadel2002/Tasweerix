import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRandom, usePlugin, video } from '@tasweerix/core';
import { nodeEnv } from '@tasweerix/media/node';
import { closeTestBrowser, renderFrames } from '../../cli/src/testing';
import { trackPlane, pinToPlane, planePoint, planeCornersAt, type Quad, analyzeMotion, applyMediaTransform, estimateReadout, fitSimilarityShear, rowShifts, follow, pointAt, computeStabilization, correctionAt, decompose, fitSimilarity, goodFeatures, gray, invert, compose, apply, ransacSimilarity, stabilize, trackPoint, zoomToCover, fitHomography, ransacHomography, happly, hcompose, hinvert, hscale, fromSimilarity, H_IDENTITY, type Homography, type MotionData, type Similarity } from '../src';
import { visionPlugin } from '../src/node';

const dir = join(__dirname, '.tmp');
const env = nodeEnv(dir);
const ff = (...a: string[]) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...a]);

// Known handheld-style shake: the crop window wanders, so the content moves the opposite way.
const jx = (n: number) => Math.round(160 + 20 * Math.sin(n * 0.7) + 8 * Math.sin(n * 2.3));
const jy = (n: number) => Math.round(100 + 14 * Math.cos(n * 1.1));
// Rolling-shutter footage: continuous shake sampled per row.
const RS_READOUT = 0.8;
const rsx = (t: number) => 150 + 20 * Math.sin(t * 0.5) + 6 * Math.sin(t * 1.2);
const rsy = (t: number) => 90 + 14 * Math.cos(t * 0.7);
// Planar footage: a textured card seen in changing perspective over a slowly panning background.
const planeQuad = (n: number): Quad => {
  const cx = 110 + n * 1.6;
  const cy = 95 + 12 * Math.sin(n * 0.12);
  const k = 0.25 * Math.sin(n * 0.09); // the card turns: its left and right edges change height
  const w = 60 + 8 * Math.cos(n * 0.07);
  return [
    [cx - w, cy - 42 * (1 + k) + 0.15 * n],
    [cx + w, cy - 42 * (1 - k)],
    [cx + w + 6 * Math.sin(n * 0.1), cy + 42 * (1 - k)],
    [cx - w, cy + 42 * (1 + k) - 0.1 * n],
  ];
};

beforeAll(() => {
  usePlugin(visionPlugin);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  ff('-f', 'lavfi', '-i', 'testsrc2=s=640x400:d=1', '-frames:v', '1', join(dir, 'still.png'));
  ff('-loop', '1', '-framerate', '30', '-i', join(dir, 'still.png'), '-vf', `crop=320:200:'160+20*sin(n*0.7)+8*sin(n*2.3)':'100+14*cos(n*1.1)'`, '-t', '2', '-r', '30', '-pix_fmt', 'yuv444p', '-c:v', 'libx264', '-qp', '0', join(dir, 'shaky.mp4'));
  // Rotation jitter around the center (cropped so no black corners enter the frame).
  ff('-loop', '1', '-framerate', '30', '-i', join(dir, 'still.png'), '-vf', `rotate=a='0.03*sin(n*0.9)':c=black,crop=320:200`, '-t', '1', '-r', '30', '-pix_fmt', 'yuv444p', '-c:v', 'libx264', '-qp', '0', join(dir, 'rotating.mp4'));
  // Keystone wobble: the top and bottom edges of the view swing in depth (a camera tilting and
  // turning), which no similarity can undo. The enlarged source keeps borders out of the crop.
  ff('-loop', '1', '-framerate', '30', '-i', join(dir, 'still.png'), '-vf', `scale=960:600,perspective=x0='36*sin(in*0.8)':y0='24*sin(in*1.1)':x1='W-36*sin(in*0.8)':y1='-24*sin(in*1.1)':x2='-36*sin(in*0.8)':y2='H+24*sin(in*1.1)':x3='W+36*sin(in*0.8)':y3='H-24*sin(in*1.1)':eval=frame,crop=480:300,scale=320:200`, '-t', '2', '-r', '30', '-pix_fmt', 'yuv444p', '-c:v', 'libx264', '-qp', '0', join(dir, 'keystone.mp4'));
  // Rolling shutter: the same kind of shake, but each row is read 0.8 frame intervals × its height
  // later than the top one, so rows land at different crop offsets (skew and jello).
  const still = execFileSync('ffmpeg', ['-v', 'error', '-i', join(dir, 'still.png'), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 });
  const rsFrames = Buffer.alloc(60 * 320 * 200 * 3);
  for (let n = 0; n < 60; n++) {
    for (let y = 0; y < 200; y++) {
      const tau = n + RS_READOUT * (y / 200 - 0.5);
      const ox = rsx(tau);
      const oy = rsy(tau) + y;
      const y0 = Math.floor(oy);
      const fy = oy - y0;
      for (let x = 0; x < 320; x++) {
        const sx = ox + x;
        const x0 = Math.floor(sx);
        const fx = sx - x0;
        for (let ch = 0; ch < 3; ch++) {
          const at = (xx: number, yy: number) => still[(yy * 640 + xx) * 3 + ch]!;
          const v = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
          rsFrames[((n * 200 + y) * 320 + x) * 3 + ch] = Math.round(v);
        }
      }
    }
  }
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '320x200', '-r', '30', '-i', '-', '-pix_fmt', 'yuv444p', '-c:v', 'libx264', '-qp', '0', join(dir, 'rolling.mp4')], { input: rsFrames });
  {
    // Card texture: random 8 px blocks (plenty of corners).
    const rnd = createRandom(3);
    const tex = Array.from({ length: 16 * 16 }, () => Math.round(rnd() * 255));
    const unit: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const buf = Buffer.alloc(60 * 320 * 200 * 3);
    for (let n = 0; n < 60; n++) {
      const inv = hinvert(fitHomography(unit, planeQuad(n))!);
      for (let y = 0; y < 200; y++) {
        for (let x = 0; x < 320; x++) {
          const [u, v] = happly(inv, [x + 0.5, y + 0.5]);
          const o = ((n * 200 + y) * 320 + x) * 3;
          if (u >= 0 && u < 1 && v >= 0 && v < 1) {
            const t = tex[Math.floor(v * 16) * 16 + Math.floor(u * 16)]!;
            buf[o] = t;
            buf[o + 1] = 255 - t;
            buf[o + 2] = (t * 3) % 256;
          } else {
            const sx = Math.min(639, x + 100 + Math.round(n * 0.5));
            for (let ch = 0; ch < 3; ch++) buf[o + ch] = still[((y + 100) * 640 + sx) * 3 + ch]!;
          }
        }
      }
    }
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '320x200', '-r', '30', '-i', '-', '-pix_fmt', 'yuv444p', '-c:v', 'libx264', '-qp', '0', join(dir, 'plane.mp4')], { input: buf });
    ff('-f', 'lavfi', '-i', 'color=c=red:s=64x48', '-frames:v', '1', join(dir, 'red.png'));
  }
  // A textured patch moving over a plain background.
  ff('-f', 'lavfi', '-i', 'color=c=0x404040:s=320x200:d=2:r=30', '-i', join(dir, 'still.png'), '-filter_complex', `[1]crop=40:40:420:260[p];[0][p]overlay=x='40+t*60':y='80+20*sin(t*3)'`, '-t', '2', '-pix_fmt', 'yuv444p', '-c:v', 'libx264', '-qp', '0', join(dir, 'moving.mp4'));
});
afterAll(closeTestBrowser);

describe('vision math', () => {
  it('fits similarities exactly and robustly', () => {
    const truth: Similarity = [Math.cos(0.1) * 1.05, Math.sin(0.1) * 1.05, 12, -7];
    const src = Array.from({ length: 40 }, (_, i) => [((i * 37) % 100) - 50, ((i * 53) % 80) - 40] as [number, number]);
    const dst = src.map((p) => apply(truth, p));
    expect(fitSimilarity(src, dst)!.map((v) => +v.toFixed(6))).toEqual(truth.map((v) => +v.toFixed(6)));
    // 30 % outliers.
    const noisy = dst.map((p, i) => (i % 3 === 0 ? ([p[0] + 40, p[1] - 25] as [number, number]) : p));
    const r = ransacSimilarity(src, noisy)!;
    expect(r.inliers).toBe(26);
    r.model.forEach((v, i) => expect(v).toBeCloseTo(truth[i]!, 5));
    const back = compose(invert(truth), truth);
    back.forEach((v, i) => expect(v).toBeCloseTo([1, 0, 0, 0][i]!, 9));
  });

  it('finds corners on texture and none on flat images', () => {
    const img = gray(64, 64);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) img.data[y * 64 + x] = (x >> 3) % 2 ^ (y >> 3) % 2 ? 230 : 20;
    const pts = goodFeatures(img, { max: 100, minDistance: 4 });
    expect(pts.length).toBeGreaterThan(20);
    // Checkerboard corners sit on multiples of 8.
    for (const p of pts) expect(Math.min(p[0] % 8, 8 - (p[0] % 8)) + Math.min(p[1] % 8, 8 - (p[1] % 8))).toBeLessThanOrEqual(2);
    expect(goodFeatures(gray(64, 64))).toHaveLength(0);
  });

  it('computes the zoom that hides moved edges', () => {
    expect(zoomToCover([1, 0, 0.05, 0], 0.5625)).toBeCloseTo(0.5 / 0.45, 6);
    expect(zoomToCover([1, 0, 0, 0], 0.5625)).toBe(1);
    // A rotation needs some zoom too.
    expect(zoomToCover([Math.cos(0.05), Math.sin(0.05), 0, 0], 0.5625)).toBeGreaterThan(1.02);
  });

  it('locks a shaking camera path and smooths a pan', () => {
    const n = 60;
    const W = 320;
    const shake = (i: number) => 6 * Math.sin(i * 1.3);
    // Pan of 2 px/frame plus shake, translation only.
    const motions: Similarity[] = Array.from({ length: n }, (_, i) => (i === 0 ? [1, 0, 0, 0] : [1, 0, 2 + shake(i) - shake(i - 1), 0]));
    const m: MotionData = { version: 1, width: W, height: 180, fps: 30, start: 0, motions, inliers: motions.map(() => 100) };
    // Position of frame-0 point (0,0) in each frame, after correction, in pixels.
    const corrected = (d: ReturnType<typeof computeStabilization>, i: number) => {
      let x = 0;
      for (let k = 1; k <= i; k++) x += motions[k]![2];
      return apply(d.frames[i] as Similarity, [x / W, 0])[0] * W;
    };
    const lock = computeStabilization(m, { mode: 'lock', crop: 'none' });
    const lockX = Array.from({ length: n }, (_, i) => corrected(lock, i));
    expect(Math.max(...lockX) - Math.min(...lockX)).toBeLessThan(0.01);
    const smooth = computeStabilization(m, { smoothing: 1, crop: 'none' });
    const sm = Array.from({ length: n }, (_, i) => corrected(smooth, i));
    // The pan survives, the shake (6 px) is mostly gone in the middle of the clip.
    const steps = sm.slice(16, 44).map((v, i, a) => (i ? v - a[i - 1]! : 2));
    for (const s of steps) expect(Math.abs(s - 2)).toBeLessThan(1);
    const auto = computeStabilization(m, { mode: 'lock' });
    expect(auto.zoom).toBeGreaterThan(1);
    expect(auto.zoom).toBeLessThanOrEqual(1.3);
    expect(correctionAt(auto, 0.5)).toEqual(auto.frames[15]);
  });
});

describe('perspective math', () => {
  const truth: Homography = [1.02, 0.03, 4, -0.02, 0.98, -3, 0.0004, -0.0003, 1];
  const src = Array.from({ length: 40 }, (_, i) => [((i * 37) % 200) - 100, ((i * 53) % 120) - 60] as [number, number]);

  it('fits homographies exactly and robustly', () => {
    const dst = src.map((p) => happly(truth, p));
    fitHomography(src, dst)!.forEach((v, i) => expect(v).toBeCloseTo(truth[i]!, 8));
    const noisy = dst.map((p, i) => (i % 4 === 0 ? ([p[0] + 30, p[1] - 20] as [number, number]) : p));
    const r = ransacHomography(noisy.map((_, i) => src[i]!), noisy)!;
    expect(r.inliers).toBe(30);
    r.model.forEach((v, i) => expect(v).toBeCloseTo(truth[i]!, 7));
    hcompose(hinvert(truth), truth).forEach((v, i) => expect(v).toBeCloseTo(H_IDENTITY[i]!, 9));
    // Pixel ↔ width units.
    const n = hscale(truth, 320);
    const p = happly(truth, [64, -32]);
    const q = happly(n, [0.2, -0.1]);
    expect(q[0] * 320).toBeCloseTo(p[0], 8);
    expect(q[1] * 320).toBeCloseTo(p[1], 8);
  });

  it('computes the zoom that hides perspective edges', () => {
    const s: Similarity = [Math.cos(0.04) * 1.01, Math.sin(0.04) * 1.01, 0.02, -0.01];
    expect(zoomToCover(fromSimilarity(s), 0.5625)).toBeCloseTo(zoomToCover(s, 0.5625), 9);
    // Keystone: the far edge shrinks, so some zoom is needed even without any shift.
    expect(zoomToCover([1, 0, 0, 0, 1, 0, 0, 0.3, 1], 0.5625)).toBeGreaterThan(1.05);
  });

  it('locks a perspective-shaking camera path', () => {
    const n = 40;
    const W = 320;
    // Frame-to-frame homographies (pixels): keystone and shift jitter.
    const k = (i: number): Homography => [1, 0.01 * Math.sin(i), 3 * Math.sin(i * 1.3), 0, 1, 2 * Math.cos(i * 0.7), 0.00008 * Math.sin(i * 0.9), 0.0001 * Math.cos(i * 1.7), 1];
    const hs = Array.from({ length: n }, (_, i) => (i === 0 ? H_IDENTITY : hcompose(k(i), hinvert(k(i - 1)))));
    const m: MotionData = { version: 1, width: W, height: 180, fps: 30, start: 0, motions: hs.map(() => [1, 0, 0, 0] as Similarity), inliers: hs.map(() => 100), homographies: hs };
    const d = computeStabilization(m, { mode: 'lock', crop: 'none', model: 'perspective' });
    expect(d.frames[0]).toHaveLength(9);
    // corrected ∘ path is the same transform for every frame: the view no longer moves.
    let path = H_IDENTITY;
    const views = hs.map((h, i) => {
      if (i) path = hcompose(hscale(h, W), path);
      return hcompose(d.frames[i] as Homography, path);
    });
    for (const v of views) for (const p of [[-0.5, -0.28], [0.5, 0.28], [0.1, -0.2]] as [number, number][]) {
      const a = happly(v, p);
      const b = happly(views[0]!, p);
      expect(Math.hypot(a[0] - b[0], a[1] - b[1]) * W).toBeLessThan(0.01);
    }
    expect(() => computeStabilization({ ...m, homographies: undefined }, { model: 'perspective' })).toThrow(/perspective/);
    const auto = computeStabilization(m, { mode: 'lock', model: 'perspective' });
    expect(auto.zoom).toBeGreaterThan(1);
    expect(auto.zoom).toBeLessThanOrEqual(1.3);
  });
});

describe('rolling-shutter math', () => {
  it('fits similarity with row shear exactly', () => {
    const src = Array.from({ length: 30 }, (_, i) => [((i * 37) % 200) - 100, ((i * 53) % 120) - 60] as [number, number]);
    const [a, b, tx, ty, wx, wy] = [1.01, 0.02, 3, -2, 4, -1.5];
    const dst = src.map(([x, y]) => [a * x - b * y + tx + (wx * y) / 120, b * x + a * y + ty + (wy * y) / 120] as [number, number]);
    const f = fitSimilarityShear(src, dst, 120)!;
    [a, b, tx, ty].forEach((v, i) => expect(f.model[i]).toBeCloseTo(v, 9));
    expect(f.shear[0]).toBeCloseTo(wx, 9);
    expect(f.shear[1]).toBeCloseTo(wy, 9);
  });

  it('estimates the readout and corrects rows', () => {
    // Image velocity v(t) sampled per frame interval; shear predicted for a readout of 0.6.
    const vx = (k: number) => 8 * Math.sin(k * 0.8);
    const n = 40;
    const motions: Similarity[] = Array.from({ length: n }, (_, k) => (k ? [1, 0, vx(k), 0] : [1, 0, 0, 0]));
    const shear = motions.map((_, k) => [k > 0 && k < n - 1 ? (0.6 * (vx(k + 1) - vx(k - 1))) / 2 : 0, 0] as [number, number]);
    const m: MotionData = { version: 1, width: 320, height: 180, fps: 30, start: 0, motions, inliers: motions.map(() => 100), shear };
    expect(estimateReadout(m)).toBeCloseTo(0.6, 6);
    expect(estimateReadout({ ...m, shear: undefined })).toBe(0);
    const rows = rowShifts(m, 0.6);
    // Frame 10: a row half a frame below the center was read 0.3 intervals later.
    const expected = (0.3 * (vx(10) + vx(11))) / 2 + (0.09 * (vx(11) - vx(10))) / 2;
    expect((rows[10]![0] * 0.5 + rows[10]![2] * 0.25) * 320).toBeCloseTo(expected, 6);
    const d = computeStabilization(m, { mode: 'lock', crop: 'none', rollingShutter: 'auto' });
    expect(d.readout).toBeCloseTo(0.6, 3);
    const xf = correctionAt(d, 10 / 30);
    expect(xf).toMatchObject({ aspect: 180 / 320 });
    // The center row is untouched by the row correction; the bottom row moves back by its shift.
    const plain = d.frames[10]!;
    expect(applyMediaTransform(xf, [0.1, 0])).toEqual(applyMediaTransform(plain, [0.1, 0]));
    const bottom = applyMediaTransform(xf, [0.1, 0.28125]);
    const shifted = applyMediaTransform(plain, [0.1 - (rows[10]![0] * 0.5 + rows[10]![2] * 0.25), 0.28125]);
    expect(bottom[0]).toBeCloseTo(shifted[0], 6);
    expect(() => computeStabilization({ ...m, shear: undefined }, { rollingShutter: 'auto' })).toThrow(/rollingShutter/);
    // A fixed readout needs no shear data.
    expect(computeStabilization({ ...m, shear: undefined }, { rollingShutter: 0.5 }).readout).toBe(0.5);
  });
});

describe('motion analysis (ffmpeg + pure TypeScript)', () => {
  it('measures frame-to-frame shake to sub-pixel accuracy', async () => {
    const m = await analyzeMotion('shaky.mp4', {}, env);
    expect(m.width).toBe(320);
    expect(m.motions).toHaveLength(60);
    let worst = 0;
    for (let n = 1; n < 60; n++) {
      const d = decompose(m.motions[n]!);
      worst = Math.max(worst, Math.abs(d.x - -(jx(n) - jx(n - 1))), Math.abs(d.y - -(jy(n) - jy(n - 1))));
      expect(Math.abs(d.angle)).toBeLessThan(0.003);
    }
    expect(worst).toBeLessThan(0.35);
  });

  it('measures rotation', async () => {
    const m = await analyzeMotion('rotating.mp4', {}, env);
    for (let n = 1; n < m.motions.length; n++) {
      const d = decompose(m.motions[n]!);
      // ffmpeg's rotate is clockwise for positive angles in image coordinates (y down): same sign as ours.
      expect(Math.abs(d.angle - 0.03 * (Math.sin(n * 0.9) - Math.sin((n - 1) * 0.9)))).toBeLessThan(0.002);
    }
  });

  it('caches analyses and stabilizes a node', async () => {
    const t0 = Date.now();
    await analyzeMotion('shaky.mp4', {}, env);
    expect(Date.now() - t0).toBeLessThan(500);
    const v = await stabilize(video('shaky.mp4'), { mode: 'lock' }, env);
    expect(v.meta.stabilization).toMatchObject({ frames: 60 });
    expect(v.mediaTransform!(1)).toHaveLength(4);
  });

  it('tracks a moving patch', async () => {
    const tr = await trackPoint('moving.mp4', { at: [60, 100], time: 0, from: 0, to: 2 }, env);
    expect(tr.points.length).toBeGreaterThanOrEqual(59);
    let worst = 0;
    tr.points.forEach((p, i) => {
      const t = tr.start + i / tr.fps;
      worst = Math.max(worst, Math.hypot(p[0] - (60 + 60 * t), p[1] - (100 + 20 * Math.sin(3 * t))));
    });
    expect(worst).toBeLessThan(2.5);
    expect(tr.lost.filter(Boolean)).toHaveLength(0);
    // follow(): a child of a video trimmed at 0.5 s and shown at 2× sits on the point.
    const v = video('moving.mp4', { trim: [0.5, 2], size: [640, 400] });
    await v.prepare(env);
    const at = follow(v, tr)({ time: 0.5 } as never);
    const p = pointAt(tr, 1);
    expect(at[0]).toBeCloseTo(-320 + p[0] * 2, 6);
    expect(at[1]).toBeCloseTo(-200 + p[1] * 2, 6);
  });
});

describe('stabilized rendering (headless Chromium)', () => {
  it('locked footage holds still on screen', async () => {
    const src = (lock: boolean) => `import { composition, video, stabilize } from 'tasweerix';
export default composition({ width: 320, height: 200, fps: 30, duration: 2, background: '#000' }, async (c) => {
  const v = video('shaky.mp4', { size: [320, 200] });
  c.add(${lock ? "await stabilize(v, { mode: 'lock', crop: 1.25 })" : 'v'});
});`;
    const frames = [3, 11, 20, 37, 52];
    const diff = (a: { at(x: number, y: number): number[] }, b: { at(x: number, y: number): number[] }) => {
      let d = 0;
      let n = 0;
      for (let y = 60; y < 140; y += 2) {
        for (let x = 100; x < 220; x += 2) {
          const p = a.at(x, y);
          const q = b.at(x, y);
          d += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
          n += 3;
        }
      }
      return d / n;
    };
    const raw = await renderFrames({ dir, root: dir, frames, source: src(false) });
    const st = await renderFrames({ dir, root: dir, frames, source: src(true) });
    const rawDiff = frames.slice(1).map((_, i) => diff(raw.frames[0]!, raw.frames[i + 1]!));
    const stDiff = frames.slice(1).map((_, i) => diff(st.frames[0]!, st.frames[i + 1]!));
    // Shaky frames differ (by 4–85 levels on this pattern); locked ones only by resampling noise.
    for (const d of rawDiff) expect(d).toBeGreaterThan(2);
    expect(Math.max(...rawDiff)).toBeGreaterThan(20);
    for (const d of stDiff) expect(d).toBeLessThan(0.5);
  });
});

describe('perspective stabilization (headless Chromium)', () => {
  it('measures keystone wobble and removes it on screen', async () => {
    const sim = await analyzeMotion('keystone.mp4', {}, env);
    const per = await analyzeMotion('keystone.mp4', { model: 'perspective' }, env);
    expect(sim.homographies).toBeUndefined();
    expect(per.homographies).toHaveLength(60);
    // Most frames carry a measured perspective change (not the similarity fallback).
    expect(per.homographies!.filter((h) => Math.abs(h[6]) + Math.abs(h[7]) > 1e-6).length).toBeGreaterThan(50);
    const src = (o: string) => `import { composition, video, stabilize } from 'tasweerix';
export default composition({ width: 320, height: 200, fps: 30, duration: 2, background: '#000' }, async (c) => {
  const v = video('keystone.mp4', { size: [320, 200] });
  c.add(${o ? `await stabilize(v, ${o})` : 'v'});
});`;
    const frames = [3, 11, 20, 37, 52];
    const diff = (a: { at(x: number, y: number): number[] }, b: { at(x: number, y: number): number[] }) => {
      let d = 0;
      let n = 0;
      for (let y = 40; y < 160; y += 2) {
        for (let x = 60; x < 260; x += 2) {
          const p = a.at(x, y);
          const q = b.at(x, y);
          d += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
          n += 3;
        }
      }
      return d / n;
    };
    const spread = async (o: string) => {
      const r = await renderFrames({ dir, root: dir, frames, source: src(o) });
      return frames.slice(1).map((_, i) => diff(r.frames[0]!, r.frames[i + 1]!));
    };
    const raw = await spread('');
    const simDiff = await spread("{ mode: 'lock', crop: 1.25 }");
    const perDiff = await spread("{ mode: 'lock', crop: 1.25, model: 'perspective' }");
    // The raw view wobbles; a similarity lock cannot undo keystone (it even drifts further); the
    // perspective lock holds the picture still up to resampling noise.
    expect(Math.max(...raw)).toBeGreaterThan(2.5);
    expect(Math.max(...simDiff)).toBeGreaterThan(4);
    for (const d of perDiff) expect(d).toBeLessThan(1);
  });
});

describe('rolling-shutter stabilization (headless Chromium)', () => {
  it('estimates the readout and removes skew and wobble on screen', async () => {
    const m = await analyzeMotion('rolling.mp4', { rollingShutter: true }, env);
    expect(m.shear).toHaveLength(60);
    const r = estimateReadout(m);
    // True readout 0.8; the frame-level velocity model reads fast shake slightly high.
    expect(r).toBeGreaterThan(0.65);
    expect(r).toBeLessThan(1);
    const src = (o: string) => `import { composition, video, stabilize } from 'tasweerix';
export default composition({ width: 320, height: 200, fps: 30, duration: 2, background: '#000' }, async (c) => {
  const v = video('rolling.mp4', { size: [320, 200] });
  c.add(${o ? `await stabilize(v, ${o})` : 'v'});
});`;
    const frames = [3, 11, 20, 37, 52];
    const diff = (a: { at(x: number, y: number): number[] }, b: { at(x: number, y: number): number[] }) => {
      let d = 0;
      let n = 0;
      for (let y = 30; y < 170; y += 2) {
        for (let x = 60; x < 260; x += 2) {
          const p = a.at(x, y);
          const q = b.at(x, y);
          d += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
          n += 3;
        }
      }
      return d / n;
    };
    const spread = async (o: string) => {
      const res = await renderFrames({ dir, root: dir, frames, source: src(o) });
      return frames.slice(1).map((_, i) => diff(res.frames[0]!, res.frames[i + 1]!));
    };
    const raw = await spread('');
    const plain = await spread("{ mode: 'lock', crop: 1.25 }");
    const rs = await spread("{ mode: 'lock', crop: 1.25, rollingShutter: 'auto' }");
    // Without row correction the lock still skews and wobbles; with it, only small drift remains.
    expect(Math.max(...raw)).toBeGreaterThan(30);
    expect(Math.max(...plain)).toBeGreaterThan(10);
    expect(Math.max(...rs)).toBeLessThan(5);
  });
});

describe('planar tracking', () => {
  it('follows a plane in perspective and pins a picture to it', async () => {
    const pl = await trackPlane('plane.mp4', { corners: planeQuad(0), time: 0, from: 0, to: 2 }, env);
    expect(pl.corners).toHaveLength(60);
    expect(pl.lost.filter(Boolean)).toHaveLength(0);
    let worst = 0;
    pl.corners.forEach((q, n) => q.forEach((p, c) => (worst = Math.max(worst, Math.hypot(p[0] - planeQuad(n)[c]![0], p[1] - planeQuad(n)[c]![1])))));
    // Under 2.5 px everywhere (the frame-to-frame estimate is refined against the reference frame, so it does not drift).
    expect(worst).toBeLessThan(2.5);
    // Tracking from a later reference frame works backwards too.
    const back = await trackPlane('plane.mp4', { corners: planeQuad(45), time: 1.5, from: 0, to: 2 }, env);
    back.corners[5]!.forEach((p, c) => expect(Math.hypot(p[0] - planeQuad(5)[c]![0], p[1] - planeQuad(5)[c]![1])).toBeLessThan(2.5));
    // Any point of the plane follows it (here the card's center at frame 0 → its center later).
    const mid = (q: Quad): [number, number] => happly(fitHomography([[0, 0], [1, 0], [1, 1], [0, 1]], q)!, [0.5, 0.5]);
    const c = planePoint(pl, mid(planeQuad(0)));
    const p40 = c.points[40]!;
    expect(Math.hypot(p40[0] - mid(planeQuad(40))[0], p40[1] - mid(planeQuad(40))[1])).toBeLessThan(1.5);
    expect(planeCornersAt(pl, 40 / 30)).toEqual(pl.corners[40]);
    // pinToPlane maps the corners into the video's box (here shown at 2×, centered).
    const v = video('plane.mp4', { size: [640, 400] });
    await v.prepare(env);
    const q = pinToPlane(v, pl)({ time: 40 / 30 } as never);
    expect(q[0][0]).toBeCloseTo(-320 + pl.corners[40]![0]![0] * 2, 6);
    expect(q[2][1]).toBeCloseTo(-200 + pl.corners[40]![2]![1] * 2, 6);

    const src = `import { composition, video, image, pinToPlane, trackPlane } from 'tasweerix';
export default composition({ width: 320, height: 200, fps: 30, duration: 2, background: '#000' }, async (c) => {
  const v = video('plane.mp4', { size: [320, 200] });
  const plane = await trackPlane('plane.mp4', { corners: ${JSON.stringify(planeQuad(0))}, time: 0, from: 0, to: 2 });
  v.add(image('red.png', { cornerPin: pinToPlane(v, plane) }));
  c.add(v);
});`;
    const frames = [10, 40];
    const r = await renderFrames({ dir, root: dir, frames, source: src });
    frames.forEach((n, i) => {
      const f = r.frames[i]!;
      const quad = planeQuad(n);
      // Inside the card (pulled 15 % toward its center): red. Outside: the original footage.
      const center = mid(quad);
      for (const p of [center, ...quad.map((p) => [p[0] + (center[0] - p[0]) * 0.15, p[1] + (center[1] - p[1]) * 0.15])]) {
        const px = f.at(Math.round(p[0]!), Math.round(p[1]!));
        expect(px[0]).toBeGreaterThan(200);
        expect(px[1]).toBeLessThan(60);
      }
      for (const p of quad.map((p) => [p[0] + (p[0] - center[0]) * 0.2, p[1] + (p[1] - center[1]) * 0.2])) {
        const px = f.at(Math.round(p[0]!), Math.round(p[1]!));
        expect(px[0] > 200 && px[1] < 60 && px[2] < 60).toBe(false);
      }
    });
  });
});

describe('stabilize command', () => {
  it('renders a stabilized copy through the CLI', () => {
    const bin = join(__dirname, '../../cli/bin/tasweerix.mjs');
    const out = execFileSync(process.execPath, [bin, 'stabilize', 'shaky.mp4', '--mode', 'lock', '-o', 'shaky.locked.mp4'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    void out;
    const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height', '-of', 'json', join(dir, 'shaky.locked.mp4')]).toString());
    expect(info.streams[0]).toMatchObject({ width: 320, height: 200 });
    expect(Number(info.format.duration)).toBeCloseTo(2, 1);
    execFileSync(process.execPath, [bin, 'stabilize', 'keystone.mp4', '--mode', 'lock', '--model', 'perspective', '-o', 'keystone.locked.mp4'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    const info2 = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', join(dir, 'keystone.locked.mp4')]).toString());
    expect(info2.streams[0]).toMatchObject({ width: 320, height: 200 });
    const out3 = spawnSync(process.execPath, [bin, 'stabilize', 'rolling.mp4', '--rolling-shutter', 'auto', '-o', 'rolling.steady.mp4'], { cwd: dir, encoding: 'utf8' });
    expect(out3.status).toBe(0);
    expect(out3.stdout + out3.stderr).toMatch(/rolling shutter: estimated readout \d+%/);
    const q = planeQuad(0).flat().map((v) => v.toFixed(1)).join(',');
    const out4 = execFileSync(process.execPath, [bin, 'track', 'plane.mp4', '--corners', q, '--to', '1', '--every', '10'], { cwd: dir, encoding: 'utf8' });
    expect(out4).toMatch(/const plane = keys\(\[/);
    expect(out4.match(/^  \[/gm)).toHaveLength(3);
  });
});
