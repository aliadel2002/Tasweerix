import { describe, expect, it } from 'vitest';
import {
  audio,
  composition,
  createNoise,
  createRandom,
  ease,
  expr,
  formatTimecode,
  interpolate,
  keys,
  makeContext,
  mat2d,
  mixColor,
  parseColor,
  rect,
  sequence,
  springValue,
  stagger,
  still,
  text,
  toCss,
  toSeconds,
  Track,
  tween,
  video,
  type Env,
} from '../src';

const ctxAt = (time: number) => makeContext({ time, fps: 30, width: 100, height: 100 });

describe('time', () => {
  it('parses units and timecodes', () => {
    expect(toSeconds(2.5)).toBe(2.5);
    expect(toSeconds('250ms')).toBeCloseTo(0.25);
    expect(toSeconds('1.5m')).toBe(90);
    expect(toSeconds('90f', 30)).toBe(3);
    expect(toSeconds('01:02.5')).toBe(62.5);
    expect(toSeconds('00:00:01:15', 30)).toBe(1.5);
    expect(() => toSeconds('banana')).toThrow();
    expect(formatTimecode(61.5, 30)).toBe('00:01:01:15');
  });
});

describe('color', () => {
  it('parses css colors', () => {
    expect(parseColor('#ff0000')).toEqual([1, 0, 0, 1]);
    expect(parseColor('#0f08')[3]).toBeCloseTo(0x88 / 255);
    expect(parseColor('rgb(0, 128, 255)')[1]).toBeCloseTo(128 / 255);
    expect(parseColor('hsl(120, 100%, 50%)')).toEqual([0, 1, 0, 1]);
    expect(parseColor('white')).toEqual([1, 1, 1, 1]);
  });
  it('mixes in oklab and keeps endpoints', () => {
    expect(toCss(mixColor('#ff0000', '#0000ff', 0))).toBe('rgba(255, 0, 0, 1)');
    const mid = mixColor('black', 'white', 0.5);
    expect(mid[0]).toBeGreaterThan(0.3);
    expect(mid[0]).toBeLessThan(0.7);
  });
});

describe('easing', () => {
  it('has fixed endpoints', () => {
    for (const [name, f] of Object.entries(ease)) {
      if (typeof f !== 'function' || ['bezier', 'steps', 'spring', 'reverse', 'mirror', 'chain'].includes(name)) continue;
      expect((f as (t: number) => number)(0), name).toBeCloseTo(0, 5);
      expect((f as (t: number) => number)(1), name).toBeCloseTo(1, 5);
    }
  });
  it('cubic-bezier matches linear for (0,0,1,1)', () => {
    const e = ease.bezier(0, 0, 1, 1);
    expect(e(0.37)).toBeCloseTo(0.37, 4);
  });
  it('spring settles at 1', () => {
    expect(springValue(0)).toBeCloseTo(0);
    expect(springValue(5)).toBeCloseTo(1, 3);
    const s = ease.spring({ stiffness: 200, damping: 10 });
    expect(s(1)).toBe(1);
    expect(Math.max(...Array.from({ length: 100 }, (_, i) => s(i / 100)))).toBeGreaterThan(1); // overshoot
  });
});

describe('tracks', () => {
  it('interpolates keyframes with per-segment easing', () => {
    const t = keys<number>([
      [0, 0],
      [1, 10],
      [2, 0, 'outCubic'],
    ]);
    expect(t.at(-1)).toBe(0);
    expect(t.at(0.5)).toBe(5);
    expect(t.at(1)).toBe(10);
    expect(t.at(1.5)).toBeCloseTo(10 - 10 * ease.outCubic(0.5));
    expect(t.at(5)).toBe(0);
  });
  it('loops and ping-pongs', () => {
    const t = new Track<number>([[0, 0], [1, 1]], { loop: 'loop' });
    expect(t.at(1.25)).toBeCloseTo(0.25);
    const p = new Track<number>([[0, 0], [1, 1]], { loop: 'pingpong' });
    expect(p.at(1.25)).toBeCloseTo(0.75);
  });
  it('interpolates vectors, colors and objects', () => {
    expect(interpolate([0, 10], [10, 20], 0.5)).toEqual([5, 15]);
    expect(interpolate({ a: 0, b: '#000' }, { a: 2, b: '#fff' }, 0.5).a).toBe(1);
    expect(interpolate('10px', '20px', 0.5)).toBe('15px');
  });
  it('tween and expressions are deterministic', () => {
    const tw = tween(0, 100, { start: 1, duration: 1, ease: 'linear' });
    expect(tw.at(1.5)).toBe(50);
    const w = expr.wiggle(2, 10, 50, 'x');
    expect(w(ctxAt(1.3))).toBe(w(ctxAt(1.3)));
    expect(Math.abs(w(ctxAt(1.3)) - 50)).toBeLessThanOrEqual(10);
  });
});

describe('random & noise', () => {
  it('is seeded', () => {
    const a = createRandom('seed');
    const b = createRandom('seed');
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    const n = createNoise(1);
    const v = n.noise2(0.3, 0.7);
    expect(v).toBe(createNoise(1).noise2(0.3, 0.7));
    expect(Math.abs(v)).toBeLessThanOrEqual(1);
  });
});

describe('matrix', () => {
  it('composes and inverts', () => {
    const m = mat2d.compose([10, 20], [2, 2], 90, [5, 5]);
    const p = mat2d.apply(m, [5, 5]);
    expect(p[0]).toBeCloseTo(10);
    expect(p[1]).toBeCloseTo(20);
    const back = mat2d.apply(mat2d.invert(m), p);
    expect(back[0]).toBeCloseTo(5);
  });
});

describe('scene graph', () => {
  it('animate() chains tweens', () => {
    const r = rect({ opacity: 0 });
    r.animate({ opacity: 1 }, { duration: 1, ease: 'linear' }).animate({ opacity: 0 }, { start: 2, duration: 1, ease: 'linear' });
    expect(r.value('opacity', ctxAt(0.5))).toBeCloseTo(0.5);
    expect(r.value('opacity', ctxAt(1.5))).toBe(1);
    expect(r.value('opacity', ctxAt(2.5))).toBeCloseTo(0.5);
    r.animate({ position: [[0, 0], [100, 0]] }, { duration: 1, ease: 'linear' });
    expect(r.value('position', ctxAt(0.5))).toEqual([50, 0]);
  });
  it('evaluates defaults', () => {
    const t = text('hello', { size: 72 });
    const v = t.evaluate(ctxAt(0));
    expect(v.size).toBe(72);
    expect(v.opacity).toBe(1);
    expect(v.align).toBe('center');
  });
});

const fakeEnv: Env = {
  kind: 'none',
  probe: async (src) => (src.includes('a') ? { duration: 4, hasAudio: true, hasVideo: true } : { duration: 10, hasVideo: true }),
};

describe('composition & timeline', () => {
  it('sequences media after probing and derives duration and implicit audio', async () => {
    const def = composition({ width: 640, height: 360, fps: 25 }, (c) => {
      c.add(sequence([video('a.mp4', { trim: [1] }), video('b.mp4', { trim: [0, 2], speed: 2 })], { overlap: 0.5 }));
      c.audio(audio('music.mp3', { start: '1s' }));
    });
    const comp = await def.create({ env: fakeEnv });
    const seq = comp.root.children[0]!;
    expect(seq.children[0]!.effectiveDuration()).toBe(3);
    expect(seq.children[1]!.start).toBe(2.5);
    expect(seq.children[1]!.effectiveDuration()).toBe(1);
    expect(comp.duration).toBe(11); // music (10s) starting at 1s outlasts the video sequence (3.5s)
    const clips = comp.allAudioClips();
    expect(clips.filter((c) => c.implicit)).toHaveLength(1);
    expect(clips.find((c) => c.implicit)!.trimIn).toBe(1);
  });
  it('stagger offsets children', () => {
    const g = stagger([rect(), rect(), rect()], 0.2);
    expect(g.children.map((c) => +c.start.toFixed(3))).toEqual([0, 0.2, 0.4]);
  });
  it('stills are one frame', async () => {
    const s = await still({ width: 100, height: 100 }, (c) => void c.add(rect())).create();
    expect(s.frameCount).toBe(1);
  });
});
