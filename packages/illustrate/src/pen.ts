import { serializePath, parsePath, mapPath, mat2d, type Mat2D, type PathData, type Vec2 } from '@tasweerix/core';

/** Fluent SVG path builder: `pen().move(0,0).line(100,0).curve(...).close().d` */
export class Pen {
  private parts: string[] = [];
  private cur: Vec2 = [0, 0];
  move(x: number, y: number): this {
    this.parts.push(`M${x} ${y}`);
    this.cur = [x, y];
    return this;
  }
  line(x: number, y: number): this {
    this.parts.push(`L${x} ${y}`);
    this.cur = [x, y];
    return this;
  }
  /** Relative line. */
  by(dx: number, dy: number): this {
    return this.line(this.cur[0] + dx, this.cur[1] + dy);
  }
  quad(cx: number, cy: number, x: number, y: number): this {
    this.parts.push(`Q${cx} ${cy} ${x} ${y}`);
    this.cur = [x, y];
    return this;
  }
  curve(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): this {
    this.parts.push(`C${c1x} ${c1y} ${c2x} ${c2y} ${x} ${y}`);
    this.cur = [x, y];
    return this;
  }
  arc(rx: number, ry: number, rotation: number, large: boolean, sweep: boolean, x: number, y: number): this {
    this.parts.push(`A${rx} ${ry} ${rotation} ${large ? 1 : 0} ${sweep ? 1 : 0} ${x} ${y}`);
    this.cur = [x, y];
    return this;
  }
  /** Circular arc around a center between angles (degrees, 0 = right, clockwise). */
  arcAround(cx: number, cy: number, r: number, from: number, to: number): this {
    const p = (a: number): Vec2 => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)];
    const [sx, sy] = p(from);
    if (!this.parts.length) this.move(sx, sy);
    else this.line(sx, sy);
    const sweep = to > from;
    let a = from;
    // Split into ≤180° pieces for robustness.
    while (Math.abs(to - a) > 1e-9) {
      const b = sweep ? Math.min(to, a + 180) : Math.max(to, a - 180);
      const [x, y] = p(b);
      this.arc(r, r, 0, false, sweep, x, y);
      a = b;
    }
    return this;
  }
  close(): this {
    this.parts.push('Z');
    return this;
  }
  get d(): string {
    return this.parts.join('');
  }
  toString(): string {
    return this.d;
  }
}

export const pen = (): Pen => new Pen();

/** Transforms an SVG path string by a 2D matrix. */
export function transformPath(d: string, m: Mat2D): string {
  return serializePath(mapPath(parsePath(d), (p) => mat2d.apply(m, p)));
}

export function translatePath(d: string, dx: number, dy: number): string {
  return transformPath(d, mat2d.translate(dx, dy));
}
export function scalePath(d: string, sx: number, sy = sx): string {
  return transformPath(d, mat2d.scale(sx, sy));
}
export function rotatePath(d: string, degrees: number): string {
  return transformPath(d, mat2d.rotate((degrees * Math.PI) / 180));
}

/** Re-centers a path so its bounding box is centered on the origin. */
export function centerPath(d: string): string {
  const p = parsePath(d);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of p) {
    if (c.c === 'Z') continue;
    for (const v of c.c === 'C' ? [c.c1, c.c2, c.p] : [c.p]) {
      x0 = Math.min(x0, v[0]); y0 = Math.min(y0, v[1]); x1 = Math.max(x1, v[0]); y1 = Math.max(y1, v[1]);
    }
  }
  return serializePath(mapPath(p, ([x, y]) => [x - (x0 + x1) / 2, y - (y0 + y1) / 2]));
}

export type { PathData };
