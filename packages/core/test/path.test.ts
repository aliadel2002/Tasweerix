import { describe, expect, it } from 'vitest';
import { ellipsePath, flattenPath, parsePath, pathBounds, pathLength, pointAtLength, rectPath, resamplePolyline, serializePath, trimPolylines } from '../src';

describe('path geometry', () => {
  it('parses relative/absolute/implicit commands', () => {
    const p = parsePath('M10 10 l10 0 h10 v10 H10 z');
    expect(p.map((c) => c.c).join('')).toBe('MLLLLZ');
    expect(serializePath(p)).toBe('M10 10L20 10L30 10L30 20L10 20Z');
    const q = parsePath('M0,0 Q 50,100 100,0 T200,0');
    expect(q.filter((c) => c.c === 'C')).toHaveLength(2);
    const a = parsePath('M0 0 A 50 50 0 0 1 100 0');
    const last = a[a.length - 1]!;
    expect(last.c).toBe('C');
    if (last.c === 'C') expect(last.p[0]).toBeCloseTo(100);
  });
  it('measures length and bounds', () => {
    expect(pathLength(rectPath(100, 50))).toBeCloseTo(300, 0);
    expect(pathLength(ellipsePath(100, 100))).toBeCloseTo(Math.PI * 100, 0);
    const b = pathBounds(ellipsePath(100, 60));
    expect(b.width).toBeCloseTo(100, 0);
    expect(b.height).toBeCloseTo(60, 0);
  });
  it('trims and samples', () => {
    const subs = flattenPath(parsePath('M0 0 L100 0'));
    const half = trimPolylines(subs, 0, 0.5);
    expect(half[0]![half[0]!.length - 1]![0]).toBeCloseTo(50);
    const wrap = trimPolylines(subs, 0.8, 1, 0.5); // wraps around
    expect(wrap.length).toBe(1);
    expect(pointAtLength(parsePath('M0 0 L100 0'), 0.25).point[0]).toBeCloseTo(25);
    expect(resamplePolyline([[0, 0], [10, 0]], 11)[5]![0]).toBeCloseTo(5);
  });
});
