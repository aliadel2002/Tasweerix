import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { arabicDigits, kashida, layoutWithFont, shapeLine, stripDiacritics, TypeFont } from '../src';
import type { ResolvedText } from '@tasweerix/render';
import { closeTestBrowser, renderFrames } from '../../cli/src/testing';

const FONTS = join(__dirname, '../../../assets/fonts');
let cairo: TypeFont;
let amiri: TypeFont;

beforeAll(async () => {
  cairo = await TypeFont.load(readFileSync(join(FONTS, 'Cairo-Bold.ttf')), 'cairo');
  amiri = await TypeFont.load(readFileSync(join(FONTS, 'Amiri-Regular.ttf')), 'amiri');
});
afterAll(closeTestBrowser);

const resolved = (text: string, extra: Partial<ResolvedText> = {}): ResolvedText => ({
  text, font: 'x', fontFamily: 'x', size: 100, weight: 400, style: 'normal', align: 'center', baseline: 'middle', direction: 'auto', lineHeight: 1.2,
  letterSpacing: 0, wordSpacing: 0, maxWidth: 0, features: {}, variations: {}, script: '', language: '', ...extra,
});

describe('HarfBuzz shaping', () => {
  it('applies Arabic contextual forms', () => {
    const word = cairo.shape('سلم', { direction: 'rtl' });
    expect(word).toHaveLength(3);
    // visual (left→right) order means clusters descend for RTL
    expect(word.map((g) => g.cluster)).toEqual([2, 1, 0]);
    const isolatedSeen = cairo.shape('س', { direction: 'rtl' })[0]!.id;
    const initialSeen = word.find((g) => g.cluster === 0)!.id;
    expect(initialSeen).not.toBe(isolatedSeen);
  });
  it('forms the lam-alef ligature (one cluster spanning two letters)', () => {
    const salam = cairo.shape('سلام', { direction: 'rtl' });
    expect(salam).toHaveLength(3);
    expect(salam.map((g) => g.cluster)).toEqual([3, 1, 0]);
    // Every glyph resolves (no .notdef) in a second, calligraphic font.
    expect(amiri.shape('بِسْمِ ٱللَّٰهِ', { direction: 'rtl' }).every((g) => g.id !== 0)).toBe(true);
  });
  it('resolves mixed-direction lines with the bidi algorithm', () => {
    const { runs, rtl } = shapeLine(cairo, 'مرحبا Tasweerix 2026', 80, { direction: 'auto' });
    expect(rtl).toBe(true);
    // In an RTL paragraph the Latin word sits left of the Arabic word.
    const arabic = runs.find((r) => /[؀-ۿ]/.test(r.text))!;
    const latin = runs.find((r) => r.text.includes('Tasweerix'))!;
    expect(latin.glyphs[0]!.x).toBeLessThan(arabic.glyphs[0]!.x);
  });
  it('lays out words and reading order for RTL text', () => {
    const l = layoutWithFont(cairo, resolved('مرحبا بالعالم'));
    expect(l.engine).toBe('harfbuzz');
    expect(new Set(l.glyphs.map((g) => g.word)).size).toBe(2);
    const first = l.glyphs.find((g) => g.index === 0)!;
    const last = l.glyphs.reduce((a, b) => (b.index > a.index ? b : a));
    expect(first.x).toBeGreaterThan(last.x); // reading starts on the right
    expect(l.glyphs.every((g) => g.pathData && g.pathData.length > 0 || g.text.trim() === '')).toBe(true);
  });
  it('wraps to maxWidth', () => {
    const l = layoutWithFont(cairo, resolved('هذا نص طويل جدا يحتاج إلى التفاف على عدة أسطر', { maxWidth: 600 }));
    expect(l.lines.length).toBeGreaterThan(1);
    for (const line of l.lines) expect(line.width).toBeLessThanOrEqual(601);
  });
});

describe('Arabic helpers', () => {
  it('inserts kashida only at joinable positions', () => {
    const k = kashida('سلام', 2);
    expect(k).toBe('ســـلـــام'.replace(/ـ+/g, (m) => 'ـ'.repeat(2)));
    expect(kashida('دار', 3)).toBe('دار'); // د and ا don't join forward
    expect(arabicDigits(2026)).toBe('٢٠٢٦');
    expect(stripDiacritics('مَرْحَبًا')).toBe('مرحبا');
  });
});

describe('glyph-path rendering (browser)', () => {
  it('renders animated Arabic glyphs with HarfBuzz', async () => {
    const dir = join(__dirname, '.tmp');
    const { frames } = await renderFrames({
      dir,
      root: join(__dirname, '../../..'),
      frames: [0, 30],
      source: `import { composition, text } from 'tasweerix';
      export default composition({ width: 600, height: 200, fps: 30, duration: 1.2, background: '#000' }, (c) => {
        c.add(text('مرحبا بالعالم', { font: 'assets/fonts/Cairo-Bold.ttf', size: 80, fill: '#fff' }).glyphs({
          by: 'glyph', order: 'reading', stagger: 0.05, start: 0, duration: 0.3, ease: (t) => t, from: { opacity: 0, y: 40 }, seed: 0,
        }));
      });`,
    });
    const ink = (f: (typeof frames)[0]) => {
      let n = 0;
      for (let i = 0; i < f.data.length; i += 4) if (f.data[i]! > 128) n++;
      return n;
    };
    expect(ink(frames[0]!)).toBe(0); // all glyphs start invisible
    expect(ink(frames[1]!)).toBeGreaterThan(2000);
  });
});
