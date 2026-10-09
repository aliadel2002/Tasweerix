/** Something drawable with known pixel size. */
export type Drawable = CanvasImageSource & { width: number; height: number };

/**
 * Asset services needed by the renderer. Implementations live in @tasweerix/media
 * (browser preview, headless export with ffmpeg-served frames, …).
 */
export interface AssetProvider {
  /** Loads an image (cached). */
  loadImage(src: string): Promise<Drawable>;
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
