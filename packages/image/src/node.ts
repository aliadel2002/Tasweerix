import { ImageNode, type AnimProps, type BaseProps, type ImageProps, type NodeOptions } from '@tasweerix/core';
import { drawMedia, registerDrawer, type Drawable } from '@tasweerix/render';
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

/** Runs a photo pipeline on a drawable (browser): returns the edited bitmap. */
export async function processDrawable(img: Drawable, ops: PhotoOp[]): Promise<Drawable> {
  const c = new OffscreenCanvas(img.width, img.height);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, img.width, img.height);
  return processBitmap(fromRGBA8(id.data, img.width, img.height), ops);
}

/** Runs a photo pipeline on a float bitmap (browser): returns the edited result as a drawable. */
export async function processBitmap(src: Bitmap, ops: PhotoOp[]): Promise<Drawable> {
  const out = applyOps(src, ops);
  const oc = new OffscreenCanvas(out.width, out.height);
  oc.getContext('2d')!.putImageData(new ImageData(toRGBA8(out), out.width, out.height), 0, 0);
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
            const out = hi ? await processBitmap(fromRGBA16(hi.data, hi.width, hi.height), node.ops) : await processDrawable(await renderer.assets.loadImage(path), node.ops);
            ready.set(key, out);
            return out;
          })(),
        );
      }
      await processed.get(key);
    },
  },
);
