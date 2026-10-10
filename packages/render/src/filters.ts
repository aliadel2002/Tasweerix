import { parseColor, type FrameContext } from '@tasweerix/core';
import { GLSL_PRELUDE, type GLPipeline, type Tex, type UniformValue } from './gl';
import type { AssetProvider } from './assets';

export interface FilterContext {
  gl: GLPipeline;
  frame: FrameContext;
  assets: AssetProvider;
  /** Output pixels per composition pixel. */
  scale: number;
}

export interface FilterImpl {
  apply(input: Tex, params: Record<string, any>, fc: FilterContext): Tex;
  /** Optional async preparation (e.g. loading LUT files). */
  prepare?(params: Record<string, any>, assets: AssetProvider): Promise<void>;
  /**
   * Per-pixel form of the filter, when it has one. Consecutive per-pixel filters are fused into a
   * single pass (see `fusePointStages`), so a grade stack costs one full-frame pass, not one each.
   */
  point?(params: Record<string, any>, fc: FilterContext): PointStage | undefined;
}

/** A per-pixel filter step: a shader body whose only read of the input is `texture(uTex, vUv)`. */
export interface PointStage {
  /** Fragment shader body without the prelude, defining `main` and writing `outColor`. */
  body: string;
  uniforms: Record<string, UniformValue>;
  /** Frees per-call resources (data textures) once the pass has run. */
  dispose?: () => void;
}

const registry = new Map<string, FilterImpl>();
export function registerFilter(kind: string, impl: FilterImpl): void {
  registry.set(kind, impl);
}
export function getFilter(kind: string): FilterImpl | undefined {
  return registry.get(kind);
}
export function filterKinds(): string[] {
  return [...registry.keys()];
}

const frag = (body: string) => `${GLSL_PRELUDE}\n${body}`;
const color4 = (c: unknown, fallback = '#000') => parseColor((c ?? fallback) as string) as number[];

/** Helper for single-pass filters. Bodies that only read `texture(uTex, vUv)` also fuse as point stages. */
function single(body: string, uniforms: (p: Record<string, any>, fc: FilterContext) => Record<string, UniformValue>): FilterImpl {
  const src = frag(body);
  return {
    apply(input, p, fc) {
      const out = fc.gl.run(src, { uTex: input, ...uniforms(p, fc) });
      return out;
    },
    point: isPointwise(body) ? (p, fc) => ({ body, uniforms: uniforms(p, fc) }) : undefined,
  };
}

/** Runs a point stage on its own (the `apply` of filters defined by `point`). */
function pointApply(input: Tex, stage: PointStage, gl: GLPipeline): Tex {
  const out = gl.run(frag(stage.body), { uTex: input, ...stage.uniforms });
  stage.dispose?.();
  return out;
}

// ------------------------------------------------------------------ Pass fusion

const POINT_READ = /texture\(\s*uTex\s*,\s*vUv\s*\)/g;

/** True when a shader body reads its input only at the current pixel, so it can share a pass. */
export function isPointwise(body: string): boolean {
  const reads = body.match(POINT_READ)?.length ?? 0;
  const refs = body.match(/\buTex\b/g)?.length ?? 0;
  return reads > 0 && reads === refs && !/\breturn\b|gl_FragCoord|\bdiscard\b/.test(body);
}

interface StageNames {
  uniforms: Set<string>;
  src: string;
}

/** Rewrites a point-stage body as `vec4 _sN(vec4 _in)`, suffixing its uniforms and helpers with `_sN`. */
function stageFunction(body: string, i: number): StageNames {
  const uniforms = new Set<string>();
  for (const m of body.matchAll(/\buniform\s+\w+\s+([^;]+);/g)) {
    for (const name of m[1]!.split(',')) uniforms.add(name.trim().replace(/\[.*$/, ''));
  }
  const helpers = new Set<string>();
  for (const m of body.matchAll(/\b(?:float|int|bool|[iu]?vec[234]|mat[234]|void)\s+(\w+)\s*\([^)]*\)\s*\{/g)) if (m[1] !== 'main') helpers.add(m[1]!);
  let src = body;
  for (const name of [...uniforms, ...helpers]) src = src.replace(new RegExp(`\\b${name}\\b`, 'g'), `${name}_s${i}`);
  src = src.replace(POINT_READ, '_in').replace(/\boutColor\b/g, '_out');
  const head = src.match(/\bvoid\s+main\s*\(\s*(?:void)?\s*\)\s*\{/);
  if (!head) throw new Error('Point stage has no main()');
  const open = head.index! + head[0].length;
  let depth = 1;
  let close = open;
  for (; close < src.length && depth > 0; close++) {
    if (src[close] === '{') depth++;
    else if (src[close] === '}') depth--;
  }
  src = `${src.slice(0, head.index!)}vec4 _s${i}(vec4 _in) {\n  vec4 _out = _in;${src.slice(open, close - 1)}\n  return _out;\n}${src.slice(close)}`;
  return { uniforms, src };
}

/**
 * Whether `next` may join a fused pass. On software GL (SwiftShader) a 3D LUT lookup in the same
 * shader as a long stage such as `grade` runs slower than two passes, so those stay apart there.
 */
export function canSharePass(group: PointStage[], next: PointStage, software: boolean): boolean {
  if (!software) return true;
  const lut = (s: PointStage) => /\bsampler3D\b/.test(s.body);
  const long = (s: PointStage) => s.body.length > 1200;
  return !((lut(next) && group.some(long)) || (long(next) && group.some(lut)));
}

const fusedCache = new Map<string, { frag: string; names: Set<string>[] }>();

/**
 * Combines consecutive point stages into one pass. Each stage keeps its own uniforms (suffixed per
 * stage) and is blended by its `amount` the way separate passes are. Intermediate values stay in
 * shader precision instead of being written to a texture between filters.
 */
export function fusePointStages(input: Tex, stages: (PointStage & { amount: number })[]): { frag: string; uniforms: Record<string, UniformValue>; dispose(): void } {
  const key = stages.map((s) => s.body).join('\u0000');
  let fused = fusedCache.get(key);
  if (!fused) {
    const fns = stages.map((s, i) => stageFunction(s.body, i));
    const calls = stages.map((_, i) => `  { vec4 o = _s${i}(c); c = uAmt${i} >= 1.0 ? o : unpremul(mix(premul(c), premul(o), uAmt${i})); }`).join('\n');
    const amts = stages.map((_, i) => `uniform float uAmt${i};`).join('\n');
    fused = {
      frag: frag(`${amts}\n${fns.map((f) => f.src).join('\n')}\nvoid main() {\n  vec4 c = texture(uTex, vUv);\n${calls}\n  outColor = c;\n}`),
      names: fns.map((f) => f.uniforms),
    };
    fusedCache.set(key, fused);
  }
  const uniforms: Record<string, UniformValue> = { uTex: input };
  stages.forEach((s, i) => {
    uniforms[`uAmt${i}`] = s.amount;
    for (const [k, v] of Object.entries(s.uniforms)) {
      const base = k.replace(/\[0\]$/, '');
      if (fused!.names[i]!.has(base)) uniforms[k === base ? `${base}_s${i}` : `${base}_s${i}[0]`] = v;
    }
  });
  return { frag: fused.frag, uniforms, dispose: () => stages.forEach((s) => s.dispose?.()) };
}

// ------------------------------------------------------------------ Blur family

/** Separable gaussian shader specialized for a pair count (linear-sampling: 2 taps per fetch). */
const blurShaders = new Map<number, string>();
function blurShader(pairs: number): string {
  let s = blurShaders.get(pairs);
  if (!s) {
    s = frag(`
uniform vec2 uDir;
uniform float uW0;
uniform float uWeights[${pairs}];
uniform float uOffsets[${pairs}];
void main() {
  vec4 acc = sampleP(uTex, vUv) * uW0;
  for (int i = 0; i < ${pairs}; i++) {
    vec2 o = uDir * uOffsets[i] / uSize;
    acc += (sampleP(uTex, vUv + o) + sampleP(uTex, vUv - o)) * uWeights[i];
  }
  outColor = unpremul(acc);
}`);
    blurShaders.set(pairs, s);
  }
  return s;
}

/** Gaussian weights folded into bilinear pairs. */
function blurKernel(sigma: number): { w0: number; weights: number[]; offsets: number[] } {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const w: number[] = [];
  for (let i = 0; i <= r; i++) w.push(Math.exp((-0.5 * i * i) / (sigma * sigma)));
  const norm = w[0]! + 2 * w.slice(1).reduce((a, b) => a + b, 0);
  const weights: number[] = [];
  const offsets: number[] = [];
  for (let i = 1; i <= r; i += 2) {
    const a = w[i]! / norm;
    const b = (w[i + 1] ?? 0) / norm;
    weights.push(a + b);
    offsets.push(a + b > 0 ? (i * a + (i + 1) * b) / (a + b) : i);
  }
  return { w0: w[0]! / norm, weights, offsets };
}

const DOWN_FRAG = frag(`
void main() {
  vec2 o = 0.5 / uSize;
  vec4 c = sampleP(uTex, vUv + vec2(-o.x, -o.y)) + sampleP(uTex, vUv + vec2(o.x, -o.y)) + sampleP(uTex, vUv + vec2(-o.x, o.y)) + sampleP(uTex, vUv + vec2(o.x, o.y));
  outColor = unpremul(c * 0.25);
}`);

const COPY = frag(`void main(){ outColor = texture(uTex, vUv); }`);

/** Gaussian blur (radius ≈ 2σ, in output pixels), downsampling for larger radii. */
export function gaussianBlur(gl: GLPipeline, input: Tex, radius: number, dirMask: [number, number] = [1, 1]): Tex {
  if (radius <= 0.01) return gl.run(COPY, { uTex: input });
  let src = input;
  let factor = 1;
  const owned: Tex[] = [];
  while (radius / factor > 8 && src.width > 16 && src.height > 16) {
    const t = gl.target(Math.max(1, Math.ceil(src.width / 2)), Math.max(1, Math.ceil(src.height / 2)));
    gl.run(DOWN_FRAG, { uTex: src }, t);
    owned.push(t);
    src = t;
    factor *= 2;
  }
  const sigma = Math.max(0.3, radius / factor / 2);
  const k = blurKernel(sigma);
  const shader = blurShader(k.weights.length);
  const uniforms = { uW0: k.w0, 'uWeights[0]': k.weights, 'uOffsets[0]': k.offsets };
  let a = src;
  if (dirMask[0]) {
    a = gl.run(shader, { uTex: src, uDir: [1, 0], ...uniforms }, gl.target(src.width, src.height));
    owned.push(a);
  }
  let b = a;
  if (dirMask[1]) {
    b = gl.run(shader, { uTex: a, uDir: [0, 1], ...uniforms }, gl.target(src.width, src.height));
    owned.push(b);
  }
  const out = gl.run(COPY, { uTex: b }, gl.target(input.width, input.height));
  owned.forEach((t) => gl.release(t));
  return out;
}

registerFilter('blur', {
  apply: (input, p, fc) => gaussianBlur(fc.gl, input, (p.radius ?? 8) * fc.scale, [p.horizontal === false ? 0 : 1, p.vertical === false ? 0 : 1]),
});

registerFilter(
  'directionalBlur',
  single(
    `uniform vec2 uVec; uniform float uSamples;
void main(){
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 64; i++) {
    if (float(i) >= uSamples) break;
    float t = float(i) / max(uSamples - 1.0, 1.0) - 0.5;
    acc += sampleP(uTex, vUv + uVec * t / uSize);
  }
  outColor = unpremul(acc / uSamples);
}`,
    (p, fc) => {
      const a = ((p.angle ?? 0) * Math.PI) / 180;
      const d = (p.distance ?? 20) * fc.scale;
      return { uVec: [Math.cos(a) * d, Math.sin(a) * d], uSamples: Math.min(64, Math.max(2, Math.ceil(d))) };
    },
  ),
);

registerFilter(
  'zoomBlur',
  single(
    `uniform vec2 uCenter; uniform float uAmount;
void main(){
  vec4 acc = vec4(0.0);
  vec2 dir = vUv - uCenter;
  for (int i = 0; i < 48; i++) {
    float t = float(i) / 47.0;
    acc += sampleP(uTex, uCenter + dir * (1.0 - uAmount * t));
  }
  outColor = unpremul(acc / 48.0);
}`,
    (p, fc) => ({ uCenter: [(p.center?.[0] ?? fc.frame.width / 2) / fc.frame.width, (p.center?.[1] ?? fc.frame.height / 2) / fc.frame.height], uAmount: p.amount ?? 0.2 }),
  ),
);

registerFilter(
  'radialBlur',
  single(
    `uniform vec2 uCenter; uniform float uAngle;
void main(){
  vec4 acc = vec4(0.0);
  vec2 asp = vec2(uSize.x / uSize.y, 1.0);
  vec2 d = (vUv - uCenter) * asp;
  for (int i = 0; i < 48; i++) {
    float a = (float(i) / 47.0 - 0.5) * uAngle;
    float c = cos(a), s = sin(a);
    vec2 r = vec2(d.x * c - d.y * s, d.x * s + d.y * c) / asp;
    acc += sampleP(uTex, uCenter + r);
  }
  outColor = unpremul(acc / 48.0);
}`,
    (p, fc) => ({
      uCenter: [(p.center?.[0] ?? fc.frame.width / 2) / fc.frame.width, (p.center?.[1] ?? fc.frame.height / 2) / fc.frame.height],
      uAngle: ((p.angle ?? 10) * Math.PI) / 180,
    }),
  ),
);

const UNSHARP_FRAG = frag(`
uniform sampler2D uBlur; uniform float uAmount; uniform float uThreshold;
void main(){
  vec4 o = texture(uTex, vUv);
  vec4 b = texture(uBlur, vUv);
  vec3 diff = o.rgb - b.rgb;
  vec3 m = step(vec3(uThreshold), abs(diff));
  outColor = vec4(clamp(o.rgb + diff * uAmount * m, 0.0, 1.0), o.a);
}`);
const unsharp: FilterImpl = {
  apply(input, p, fc) {
    const blur = gaussianBlur(fc.gl, input, (p.radius ?? 2) * fc.scale);
    const out = fc.gl.run(UNSHARP_FRAG, { uTex: input, uBlur: blur, uAmount: p.amount ?? 1, uThreshold: p.threshold ?? 0 });
    fc.gl.release(blur);
    return out;
  },
};
registerFilter('unsharp', unsharp);
registerFilter('sharpen', { apply: (i, p, fc) => unsharp.apply(i, { radius: 1, amount: p.amount ?? 0.6, threshold: 0 }, fc) });

// ------------------------------------------------------------------ Color

/** Comprehensive color grade (photo + video). */
registerFilter(
  'grade',
  single(
    `uniform float uExposure, uContrast, uSaturation, uVibrance, uTemp, uTint, uHighlights, uShadows, uWhites, uBlacks, uHue, uBrightness, uGammaAll, uPivot;
uniform vec3 uLift, uGamma, uGain;
void main(){
  vec4 c = texture(uTex, vUv);
  vec3 col = c.rgb;
  // linearize for exposure / white balance
  vec3 lin = pow(col, vec3(2.2));
  lin *= exp2(uExposure);
  lin *= vec3(1.0 + uTemp * 0.2 + uTint * 0.05, 1.0 - uTint * 0.1, 1.0 - uTemp * 0.2 + uTint * 0.05);
  col = pow(max(lin, 0.0), vec3(1.0 / 2.2));
  col += uBrightness;
  // tone regions
  float l = luma(col);
  float sh = 1.0 - smoothstep(0.0, 0.5, l);
  float hi = smoothstep(0.5, 1.0, l);
  col += col * uShadows * sh * 0.8 + uHighlights * hi * 0.5 * (uHighlights > 0.0 ? (1.0 - col) : col);
  col = mix(vec3(uBlacks * 0.15), vec3(1.0 + uWhites * 0.15), col);
  // contrast around pivot
  col = (col - uPivot) * (1.0 + uContrast) + uPivot;
  // lift / gamma / gain (ASC-CDL style)
  col = col * uGain + uLift * (1.0 - col);
  col = pow(max(col, 0.0), 1.0 / max(uGamma * uGammaAll, vec3(0.01)));
  // hue rotation
  if (abs(uHue) > 0.0001) { vec3 hsv = rgb2hsv(clamp(col, 0.0, 1.0)); hsv.x = fract(hsv.x + uHue / 360.0); col = hsv2rgb(hsv); }
  // saturation & vibrance
  float g = luma(col);
  col = mix(vec3(g), col, 1.0 + uSaturation);
  float mx = max(col.r, max(col.g, col.b));
  float mn = min(col.r, min(col.g, col.b));
  float sat = mx - mn;
  col = mix(vec3(luma(col)), col, 1.0 + uVibrance * (1.0 - sat));
  outColor = vec4(clamp(col, 0.0, 1.0), c.a);
}`,
    (p) => ({
      uExposure: p.exposure ?? 0,
      uContrast: p.contrast ?? 0,
      uSaturation: p.saturation ?? 0,
      uVibrance: p.vibrance ?? 0,
      uTemp: p.temperature ?? 0,
      uTint: p.tint ?? 0,
      uHighlights: p.highlights ?? 0,
      uShadows: p.shadows ?? 0,
      uWhites: p.whites ?? 0,
      uBlacks: p.blacks ?? 0,
      uHue: p.hue ?? 0,
      uBrightness: p.brightness ?? 0,
      uGammaAll: p.gamma ?? 1,
      uPivot: p.pivot ?? 0.435,
      uLift: p.lift ?? [0, 0, 0],
      uGamma: p.gammaRGB ?? [1, 1, 1],
      uGain: p.gain ?? [1, 1, 1],
    }),
  ),
);

registerFilter(
  'levels',
  single(
    `uniform vec3 uInBlack, uInWhite, uGammaV, uOutBlack, uOutWhite;
void main(){
  vec4 c = texture(uTex, vUv);
  vec3 v = clamp((c.rgb - uInBlack) / max(uInWhite - uInBlack, vec3(1e-4)), 0.0, 1.0);
  v = pow(v, 1.0 / uGammaV);
  outColor = vec4(mix(uOutBlack, uOutWhite, v), c.a);
}`,
    (p) => {
      const v3 = (x: unknown, d: number) => (Array.isArray(x) ? x : [x ?? d, x ?? d, x ?? d]);
      return {
        uInBlack: v3(p.inBlack, 0),
        uInWhite: v3(p.inWhite, 1),
        uGammaV: v3(p.gamma, 1),
        uOutBlack: v3(p.outBlack, 0),
        uOutWhite: v3(p.outWhite, 1),
      };
    },
  ),
);

/** Monotone cubic interpolation through control points (x, y in 0..1) → 256-entry table. */
export function curveTable(points: [number, number][] | undefined): Float32Array {
  const out = new Float32Array(256);
  const pts = (points && points.length ? [...points] : [[0, 0], [1, 1]] as [number, number][]).sort((a, b) => a[0] - b[0]);
  if (pts[0]![0] > 0) pts.unshift([0, pts[0]![1]]);
  if (pts[pts.length - 1]![0] < 1) pts.push([1, pts[pts.length - 1]![1]]);
  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const d: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1]! - ys[i]!) / (xs[i + 1]! - xs[i]! || 1e-6));
  m.push(d[0] ?? 0);
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) / 2);
  m.push(d[n - 2] ?? 0);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / d[i]!;
    const b = m[i + 1]! / d[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i]!;
      m[i + 1] = t * b * d[i]!;
    }
  }
  for (let k = 0; k < 256; k++) {
    const x = k / 255;
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]!) i++;
    const h = xs[i + 1]! - xs[i]! || 1e-6;
    const t = Math.min(1, Math.max(0, (x - xs[i]!) / h));
    const t2 = t * t;
    const t3 = t2 * t;
    const y = (2 * t3 - 3 * t2 + 1) * ys[i]! + (t3 - 2 * t2 + t) * h * m[i]! + (-2 * t3 + 3 * t2) * ys[i + 1]! + (t3 - t2) * h * m[i + 1]!;
    out[k] = Math.min(1, Math.max(0, y));
  }
  return out;
}

const CURVES_BODY = `
uniform sampler2D uCurve;
// Linear interpolation between table entries (the texture is NEAREST-filtered).
float cv(float x, float row) {
  float f = clamp(x, 0.0, 1.0) * 255.0;
  int i = int(floor(f));
  return mix(texelFetch(uCurve, ivec2(i, int(row)), 0).r, texelFetch(uCurve, ivec2(min(i + 1, 255), int(row)), 0).r, f - float(i));
}
void main(){
  vec4 c = texture(uTex, vUv);
  vec3 v = vec3(cv(c.r, 0.0), cv(c.g, 0.0), cv(c.b, 0.0));
  v = vec3(cv(v.r, 1.0), cv(v.g, 2.0), cv(v.b, 3.0));
  outColor = vec4(v, c.a);
}`;
const curves: FilterImpl = {
  point(p, fc) {
    const rows = [p.rgb, p.r, p.g, p.b].map((pts) => curveTable(pts));
    const data = new Float32Array(256 * 4 * 4);
    rows.forEach((row, r) => row.forEach((v, i) => data.set([v, v, v, 1], (r * 256 + i) * 4)));
    const tex = fc.gl.dataTexture(256, 4, data);
    return { body: CURVES_BODY, uniforms: { uCurve: tex }, dispose: () => fc.gl.deleteTex(tex) };
  },
  apply: (input, p, fc) => pointApply(input, curves.point!(p, fc)!, fc.gl),
};
registerFilter('curves', curves);

/** Hue/Saturation/Lightness adjustments, globally or per hue range. */
registerFilter(
  'hsl',
  single(
    `uniform float uHue, uSat, uLight; uniform float uRangeCenter, uRangeWidth, uUseRange;
void main(){
  vec4 c = texture(uTex, vUv);
  vec3 hsv = rgb2hsv(c.rgb);
  float w = 1.0;
  if (uUseRange > 0.5) {
    float d = abs(fract(hsv.x - uRangeCenter / 360.0 + 0.5) - 0.5) * 360.0;
    w = (1.0 - smoothstep(uRangeWidth * 0.5, uRangeWidth, d)) * smoothstep(0.02, 0.15, hsv.y);
  }
  hsv.x = fract(hsv.x + w * uHue / 360.0);
  hsv.y = clamp(hsv.y * (1.0 + w * uSat), 0.0, 1.0);
  vec3 rgb = hsv2rgb(hsv);
  rgb = uLight >= 0.0 ? mix(rgb, vec3(1.0), w * uLight) : mix(rgb, vec3(0.0), -w * uLight);
  outColor = vec4(rgb, c.a);
}`,
    (p) => {
      const ranges: Record<string, number> = { reds: 0, oranges: 30, yellows: 60, greens: 120, aquas: 180, cyans: 180, blues: 240, purples: 280, magentas: 310 };
      const r = typeof p.range === 'string' ? ranges[p.range] : p.range;
      return {
        uHue: p.hue ?? 0,
        uSat: p.saturation ?? 0,
        uLight: p.lightness ?? 0,
        uUseRange: r === undefined ? 0 : 1,
        uRangeCenter: r ?? 0,
        uRangeWidth: p.width ?? 60,
      };
    },
  ),
);

/** Parses an Adobe/Resolve .cube 3D LUT. */
export function parseCubeLUT(text: string): { size: number; data: Float32Array; domainMin: number[]; domainMax: number[] } {
  let size = 0;
  let domainMin = [0, 0, 0];
  let domainMax = [1, 1, 1];
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('TITLE')) continue;
    if (line.startsWith('LUT_3D_SIZE')) size = parseInt(line.split(/\s+/)[1]!, 10);
    else if (line.startsWith('DOMAIN_MIN')) domainMin = line.split(/\s+/).slice(1).map(Number);
    else if (line.startsWith('DOMAIN_MAX')) domainMax = line.split(/\s+/).slice(1).map(Number);
    else if (/^[-\d.]/.test(line)) values.push(...line.split(/\s+/).slice(0, 3).map(Number));
  }
  if (!size || values.length < size * size * size * 3) throw new Error('Invalid .cube LUT');
  const data = new Float32Array(size * size * size * 4);
  for (let i = 0; i < size * size * size; i++) data.set([values[i * 3]!, values[i * 3 + 1]!, values[i * 3 + 2]!, 1], i * 4);
  return { size, data, domainMin, domainMax };
}

const LUT_BODY = `
uniform sampler3D uLut; uniform float uSizeL, uIntensity;
void main(){
  vec4 c = texture(uTex, vUv);
  vec3 coord = clamp(c.rgb, 0.0, 1.0) * ((uSizeL - 1.0) / uSizeL) + 0.5 / uSizeL;
  vec3 g = texture(uLut, coord).rgb;
  outColor = vec4(mix(c.rgb, g, uIntensity), c.a);
}`;
const lutCache = new Map<string, ReturnType<typeof parseCubeLUT>>();
const lut: FilterImpl = {
  async prepare(p, assets) {
    if (typeof p.src === 'string' && !lutCache.has(p.src)) lutCache.set(p.src, parseCubeLUT(await assets.loadText(p.src)));
  },
  point(p, fc) {
    const cube = typeof p.src === 'string' ? lutCache.get(p.src) : (p.lut as ReturnType<typeof parseCubeLUT>);
    if (!cube) return undefined;
    const tex = fc.gl.texture3D(cube.size, cube.data);
    return { body: LUT_BODY, uniforms: { uLut: tex, uSizeL: cube.size, uIntensity: p.intensity ?? 1 }, dispose: () => fc.gl.deleteTex(tex) };
  },
  apply(input, p, fc) {
    const stage = lut.point!(p, fc);
    return stage ? pointApply(input, stage, fc.gl) : fc.gl.run(COPY, { uTex: input });
  },
};
registerFilter('lut', lut);

registerFilter('invert', single(`void main(){ vec4 c = texture(uTex, vUv); outColor = vec4(1.0 - c.rgb, c.a); }`, () => ({})));
registerFilter(
  'grayscale',
  single(`uniform float uAmount; void main(){ vec4 c = texture(uTex, vUv); outColor = vec4(mix(c.rgb, vec3(luma(c.rgb)), uAmount), c.a); }`, (p) => ({ uAmount: p.amount ?? 1 })),
);
registerFilter(
  'sepia',
  single(
    `uniform float uAmount; void main(){ vec4 c = texture(uTex, vUv);
  vec3 s = vec3(dot(c.rgb, vec3(0.393, 0.769, 0.189)), dot(c.rgb, vec3(0.349, 0.686, 0.168)), dot(c.rgb, vec3(0.272, 0.534, 0.131)));
  outColor = vec4(mix(c.rgb, min(s, 1.0), uAmount), c.a); }`,
    (p) => ({ uAmount: p.amount ?? 1 }),
  ),
);
registerFilter(
  'tint',
  single(`uniform vec4 uColor; uniform float uAmount; void main(){ vec4 c = texture(uTex, vUv); outColor = vec4(mix(c.rgb, uColor.rgb * luma(c.rgb) * 1.5, uAmount), c.a); }`, (p) => ({
    uColor: color4(p.color, '#ff8800'),
    uAmount: p.amount ?? 0.5,
  })),
);
registerFilter(
  'colorize',
  single(`uniform vec4 uColor; uniform float uAmount; void main(){ vec4 c = texture(uTex, vUv); outColor = vec4(mix(c.rgb, uColor.rgb, uAmount * uColor.a), c.a); }`, (p) => ({
    uColor: color4(p.color, '#ffffff'),
    uAmount: p.amount ?? 1,
  })),
);
registerFilter(
  'duotone',
  single(`uniform vec4 uDark, uLight; void main(){ vec4 c = texture(uTex, vUv); outColor = vec4(mix(uDark.rgb, uLight.rgb, luma(c.rgb)), c.a); }`, (p) => ({
    uDark: color4(p.dark, '#1b1f6b'),
    uLight: color4(p.light, '#ffd166'),
  })),
);
const GRADMAP_BODY = `uniform sampler2D uMap;
void main(){
  vec4 c = texture(uTex, vUv);
  float f = clamp(luma(c.rgb), 0.0, 1.0) * 255.0;
  int i = int(floor(f));
  vec3 m = mix(texelFetch(uMap, ivec2(i, 0), 0).rgb, texelFetch(uMap, ivec2(min(i + 1, 255), 0), 0).rgb, f - float(i));
  outColor = vec4(m, c.a);
}`;
const gradientMap: FilterImpl = {
  point(p, fc) {
    const stops: [number, string][] = (p.stops ?? [[0, '#000'], [1, '#fff']]).map((s: string | [number, string], i: number, arr: unknown[]) =>
      Array.isArray(s) ? s : [i / Math.max(1, arr.length - 1), s],
    );
    const data = new Float32Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      const x = i / 255;
      let k = 0;
      while (k < stops.length - 2 && x > stops[k + 1]![0]) k++;
      const a = stops[k]!;
      const b = stops[Math.min(k + 1, stops.length - 1)]!;
      const t = b[0] === a[0] ? 0 : Math.min(1, Math.max(0, (x - a[0]) / (b[0] - a[0])));
      const ca = parseColor(a[1]);
      const cb = parseColor(b[1]);
      data.set([ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t, 1], i * 4);
    }
    const tex = fc.gl.dataTexture(256, 1, data);
    return { body: GRADMAP_BODY, uniforms: { uMap: tex }, dispose: () => fc.gl.deleteTex(tex) };
  },
  apply: (input, p, fc) => pointApply(input, gradientMap.point!(p, fc)!, fc.gl),
};
registerFilter('gradientMap', gradientMap);
registerFilter(
  'posterize',
  single(`uniform float uLevels; void main(){ vec4 c = texture(uTex, vUv); outColor = vec4(floor(c.rgb * uLevels + 0.5) / uLevels, c.a); }`, (p) => ({ uLevels: Math.max(2, (p.levels ?? 6) - 1) })),
);
registerFilter(
  'threshold',
  single(`uniform float uT; void main(){ vec4 c = texture(uTex, vUv); outColor = vec4(vec3(step(uT, luma(c.rgb))), c.a); }`, (p) => ({ uT: p.level ?? 0.5 })),
);
registerFilter(
  'opacity',
  single(`uniform float uA; void main(){ vec4 c = texture(uTex, vUv); outColor = vec4(c.rgb, c.a * uA); }`, (p) => ({ uA: p.amount ?? 1 })),
);

// ------------------------------------------------------------------ Keying

registerFilter(
  'chromaKey',
  single(
    `uniform vec4 uKey; uniform float uSim, uSmooth, uSpill;
vec2 toUV(vec3 c) { return vec2(-0.169 * c.r - 0.331 * c.g + 0.5 * c.b, 0.5 * c.r - 0.419 * c.g - 0.081 * c.b); }
void main(){
  vec4 c = texture(uTex, vUv);
  float d = distance(toUV(c.rgb), toUV(uKey.rgb));
  float a = smoothstep(uSim, uSim + uSmooth, d);
  vec3 col = c.rgb;
  // spill suppression: pull key-dominant channel toward the others
  float spillVal = pow(clamp(1.0 - smoothstep(uSim, uSim + uSmooth + 0.25, d), 0.0, 1.0), 1.5) * uSpill;
  float gray = luma(col);
  col = mix(col, vec3(gray), spillVal);
  outColor = vec4(col, c.a * a);
}`,
    (p) => ({ uKey: color4(p.color, '#00ff00'), uSim: p.similarity ?? 0.12, uSmooth: p.smoothness ?? 0.08, uSpill: p.spill ?? 0.5 }),
  ),
);
registerFilter(
  'lumaKey',
  single(
    `uniform float uT, uSoft, uInv; void main(){ vec4 c = texture(uTex, vUv); float l = luma(c.rgb); float a = smoothstep(uT - uSoft, uT + uSoft, l); if (uInv > 0.5) a = 1.0 - a; outColor = vec4(c.rgb, c.a * a); }`,
    (p) => ({ uT: p.threshold ?? 0.1, uSoft: p.softness ?? 0.05, uInv: p.invert ? 1 : 0 }),
  ),
);

// ------------------------------------------------------------------ Light & stylize

const GLOW_THRESH = frag(`uniform float uT; uniform vec4 uColor; uniform float uUseColor;
void main(){ vec4 c = texture(uTex, vUv); float l = luma(c.rgb); float k = smoothstep(uT, uT + 0.1, l) * c.a; vec3 col = uUseColor > 0.5 ? uColor.rgb : c.rgb; outColor = vec4(col, k); }`);
const ADD_FRAG = frag(`uniform sampler2D uAdd; uniform float uIntensity;
void main(){
  vec4 o = premul(texture(uTex, vUv));
  vec4 g = premul(texture(uAdd, vUv)) * uIntensity;
  float a = clamp(o.a + g.a * (1.0 - o.a), 0.0, 1.0);
  outColor = unpremul(vec4(min(o.rgb + g.rgb, vec3(a)), a));
}`);
registerFilter('glow', {
  apply(input, p, fc) {
    const thr = fc.gl.run(GLOW_THRESH, { uTex: input, uT: p.threshold ?? 0.6, uColor: color4(p.color, '#fff'), uUseColor: p.color ? 1 : 0 });
    const blur = gaussianBlur(fc.gl, thr, (p.radius ?? 20) * fc.scale);
    fc.gl.release(thr);
    const out = fc.gl.run(ADD_FRAG, { uTex: input, uAdd: blur, uIntensity: p.intensity ?? 1 });
    fc.gl.release(blur);
    return out;
  },
});

const SHADOW_SHAPE = frag(`uniform vec4 uColor; uniform vec2 uOffset; void main(){ float a = texture(uTex, vUv - uOffset / uSize).a; outColor = vec4(uColor.rgb, a * uColor.a); }`);
const UNDER_FRAG = frag(`uniform sampler2D uUnder; void main(){ vec4 top = premul(texture(uTex, vUv)); vec4 bot = premul(texture(uUnder, vUv)); outColor = unpremul(top + bot * (1.0 - top.a)); }`);
registerFilter('dropShadow', {
  apply(input, p, fc) {
    const col = color4(p.color, 'rgba(0,0,0,0.6)');
    if (p.opacity !== undefined) col[3] = col[3]! * p.opacity;
    const shape = fc.gl.run(SHADOW_SHAPE, { uTex: input, uColor: col, uOffset: [(p.x ?? 0) * fc.scale, (p.y ?? 12) * fc.scale] });
    const blur = gaussianBlur(fc.gl, shape, (p.blur ?? 24) * fc.scale);
    fc.gl.release(shape);
    const out = fc.gl.run(UNDER_FRAG, { uTex: input, uUnder: blur });
    fc.gl.release(blur);
    return out;
  },
});

registerFilter(
  'vignette',
  single(
    `uniform float uAmount, uRadius, uSoft; uniform vec4 uColor;
void main(){ vec4 c = texture(uTex, vUv); vec2 d = (vUv - 0.5) * vec2(uSize.x / uSize.y, 1.0); float r = length(d) / 0.7071;
  float v = smoothstep(uRadius, uRadius + uSoft, r) * uAmount; outColor = vec4(mix(c.rgb, uColor.rgb, v), c.a); }`,
    (p) => ({ uAmount: p.amount ?? 0.6, uRadius: p.radius ?? 0.5, uSoft: p.softness ?? 0.6, uColor: color4(p.color, '#000') }),
  ),
);
registerFilter(
  'grain',
  single(
    `uniform float uAmount, uGrain, uSeed;
void main(){ vec4 c = texture(uTex, vUv); vec2 p = floor(vUv * uSize / uGrain); float n = hash12(p + uSeed * 17.0) - 0.5;
  float w = 1.0 - abs(luma(c.rgb) - 0.5) * 1.2; outColor = vec4(clamp(c.rgb + n * uAmount * w, 0.0, 1.0), c.a); }`,
    (p, fc) => ({ uAmount: p.amount ?? 0.12, uGrain: Math.max(1, (p.size ?? 1.5) * fc.scale), uSeed: (p.seed ?? 0) + (p.animated === false ? 0 : fc.frame.frame) }),
  ),
);
registerFilter(
  'chromaticAberration',
  single(
    `uniform vec2 uOff; uniform float uRadial;
void main(){ vec2 o = uOff / uSize; if (uRadial > 0.5) o = (vUv - 0.5) * length(uOff) / uSize.x * 4.0;
  vec4 r = texture(uTex, vUv + o); vec4 g = texture(uTex, vUv); vec4 b = texture(uTex, vUv - o);
  outColor = vec4(r.r, g.g, b.b, max(g.a, max(r.a, b.a))); }`,
    (p, fc) => {
      const a = ((p.angle ?? 0) * Math.PI) / 180;
      const d = (p.amount ?? 4) * fc.scale;
      return { uOff: [Math.cos(a) * d, Math.sin(a) * d], uRadial: p.radial ? 1 : 0 };
    },
  ),
);
registerFilter(
  'pixelate',
  single(`uniform float uPx; void main(){ vec2 cell = uPx / uSize; vec2 uv = (floor(vUv / cell) + 0.5) * cell; outColor = texture(uTex, uv); }`, (p, fc) => ({ uPx: Math.max(1, (p.size ?? 12) * fc.scale) })),
);
registerFilter(
  'halftone',
  single(
    `uniform float uCell, uAngle; uniform vec4 uInk, uPaper; uniform float uColorMode;
void main(){
  vec2 px = vUv * uSize; float c = cos(uAngle), s = sin(uAngle);
  vec2 r = mat2(c, -s, s, c) * px; vec2 cell = floor(r / uCell) + 0.5; vec2 center = mat2(c, s, -s, c) * (cell * uCell);
  vec4 col = texture(uTex, center / uSize); float l = 1.0 - luma(col.rgb);
  float d = length(r - cell * uCell) / (uCell * 0.7071);
  float dot_ = 1.0 - smoothstep(sqrt(l) - 0.08, sqrt(l), d);
  vec3 ink = uColorMode > 0.5 ? col.rgb : uInk.rgb;
  outColor = vec4(mix(uPaper.rgb, ink, dot_), texture(uTex, vUv).a);
}`,
    (p, fc) => ({ uCell: Math.max(2, (p.size ?? 8) * fc.scale), uAngle: ((p.angle ?? 45) * Math.PI) / 180, uInk: color4(p.ink, '#111'), uPaper: color4(p.paper, '#f4efe4'), uColorMode: p.color ? 1 : 0 }),
  ),
);
registerFilter(
  'edges',
  single(
    `uniform float uStrength; uniform float uInvert;
void main(){ vec2 o = 1.0 / uSize;
  float tl = luma(texture(uTex, vUv + vec2(-o.x, -o.y)).rgb), t = luma(texture(uTex, vUv + vec2(0.0, -o.y)).rgb), tr = luma(texture(uTex, vUv + vec2(o.x, -o.y)).rgb);
  float l = luma(texture(uTex, vUv + vec2(-o.x, 0.0)).rgb), r = luma(texture(uTex, vUv + vec2(o.x, 0.0)).rgb);
  float bl = luma(texture(uTex, vUv + vec2(-o.x, o.y)).rgb), b = luma(texture(uTex, vUv + vec2(0.0, o.y)).rgb), br = luma(texture(uTex, vUv + vec2(o.x, o.y)).rgb);
  float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br; float gy = -tl - 2.0 * t - tr + bl + 2.0 * b + br;
  float e = clamp(length(vec2(gx, gy)) * uStrength, 0.0, 1.0); if (uInvert > 0.5) e = 1.0 - e;
  outColor = vec4(vec3(e), texture(uTex, vUv).a); }`,
    (p) => ({ uStrength: p.strength ?? 1, uInvert: p.invert ? 1 : 0 }),
  ),
);
registerFilter(
  'emboss',
  single(
    `uniform float uStrength; void main(){ vec2 o = 1.0 / uSize; vec4 c = texture(uTex, vUv);
  float d = luma(texture(uTex, vUv - o).rgb) - luma(texture(uTex, vUv + o).rgb);
  outColor = vec4(vec3(0.5 + d * uStrength), c.a); }`,
    (p) => ({ uStrength: p.strength ?? 2 }),
  ),
);

// ------------------------------------------------------------------ Distort

registerFilter(
  'wave',
  single(
    `uniform float uAmp, uLen, uPhase, uAngle;
void main(){ vec2 dir = vec2(cos(uAngle), sin(uAngle)); vec2 px = vUv * uSize; float d = dot(px, dir);
  vec2 perp = vec2(-dir.y, dir.x); px += perp * sin(d / uLen * 6.2831853 + uPhase) * uAmp; outColor = texture(uTex, px / uSize); }`,
    (p, fc) => ({
      uAmp: (p.amplitude ?? 10) * fc.scale,
      uLen: Math.max(1, (p.wavelength ?? 120) * fc.scale),
      uPhase: (p.phase ?? 0) + fc.frame.time * (p.speed ?? 1) * Math.PI * 2,
      uAngle: ((p.angle ?? 0) * Math.PI) / 180,
    }),
  ),
);
registerFilter(
  'twirl',
  single(
    `uniform vec2 uCenter; uniform float uRadius, uAngle;
void main(){ vec2 px = vUv * uSize - uCenter; float d = length(px); if (d < uRadius) { float k = (uRadius - d) / uRadius; float a = uAngle * k * k; float c = cos(a), s = sin(a); px = vec2(px.x * c - px.y * s, px.x * s + px.y * c); }
  outColor = texture(uTex, (px + uCenter) / uSize); }`,
    (p, fc) => ({
      uCenter: [(p.center?.[0] ?? fc.frame.width / 2) * fc.scale, (p.center?.[1] ?? fc.frame.height / 2) * fc.scale],
      uRadius: (p.radius ?? 300) * fc.scale,
      uAngle: ((p.angle ?? 180) * Math.PI) / 180,
    }),
  ),
);
registerFilter(
  'bulge',
  single(
    `uniform vec2 uCenter; uniform float uRadius, uStrength;
void main(){ vec2 px = vUv * uSize - uCenter; float d = length(px); if (d < uRadius) { float k = d / uRadius; px *= mix(1.0, smoothstep(0.0, 1.0, k), uStrength); }
  outColor = texture(uTex, (px + uCenter) / uSize); }`,
    (p, fc) => ({
      uCenter: [(p.center?.[0] ?? fc.frame.width / 2) * fc.scale, (p.center?.[1] ?? fc.frame.height / 2) * fc.scale],
      uRadius: (p.radius ?? 300) * fc.scale,
      uStrength: p.strength ?? 0.5,
    }),
  ),
);
registerFilter(
  'displace',
  single(
    `uniform float uAmount, uScale, uT, uSeed;
float vnoise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i + vec2(1,0)), f.x), mix(hash12(i + vec2(0,1)), hash12(i + vec2(1,1)), f.x), f.y); }
void main(){ vec2 p = vUv * uSize / uScale; vec2 o = vec2(vnoise(p + uT + uSeed), vnoise(p + 31.7 - uT + uSeed)) - 0.5;
  outColor = texture(uTex, vUv + o * uAmount / uSize); }`,
    (p, fc) => ({ uAmount: (p.amount ?? 20) * fc.scale, uScale: Math.max(1, (p.scale ?? 80) * fc.scale), uT: fc.frame.time * (p.speed ?? 0.5), uSeed: p.seed ?? 0 }),
  ),
);
registerFilter(
  'kaleidoscope',
  single(
    `uniform float uSeg, uRot; uniform vec2 uCenter;
void main(){ vec2 d = vUv * uSize - uCenter; float r = length(d); float a = atan(d.y, d.x) + uRot; float seg = 6.2831853 / uSeg;
  a = mod(a, seg); if (a > seg * 0.5) a = seg - a; vec2 px = uCenter + vec2(cos(a), sin(a)) * r; outColor = texture(uTex, px / uSize); }`,
    (p, fc) => ({
      uSeg: Math.max(2, p.segments ?? 6),
      uRot: ((p.rotation ?? 0) * Math.PI) / 180,
      uCenter: [(p.center?.[0] ?? fc.frame.width / 2) * fc.scale, (p.center?.[1] ?? fc.frame.height / 2) * fc.scale],
    }),
  ),
);
registerFilter(
  'mirror',
  single(
    `uniform float uAxis; void main(){ vec2 uv = vUv; if (uAxis < 0.5) uv.x = uv.x > 0.5 ? 1.0 - uv.x : uv.x; else uv.y = uv.y > 0.5 ? 1.0 - uv.y : uv.y; outColor = texture(uTex, uv); }`,
    (p) => ({ uAxis: p.axis === 'y' ? 1 : 0 }),
  ),
);
registerFilter(
  'tile',
  single(`uniform vec2 uCount; void main(){ outColor = texture(uTex, fract(vUv * uCount)); }`, (p) => ({ uCount: Array.isArray(p.count) ? p.count : [p.count ?? 3, p.count ?? 3] })),
);
registerFilter(
  'glitch',
  single(
    `uniform float uAmount, uSeed, uBlocks;
void main(){ vec2 uv = vUv; float row = floor(uv.y * uBlocks); float r = hash12(vec2(row, uSeed));
  if (r < uAmount) uv.x += (hash12(vec2(row * 3.1, uSeed + 1.0)) - 0.5) * uAmount * 0.4;
  float ca = uAmount * 0.012 * (hash12(vec2(uSeed, 7.0)) - 0.5);
  vec4 c = texture(uTex, uv); float rr = texture(uTex, uv + vec2(ca, 0.0)).r; float bb = texture(uTex, uv - vec2(ca, 0.0)).b;
  outColor = vec4(rr, c.g, bb, c.a); }`,
    (p, fc) => ({ uAmount: p.amount ?? 0.3, uSeed: (p.seed ?? 0) + Math.floor(fc.frame.frame / Math.max(1, p.hold ?? 2)), uBlocks: p.blocks ?? 24 }),
  ),
);
registerFilter(
  'crop',
  single(
    `uniform vec4 uRect; void main(){ vec2 px = vUv * uSize; bool inside = px.x >= uRect.x && px.y >= uRect.y && px.x <= uRect.x + uRect.z && px.y <= uRect.y + uRect.w; outColor = inside ? texture(uTex, vUv) : vec4(0.0); }`,
    (p, fc) => ({ uRect: [(p.x ?? 0) * fc.scale, (p.y ?? 0) * fc.scale, (p.width ?? fc.frame.width) * fc.scale, (p.height ?? fc.frame.height) * fc.scale] }),
  ),
);
registerFilter(
  'noise',
  single(
    `uniform float uAmount, uSeed, uMono;
void main(){ vec4 c = texture(uTex, vUv); vec2 p = vUv * uSize; vec3 n = uMono > 0.5 ? vec3(hash12(p + uSeed)) : vec3(hash12(p + uSeed), hash12(p + uSeed + 11.0), hash12(p + uSeed + 23.0));
  outColor = vec4(clamp(c.rgb + (n - 0.5) * uAmount, 0.0, 1.0), c.a); }`,
    (p, fc) => ({ uAmount: p.amount ?? 0.2, uSeed: (p.seed ?? 0) + (p.animated === false ? 0 : fc.frame.frame * 1.37), uMono: p.mono === false ? 0 : 1 }),
  ),
);

/** Custom user shader. `body` is GLSL that writes `outColor`; uniforms are passed through by name. */
registerFilter('shader', {
  apply(input, p, fc) {
    const src = frag(p.source as string);
    const uniforms: Record<string, UniformValue> = {};
    for (const [k, v] of Object.entries((p.uniforms ?? {}) as Record<string, unknown>)) {
      if (typeof v === 'string') uniforms[k] = color4(v);
      else uniforms[k] = v as UniformValue;
    }
    return fc.gl.run(src, { uTex: input, ...uniforms });
  },
});

// Luma → alpha (for luma mattes)
export const LUMA_TO_ALPHA = frag(`uniform float uInvert; void main(){ vec4 c = texture(uTex, vUv); float l = luma(c.rgb) * c.a; if (uInvert > 0.5) l = 1.0 - l; outColor = vec4(1.0, 1.0, 1.0, l); }`);
export const MIX_FRAG = frag(`uniform sampler2D uOrig; uniform float uAmount; void main(){ outColor = unpremul(mix(premul(texture(uOrig, vUv)), premul(texture(uTex, vUv)), uAmount)); }`);
export { COPY as COPY_SHADER };
