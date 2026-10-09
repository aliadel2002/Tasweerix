import { GroupNode, group } from './nodes';
import type { NodeOptions, SceneNode } from './node';
import { toSeconds, type TimeInput } from './time';

export interface SequenceOptions extends NodeOptions {
  /** Gap between consecutive items (negative = overlap). */
  gap?: TimeInput;
  /** Overlap between items (positive number). */
  overlap?: TimeInput;
}

/** Plays children one after another. Durations are resolved after media probing. */
export function sequence(items: SceneNode[], opts: SequenceOptions = {}): GroupNode {
  const { gap, overlap, ...rest } = opts;
  const g = group(...items, rest);
  g.meta.layout = 'sequence';
  const gapS = toSeconds(gap ?? 0) - toSeconds(overlap ?? 0);
  g.layout = (node) => {
    let t = 0;
    let end = 0;
    for (const child of node.children) {
      child.start = t + (child.meta.offset as number | undefined ?? 0);
      const d = child.effectiveDuration();
      if (!Number.isFinite(d)) throw new Error(`sequence(): item "${child.name ?? child.id}" has no finite duration`);
      end = Math.max(end, child.start + d);
      t = child.start + d + gapS;
    }
    if (node.duration === undefined) node.naturalDuration = end;
  };
  return g;
}

/** Starts all children together. Group lasts as long as its longest child. */
export function parallel(items: SceneNode[], opts: NodeOptions = {}): GroupNode {
  const g = group(...items, opts);
  g.layout = (node) => {
    let end = 0;
    for (const c of node.children) end = Math.max(end, c.end);
    if (node.duration === undefined && Number.isFinite(end)) node.naturalDuration = end;
  };
  return g;
}

/** Starts children with a fixed delay between each. */
export function stagger(items: SceneNode[], each: TimeInput, opts: NodeOptions & { from?: 'start' | 'end' | 'center' } = {}): GroupNode {
  const { from = 'start', ...rest } = opts;
  const g = group(...items, rest);
  const step = toSeconds(each);
  const n = items.length;
  items.forEach((item, i) => {
    const k = from === 'start' ? i : from === 'end' ? n - 1 - i : Math.abs(i - (n - 1) / 2);
    item.start += k * step;
  });
  g.layout = (node) => {
    let end = 0;
    for (const c of node.children) end = Math.max(end, c.end);
    if (node.duration === undefined && Number.isFinite(end)) node.naturalDuration = end;
  };
  return g;
}

/** Repeats a node factory over time: `loop(i => …, { count: 4, every: '2s' })`. */
export function repeatOver(factory: (i: number) => SceneNode, opts: { count: number; every: TimeInput } & NodeOptions): GroupNode {
  const { count, every, ...rest } = opts;
  const step = toSeconds(every);
  const items = Array.from({ length: count }, (_, i) => factory(i).startAt(i * step));
  return group(...items, rest);
}
