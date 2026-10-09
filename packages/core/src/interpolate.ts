import { mixColor, toCss, tryParseColor } from './color';
import { lerp } from './math';

export interface Interpolator {
  name: string;
  test(a: unknown, b: unknown): boolean;
  mix(a: any, b: any, t: number): any;
}

const custom: Interpolator[] = [];

/** Register an interpolator (e.g. SVG path morphing). Custom interpolators take precedence. */
export function registerInterpolator(i: Interpolator): void {
  const existing = custom.findIndex((c) => c.name === i.name);
  if (existing >= 0) custom.splice(existing, 1);
  custom.unshift(i);
}

export function interpolate<T>(a: T, b: T, t: number): T {
  if (t === 0) return a;
  if (t === 1) return b;
  for (const c of custom) if (c.test(a, b)) return c.mix(a, b, t);
  if (typeof a === 'number' && typeof b === 'number') return lerp(a, b, t) as T;
  if (typeof a === 'string' && typeof b === 'string') {
    if (a === b) return a;
    const ca = tryParseColor(a);
    const cb = tryParseColor(b);
    if (ca && cb) return toCss(mixColor(ca, cb, t)) as T;
    const na = parseUnit(a);
    const nb = parseUnit(b);
    if (na && nb && na.unit === nb.unit) return `${lerp(na.value, nb.value, t)}${na.unit}` as T;
    return (t < 1 ? a : b) as T;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const av = i < a.length ? a[i] : b[i];
      const bv = i < b.length ? b[i] : a[i];
      out[i] = interpolate(av, bv, t);
    }
    return out as T;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const out: Record<string, unknown> = {};
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of keys) {
      const av = (a as Record<string, unknown>)[k];
      const bv = (b as Record<string, unknown>)[k];
      out[k] = av === undefined ? bv : bv === undefined ? av : interpolate(av, bv, t);
    }
    return out as T;
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') return (t < 0.5 ? a : b) as T;
  return (t < 1 ? a : b) as T;
}

function parseUnit(s: string): { value: number; unit: string } | null {
  const m = /^\s*(-?\d*\.?\d+)([a-z%]*)\s*$/i.exec(s);
  return m ? { value: parseFloat(m[1]!), unit: m[2]! } : null;
}
