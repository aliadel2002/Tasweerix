import { createNoise, createRandom, mixColor, SceneNode, toCss, type AnimProps, type BaseProps, type NodeOptions, type Vec2 } from '@tasweerix/core';
import { registerDrawer } from '@tasweerix/render';

export interface ParticleConfig {
  /** Particles emitted per second. */
  rate: number;
  /** Optional burst count at t=0. */
  burst: number;
  /** Lifetime in seconds [min, max]. */
  life: [number, number];
  /** Initial speed (px/s) [min, max]. */
  speed: [number, number];
  /** Emission direction (degrees, 0 = right, 90 = down) and spread (degrees). */
  angle: number;
  spread: number;
  /** Emitter shape. */
  emitter: { type: 'point' } | { type: 'line'; length: number } | { type: 'circle'; radius: number } | { type: 'rect'; size: Vec2 };
  gravity: Vec2;
  /** Velocity damping per second (0 = none). */
  drag: number;
  /** Curl-noise turbulence strength and scale. */
  turbulence: number;
  turbulenceScale: number;
  /** Size over life [start, end] (px). */
  size: [number, number];
  /** Colors over life (OKLab gradient). */
  colors: string[];
  /** Opacity over life [start, mid, end]. */
  opacity: [number, number, number];
  shape: 'circle' | 'square' | 'star' | 'line' | 'spark';
  /** Spin (degrees/s) [min, max]. */
  spin: [number, number];
  blend: 'normal' | 'add';
  seed: number;
  /** Simulation step (seconds). */
  step: number;
  /** Emission stops after this time (seconds, Infinity = never). */
  emitUntil: number;
}

const DEFAULTS: ParticleConfig = {
  rate: 60,
  burst: 0,
  life: [1, 2],
  speed: [80, 200],
  angle: -90,
  spread: 40,
  emitter: { type: 'point' },
  gravity: [0, 0],
  drag: 0,
  turbulence: 0,
  turbulenceScale: 0.004,
  size: [6, 0],
  colors: ['#ffffff'],
  opacity: [1, 1, 0],
  shape: 'circle',
  spin: [0, 0],
  blend: 'normal',
  seed: 1,
  step: 1 / 60,
  emitUntil: Infinity,
};

/**
 * Deterministic particle system: each particle is re-simulated from its birth for every frame,
 * so frames can be rendered in any order (and in parallel) with identical results.
 */
export class ParticleNode extends SceneNode<{}> {
  config: ParticleConfig;
  constructor(config: Partial<ParticleConfig>, props: AnimProps<BaseProps>, opts: NodeOptions) {
    super('particles', props, opts);
    this.config = { ...DEFAULTS, ...config };
  }

  /** Particle states at local time t. */
  simulate(t: number): { x: number; y: number; size: number; color: string; alpha: number; rot: number; vx: number; vy: number }[] {
    const c = this.config;
    const out: ReturnType<ParticleNode['simulate']> = [];
    const noise = createNoise(c.seed);
    const maxLife = c.life[1];
    const births: number[] = [];
    for (let i = 0; i < c.burst; i++) births.push(0);
    if (c.rate > 0) {
      const first = Math.max(0, Math.ceil((t - maxLife) * c.rate));
      const last = Math.floor(Math.min(t, c.emitUntil) * c.rate);
      for (let k = first; k <= last; k++) births.push(k / c.rate);
    }
    births.forEach((born, idx) => {
      const id = born === 0 && idx < c.burst ? `b${idx}` : `r${Math.round(born * c.rate)}`;
      const r = createRandom(`${c.seed}:${id}`);
      const life = c.life[0] + (c.life[1] - c.life[0]) * r();
      const age = t - born;
      if (age < 0 || age > life) return;
      const ang = ((c.angle + (r() - 0.5) * c.spread) * Math.PI) / 180;
      const sp = c.speed[0] + (c.speed[1] - c.speed[0]) * r();
      let x = 0;
      let y = 0;
      const e = c.emitter;
      if (e.type === 'line') x = (r() - 0.5) * e.length;
      else if (e.type === 'circle') {
        const a = r() * Math.PI * 2;
        const rr = Math.sqrt(r()) * e.radius;
        x = Math.cos(a) * rr;
        y = Math.sin(a) * rr;
      } else if (e.type === 'rect') {
        x = (r() - 0.5) * e.size[0];
        y = (r() - 0.5) * e.size[1];
      }
      let vx = Math.cos(ang) * sp;
      let vy = Math.sin(ang) * sp;
      const spin = c.spin[0] + (c.spin[1] - c.spin[0]) * r();
      // Integrate with a fixed step from birth.
      const steps = Math.ceil(age / c.step);
      const dt = steps ? age / steps : 0;
      for (let s = 0; s < steps; s++) {
        if (c.turbulence) {
          const [cx, cy] = noise.curl2(x * c.turbulenceScale + idx * 0.01, y * c.turbulenceScale + (born + s * dt) * 0.3);
          vx += cx * c.turbulence * dt;
          vy += cy * c.turbulence * dt;
        }
        vx += c.gravity[0] * dt;
        vy += c.gravity[1] * dt;
        if (c.drag) {
          const k = Math.exp(-c.drag * dt);
          vx *= k;
          vy *= k;
        }
        x += vx * dt;
        y += vy * dt;
      }
      const p = age / life;
      const size = c.size[0] + (c.size[1] - c.size[0]) * p;
      const cols = c.colors;
      const ci = p * (cols.length - 1);
      const k = Math.min(cols.length - 2, Math.floor(ci));
      const color = cols.length === 1 ? cols[0]! : toCss(mixColor(cols[Math.max(0, k)]!, cols[Math.max(0, k) + 1]!, ci - Math.max(0, k)));
      const alpha = p < 0.5 ? c.opacity[0] + (c.opacity[1] - c.opacity[0]) * (p * 2) : c.opacity[1] + (c.opacity[2] - c.opacity[1]) * ((p - 0.5) * 2);
      out.push({ x, y, size, color, alpha, rot: spin * age, vx, vy });
    });
    return out;
  }
}

export function particles(config: Partial<ParticleConfig> = {}, opts: AnimProps<BaseProps> & NodeOptions = {}): ParticleNode {
  const { name, start, duration, end, at, filters, ...props } = opts;
  return new ParticleNode(config, props, { name, start, duration, end, at, filters });
}

registerDrawer('particles', (d) => {
  const n = d.node as ParticleNode;
  const ctx = d.ctx;
  const parts = n.simulate(d.frame.time);
  const base = ctx.globalAlpha;
  if (n.config.blend === 'add') ctx.globalCompositeOperation = 'lighter';
  for (const p of parts) {
    if (p.size <= 0 || p.alpha <= 0) continue;
    ctx.globalAlpha = base * Math.min(1, p.alpha);
    ctx.fillStyle = p.color;
    ctx.strokeStyle = p.color;
    const s = p.size;
    switch (n.config.shape) {
      case 'square':
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rot * Math.PI) / 180);
        ctx.fillRect(-s / 2, -s / 2, s, s);
        ctx.restore();
        break;
      case 'line':
      case 'spark': {
        const len = Math.hypot(p.vx, p.vy) * (n.config.shape === 'spark' ? 0.05 : 0.02) + s;
        const a = Math.atan2(p.vy, p.vx);
        ctx.lineWidth = Math.max(0.5, s * 0.35);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - Math.cos(a) * len, p.y - Math.sin(a) * len);
        ctx.stroke();
        break;
      }
      case 'star': {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rot * Math.PI) / 180);
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
          const r = i % 2 ? s * 0.22 : s / 2;
          const a = -Math.PI / 2 + (i * Math.PI) / 5;
          i ? ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r) : ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        break;
      }
      default:
        ctx.beginPath();
        ctx.arc(p.x, p.y, s / 2, 0, Math.PI * 2);
        ctx.fill();
    }
  }
  ctx.globalAlpha = base;
});

/** Presets for common effects. */
export const particlePresets = {
  confetti: (o: Partial<ParticleConfig> = {}) => particles({ burst: 150, rate: 0, life: [2.5, 4], speed: [300, 900], angle: -90, spread: 120, gravity: [0, 900], drag: 1.2, size: [14, 10], colors: ['#f43f5e', '#facc15', '#22d3ee', '#a855f7', '#4ade80'], shape: 'square', spin: [-720, 720], opacity: [1, 1, 0], ...o }),
  sparks: (o: Partial<ParticleConfig> = {}) => particles({ rate: 120, life: [0.4, 1], speed: [200, 600], spread: 70, gravity: [0, 600], size: [5, 1], colors: ['#fff7cc', '#ffb020', '#ff3d00'], shape: 'spark', blend: 'add', ...o }),
  snow: (o: Partial<ParticleConfig> = {}) => particles({ rate: 40, life: [6, 9], speed: [20, 60], angle: 90, spread: 30, emitter: { type: 'line', length: 2200 }, turbulence: 40, size: [6, 4], colors: ['#ffffff'], opacity: [0, 0.9, 0], ...o }),
  smoke: (o: Partial<ParticleConfig> = {}) => particles({ rate: 25, life: [2, 4], speed: [30, 80], angle: -90, spread: 30, turbulence: 120, size: [30, 160], colors: ['#9ca3af', '#374151'], opacity: [0, 0.35, 0], ...o }),
  fireflies: (o: Partial<ParticleConfig> = {}) => particles({ rate: 15, life: [3, 6], speed: [5, 25], spread: 360, emitter: { type: 'rect', size: [1600, 800] }, turbulence: 80, size: [5, 3], colors: ['#fef08a', '#bef264'], opacity: [0, 1, 0], blend: 'add', ...o }),
};
