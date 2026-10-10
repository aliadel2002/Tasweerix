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

/** Bits per channel the compositor works at: 8 (default) or 16 (float16 canvases, see `depth` on Renderer). */
export type Depth = 8 | 16;

/** 2D context settings for a compositing depth. `colorType: 'float16'` is Chromium-only (verified in 141). */
export function depthSettings(depth: Depth): CanvasRenderingContext2DSettings | undefined {
  return depth === 16 ? ({ colorType: 'float16' } as CanvasRenderingContext2DSettings) : undefined;
}

type F16Ctor = new (n: number) => ArrayLike<number> & { [i: number]: number };
const Float16 = (globalThis as unknown as { Float16Array?: F16Ctor }).Float16Array;

/**
 * Creates a float16 surface holding straight RGBA pixels given as normalized floats (0..1) or
 * 16-bit integers. Keeps more than 8 bits per channel when drawn into a float16 canvas.
 */
export function float16Surface(width: number, height: number, rgba: Float32Array | Uint16Array): Surface {
  if (!Float16) throw new Error('Float16Array is not available in this browser (16-bit compositing needs Chromium 135+)');
  const k = rgba instanceof Uint16Array ? 1 / 65535 : 1;
  const px = new Float16(width * height * 4);
  for (let i = 0; i < rgba.length; i++) px[i] = Math.min(1, Math.max(0, rgba[i]! * k));
  const s = createSurface(width, height);
  const ctx = ctx2d(s, depthSettings(16));
  const ImageDataF16 = ImageData as unknown as new (data: unknown, w: number, h: number, settings: { pixelFormat: string }) => ImageData;
  ctx.putImageData(new ImageDataF16(px, width, height, { pixelFormat: 'rgba-float16' }), 0, 0);
  return s;
}

/** Reads a float16 canvas as 16-bit straight RGBA (0..65535, clipped). */
export function readRGBA16(ctx: Ctx2D, width: number, height: number): Uint16Array {
  const id = (ctx.getImageData as unknown as (x: number, y: number, w: number, h: number, s: { pixelFormat: string }) => { data: ArrayLike<number> })(0, 0, width, height, { pixelFormat: 'rgba-float16' });
  const out = new Uint16Array(id.data.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.min(1, Math.max(0, id.data[i]!)) * 65535);
  return out;
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
  constructor(public width: number, public height: number, readonly depth: Depth = 8) {}

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
    const ctx = ctx2d(s, { willReadFrequently: false, ...depthSettings(this.depth) });
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
