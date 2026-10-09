import type { GlyphAnimator, GlyphState, GlyphUnit, FrameContext, TextProps } from '@tasweerix/core';
import { clamp, interpolate } from '@tasweerix/core';
import type { Ctx2D } from './surface';
import { createSurface, ctx2d } from './surface';

/** One drawable unit of text. Coordinates are in the text node's local space (baseline origin). */
export interface Glyph {
  x: number;
  y: number;
  width: number;
  /** Drawn with fillText when no path is present. */
  text: string;
  /** Glyph outline (font units already scaled), relative to (x, y). */
  path?: Path2D;
  /** Path command string (for SVG export / tools). */
  pathData?: string;
  /** Logical (reading-order) index. */
  index: number;
  cluster: number;
  word: number;
  line: number;
  rtl: boolean;
}

export interface TextLine {
  text: string;
  x: number;
  y: number;
  width: number;
  rtl: boolean;
}

export interface TextLayout {
  engine: string;
  font: string;
  glyphs: Glyph[];
  lines: TextLine[];
  width: number;
  height: number;
  ascent: number;
  descent: number;
  /** Bounding box relative to node origin. */
  box: { x: number; y: number; width: number; height: number };
  /** Whether the glyphs can be drawn individually without breaking shaping. */
  glyphSafe: boolean;
}

export type ResolvedText = TextProps & { fontFamily: string };

export interface TextEngine {
  name: string;
  /** Return true if this engine should lay out this text. */
  supports(p: ResolvedText): boolean;
  layout(p: ResolvedText): TextLayout;
}

const engines: TextEngine[] = [];
/** Registers a text engine with priority over the built-in canvas engine. */
export function registerTextEngine(e: TextEngine): void {
  const i = engines.findIndex((x) => x.name === e.name);
  if (i >= 0) engines.splice(i, 1);
  engines.unshift(e);
}

const RTL_RE = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LTR_RE = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;
export function detectRtl(text: string): boolean {
  for (const ch of text) {
    if (RTL_RE.test(ch)) return true;
    if (LTR_RE.test(ch)) return false;
  }
  return false;
}
/** Scripts that join letters (per-character drawing would break them). */
const JOINING_RE = /[؀-ࣿﭐ-﷿ﹰ-﻿܀-ݏऀ-෿]/;

export function cssFont(p: ResolvedText): string {
  return `${p.style === 'italic' ? 'italic ' : ''}${p.weight} ${p.size}px ${p.fontFamily.includes(',') ? p.fontFamily : `"${p.fontFamily}"`}`;
}

let measureCtx: Ctx2D | null = null;
function mctx(): Ctx2D {
  if (!measureCtx) measureCtx = ctx2d(createSurface(8, 8));
  return measureCtx;
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
function graphemes(s: string): string[] {
  if (segmenter) return [...segmenter.segment(s)].map((x) => x.segment);
  return [...s];
}

/** Built-in engine based on Canvas text APIs (browser shaping, kerning and fallback fonts). */
export const canvasTextEngine: TextEngine = {
  name: 'canvas',
  supports: () => true,
  layout(p) {
    const ctx = mctx();
    ctx.font = cssFont(p);
    (ctx as CanvasRenderingContext2D).letterSpacing = `${p.letterSpacing}px`;
    (ctx as CanvasRenderingContext2D).wordSpacing = `${p.wordSpacing}px`;
    const m = ctx.measureText('Hg');
    const ascent = m.fontBoundingBoxAscent ?? p.size * 0.8;
    const descent = m.fontBoundingBoxDescent ?? p.size * 0.2;
    const lineH = p.size * p.lineHeight;
    const baseRtl = p.direction === 'rtl' || (p.direction === 'auto' && detectRtl(p.text));
    const measure = (s: string) => ctx.measureText(s).width;

    // Wrap paragraphs.
    const rawLines: string[] = [];
    for (const para of String(p.text).split('\n')) {
      if (!p.maxWidth || p.maxWidth <= 0) {
        rawLines.push(para);
        continue;
      }
      const words = para.split(/(\s+)/);
      let cur = '';
      for (const w of words) {
        const cand = cur + w;
        if (cur && measure(cand.trimEnd()) > p.maxWidth && w.trim()) {
          rawLines.push(cur.trimEnd());
          cur = w.trimStart();
        } else cur = cand;
      }
      rawLines.push(cur.trimEnd());
    }

    const total = rawLines.length * lineH;
    let top: number;
    switch (p.baseline) {
      case 'top':
        top = 0;
        break;
      case 'bottom':
        top = -total;
        break;
      case 'alphabetic':
        top = -((lineH - (ascent + descent)) / 2 + ascent);
        break;
      default:
        top = -total / 2;
    }
    const glyphs: Glyph[] = [];
    const lines: TextLine[] = [];
    let index = 0;
    let wordIdx = 0;
    let maxW = 0;
    rawLines.forEach((lineText, li) => {
      const rtl = p.direction === 'auto' ? (lineText ? detectRtl(lineText) : baseRtl) : baseRtl;
      const width = measure(lineText);
      maxW = Math.max(maxW, width);
      lines.push({ text: lineText, x: 0, y: top + li * lineH + (lineH - (ascent + descent)) / 2 + ascent, width, rtl });
    });
    const boxW = p.maxWidth > 0 ? Math.max(p.maxWidth, maxW) : maxW;
    let glyphSafe = true;
    lines.forEach((line, li) => {
      let align = p.align;
      if (align === 'start') align = line.rtl ? 'right' : 'left';
      if (align === 'end') align = line.rtl ? 'left' : 'right';
      const justify = align === 'justify' && li < lines.length - 1;
      if (align === 'justify') align = line.rtl ? 'right' : 'left';
      // Without maxWidth the origin is the line's left edge / center / right edge.
      // With maxWidth the text box (maxWidth wide) is centered on the origin.
      let x: number;
      if (p.maxWidth > 0) {
        const blockLeft = -boxW / 2;
        x = align === 'left' ? blockLeft : align === 'right' ? blockLeft + boxW - line.width : -line.width / 2;
      } else {
        x = align === 'left' ? 0 : align === 'right' ? -line.width : -line.width / 2;
      }
      line.x = x;
      const joining = JOINING_RE.test(line.text);
      const extraPerGap = justify ? (boxW - line.width) / Math.max(1, (line.text.match(/\s+/g) ?? []).length) : 0;
      if (justify) line.width = boxW;

      if (line.rtl || joining) {
        // Word units, laid out right-to-left (keeps contextual letter joining intact).
        glyphSafe = glyphSafe && !joining;
        const parts = line.text.split(/(\s+)/).filter((s) => s.length);
        const spaceW = measure(' ');
        let cursor = line.rtl ? x + line.width : x;
        for (const part of parts) {
          const isSpace = !part.trim();
          const w = isSpace ? part.length * spaceW + extraPerGap : measure(part);
          if (!isSpace) {
            glyphs.push({ x: line.rtl ? cursor - w : cursor, y: line.y, width: w, text: part, index: index++, cluster: index - 1, word: wordIdx++, line: li, rtl: line.rtl });
          }
          cursor += line.rtl ? -w : w;
        }
      } else {
        const gs = graphemes(line.text);
        let prefix = '';
        let gap = 0;
        let inWord = false;
        for (const g of gs) {
          const isSpace = !g.trim();
          const gx = x + measure(prefix) + gap;
          if (isSpace) {
            if (inWord) wordIdx++;
            inWord = false;
            gap += extraPerGap;
          } else {
            inWord = true;
            glyphs.push({ x: gx, y: line.y, width: measure(g), text: g, index: index++, cluster: index - 1, word: wordIdx, line: li, rtl: false });
          }
          prefix += g;
        }
        if (inWord) wordIdx++;
      }
    });
    return {
      engine: 'canvas',
      font: cssFont(p),
      glyphs,
      lines,
      width: boxW,
      height: total,
      ascent,
      descent,
      box: { x: lines.length ? Math.min(...lines.map((l) => l.x)) : 0, y: top, width: boxW, height: total },
      glyphSafe,
    };
  },
};

const layoutCache = new Map<string, TextLayout>();
export function layoutText(p: ResolvedText): TextLayout {
  const key = JSON.stringify([p.text, p.fontFamily, p.size, p.weight, p.style, p.align, p.baseline, p.direction, p.lineHeight, p.letterSpacing, p.wordSpacing, p.maxWidth, p.features, p.variations, p.script, p.language]);
  let l = layoutCache.get(key);
  if (!l) {
    const engine = engines.find((e) => e.supports(p)) ?? canvasTextEngine;
    l = engine.layout(p);
    if (layoutCache.size > 500) layoutCache.clear();
    layoutCache.set(key, l);
  }
  return l;
}
export function clearTextCache(): void {
  layoutCache.clear();
}

// ------------------------------------------------------------- Glyph animation

export const REST_STATE: GlyphState = { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, blur: 0, fill: '', reveal: 1, tracking: 0 };

/** Groups glyph indices into units. */
export function unitsOf(layout: TextLayout, by: GlyphUnit): number[][] {
  const key = (g: Glyph) => (by === 'word' ? g.word : by === 'line' ? g.line : by === 'cluster' ? g.cluster : g.index);
  const map = new Map<number, number[]>();
  layout.glyphs.forEach((g, i) => {
    const k = key(g);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(i);
  });
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
}

function orderRanks(layout: TextLayout, units: number[][], order: GlyphAnimator['order'], seed: number): number[] {
  const n = units.length;
  const idx = Array.from({ length: n }, (_, i) => i);
  let sorted: number[];
  switch (order) {
    case 'visual': {
      const cx = units.map((u) => Math.min(...u.map((g) => layout.glyphs[g]!.x)));
      const cy = units.map((u) => layout.glyphs[u[0]!]!.line);
      sorted = idx.sort((a, b) => cy[a]! - cy[b]! || cx[a]! - cx[b]!);
      break;
    }
    case 'reverse':
      sorted = idx.reverse();
      break;
    case 'center-out':
      sorted = idx.sort((a, b) => Math.abs(a - (n - 1) / 2) - Math.abs(b - (n - 1) / 2));
      break;
    case 'edges-in':
      sorted = idx.sort((a, b) => Math.abs(b - (n - 1) / 2) - Math.abs(a - (n - 1) / 2));
      break;
    case 'random': {
      let s = seed * 9301 + 49297;
      const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
      sorted = idx.map((i) => [i, rnd()] as const).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
      break;
    }
    default:
      sorted = idx;
  }
  const ranks = new Array<number>(n);
  sorted.forEach((u, r) => (ranks[u] = r));
  return ranks;
}

/** Computes the animated state of every glyph (one entry per glyph) at a local time. */
export function glyphStates(layout: TextLayout, animators: GlyphAnimator[], frame: FrameContext): GlyphState[] {
  const states = layout.glyphs.map(() => ({ ...REST_STATE }));
  for (const a of animators) {
    const units = unitsOf(layout, a.by);
    const ranks = orderRanks(layout, units, a.order, a.seed);
    units.forEach((u, ui) => {
      const rank = ranks[ui]!;
      const local = frame.time - a.start - rank * a.stagger;
      const prog = a.ease(clamp(a.duration > 0 ? local / a.duration : local >= 0 ? 1 : 0));
      let delta: Partial<GlyphState>;
      if (a.custom) delta = a.custom({ index: rank, count: units.length, progress: prog, ctx: frame });
      else {
        delta = {};
        const to = { ...REST_STATE, ...(a.to ?? {}) };
        for (const [k, fromV] of Object.entries(a.from) as [keyof GlyphState, unknown][]) {
          (delta as Record<string, unknown>)[k] = interpolate(fromV, to[k] as unknown, prog);
        }
        if (a.to) for (const [k, v] of Object.entries(a.to)) if (!(k in a.from)) (delta as Record<string, unknown>)[k] = interpolate((REST_STATE as unknown as Record<string, unknown>)[k], v, prog);
      }
      for (const gi of u) {
        const s = states[gi]!;
        if (delta.x !== undefined) s.x += delta.x;
        if (delta.y !== undefined) s.y += delta.y;
        if (delta.rotation !== undefined) s.rotation += delta.rotation;
        if (delta.blur !== undefined) s.blur += delta.blur;
        if (delta.tracking !== undefined) s.tracking += delta.tracking;
        if (delta.scale !== undefined) s.scale *= delta.scale;
        if (delta.scaleX !== undefined) s.scaleX *= delta.scaleX;
        if (delta.scaleY !== undefined) s.scaleY *= delta.scaleY;
        if (delta.opacity !== undefined) s.opacity *= delta.opacity;
        if (delta.reveal !== undefined) s.reveal *= delta.reveal;
        if (delta.fill) s.fill = delta.fill;
      }
    });
  }
  return states;
}
