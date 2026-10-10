import { onFontPrepare, registerTextEngine, clearTextCache, type TextEngine } from '@tasweerix/render';
import { TypeFont } from './font';
import { layoutWithFont } from './layout';

const fonts = new Map<string, TypeFont>();
const pending = new Map<string, Promise<TypeFont>>();

/** Registers an already-loaded font under a name usable as `font:` in text nodes. */
export function registerFont(name: string, font: TypeFont): void {
  fonts.set(name, font);
  clearTextCache();
}

export function getFont(name: string): TypeFont | undefined {
  return fonts.get(name);
}

/** Loads a font from bytes and registers it. */
export async function loadFont(name: string, bytes: ArrayBuffer | Uint8Array): Promise<TypeFont> {
  let p = pending.get(name);
  if (!p) {
    p = TypeFont.load(bytes, name).then((f) => {
      registerFont(name, f);
      return f;
    });
    pending.set(name, p);
  }
  return p;
}

/** HarfBuzz text engine: used for every text node whose font is a loaded font file. */
export const harfbuzzEngine: TextEngine = {
  name: 'harfbuzz',
  supports: (p) => fonts.has(p.font),
  layout: (p) => layoutWithFont(fonts.get(p.font)!, p),
};

registerTextEngine(harfbuzzEngine);
onFontPrepare(async (src, renderer) => {
  if (fonts.has(src)) return;
  await loadFont(src, await renderer.assets.loadBinary(src));
});
