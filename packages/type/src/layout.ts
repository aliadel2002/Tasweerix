import bidiFactory from 'bidi-js';
import { serializePath, type PathData } from '@tasweerix/core';
import type { Glyph, ResolvedText, TextLayout, TextLine } from '@tasweerix/render';
import type { TypeFont } from './font';

const bidi = bidiFactory();

export interface ShapedRun {
  text: string;
  start: number;
  rtl: boolean;
  glyphs: { id: number; cluster: number; x: number; y: number; advance: number }[];
  width: number;
}

/** Splits a line into visual-order runs (Unicode bidi algorithm) and shapes each run. */
export function shapeLine(font: TypeFont, text: string, size: number, opts: { direction: 'auto' | 'ltr' | 'rtl'; features?: Record<string, number>; script?: string; language?: string; letterSpacing?: number; wordSpacing?: number }): { runs: ShapedRun[]; width: number; rtl: boolean } {
  const k = size / font.upem;
  const levels = bidi.getEmbeddingLevels(text, opts.direction === 'auto' ? undefined : opts.direction);
  const baseRtl = (levels.paragraphs[0]?.level ?? 0) % 2 === 1;
  // Logical runs of equal level.
  const logical: { start: number; end: number; level: number }[] = [];
  for (let i = 0; i < text.length; i++) {
    const lvl = levels.levels[i]!;
    const last = logical[logical.length - 1];
    if (last && last.level === lvl) last.end = i + 1;
    else logical.push({ start: i, end: i + 1, level: lvl });
  }
  // Visual order of runs: derive from the reordered character indices.
  const order = bidi.getReorderedIndices(text, levels);
  const runOf = new Int32Array(text.length);
  logical.forEach((r, ri) => runOf.fill(ri, r.start, r.end));
  const visualRuns: number[] = [];
  for (const ci of order) {
    const ri = runOf[ci]!;
    if (visualRuns[visualRuns.length - 1] !== ri) visualRuns.push(ri);
  }
  const runs: ShapedRun[] = [];
  let x = 0;
  for (const ri of visualRuns) {
    const r = logical[ri]!;
    const sub = text.slice(r.start, r.end);
    const rtl = r.level % 2 === 1;
    const shaped = font.shape(sub, { direction: rtl ? 'rtl' : 'ltr', features: opts.features, script: opts.script || undefined, language: opts.language || undefined });
    const glyphs: ShapedRun['glyphs'] = [];
    const runStart = x;
    for (const g of shaped) {
      const ch = sub[g.cluster] ?? '';
      const extra = (opts.letterSpacing ?? 0) + (/\s/.test(ch) ? (opts.wordSpacing ?? 0) : 0);
      glyphs.push({ id: g.id, cluster: r.start + g.cluster, x: x + g.dx * k, y: -g.dy * k, advance: g.ax * k + extra });
      x += g.ax * k + extra;
    }
    runs.push({ text: sub, start: r.start, rtl, glyphs, width: x - runStart });
  }
  return { runs, width: x, rtl: baseRtl };
}

const WORD_SPLIT = /(\s+)/;

/** Full paragraph layout with HarfBuzz shaping, bidi, wrapping and alignment. */
export function layoutWithFont(font: TypeFont, p: ResolvedText): TextLayout {
  if (Object.keys(p.variations ?? {}).length) font.setVariations(p.variations);
  const size = p.size;
  const k = size / font.upem;
  const ascent = font.ascender * k;
  const descent = -font.descender * k;
  const lineH = size * p.lineHeight;
  const shapeOpts = { direction: p.direction, features: p.features, script: p.script, language: p.language, letterSpacing: p.letterSpacing, wordSpacing: p.wordSpacing };
  const measure = (s: string) => shapeLine(font, s, size, shapeOpts).width;

  // Wrap paragraphs (logical text) into lines.
  const lines: { text: string; offset: number }[] = [];
  let offset = 0;
  for (const para of String(p.text).split('\n')) {
    if (!p.maxWidth || p.maxWidth <= 0) lines.push({ text: para, offset });
    else {
      const parts = para.split(WORD_SPLIT);
      let cur = '';
      let curOff = offset;
      let pos = offset;
      for (const w of parts) {
        const cand = cur + w;
        if (cur.trim() && w.trim() && measure(cand.trimEnd()) > p.maxWidth) {
          lines.push({ text: cur.trimEnd(), offset: curOff });
          cur = w;
          curOff = pos;
        } else cur = cand;
        pos += w.length;
      }
      lines.push({ text: cur.trimEnd(), offset: curOff });
    }
    offset += para.length + 1;
  }

  const total = lines.length * lineH;
  const top = p.baseline === 'top' ? 0 : p.baseline === 'bottom' ? -total : p.baseline === 'alphabetic' ? -((lineH - (ascent + descent)) / 2 + ascent) : -total / 2;
  const shaped = lines.map((l) => shapeLine(font, l.text, size, shapeOpts));
  const maxW = Math.max(0, ...shaped.map((s) => s.width));
  const boxW = p.maxWidth > 0 ? Math.max(p.maxWidth, maxW) : maxW;

  // Word index per logical char across the whole text.
  const fullText = String(p.text);
  const wordOf = new Int32Array(fullText.length + 1);
  {
    let w = -1;
    let inWord = false;
    for (let i = 0; i < fullText.length; i++) {
      const sp = /\s/.test(fullText[i]!);
      if (!sp && !inWord) w++;
      inWord = !sp;
      wordOf[i] = Math.max(0, w);
    }
  }

  const glyphs: Glyph[] = [];
  const outLines: TextLine[] = [];
  shaped.forEach((s, li) => {
    const lineText = lines[li]!.text;
    const lineOff = lines[li]!.offset;
    let align = p.align;
    if (align === 'start') align = s.rtl ? 'right' : 'left';
    if (align === 'end') align = s.rtl ? 'left' : 'right';
    const justify = align === 'justify' && li < shaped.length - 1;
    if (align === 'justify') align = s.rtl ? 'right' : 'left';
    let x0: number;
    if (p.maxWidth > 0) x0 = align === 'left' ? -boxW / 2 : align === 'right' ? boxW / 2 - s.width : -s.width / 2;
    else x0 = align === 'left' ? 0 : align === 'right' ? -s.width : -s.width / 2;
    const y = top + li * lineH + (lineH - (ascent + descent)) / 2 + ascent;
    const spaces = justify ? (lineText.match(/\s/g) ?? []).length : 0;
    const extra = spaces ? (boxW - s.width) / spaces : 0;
    let shift = 0;
    for (const run of s.runs) {
      for (const g of run.glyphs) {
        const ch = lineText[g.cluster] ?? '';
        const gx = x0 + g.x + (justify && run.rtl ? 0 : shift);
        const path = font.glyphPathAt(g.id, size);
        glyphs.push({
          x: gx,
          y: y + g.y,
          width: g.advance,
          text: ch,
          path: toPath2D(path),
          pathData: serializePath(path),
          index: 0,
          cluster: lineOff + g.cluster,
          word: wordOf[lineOff + g.cluster] ?? 0,
          line: li,
          rtl: run.rtl,
        });
        if (justify && /\s/.test(ch)) shift += extra;
      }
    }
    outLines.push({ text: lineText, x: x0, y, width: justify ? boxW : s.width, rtl: s.rtl });
  });
  // Reading-order index: logical cluster order (stable for glyphs in the same cluster).
  const order = glyphs.map((g, i) => [g.cluster, i] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  order.forEach(([, gi], rank) => (glyphs[gi]!.index = rank));
  // Clusters → dense ranks so animators can target "cluster" units.
  const clusterRank = new Map<number, number>();
  [...new Set(glyphs.map((g) => g.cluster))].sort((a, b) => a - b).forEach((c, i) => clusterRank.set(c, i));
  glyphs.forEach((g) => (g.cluster = clusterRank.get(g.cluster)!));

  return {
    engine: 'harfbuzz',
    font: `${size}px "${font.family}"`,
    glyphs,
    lines: outLines,
    width: boxW,
    height: total,
    ascent,
    descent,
    box: { x: outLines.length ? Math.min(...outLines.map((l) => l.x)) : 0, y: top, width: boxW, height: total },
    glyphSafe: true,
  };
}

function toPath2D(p: PathData): Path2D | undefined {
  if (typeof Path2D === 'undefined') return undefined;
  const out = new Path2D();
  for (const c of p) {
    if (c.c === 'M') out.moveTo(c.p[0], c.p[1]);
    else if (c.c === 'L') out.lineTo(c.p[0], c.p[1]);
    else if (c.c === 'C') out.bezierCurveTo(c.c1[0], c.c1[1], c.c2[0], c.c2[1], c.p[0], c.p[1]);
    else out.closePath();
  }
  return out;
}
