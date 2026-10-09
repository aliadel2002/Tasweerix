export type Surface = OffscreenCanvas | HTMLCanvasElement;
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function createSurface(width: number, height: number): Surface {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function ctx2d(s: Surface, opts?: CanvasRenderingContext2DSettings): Ctx2D {
  const c = (s as OffscreenCanvas).getContext('2d', opts) as Ctx2D | null;
  if (!c) throw new Error('2D canvas context unavailable');
  return c;
}

/** Reuses offscreen layers to avoid allocating canvases every frame. */
export class SurfacePool {
  private free: Surface[] = [];
  private all = new Set<Surface>();
  constructor(public width: number, public height: number) {}

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.free = [];
    this.all.clear();
  }

  acquire(): { surface: Surface; ctx: Ctx2D } {
    let s = this.free.pop();
    if (!s) {
      s = createSurface(this.width, this.height);
      this.all.add(s);
    }
    const ctx = ctx2d(s, { willReadFrequently: false });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.clearRect(0, 0, this.width, this.height);
    return { surface: s, ctx };
  }

  release(s: Surface): void {
    if (this.all.has(s) && !this.free.includes(s)) this.free.push(s);
  }
}
