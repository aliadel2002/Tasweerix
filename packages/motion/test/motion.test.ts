import { afterAll, describe, expect, it } from 'vitest';
import { interpolate, makeContext, parsePath, pathBounds, rect, star, text } from '@tasweerix/core';
import { counter, enterFx, exitFx, followPath, morph, morphPaths, particles, repeat, scramble } from '../src';
import { closeTestBrowser, renderFrames } from '../../cli/src/testing';
import { join } from 'node:path';

afterAll(closeTestBrowser);
const ctx = (time: number) => makeContext({ time, fps: 30, width: 100, height: 100 });
const SQUARE = 'M-50 -50 L50 -50 L50 50 L-50 50 Z';
const CIRCLE = 'M0 -50 A50 50 0 1 1 0 50 A50 50 0 1 1 0 -50 Z';

describe('morphing', () => {
  it('interpolates between unrelated paths', () => {
    const mid = morphPaths(SQUARE, CIRCLE, 0.5);
    const b = pathBounds(parsePath(mid));
    expect(b.width).toBeGreaterThan(95);
    expect(b.width).toBeLessThan(101);
    // registered as a global interpolator for path tracks
    expect(interpolate(SQUARE, CIRCLE, 0.5)).toBe(mid);
    const tr = morph([SQUARE, CIRCLE, SQUARE], { each: 1 });
    expect(tr.keys).toHaveLength(3);
  });
  it('handles different subpath counts', () => {
    const two = `${SQUARE} M100 0 L120 0 L120 20 Z`;
    expect(() => morphPaths(SQUARE, two, 0.3)).not.toThrow();
  });
});

describe('particles', () => {
  it('are deterministic and stateless', () => {
    const p = particles({ rate: 50, life: [1, 1], turbulence: 30, seed: 3 });
    const a = p.simulate(1.5);
    p.simulate(0.2);
    const b = p.simulate(1.5);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(45);
    expect(a.length).toBeLessThan(55);
  });
});

describe('behaviors & helpers', () => {
  it('enter/exit build keyframes relative to node timing', () => {
    const r = rect({ opacity: 1, duration: 4 }).use(enterFx.fade({ duration: 1 }), exitFx.fade({ duration: 1 }));
    expect(r.value('opacity', ctx(0))).toBe(0);
    expect(r.value('opacity', ctx(2))).toBe(1);
    expect(r.value('opacity', ctx(4))).toBe(0);
  });
  it('follows a path with tangent rotation', () => {
    const r = rect().use(followPath('M0 0 L100 0 L100 100', { duration: 1, ease: 'linear', rotate: true }));
    expect(r.value('position', ctx(0.25))).toEqual([50, 0]);
    expect(r.value('rotation', ctx(0.75))).toBeCloseTo(90);
  });
  it('repeats in a circle', () => {
    const g = repeat(4, () => star(), { type: 'circle', radius: 100 });
    const p = g.children[1]!.value('position', ctx(0)) as [number, number];
    expect(p[0]).toBeCloseTo(100);
    expect(p[1]).toBeCloseTo(0);
  });
  it('counts and scrambles text', () => {
    expect(counter(0, 1234567, { duration: 1, ease: 'linear' })(ctx(1))).toBe('1,234,567');
    expect(scramble('HELLO', { duration: 1 })(ctx(1))).toBe('HELLO');
    expect(scramble('HELLO', { duration: 1 })(ctx(0)).length).toBe(5);
    expect(text('x').glyphs().glyphAnimators).toHaveLength(0);
  });
});

describe('motion showcase renders (browser)', () => {
  it('renders particles, charts, morphs and kinetic type', async () => {
    const { frames } = await renderFrames({
      dir: join(__dirname, '.tmp'),
      frames: [15, 45],
      source: `import { composition, path, text, motion, textFx } from 'tasweerix';
      export default composition({ width: 640, height: 360, fps: 30, duration: 2, background: '#111' }, (c) => {
        c.add(motion.particlePresets.sparks({ seed: 2 }).at([100, 300]));
        c.add(motion.barChart([{ label: 'a', value: 3 }, { label: 'b', value: 7 }], { size: [200, 120], at: [450, 200] }));
        c.add(path(motion.morph(['${SQUARE}', '${CIRCLE}'], { each: 1 }), { at: [120, 120], fill: '#22d3ee' }));
        c.add(text('Kinetic', { at: [320, 60], size: 48, fill: '#fff' }).glyphs(textFx.pop({ stagger: 0.05 })));
      });`,
    });
    for (const f of frames) {
      let lit = 0;
      for (let i = 0; i < f.data.length; i += 4) if (f.data[i]! + f.data[i + 1]! + f.data[i + 2]! > 200) lit++;
      expect(lit).toBeGreaterThan(1000);
    }
  });
});
