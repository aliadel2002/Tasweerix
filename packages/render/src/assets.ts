import type { CanvasGamut } from '@tasweerix/core';
/** Something drawable with known pixel size. */
export type Drawable = CanvasImageSource & { width: number; height: number };

/**
 * Asset services needed by the renderer. Implementations live in @tasweerix/media
 * (browser preview, headless export with ffmpeg-served frames, …).
 */
export interface AssetProvider {
  /** Loads an image (cached). */
  loadImage(src: string): Promise<Drawable>;
  /**
   * Decodes a high bit-depth image (16-bit PNG/TIFF, 10-bit video stills) as 16-bit straight RGBA.
   * Resolves undefined when the source is 8-bit or no decoder is available; use `loadImage` then.
   * `colorSpace` is the space the pixels are in (default sRGB). `format: 'rgba-float16'` means `data`
   * holds half-float bits in extended sRGB (HDR sources in an HDR render).
   */
  loadImage16?(src: string): Promise<{ width: number; height: number; data: Uint16Array; colorSpace?: CanvasGamut; format?: 'rgba64le' | 'rgba-float16' } | undefined>;
  /** Returns an already loaded image. */
  getImage(src: string): Drawable | undefined;
  /** Exact video frame for a source time (seconds). */
  videoFrame(src: string, time: number, hint?: { width?: number; height?: number }): Promise<Drawable>;
  /** Registers a font file and returns the CSS family name to use. */
  loadFont(src: string): Promise<string>;
  loadText(src: string): Promise<string>;
  loadBinary(src: string): Promise<ArrayBuffer>;
  /** Called after each frame so providers can release resources. */
  endFrame?(): void;
}

export const FONT_FILE_RE = /\.(ttf|otf|woff2?|ttc)(\?.*)?$/i;
