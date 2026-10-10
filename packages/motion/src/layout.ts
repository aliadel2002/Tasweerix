import { group, pointAtLength, parsePath, resolve, toSeconds, type Animatable, type GroupNode, type NodeOptions, type PathData, type SceneNode, type TimeInput, type Vec2, type EasingInput, resolveEasing, type Behavior } from '@tasweerix/core';

export type Arrangement =
  | { type: 'grid'; columns: number; gap: Vec2 }
  | { type: 'row'; gap: number }
  | { type: 'column'; gap: number }
  | { type: 'circle'; radius: number; startAngle?: number; rotate?: boolean }
  | { type: 'spiral'; spacing: number; turns: number }
  | { type: 'path'; d: string; rotate?: boolean };

/**
 * Repeater: creates `count` items from a factory and arranges them. The factory receives the
 * index; use `stagger` to offset start times for cascading animations.
 */
export function repeat(count: number, factory: (i: number, count: number) => SceneNode, arrange: Arrangement, opts: NodeOptions & { stagger?: TimeInput } = {}): GroupNode {
  const { stagger = 0, ...rest } = opts;
  const g = group(rest);
  const step = toSeconds(stagger);
  for (let i = 0; i < count; i++) {
    const n = factory(i, count);
    const [pos, rot] = place(arrange, i, count);
    if ((n.props as { position?: unknown }).position === undefined) n.set({ position: pos } as never);
    if (rot !== undefined && (n.props as { rotation?: unknown }).rotation === undefined) n.set({ rotation: rot } as never);
    n.start += i * step;
    g.add(n);
  }
  return g;
}

function place(a: Arrangement, i: number, n: number): [Vec2, number?] {
  switch (a.type) {
    case 'grid': {
      const rows = Math.ceil(n / a.columns);
      const c = i % a.columns;
      const r = Math.floor(i / a.columns);
      return [[(c - (a.columns - 1) / 2) * a.gap[0], (r - (rows - 1) / 2) * a.gap[1]]];
    }
    case 'row':
      return [[(i - (n - 1) / 2) * a.gap, 0]];
    case 'column':
      return [[0, (i - (n - 1) / 2) * a.gap]];
    case 'circle': {
      const ang = (a.startAngle ?? -90) + (360 * i) / n;
      const r = (ang * Math.PI) / 180;
      return [[Math.cos(r) * a.radius, Math.sin(r) * a.radius], a.rotate ? ang + 90 : undefined];
    }
    case 'spiral': {
      const t = i / Math.max(1, n - 1);
      const ang = t * a.turns * Math.PI * 2;
      const r = i * a.spacing;
      return [[Math.cos(ang) * r, Math.sin(ang) * r]];
    }
    case 'path': {
      const { point, angle } = pointAtLength(parsePath(a.d), n === 1 ? 0 : i / (n - 1));
      return [point, a.rotate ? (angle * 180) / Math.PI : undefined];
    }
  }
}

/**
 * Moves a node along an SVG path over time; optionally orients it along the tangent.
 *   rect().use(followPath('M0 0 C 200 -200 400 200 600 0', { duration: 3, rotate: true }))
 */
export function followPath(d: string | PathData, opts: { start?: TimeInput; duration?: TimeInput; ease?: EasingInput; rotate?: boolean; offset?: Vec2; progress?: Animatable<number> } = {}): Behavior {
  const path = typeof d === 'string' ? parsePath(d) : d;
  const start = toSeconds(opts.start ?? 0);
  const dur = toSeconds(opts.duration ?? 2);
  const e = resolveEasing(opts.ease ?? 'inOutCubic');
  const off = opts.offset ?? [0, 0];
  const prog = (ctx: Parameters<typeof resolve>[1]) => (opts.progress !== undefined ? resolve(opts.progress, ctx) : e(Math.min(1, Math.max(0, (ctx.time - start) / dur))));
  return (n) => {
    n.set({ position: (ctx: Parameters<typeof resolve>[1]) => { const p = pointAtLength(path, prog(ctx)).point; return [p[0] + off[0], p[1] + off[1]] as Vec2; } } as never);
    if (opts.rotate) n.set({ rotation: (ctx: Parameters<typeof resolve>[1]) => (pointAtLength(path, prog(ctx)).angle * 180) / Math.PI } as never);
  };
}
