import { describe, expect, it } from 'vitest';
import { composition, ellipse, gradient, parsePath, pathBounds, rect, still, text, flattenPath } from '@tasweerix/core';
import { blob, boolean, delaunay, flowField, importSVG, lSystem, offsetPath, patterns, pen, poissonDisc, simplifyPath, spirograph, strokeToPath, toSVG, voronoi, pathToPolygons } from '../src';

const area = (d: string) => {
  let a = 0;
  for (const poly of pathToPolygons(d))
    poly.forEach((ring, ri) => {
      let s = 0;
      for (let i = 0; i < ring.length - 1; i++) s += ring[i]![0] * ring[i + 1]![1] - ring[i + 1]![0] * ring[i]![1];
      a += (ri === 0 ? 1 : -1) * Math.abs(s / 2);
    });
  return a;
};
const sq = (x: number, y: number, s: number) => pen().move(x, y).line(x + s, y).line(x + s, y + s).line(x, y + s).close().d;

describe('paths & booleans', () => {
  it('builds paths with arcs', () => {
    const d = pen().arcAround(0, 0, 50, 0, 360).close().d;
    expect(pathBounds(parsePath(d)).width).toBeCloseTo(100, 0);
  });
  it('computes boolean areas', () => {
    const a = sq(0, 0, 100);
    const b = sq(50, 50, 100);
    expect(area(boolean.union(a, b))).toBeCloseTo(17500, 0);
    expect(area(boolean.intersect(a, b))).toBeCloseTo(2500, 0);
    expect(area(boolean.subtract(a, b))).toBeCloseTo(7500, 0);
    expect(area(boolean.xor(a, b))).toBeCloseTo(15000, 0);
  });
  it('offsets and strokes', () => {
    const grown = pathBounds(parsePath(offsetPath(sq(0, 0, 100), 10)));
    expect(grown.width).toBeCloseTo(120, 0);
    const shrunk = pathBounds(parsePath(offsetPath(sq(0, 0, 100), -10)));
    expect(shrunk.width).toBeCloseTo(80, 0);
    expect(area(strokeToPath('M0 0 L100 0', 10))).toBeGreaterThan(1000);
  });
  it('simplifies', () => {
    const wobbly = 'M0 0' + Array.from({ length: 100 }, (_, i) => `L${i} ${Math.sin(i) * 0.1}`).join('');
    const pts = flattenPath(parsePath(simplifyPath(wobbly, 1)))[0]!.points.length;
    expect(pts).toBeLessThan(5);
  });
});

describe('generators', () => {
  it('poisson disc respects min distance', () => {
    const pts = poissonDisc(300, 300, 20, { seed: 2 });
    expect(pts.length).toBeGreaterThan(80);
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++) expect(Math.hypot(pts[i]![0] - pts[j]![0], pts[i]![1] - pts[j]![1])).toBeGreaterThanOrEqual(20 - 1e-9);
  });
  it('triangulates and builds voronoi cells covering the bounds', () => {
    const grid = [[0, 0], [1, 0], [0, 1], [1, 1]] as [number, number][];
    expect(delaunay(grid)).toHaveLength(2);
    const pts = poissonDisc(200, 200, 30, { seed: 5 });
    const cells = voronoi(pts, [0, 0, 200, 200]);
    const total = cells.reduce((s, c) => {
      let a = 0;
      for (let i = 0; i < c.length; i++) a += c[i]![0] * c[(i + 1) % c.length]![1] - c[(i + 1) % c.length]![0] * c[i]![1];
      return s + Math.abs(a / 2);
    }, 0);
    expect(total).toBeCloseTo(40000, -2);
  });
  it('produces flow fields, L-systems, blobs, spirographs and patterns', () => {
    expect(flowField(400, 300, { lines: 20, seed: 1 }).length).toBeGreaterThan(5);
    expect(lSystem('F', { F: 'F[+F]F[-F]F' }, { iterations: 3 }).length).toBeGreaterThan(200);
    expect(parsePath(blob(100, { seed: 3 })).length).toBeGreaterThan(5);
    expect(spirograph(100, 37, 60).length).toBeGreaterThan(1000);
    expect(patterns.dots(100, 100, 20, 4).length).toBeGreaterThan(10);
    expect(patterns.hexagons(200, 200, 20).length).toBeGreaterThan(10);
  });
});

describe('SVG', () => {
  it('imports shapes, transforms, styles and gradients', () => {
    const g = importSVG(`<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="lg"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>
      <g transform="translate(10 10)" style="stroke:#000;stroke-width:2">
        <rect x="0" y="0" width="50" height="30" fill="url(#lg)"/>
        <circle cx="100" cy="40" r="20" fill="#0f0"/>
        <!-- comment -->
        <polyline points="0,80 50,90 100,80" fill="none"/>
      </g>
      <text x="150" y="90" font-size="12" text-anchor="middle">Hi &amp; bye</text>
    </svg>`);
    expect(g.svgSize).toEqual([200, 100]);
    const inner = g.children[0]!;
    expect(inner.children).toHaveLength(3);
    const rectNode = inner.children[0]!;
    expect((rectNode.props.fill as { type: string }).type).toBe('linear');
    expect(pathBounds(parsePath(rectNode.props.d as string)).x).toBeCloseTo(10);
    expect(rectNode.props.strokeWidth).toBe(2);
    expect(g.children[1]!.props.text).toBe('Hi & bye');
  });
  it('exports a frame and re-imports it', async () => {
    const comp = await composition({ width: 400, height: 300, fps: 10, duration: 1, background: '#fff' }, (c) => {
      c.add(rect({ size: [100, 50], fill: gradient.linear([-50, 0], [50, 0], ['#f00', '#00f']), at: [100, 100] }));
      c.add(ellipse({ size: [80, 80], fill: null, stroke: '#000', strokeWidth: 4, trimEnd: 0.5, at: [300, 150] }));
      c.add(text('Tasweerix', { at: [200, 250], size: 30 }));
    }).create();
    const svg = toSVG(comp, 0);
    expect(svg).toContain('<linearGradient');
    expect(svg).toContain('Tasweerix');
    const back = importSVG(svg);
    let paths = 0;
    back.walk((n) => void (n.kind === 'path' && paths++));
    expect(paths).toBeGreaterThanOrEqual(3); // background + rect + trimmed ellipse
  });
  it('exports stills', async () => {
    const s = await still({ width: 100, height: 100, background: null }, (c) => void c.add(rect({ size: [10, 10] }))).create();
    expect(toSVG(s)).not.toContain('<rect width');
  });
});
