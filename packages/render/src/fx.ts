import type { Animatable, FilterSpec, Vec2 } from '@tasweerix/core';

type A<T> = Animatable<T>;
type P<T> = { [K in keyof T]?: A<T[K]> };

function make<T extends object>(kind: string) {
  return (params: P<T> = {}, amount?: A<number>): FilterSpec => ({ kind, params: params as FilterSpec['params'], amount });
}

export interface GradeParams {
  /** Stops of exposure (+1 doubles light). */
  exposure: number;
  /** -1..1 */
  contrast: number;
  /** -1 (grey) .. 1 */
  saturation: number;
  vibrance: number;
  /** -1 (cool) .. 1 (warm) */
  temperature: number;
  /** -1 (green) .. 1 (magenta) */
  tint: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  /** Degrees. */
  hue: number;
  brightness: number;
  gamma: number;
  pivot: number;
  lift: [number, number, number];
  gammaRGB: [number, number, number];
  gain: [number, number, number];
}

/**
 * Filter builders. Every parameter can be static, keyframed or a driver:
 *   node.filter(fx.blur({ radius: keys([[0, 20], [1, 0]]) }), fx.grade({ exposure: 0.3 }))
 */
export const fx = {
  blur: make<{ radius: number; horizontal: boolean; vertical: boolean }>('blur'),
  directionalBlur: make<{ angle: number; distance: number }>('directionalBlur'),
  zoomBlur: make<{ center: Vec2; amount: number }>('zoomBlur'),
  radialBlur: make<{ center: Vec2; angle: number }>('radialBlur'),
  sharpen: make<{ amount: number }>('sharpen'),
  unsharp: make<{ radius: number; amount: number; threshold: number }>('unsharp'),
  grade: make<GradeParams>('grade'),
  levels: make<{ inBlack: number | number[]; inWhite: number | number[]; gamma: number | number[]; outBlack: number | number[]; outWhite: number | number[] }>('levels'),
  /** Curves: control points [x, y] in 0..1 for the composite and per-channel curves. */
  curves: make<{ rgb: [number, number][]; r: [number, number][]; g: [number, number][]; b: [number, number][] }>('curves'),
  /** Hue/saturation/lightness globally or for a hue range ('reds', 'blues', …, or a hue in degrees). */
  hsl: make<{ hue: number; saturation: number; lightness: number; range: string | number; width: number }>('hsl'),
  /** 3D LUT from a .cube file. */
  lut: (src: string, intensity: A<number> = 1): FilterSpec => ({ kind: 'lut', params: { src, intensity } }),
  invert: make<{}>('invert'),
  grayscale: make<{ amount: number }>('grayscale'),
  sepia: make<{ amount: number }>('sepia'),
  tint: make<{ color: string; amount: number }>('tint'),
  colorize: make<{ color: string; amount: number }>('colorize'),
  duotone: make<{ dark: string; light: string }>('duotone'),
  gradientMap: make<{ stops: (string | [number, string])[] }>('gradientMap'),
  posterize: make<{ levels: number }>('posterize'),
  threshold: make<{ level: number }>('threshold'),
  opacity: make<{ amount: number }>('opacity'),
  chromaKey: make<{ color: string; similarity: number; smoothness: number; spill: number }>('chromaKey'),
  lumaKey: make<{ threshold: number; softness: number; invert: boolean }>('lumaKey'),
  glow: make<{ threshold: number; radius: number; intensity: number; color: string }>('glow'),
  dropShadow: make<{ color: string; blur: number; x: number; y: number; opacity: number }>('dropShadow'),
  vignette: make<{ amount: number; radius: number; softness: number; color: string }>('vignette'),
  grain: make<{ amount: number; size: number; seed: number; animated: boolean }>('grain'),
  chromaticAberration: make<{ amount: number; angle: number; radial: boolean }>('chromaticAberration'),
  pixelate: make<{ size: number }>('pixelate'),
  halftone: make<{ size: number; angle: number; ink: string; paper: string; color: boolean }>('halftone'),
  edges: make<{ strength: number; invert: boolean }>('edges'),
  emboss: make<{ strength: number }>('emboss'),
  wave: make<{ amplitude: number; wavelength: number; speed: number; phase: number; angle: number }>('wave'),
  twirl: make<{ center: Vec2; radius: number; angle: number }>('twirl'),
  bulge: make<{ center: Vec2; radius: number; strength: number }>('bulge'),
  displace: make<{ amount: number; scale: number; speed: number; seed: number }>('displace'),
  kaleidoscope: make<{ segments: number; rotation: number; center: Vec2 }>('kaleidoscope'),
  mirror: make<{ axis: 'x' | 'y' }>('mirror'),
  tile: make<{ count: number | [number, number] }>('tile'),
  glitch: make<{ amount: number; seed: number; blocks: number; hold: number }>('glitch'),
  crop: make<{ x: number; y: number; width: number; height: number }>('crop'),
  noise: make<{ amount: number; seed: number; mono: boolean; animated: boolean }>('noise'),
  /**
   * Custom GLSL. `source` is the body of a fragment shader (GLSL ES 3.0) with access to
   * uTex, vUv, uSize, uTime and helpers (luma, rgb2hsv, hsv2rgb, hash12); write to `outColor`.
   */
  shader: (source: string, uniforms: Record<string, A<number | number[] | string>> = {}): FilterSpec => ({
    kind: 'shader',
    params: { source, uniforms: (ctx: import('@tasweerix/core').FrameContext) => resolveAll(uniforms, ctx) },
  }),
  /** Any registered filter by name (for plugins). */
  custom: (kind: string, params: Record<string, A<unknown>> = {}): FilterSpec => ({ kind, params }),
};

import { resolve } from '@tasweerix/core';
function resolveAll(u: Record<string, A<unknown>>, ctx: import('@tasweerix/core').FrameContext) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(u)) out[k] = resolve(v, ctx);
  return out;
}
