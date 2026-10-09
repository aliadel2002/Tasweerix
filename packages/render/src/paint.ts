import { toCss, type Paint } from '@tasweerix/core';
import type { AssetProvider } from './assets';
import type { Ctx2D } from './surface';

/** Converts a Paint into a canvas fill/stroke style (in the current local coordinate space). */
export function toCanvasPaint(ctx: Ctx2D, paint: Paint, assets?: AssetProvider): string | CanvasGradient | CanvasPattern | null {
  if (paint === null || paint === undefined) return null;
  if (typeof paint === 'string') return paint;
  if (Array.isArray(paint)) return toCss(paint as unknown as [number, number, number, number]);
  switch (paint.type) {
    case 'linear': {
      const g = ctx.createLinearGradient(paint.from[0], paint.from[1], paint.to[0], paint.to[1]);
      for (const [o, c] of paint.stops) g.addColorStop(Math.min(1, Math.max(0, o)), toCss(c));
      return g;
    }
    case 'radial': {
      const f = paint.focus ?? paint.center;
      const g = ctx.createRadialGradient(f[0], f[1], 0, paint.center[0], paint.center[1], Math.max(0.001, paint.radius));
      for (const [o, c] of paint.stops) g.addColorStop(Math.min(1, Math.max(0, o)), toCss(c));
      return g;
    }
    case 'conic': {
      const g = ctx.createConicGradient(((paint.angle - 90) * Math.PI) / 180, paint.center[0], paint.center[1]);
      for (const [o, c] of paint.stops) g.addColorStop(Math.min(1, Math.max(0, o)), toCss(c));
      return g;
    }
    case 'pattern': {
      const img = assets?.getImage(paint.src);
      if (!img) return null;
      const pat = ctx.createPattern(img, paint.repeat ?? 'repeat');
      if (pat && paint.scale && paint.scale !== 1) pat.setTransform(new DOMMatrix().scale(paint.scale));
      return pat;
    }
  }
  return null;
}

export function isVisiblePaint(p: Paint): boolean {
  if (p === null || p === undefined || p === 'transparent' || p === 'none') return false;
  return true;
}
