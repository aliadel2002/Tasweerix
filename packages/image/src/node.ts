import { ImageNode, type AnimProps, type BaseProps, type CanvasGamut, type ImageProps, type NodeOptions } from '@tasweerix/core';
import { depthSettings, drawMedia, float16Surface, gamutSettings, registerDrawer, type Depth, type Drawable } from '@tasweerix/render';
import { fromRGBA16, fromRGBA8, toRGBA8, type Bitmap } from './bitmap';
import { applyOps, type PhotoOp } from './ops';

/** An image with a non-destructive photo-edit pipeline applied before display. */
export class PhotoNode extends ImageNode {
  ops: PhotoOp[];
  constructor(src: string, ops: PhotoOp[], props: AnimProps<ImageProps & BaseProps>, opts: NodeOptions) {
    super('photo', { ...props, src }, opts);
    this.ops = ops;
  }
  get cacheKey(): string {
    return `${this.props.src}|${JSON.stringify(this.ops)}`;
  }
}

export function photo(src: string, ops: PhotoOp[] = [], opts: AnimProps<ImageProps & BaseProps> & NodeOptions = {}): PhotoNode {
  const { name, start, duration, end, at, filters, ...props } = opts;
  return new PhotoNode(src, ops, props as AnimProps<ImageProps & BaseProps>, { name, start, duration, end, at, filters });
}

const processed = new Map<string, Promise<Drawable>>();
const ready = new Map<string, Drawable>();

/**
 * Runs a photo pipeline on a drawable (browser): returns the edited bitmap. The pixels are read and
 * edited in `gamut`, so a Display P3 photo keeps its colors when the renderer composites in P3.
 */
export async function processDrawable(img: Drawable, ops: PhotoOp[], depth: Depth = 8, gamut: CanvasGamut = 'srgb'): Promise<Drawable> {
  const c = new OffscreenCanvas(img.width, img.height);
  const ctx = c.getContext('2d', { willReadFrequently: true, ...depthSettings(8, gamut) })! as OffscreenCanvasRenderingContext2D;
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, img.width, img.height, gamutSettings(gamut));
  return processBitmap(fromRGBA8(id.data, img.width, img.height), ops, depth, gamut);
}

/** Runs a photo pipeline on a float bitmap in `colorSpace` (browser): returns the edited result as a drawable. */
export async function processBitmap(src: Bitmap, ops: PhotoOp[], depth: Depth = 8, colorSpace: CanvasGamut = 'srgb'): Promise<Drawable> {
  const out = applyOps(src, ops);
  // 16-bit compositing: hand the float result over without the 8-bit (dithered) conversion.
  if (depth === 16) return float16Surface(out.width, out.height, out.data, colorSpace) as Drawable;
  const oc = new OffscreenCanvas(out.width, out.height);
  (oc.getContext('2d', depthSettings(8, colorSpace)) as OffscreenCanvasRenderingContext2D).putImageData(new ImageData(toRGBA8(out), out.width, out.height, gamutSettings(colorSpace)), 0, 0);
  return createImageBitmap(oc);
}

registerDrawer(
  'photo',
  (d) => {
    const n = d.node as PhotoNode;
    const img = ready.get(n.cacheKey);
    if (img) drawMedia(d, img, img.width, img.height);
  },
  {
    prepare: async (n, renderer) => {
      const node = n as PhotoNode;
      const key = node.cacheKey;
      if (!processed.has(key)) {
        processed.set(
          key,
          (async () => {
            const path = node.props.src as string;
            // High bit-depth sources (16-bit PNG/TIFF) are decoded at full depth so edits don't start from 8 bits.
            const hi = await renderer.assets.loadImage16?.(path);
            const out = hi
              ? await processBitmap(fromRGBA16(hi.data, hi.width, hi.height), node.ops, renderer.depth, hi.colorSpace ?? 'srgb')
              : await processDrawable(await renderer.assets.loadImage(path), node.ops, renderer.depth, renderer.gamut);
            ready.set(key, out);
            return out;
          })(),
        );
      }
      await processed.get(key);
    },
  },
);
