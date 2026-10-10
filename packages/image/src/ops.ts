import type { Bitmap } from './bitmap';
import { blur, clarity, dehaze, denoise, median, unsharp } from './filters';
import { crop, flip, perspective, resize, rotate } from './geometry';
import { resolveMask, type MaskSpec } from './masks';
import { clone, heal, redEye, type PatchOptions } from './retouch';
import { adjust, autoLevels, autoWhiteBalance, curves, hsl, type AdjustParams } from './tone';

/** One step of a non-destructive photo edit pipeline (plain data, serializable). */
export interface PhotoOp {
  kind: string;
  params: Record<string, any>;
  mask?: MaskSpec;
}

export type OpImpl = (b: Bitmap, params: Record<string, any>, mask?: MaskSpec) => Bitmap;
const impls = new Map<string, OpImpl>();
export function registerPhotoOp(kind: string, impl: OpImpl): void {
  impls.set(kind, impl);
}

const m = (b: Bitmap, s?: MaskSpec) => (s ? resolveMask(s, b) : undefined);
registerPhotoOp('crop', (b, p) => crop(b, p.x ?? 0, p.y ?? 0, p.width ?? b.width, p.height ?? b.height));
registerPhotoOp('cropAspect', (b, p) => {
  const ar = p.aspect as number;
  let w = b.width;
  let h = Math.round(w / ar);
  if (h > b.height) {
    h = b.height;
    w = Math.round(h * ar);
  }
  const fx = p.focus?.[0] ?? b.width / 2;
  const fy = p.focus?.[1] ?? b.height / 2;
  const x = Math.min(b.width - w, Math.max(0, fx - w / 2));
  const y = Math.min(b.height - h, Math.max(0, fy - h / 2));
  return crop(b, x, y, w, h);
});
registerPhotoOp('rotate', (b, p) => rotate(b, p.degrees ?? 0, p));
registerPhotoOp('flip', (b, p) => flip(b, p.axis ?? 'x'));
registerPhotoOp('resize', (b, p) => {
  let w = p.width as number | undefined;
  let h = p.height as number | undefined;
  if (p.scale) {
    w = b.width * p.scale;
    h = b.height * p.scale;
  }
  if (w && !h) h = (b.height * w) / b.width;
  if (h && !w) w = (b.width * h) / b.height;
  if (p.maxSize) {
    const k = Math.min(1, p.maxSize / Math.max(b.width, b.height));
    w = b.width * k;
    h = b.height * k;
  }
  return resize(b, w ?? b.width, h ?? b.height);
});
registerPhotoOp('perspective', (b, p) => perspective(b, p.corners, p.width, p.height));
registerPhotoOp('autoLevels', (b, p) => autoLevels(b, p));
registerPhotoOp('autoWhiteBalance', (b, p) => autoWhiteBalance(b, p.method, p.strength));
registerPhotoOp('adjust', (b, p, s) => adjust(b, p as AdjustParams, m(b, s)));
registerPhotoOp('curves', (b, p, s) => curves(b, p, m(b, s)));
registerPhotoOp('hsl', (b, p, s) => hsl(b, p, m(b, s)));
registerPhotoOp('blur', (b, p, s) => blur(b, p.radius ?? 4, m(b, s)));
registerPhotoOp('sharpen', (b, p, s) => unsharp(b, { radius: p.radius ?? 1.2, amount: p.amount ?? 0.6, threshold: p.threshold ?? 0.01 }, m(b, s)));
registerPhotoOp('clarity', (b, p, s) => clarity(b, p.amount ?? 0.3, m(b, s)));
registerPhotoOp('dehaze', (b, p) => dehaze(b, p.amount ?? 0.5));
registerPhotoOp('denoise', (b, p, s) => denoise(b, p, m(b, s)));
registerPhotoOp('median', (b, p, s) => median(b, p.radius ?? 1, m(b, s)));
registerPhotoOp('clone', (b, p) => clone(b, p as PatchOptions));
registerPhotoOp('heal', (b, p) => heal(b, p as PatchOptions));
registerPhotoOp('redEye', (b, p) => redEye(b, p.center, p.radius));
registerPhotoOp('vignette', (b, p, s) => {
  const amount = p.amount ?? 0.4;
  const mk = m(b, s);
  const out = { ...b, data: new Float32Array(b.data) };
  for (let y = 0; y < b.height; y++)
    for (let x = 0; x < b.width; x++) {
      const dx = (x / b.width - 0.5) * 2;
      const dy = (y / b.height - 0.5) * 2;
      const r = Math.hypot(dx, dy) / Math.SQRT2;
      const v = 1 - amount * Math.pow(Math.max(0, (r - (p.radius ?? 0.4)) / (1 - (p.radius ?? 0.4))), 2);
      const k = mk ? 1 + (v - 1) * mk.data[y * b.width + x]! : v;
      const i = (y * b.width + x) * 4;
      for (let c = 0; c < 3; c++) out.data[i + c]! *= k;
    }
  return out;
});

export function applyOps(b: Bitmap, ops: PhotoOp[]): Bitmap {
  let cur = b;
  for (const o of ops) {
    const impl = impls.get(o.kind);
    if (!impl) throw new Error(`Unknown photo op "${o.kind}"`);
    cur = impl(cur, o.params, o.mask);
  }
  return cur;
}

const opFn = (kind: string) => (params: Record<string, any> = {}, opts: { mask?: MaskSpec } = {}): PhotoOp => ({ kind, params, mask: opts.mask });

/**
 * Photo operations (applied in order, non-destructively):
 *   photo('portrait.jpg', [op.autoWhiteBalance(), op.adjust({ exposure: 0.3 }, { mask: mask.radial([800, 500], 400) })])
 */
export const op = {
  crop: (x: number, y: number, width: number, height: number): PhotoOp => ({ kind: 'crop', params: { x, y, width, height } }),
  /** Crops to an aspect ratio around a focus point. */
  cropAspect: (aspect: number, focus?: [number, number]): PhotoOp => ({ kind: 'cropAspect', params: { aspect, focus } }),
  rotate: (degrees: number, opts: { expand?: boolean; autoCrop?: boolean } = {}): PhotoOp => ({ kind: 'rotate', params: { degrees, ...opts } }),
  /** Straighten a tilted horizon (rotate + auto-crop). */
  straighten: (degrees: number): PhotoOp => ({ kind: 'rotate', params: { degrees, autoCrop: true } }),
  flip: (axis: 'x' | 'y' = 'x'): PhotoOp => ({ kind: 'flip', params: { axis } }),
  resize: (p: { width?: number; height?: number; scale?: number; maxSize?: number }): PhotoOp => ({ kind: 'resize', params: p }),
  /** Perspective correction: quad corners (tl, tr, br, bl) → rectangle. */
  perspective: (corners: [number, number][], size?: { width?: number; height?: number }): PhotoOp => ({ kind: 'perspective', params: { corners, ...size } }),
  autoLevels: (p: { clip?: number; perChannel?: boolean } = {}): PhotoOp => ({ kind: 'autoLevels', params: p }),
  autoWhiteBalance: (method: 'gray-world' | 'white-patch' = 'gray-world', strength = 1): PhotoOp => ({ kind: 'autoWhiteBalance', params: { method, strength } }),
  adjust: (p: AdjustParams, opts?: { mask?: MaskSpec }) => opFn('adjust')(p as Record<string, any>, opts),
  curves: (p: { rgb?: [number, number][]; r?: [number, number][]; g?: [number, number][]; b?: [number, number][] }, opts?: { mask?: MaskSpec }) => opFn('curves')(p, opts),
  hsl: (p: { hue?: number; saturation?: number; lightness?: number; range?: number; width?: number }, opts?: { mask?: MaskSpec }) => opFn('hsl')(p, opts),
  blur: (radius: number, opts?: { mask?: MaskSpec }) => opFn('blur')({ radius }, opts),
  sharpen: (p: { amount?: number; radius?: number; threshold?: number } = {}, opts?: { mask?: MaskSpec }) => opFn('sharpen')(p, opts),
  clarity: (amount = 0.3, opts?: { mask?: MaskSpec }) => opFn('clarity')({ amount }, opts),
  dehaze: (amount = 0.5): PhotoOp => ({ kind: 'dehaze', params: { amount } }),
  denoise: (p: { strength?: number; radius?: number } = {}, opts?: { mask?: MaskSpec }) => opFn('denoise')(p, opts),
  dust: (radius = 1, opts?: { mask?: MaskSpec }) => opFn('median')({ radius }, opts),
  clone: (p: PatchOptions): PhotoOp => ({ kind: 'clone', params: p }),
  heal: (p: PatchOptions): PhotoOp => ({ kind: 'heal', params: p }),
  redEye: (center: [number, number], radius: number): PhotoOp => ({ kind: 'redEye', params: { center, radius } }),
  vignette: (amount = 0.4, radius = 0.4, opts?: { mask?: MaskSpec }) => opFn('vignette')({ amount, radius }, opts),
  custom: (kind: string, params: Record<string, any> = {}, opts?: { mask?: MaskSpec }) => opFn(kind)(params, opts),
};
