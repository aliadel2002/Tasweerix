import type { Vec2 } from './math';

export type ColorStop = [offset: number, color: string];

export interface LinearGradient {
  type: 'linear';
  from: Vec2;
  to: Vec2;
  stops: ColorStop[];
}
export interface RadialGradient {
  type: 'radial';
  center: Vec2;
  radius: number;
  /** Optional focal point. */
  focus?: Vec2;
  stops: ColorStop[];
}
export interface ConicGradient {
  type: 'conic';
  center: Vec2;
  /** Start angle in degrees. */
  angle: number;
  stops: ColorStop[];
}
export interface PatternPaint {
  type: 'pattern';
  /** Image / canvas source URL or asset path. */
  src: string;
  repeat?: 'repeat' | 'repeat-x' | 'repeat-y' | 'no-repeat';
  scale?: number;
}

export type Gradient = LinearGradient | RadialGradient | ConicGradient;
/** Anything that can fill or stroke a shape. */
export type Paint = string | Gradient | PatternPaint | null;

function normStops(stops: (string | ColorStop)[]): ColorStop[] {
  return stops.map((s, i) => (Array.isArray(s) ? s : [stops.length === 1 ? 0 : i / (stops.length - 1), s]));
}

export const gradient = {
  linear(from: Vec2, to: Vec2, stops: (string | ColorStop)[]): LinearGradient {
    return { type: 'linear', from, to, stops: normStops(stops) };
  },
  /** Linear gradient at an angle (degrees) across a box of the given size, centered at origin. */
  angled(angleDeg: number, size: Vec2, stops: (string | ColorStop)[]): LinearGradient {
    const a = (angleDeg * Math.PI) / 180;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const half = (Math.abs(size[0] * dx) + Math.abs(size[1] * dy)) / 2;
    return { type: 'linear', from: [-dx * half, -dy * half], to: [dx * half, dy * half], stops: normStops(stops) };
  },
  radial(center: Vec2, radius: number, stops: (string | ColorStop)[], focus?: Vec2): RadialGradient {
    return { type: 'radial', center, radius, stops: normStops(stops), focus };
  },
  conic(center: Vec2, angle: number, stops: (string | ColorStop)[]): ConicGradient {
    return { type: 'conic', center, angle, stops: normStops(stops) };
  },
  pattern(src: string, opts: Omit<PatternPaint, 'type' | 'src'> = {}): PatternPaint {
    return { type: 'pattern', src, ...opts };
  },
};
