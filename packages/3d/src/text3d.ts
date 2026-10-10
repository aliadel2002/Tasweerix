import { mapPath, parsePath, type Env, type PathData } from '@tasweerix/core';
import type { ResolvedText } from '@tasweerix/render';
import { getFont, layoutWithFont, loadFont } from '@tasweerix/type';
import { extrudeGeometry, type Geometry } from './geometry';

export interface Text3DProps {
  text: string;
  /** Font file (.ttf/.otf/.woff) — shaped with HarfBuzz, so Arabic joins correctly. */
  font: string;
  /** Font size in world units. */
  size: number;
  depth: number;
  align: 'left' | 'center' | 'right';
  /** Extra spacing in world units. */
  letterSpacing: number;
  lineHeight: number;
  direction: 'auto' | 'ltr' | 'rtl';
}

/** Loads and registers a font file for text3d (once per font). */
export async function loadTextFont(font: string, env: Env): Promise<void> {
  if (getFont(font)) return;
  if (!env.loadBinary) throw new Error('text3d(): this environment cannot load font files');
  await loadFont(font, await env.loadBinary(font));
}

const LAYOUT_PX = 100;

/**
 * Lays text out with HarfBuzz (shaping, bidi, line breaks) and extrudes the glyph outlines.
 * The block is centered vertically; horizontally it follows `align` around x = 0.
 */
export function text3dGeometry(p: Text3DProps): Geometry {
  const font = getFont(p.font);
  if (!font) throw new Error(`text3d(): font ${p.font} is not loaded`);
  const rt: ResolvedText = {
    text: String(p.text ?? ''),
    font: p.font,
    fontFamily: p.font,
    size: LAYOUT_PX,
    weight: 400,
    style: 'normal',
    align: p.align,
    baseline: 'middle',
    direction: p.direction,
    lineHeight: p.lineHeight,
    letterSpacing: (p.letterSpacing / p.size) * LAYOUT_PX,
    wordSpacing: 0,
    maxWidth: 0,
    features: {},
    variations: {},
    script: '',
    language: '',
  };
  const layout = layoutWithFont(font, rt);
  const cy = layout.box.y + layout.box.height / 2;
  const paths: PathData[] = [];
  for (const g of layout.glyphs) {
    if (!g.pathData) continue;
    paths.push(mapPath(parsePath(g.pathData), ([x, y]) => [x + g.x, y + g.y - cy]));
  }
  return extrudeGeometry(paths, { depth: p.depth, scale: p.size / LAYOUT_PX, center: false, tolerance: 0.6 });
}
