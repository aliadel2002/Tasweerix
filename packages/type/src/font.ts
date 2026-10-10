import { mapPath, parsePath, type PathData } from '@tasweerix/core';
import { harfbuzz, loadHarfBuzz } from './harfbuzz';

export interface ShapedGlyph {
  /** Glyph id in the font. */
  id: number;
  /** Logical character index (cluster start) in the shaped string. */
  cluster: number;
  /** Advance & offsets in font units. */
  ax: number;
  ay: number;
  dx: number;
  dy: number;
}

export interface ShapeOptions {
  direction?: 'ltr' | 'rtl';
  script?: string;
  language?: string;
  /** OpenType features, e.g. { liga: 0, ss01: 1 }. */
  features?: Record<string, number>;
}

function readTables(bytes: Uint8Array): Map<string, { offset: number; length: number }> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = v.getUint16(4);
  const out = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    const tag = String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
    out.set(tag, { offset: v.getUint32(o + 8), length: v.getUint32(o + 12) });
  }
  return out;
}

/** A font loaded into HarfBuzz with metrics and cached glyph outlines. */
export class TypeFont {
  readonly upem: number;
  readonly ascender: number;
  readonly descender: number;
  readonly lineGap: number;
  readonly family: string;
  private face: HbFace;
  private font: HbFont;
  private paths = new Map<number, PathData>();
  private variationsKey = '';

  private constructor(readonly bytes: Uint8Array, readonly name: string) {
    const hb = harfbuzz();
    const blob = hb.createBlob(bytes);
    this.face = hb.createFace(blob, 0);
    this.font = hb.createFont(this.face);
    this.upem = this.face.upem;
    const tables = readTables(bytes);
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const hhea = tables.get('hhea');
    const os2 = tables.get('OS/2');
    let asc = hhea ? v.getInt16(hhea.offset + 4) : this.upem * 0.8;
    let desc = hhea ? v.getInt16(hhea.offset + 6) : -this.upem * 0.2;
    let gap = hhea ? v.getInt16(hhea.offset + 8) : 0;
    if (os2 && os2.length >= 78) {
      // Prefer typographic metrics when USE_TYPO_METRICS is set.
      const fsSelection = v.getUint16(os2.offset + 62);
      if (fsSelection & (1 << 7)) {
        asc = v.getInt16(os2.offset + 68);
        desc = v.getInt16(os2.offset + 70);
        gap = v.getInt16(os2.offset + 72);
      }
    }
    this.ascender = asc;
    this.descender = desc;
    this.lineGap = gap;
    this.family = readFamilyName(bytes, tables) ?? name;
  }

  static async load(bytes: ArrayBuffer | Uint8Array, name = 'font'): Promise<TypeFont> {
    await loadHarfBuzz();
    return new TypeFont(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), name);
  }

  setVariations(v: Record<string, number>): void {
    const k = JSON.stringify(v);
    if (k === this.variationsKey) return;
    this.variationsKey = k;
    this.font.setVariations(v);
    this.paths.clear();
  }

  /** Shapes a single-direction run. */
  shape(text: string, opts: ShapeOptions = {}): ShapedGlyph[] {
    const hb = harfbuzz();
    const buf = hb.createBuffer();
    buf.addText(text);
    if (opts.direction) buf.setDirection(opts.direction);
    if (opts.script) buf.setScript(opts.script);
    if (opts.language) buf.setLanguage(opts.language);
    buf.guessSegmentProperties();
    const features = opts.features ? Object.entries(opts.features).map(([k, v]) => (v === 1 ? `+${k}` : v === 0 ? `-${k}` : `${k}=${v}`)).join(',') : undefined;
    hb.shape(this.font, buf, features);
    const out = buf.json().map((g) => ({ id: g.g, cluster: g.cl, ax: g.ax, ay: g.ay, dx: g.dx, dy: g.dy }));
    buf.destroy();
    // HarfBuzz reports clusters as UTF-8 byte offsets? No: JS strings are added as UTF-16, so clusters are UTF-16 indices.
    return out;
  }

  /** Glyph outline in font units, y-up (as stored in the font). */
  glyphPath(id: number): PathData {
    let p = this.paths.get(id);
    if (!p) {
      p = parsePath(this.font.glyphToPath(id));
      this.paths.set(id, p);
    }
    return p;
  }

  /** Glyph outline scaled to a font size, y-down (canvas coordinates, origin on the baseline). */
  glyphPathAt(id: number, size: number): PathData {
    const k = size / this.upem;
    return mapPath(this.glyphPath(id), ([x, y]) => [x * k, -y * k]);
  }

  /** Total advance width (px) of a string at a size. */
  measure(text: string, size: number, opts?: ShapeOptions): number {
    return (this.shape(text, opts).reduce((s, g) => s + g.ax, 0) * size) / this.upem;
  }
}

function readFamilyName(bytes: Uint8Array, tables: Map<string, { offset: number; length: number }>): string | undefined {
  const t = tables.get('name');
  if (!t) return undefined;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = v.getUint16(t.offset + 2);
  const strOff = t.offset + v.getUint16(t.offset + 4);
  for (let i = 0; i < count; i++) {
    const r = t.offset + 6 + i * 12;
    const platform = v.getUint16(r);
    const nameId = v.getUint16(r + 6);
    const len = v.getUint16(r + 8);
    const off = v.getUint16(r + 10);
    if (nameId !== 1) continue;
    if (platform === 3 || platform === 0) {
      let s = '';
      for (let k = 0; k < len; k += 2) s += String.fromCharCode(v.getUint16(strOff + off + k));
      return s;
    }
  }
  return undefined;
}
