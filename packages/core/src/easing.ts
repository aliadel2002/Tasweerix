/** An easing maps normalized progress t ∈ [0,1] to eased progress (may overshoot for back/elastic/spring). */
export type Easing = (t: number) => number;

/** CSS-style cubic-bezier easing solved with Newton-Raphson + bisection fallback. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Easing {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  const solve = (x: number) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-7) return t;
      const d = sampleDX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0,
      hi = 1;
    t = x;
    while (lo < hi) {
      const v = sampleX(t);
      if (Math.abs(v - x) < 1e-7) return t;
      if (x > v) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
      if (hi - lo < 1e-9) break;
    }
    return t;
  };
  return (t) => (t <= 0 ? 0 : t >= 1 ? 1 : sampleY(solve(t)));
}

export function steps(n: number, position: 'start' | 'end' = 'end'): Easing {
  return (t) => {
    if (t >= 1) return 1;
    const k = position === 'start' ? Math.ceil(t * n) : Math.floor(t * n);
    return Math.min(1, Math.max(0, k / n));
  };
}

export interface SpringOptions {
  stiffness?: number;
  damping?: number;
  mass?: number;
  velocity?: number;
}

/**
 * Damped harmonic oscillator from 0 → 1. Returns the position at physical time `seconds`.
 * Used both as a time-based driver and (normalized over its settle time) as an easing.
 */
export function springValue(seconds: number, opts: SpringOptions = {}): number {
  const k = opts.stiffness ?? 170;
  const c = opts.damping ?? 18;
  const m = opts.mass ?? 1;
  const v0 = -(opts.velocity ?? 0);
  const x0 = -1;
  const w0 = Math.sqrt(k / m);
  const zeta = c / (2 * Math.sqrt(k * m));
  const t = seconds;
  let x: number;
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    x = Math.exp(-zeta * w0 * t) * (x0 * Math.cos(wd * t) + ((v0 + zeta * w0 * x0) / wd) * Math.sin(wd * t));
  } else if (zeta === 1) {
    x = Math.exp(-w0 * t) * (x0 + (v0 + w0 * x0) * t);
  } else {
    const r1 = -w0 * (zeta - Math.sqrt(zeta * zeta - 1));
    const r2 = -w0 * (zeta + Math.sqrt(zeta * zeta - 1));
    const B = (v0 - r1 * x0) / (r2 - r1);
    const A = x0 - B;
    x = A * Math.exp(r1 * t) + B * Math.exp(r2 * t);
  }
  return 1 + x;
}

/** Time (seconds) after which the spring stays within `threshold` of rest. */
export function springSettleTime(opts: SpringOptions = {}, threshold = 0.001): number {
  const dt = 1 / 240;
  let lastOut = 0;
  for (let t = 0; t < 30; t += dt) {
    if (Math.abs(springValue(t, opts) - 1) > threshold) lastOut = t;
    else if (t - lastOut > 0.25) return lastOut + dt;
  }
  return 30;
}

/** A spring as an easing over its natural settle time. */
export function spring(opts: SpringOptions = {}): Easing {
  const T = springSettleTime(opts);
  return (t) => (t <= 0 ? 0 : t >= 1 ? 1 : springValue(t * T, opts));
}

const pow = Math.pow;
const sqrt = Math.sqrt;
const sin = Math.sin;
const cos = Math.cos;
const PI = Math.PI;
const c1 = 1.70158;
const c2 = c1 * 1.525;
const c3 = c1 + 1;
const c4 = (2 * PI) / 3;
const c5 = (2 * PI) / 4.5;

function bounceOut(x: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
}

export const ease = {
  linear: ((t) => t) as Easing,
  hold: ((t) => (t >= 1 ? 1 : 0)) as Easing,
  inQuad: ((t) => t * t) as Easing,
  outQuad: ((t) => 1 - (1 - t) * (1 - t)) as Easing,
  inOutQuad: ((t) => (t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2)) as Easing,
  inCubic: ((t) => t * t * t) as Easing,
  outCubic: ((t) => 1 - pow(1 - t, 3)) as Easing,
  inOutCubic: ((t) => (t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2)) as Easing,
  inQuart: ((t) => t * t * t * t) as Easing,
  outQuart: ((t) => 1 - pow(1 - t, 4)) as Easing,
  inOutQuart: ((t) => (t < 0.5 ? 8 * t * t * t * t : 1 - pow(-2 * t + 2, 4) / 2)) as Easing,
  inQuint: ((t) => t * t * t * t * t) as Easing,
  outQuint: ((t) => 1 - pow(1 - t, 5)) as Easing,
  inOutQuint: ((t) => (t < 0.5 ? 16 * t * t * t * t * t : 1 - pow(-2 * t + 2, 5) / 2)) as Easing,
  inSine: ((t) => 1 - cos((t * PI) / 2)) as Easing,
  outSine: ((t) => sin((t * PI) / 2)) as Easing,
  inOutSine: ((t) => -(cos(PI * t) - 1) / 2) as Easing,
  inExpo: ((t) => (t === 0 ? 0 : pow(2, 10 * t - 10))) as Easing,
  outExpo: ((t) => (t === 1 ? 1 : 1 - pow(2, -10 * t))) as Easing,
  inOutExpo: ((t) =>
    t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? pow(2, 20 * t - 10) / 2 : (2 - pow(2, -20 * t + 10)) / 2) as Easing,
  inCirc: ((t) => 1 - sqrt(1 - pow(t, 2))) as Easing,
  outCirc: ((t) => sqrt(1 - pow(t - 1, 2))) as Easing,
  inOutCirc: ((t) =>
    t < 0.5 ? (1 - sqrt(1 - pow(2 * t, 2))) / 2 : (sqrt(1 - pow(-2 * t + 2, 2)) + 1) / 2) as Easing,
  inBack: ((t) => c3 * t * t * t - c1 * t * t) as Easing,
  outBack: ((t) => 1 + c3 * pow(t - 1, 3) + c1 * pow(t - 1, 2)) as Easing,
  inOutBack: ((t) =>
    t < 0.5
      ? (pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2
      : (pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2) as Easing,
  inElastic: ((t) =>
    t === 0 ? 0 : t === 1 ? 1 : -pow(2, 10 * t - 10) * sin((t * 10 - 10.75) * c4)) as Easing,
  outElastic: ((t) => (t === 0 ? 0 : t === 1 ? 1 : pow(2, -10 * t) * sin((t * 10 - 0.75) * c4) + 1)) as Easing,
  inOutElastic: ((t) =>
    t === 0
      ? 0
      : t === 1
        ? 1
        : t < 0.5
          ? -(pow(2, 20 * t - 10) * sin((20 * t - 11.125) * c5)) / 2
          : (pow(2, -20 * t + 10) * sin((20 * t - 11.125) * c5)) / 2 + 1) as Easing,
  inBounce: ((t) => 1 - bounceOut(1 - t)) as Easing,
  outBounce: bounceOut as Easing,
  inOutBounce: ((t) => (t < 0.5 ? (1 - bounceOut(1 - 2 * t)) / 2 : (1 + bounceOut(2 * t - 1)) / 2)) as Easing,
  /** Smooth "ease" from CSS. */
  smooth: cubicBezier(0.25, 0.1, 0.25, 1),
  /** Snappy UI-style easing. */
  snappy: cubicBezier(0.2, 0.9, 0.1, 1),
  /** Cinematic slow-in slow-out. */
  cinematic: cubicBezier(0.7, 0, 0.3, 1),
  bezier: cubicBezier,
  steps,
  spring,
  /** Reverse an easing (out ↔ in). */
  reverse: (e: Easing): Easing => (t) => 1 - e(1 - t),
  /** Mirror: plays the easing forward then backward. */
  mirror: (e: Easing): Easing => (t) => (t < 0.5 ? e(t * 2) : e((1 - t) * 2)),
  /** Chains easings over equal portions. */
  chain: (...es: Easing[]): Easing => (t) => {
    if (t >= 1) return 1;
    const n = es.length;
    const i = Math.min(n - 1, Math.floor(t * n));
    return (i + es[i]!((t * n) - i)) / n;
  },
};

export type EaseName = Exclude<
  keyof typeof ease,
  'bezier' | 'steps' | 'spring' | 'reverse' | 'mirror' | 'chain'
>;

export type EasingInput = Easing | EaseName;

export function resolveEasing(e: EasingInput | undefined, fallback: Easing = ease.linear): Easing {
  if (!e) return fallback;
  if (typeof e === 'function') return e;
  const f = (ease as Record<string, unknown>)[e];
  if (typeof f !== 'function') throw new Error(`Unknown easing "${e}"`);
  return f as Easing;
}
