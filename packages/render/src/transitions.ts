import { GroupNode, parseColor, resolveEasing, toSeconds, type EasingInput, type NodeOptions, type SceneNode, type TimeInput } from '@tasweerix/core';
import { GLSL_PRELUDE } from './gl';
import type { FilterContext } from './filters';
import type { UniformValue } from './gl';

export interface TransitionImpl {
  frag: string;
  uniforms?(params: Record<string, any>, fc: FilterContext): Record<string, UniformValue>;
}

const T = (body: string) => `${GLSL_PRELUDE}
uniform sampler2D uTo;
uniform float uProgress;
vec4 getFrom(vec2 uv) { return texture(uTex, uv); }
vec4 getTo(vec2 uv) { return texture(uTo, uv); }
vec4 blendP(vec4 a, vec4 b, float t) { return unpremul(mix(premul(a), premul(b), t)); }
${body}`;

const registry = new Map<string, TransitionImpl>();
export function registerTransition(name: string, impl: TransitionImpl): void {
  registry.set(name, impl);
}
export function getTransition(name: string): TransitionImpl | undefined {
  return registry.get(name);
}
export function transitionKinds(): string[] {
  return [...registry.keys()];
}

const dirVec = (d: string | undefined): [number, number] =>
  d === 'right' ? [1, 0] : d === 'up' ? [0, -1] : d === 'down' ? [0, 1] : [-1, 0];

registerTransition('crossfade', { frag: T(`void main(){ outColor = blendP(getFrom(vUv), getTo(vUv), uProgress); }`) });
registerTransition('dip', {
  frag: T(`uniform vec4 uColor; void main(){ float p = uProgress; vec4 c = p < 0.5 ? blendP(getFrom(vUv), uColor, p * 2.0) : blendP(uColor, getTo(vUv), (p - 0.5) * 2.0); outColor = c; }`),
  uniforms: (p) => ({ uColor: parseColor(p.color ?? '#000') as number[] }),
});
registerTransition('flash', {
  frag: T(`void main(){ float f = 1.0 - abs(uProgress - 0.5) * 2.0; vec4 c = blendP(getFrom(vUv), getTo(vUv), smoothstep(0.4, 0.6, uProgress)); outColor = vec4(mix(c.rgb, vec3(1.0), pow(f, 3.0)), c.a); }`),
});
registerTransition('wipe', {
  frag: T(`uniform vec2 uDir; uniform float uSoft;
void main(){ vec2 d = normalize(uDir); float proj = dot(vUv - 0.5, d) / (abs(d.x) * 0.5 + abs(d.y) * 0.5) * 0.5 + 0.5;
  float e = uProgress * (1.0 + uSoft) - uSoft; float m = smoothstep(e, e + uSoft, proj); outColor = blendP(getTo(vUv), getFrom(vUv), m); }`),
  uniforms: (p) => {
    const a = (((p.angle ?? 0) as number) * Math.PI) / 180;
    return { uDir: [Math.cos(a), Math.sin(a)], uSoft: p.softness ?? 0.05 };
  },
});
registerTransition('clock', {
  frag: T(`uniform float uSoft; void main(){ vec2 d = vUv - 0.5; float a = atan(d.x, -d.y) / 6.2831853 + 0.5; float m = smoothstep(uProgress - uSoft, uProgress, a); outColor = blendP(getTo(vUv), getFrom(vUv), m); }`),
  uniforms: (p) => ({ uSoft: p.softness ?? 0.01 }),
});
registerTransition('iris', {
  frag: T(`uniform float uSoft; uniform vec2 uCenter; void main(){ vec2 d = (vUv - uCenter) * vec2(uSize.x / uSize.y, 1.0); float r = length(d) / length(vec2(uSize.x / uSize.y, 1.0));
  float m = smoothstep(uProgress * (1.0 + uSoft) - uSoft, uProgress * (1.0 + uSoft), r); outColor = blendP(getTo(vUv), getFrom(vUv), m); }`),
  uniforms: (p, fc) => ({ uSoft: p.softness ?? 0.05, uCenter: p.center ? [p.center[0] / fc.frame.width, p.center[1] / fc.frame.height] : [0.5, 0.5] }),
});
registerTransition('slide', {
  frag: T(`uniform vec2 uDir; uniform float uPush;
void main(){ vec2 off = uDir * uProgress; vec2 toUv = vUv + uDir - off; vec2 fromUv = vUv - off * uPush;
  bool inTo = all(greaterThanEqual(toUv, vec2(0.0))) && all(lessThanEqual(toUv, vec2(1.0)));
  vec4 from = (all(greaterThanEqual(fromUv, vec2(0.0))) && all(lessThanEqual(fromUv, vec2(1.0)))) ? getFrom(fromUv) : vec4(0.0);
  outColor = inTo ? getTo(toUv) : from; }`),
  uniforms: (p) => {
    const d = dirVec(p.direction);
    return { uDir: [-d[0], -d[1]], uPush: p.push === false ? 0 : 1 };
  },
});
registerTransition('zoom', {
  frag: T(`uniform float uStrength; void main(){ float p = uProgress; vec2 c = vec2(0.5);
  vec2 fu = c + (vUv - c) / (1.0 + p * uStrength); vec2 tu = c + (vUv - c) * (1.0 + (1.0 - p) * uStrength);
  outColor = blendP(getFrom(fu), getTo(tu), smoothstep(0.3, 0.7, p)); }`),
  uniforms: (p) => ({ uStrength: p.strength ?? 1.5 }),
});
registerTransition('blur', {
  frag: T(`uniform float uAmount; void main(){ float b = sin(uProgress * 3.14159) * uAmount; vec4 a = vec4(0.0), c = vec4(0.0);
  for (int i = 0; i < 25; i++) { vec2 o = (vec2(float(i % 5), float(i / 5)) - 2.0) * b / uSize; a += premul(getFrom(vUv + o)); c += premul(getTo(vUv + o)); }
  outColor = unpremul(mix(a, c, smoothstep(0.2, 0.8, uProgress)) / 25.0); }`),
  uniforms: (p, fc) => ({ uAmount: (p.amount ?? 12) * fc.scale }),
});
registerTransition('pixelate', {
  frag: T(`uniform float uMax; void main(){ float s = max(1.0, sin(uProgress * 3.14159) * uMax); vec2 cell = s / uSize; vec2 uv = (floor(vUv / cell) + 0.5) * cell;
  outColor = uProgress < 0.5 ? getFrom(uv) : getTo(uv); }`),
  uniforms: (p, fc) => ({ uMax: (p.size ?? 48) * fc.scale }),
});
registerTransition('glitch', {
  frag: T(`void main(){ float p = uProgress; float a = sin(p * 3.14159); float row = floor(vUv.y * 30.0); float r = hash12(vec2(row, floor(p * 20.0)));
  vec2 uv = vUv; if (r < a * 0.7) uv.x += (hash12(vec2(row, 3.0 + floor(p * 20.0))) - 0.5) * a * 0.3;
  vec4 c = p < 0.5 ? getFrom(uv) : getTo(uv); float ca = a * 0.02; vec4 cr = p < 0.5 ? getFrom(uv + vec2(ca, 0.0)) : getTo(uv + vec2(ca, 0.0));
  outColor = vec4(cr.r, c.g, c.b, c.a); }`),
});
registerTransition('luma', {
  frag: T(`uniform float uSoft; uniform float uInvert; void main(){ float l = luma(getFrom(vUv).rgb); if (uInvert > 0.5) l = 1.0 - l;
  float m = smoothstep(uProgress * (1.0 + uSoft) - uSoft, uProgress * (1.0 + uSoft), l); outColor = blendP(getTo(vUv), getFrom(vUv), m); }`),
  uniforms: (p) => ({ uSoft: p.softness ?? 0.1, uInvert: p.invert ? 1 : 0 }),
});
registerTransition('ripple', {
  frag: T(`uniform float uAmp; void main(){ vec2 d = vUv - 0.5; float dist = length(d); float w = sin(dist * 40.0 - uProgress * 30.0) * uAmp * sin(uProgress * 3.14159);
  vec2 uv = vUv + normalize(d + 1e-5) * w; outColor = blendP(getFrom(uv), getTo(uv), smoothstep(0.2, 0.8, uProgress)); }`),
  uniforms: (p) => ({ uAmp: p.amplitude ?? 0.03 }),
});
registerTransition('spin', {
  frag: T(`void main(){ float p = uProgress; float a = p * 6.2831853; vec2 c = vUv - 0.5; float s = 1.0 + sin(p * 3.14159) * 1.5;
  vec2 r = mat2(cos(a), -sin(a), sin(a), cos(a)) * c / s + 0.5; vec4 col = p < 0.5 ? getFrom(r) : getTo(r);
  bool inside = all(greaterThanEqual(r, vec2(0.0))) && all(lessThanEqual(r, vec2(1.0))); outColor = inside ? col : vec4(0.0); }`),
});

export interface TransitionSpec {
  type: string;
  duration: number;
  ease: (t: number) => number;
  params: Record<string, unknown>;
  /** Custom GLSL body for type 'custom'. */
  source?: string;
}

export interface TransitionInput {
  type?: string;
  duration?: TimeInput;
  ease?: EasingInput;
  /** Custom GLSL body (getFrom(uv), getTo(uv), uProgress available). */
  source?: string;
  [param: string]: unknown;
}

function spec(t: TransitionInput | string | undefined): TransitionSpec {
  const o = typeof t === 'string' ? { type: t } : (t ?? {});
  const { type = 'crossfade', duration = 0.5, ease, source, ...params } = o;
  return { type: source ? 'custom' : type, duration: toSeconds(duration), ease: resolveEasing(ease ?? 'inOutCubic'), params, source };
}

/** A sequence whose consecutive items overlap and blend through GPU transitions. */
export class TransitionGroup extends GroupNode {
  transitions: TransitionSpec[] = [];
}

/**
 * Plays clips in order with transitions between them.
 *   transition.sequence([a, b, c], { type: 'wipe', duration: '0.6s', angle: 45 })
 *   transition.chain(a, 'zoom', b, { type: 'glitch', duration: 0.3 }, c)
 */
export const transition = {
  sequence(items: SceneNode[], t: TransitionInput | string = {}, opts: NodeOptions = {}): TransitionGroup {
    const s = spec(t);
    return build(items, items.slice(1).map(() => s), opts);
  },
  chain(...parts: (SceneNode | TransitionInput | string)[]): TransitionGroup {
    const items: SceneNode[] = [];
    const specs: TransitionSpec[] = [];
    let pending: TransitionSpec | null = null;
    for (const p of parts) {
      if (typeof p === 'object' && p !== null && 'kind' in p && 'children' in p) {
        if (items.length) specs.push(pending ?? spec({ type: 'cut', duration: 0 }));
        items.push(p as SceneNode);
        pending = null;
      } else pending = spec(p as TransitionInput | string);
    }
    return build(items, specs, {});
  },
};

function build(items: SceneNode[], specs: TransitionSpec[], opts: NodeOptions): TransitionGroup {
  const g = new TransitionGroup('xseq', {}, opts);
  g.add(...items);
  g.transitions = specs;
  g.layout = (node) => {
    let t = 0;
    let end = 0;
    node.children.forEach((c, i) => {
      if (i > 0) t -= specs[i - 1]!.duration;
      c.start = t;
      const d = c.effectiveDuration();
      if (!Number.isFinite(d)) throw new Error(`transition sequence item "${c.name ?? c.id}" needs a finite duration`);
      t += d;
      end = Math.max(end, t);
    });
    if (node.duration === undefined) node.naturalDuration = end;
  };
  return g;
}

export const customTransitionFrag = (body: string) => T(body);
