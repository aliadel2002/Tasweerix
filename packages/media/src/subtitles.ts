import { group, text, type Animatable, type AnimProps, type BaseProps, type GroupNode, type NodeOptions, type ShapeStyle, type TextProps, type Vec2 } from '@tasweerix/core';

export interface Cue {
  start: number;
  end: number;
  text: string;
  /** Optional word timings (for karaoke-style captions). */
  words?: { start: number; end: number; text: string }[];
}

function parseStamp(s: string): number {
  const m = /(?:(\d+):)?(\d+):(\d+)[.,](\d+)/.exec(s.trim());
  if (!m) throw new Error(`Bad timestamp "${s}"`);
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4]}`);
}

/** Parses SubRip (.srt) or WebVTT (.vtt) text. */
export function parseSubtitles(src: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = src.replace(/\r/g, '').replace(/^WEBVTT[^\n]*\n/, '').split(/\n{2,}/);
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, z] = lines[ti]!.split('-->');
    const body = lines
      .slice(ti + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .trim();
    cues.push({ start: parseStamp(a!), end: parseStamp(z!.trim().split(/\s+/)[0]!), text: body });
  }
  return cues.sort((x, y) => x.start - y.start);
}

const stamp = (t: number, sep: string) => {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(ms % 1000, 3)}`;
};

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.text}\n`).join('\n');
}
export function toVtt(cues: Cue[]): string {
  return `WEBVTT\n\n${cues.map((c) => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${c.text}\n`).join('\n')}`;
}

export interface CaptionStyle extends AnimProps<TextProps & ShapeStyle & BaseProps> {
  /** Fade in/out duration per cue (seconds). */
  fade?: number;
  /** Highlight color for the active word (needs word timings). */
  highlight?: string;
  /** Caption position (shorthand for position). */
  at?: Animatable<Vec2>;
}

/** Builds caption text nodes from cues. */
export function captions(cues: Cue[], style: CaptionStyle = {}, opts: NodeOptions = {}): GroupNode {
  const { fade = 0.12, highlight, ...textStyle } = style;
  // Cue positions are absolute composition coordinates, so the container sits at the origin.
  const g = group({ at: [0, 0], ...opts });
  g.name = g.name ?? 'captions';
  for (const c of cues) {
    const dur = Math.max(0.01, c.end - c.start);
    const t = text(c.text, { size: 54, fill: '#fff', stroke: 'rgba(0,0,0,0.85)', strokeWidth: 8, strokeFirst: true, weight: 700, maxWidth: 1500, baseline: 'bottom', ...textStyle } as never);
    t.span(c.start, dur);
    if (fade > 0) t.keys('opacity', [[0, 0], [Math.min(fade, dur / 2), 1], [Math.max(dur - fade, dur / 2), 1], [dur, 0]]);
    if (highlight && c.words?.length) {
      const words = c.words;
      t.glyphs({
        by: 'word',
        order: 'reading',
        stagger: 0,
        start: 0,
        duration: 0,
        ease: (x) => x,
        from: {},
        seed: 0,
        custom: ({ index, ctx }) => {
          const w = words[index];
          const active = w && ctx.time + c.start >= w.start && ctx.time + c.start < w.end;
          return active ? { fill: highlight, scale: 1.08 } : {};
        },
      });
    }
    g.add(t);
  }
  g.lasting(cues.length ? Math.max(...cues.map((c) => c.end)) : 0);
  return g;
}
