---
name: motion-type
description: Tasweerix motion graphics and typography - kinetic text with glyph animators, Arabic and RTL text shaped by HarfBuzz, kashida, enter/exit/loop behaviors, trim paths, path morphing, repeaters, particles, animated charts, lower thirds, title cards, callouts, and vector illustration with SVG export. Use for titles, explainers, social posts, data videos and generative art.
---

# Motion graphics and typography in Tasweerix

## Kinetic text

```ts
text('Hello world', { size: 120, weight: 800 }).glyphs(textFx.pop({ stagger: 0.04 }));
text('Words fly in', { size: 80 }).glyphs(textFx.fadeUp({ by: 'word', stagger: 0.1 }), textFx.out({ start: 3, by: 'word' }));
text('Typing…').glyphs(textFx.typewriter({ cps: 20 }));
text(scramble('DECODED', { duration: 1.5 }), { size: 90 });
text(counter(0, 1_000_000, { duration: 2, prefix: '$' }));
```

Presets: `reveal`, `fadeUp`, `fadeDown`, `pop`, `blurIn`, `spinIn`, `dropIn`, `stretchIn`, `typewriter`,
`wipe`, `out`, `wave`, `jitter`, `highlight`. Options: `by` (`glyph`, `cluster`, `char`, `word`, `line`),
`order` (`reading`, `visual`, `reverse`, `center-out`, `edges-in`, `random`), `start`, `stagger`,
`duration`, `from`/`to`, `ease`. Use `textFx.out(...)` with a later `start` for the exit.

## Arabic and right-to-left text

Give `font` a **font file** to shape with HarfBuzz and the Unicode bidi algorithm: joined forms,
ligatures and marks stay correct while each glyph animates in reading order. Without a font file,
RTL text animates per word only.

```ts
import { composition, text, textFx, kashidaText, keys, arabicDigits, rect, gradient } from 'tasweerix';

const CAIRO = 'assets/fonts/Cairo-Bold.ttf';

export default composition({ width: 1920, height: 1080, fps: 30, duration: 5, background: '#0b0d17' }, (c) => {
  c.add(rect({ size: [1920, 1080], fill: gradient.radial([0, 0], 1100, ['#1e1b4b', '#0b0d17']) }));
  c.add(text('مرحبا بالعالم', { font: CAIRO, size: 160, fill: '#fff', at: [960, 420] }).glyphs(textFx.dropIn({ by: 'glyph', order: 'reading', stagger: 0.06 })));
  c.add(text(kashidaText('جميل', keys([[1, 0], [2.5, 4, 'inOutCubic']])), { font: CAIRO, size: 110, fill: '#facc15', at: [960, 680] }));
  c.add(text(`أهلاً بكم ${arabicDigits(2026)}`, { font: CAIRO, size: 48, fill: '#cbd5e1', at: [960, 880] }).glyphs(textFx.fadeUp({ by: 'word', stagger: 0.12 })));
});
```

`direction` (`auto`, `ltr`, `rtl`), `script`, `language`, `features` (e.g. `{ liga: 0 }`) and
`variations` (e.g. `{ wght: 650 }`) pass to HarfBuzz. Arabic fonts in this repo: `assets/fonts/`
(use `--root .` when rendering examples that reference them). Always check Arabic output with
`render_still`; broken joining means the font file wasn't found or isn't a file path.

## Behaviors

```ts
node.use(motion.enter.slideUp({ duration: 0.6 }), motion.exit.fade(), motion.loop.float());
```

Enter: `fade`, `scale`, `pop`, `rotate`, `blur`, `slideLeft|Right|Up|Down`, `draw`. Exit: `fade`,
`scale`, `slide*`, `erase`. Loop: `float`, `pulse`, `spin`, `shake`.

## Shapes, paths and morphing

```ts
path(motion.morph([starD, circleD, heartD], { each: 0.8, hold: 0.4 }), { fill: '#22d3ee' });
rect().use(motion.followPath('M0 0 C 200 -200 400 200 600 0', { duration: 3, rotate: true }));
motion.repeat(12, (i) => star({ fill: palette[i] }), { type: 'circle', radius: 300, rotate: true }, { stagger: 0.05 });
ellipse({ size: [80, 80], fill: null, stroke: '#fff', strokeWidth: 6, trimEnd: keys([[0, 0], [2, 1]]) });   // draw-on
```

## Particles

Deterministic, re-simulated from birth each frame: `motion.particlePresets.confetti({ seed })`,
`sparks`, `snow`, `smoke`, `fireflies`, placed with `.at([x, y])` and `.startAt(t)`. Always pass a `seed`.

## Ready-made pieces

`motion.titleCard(title, { kicker, at, size, duration })`, `motion.lowerThird(title, subtitle, { at, start, duration })`
(RTL aware), `motion.callout(point, label, { start, offset })`, `motion.numberCounter(value, { from, prefix, suffix, size, at, start, duration })`,
`motion.progressBar`, `motion.barChart(items, { size, at, animateIn })`, `motion.lineChart(values, ...)`,
`motion.pieChart(items, { radius, donut, ... })`, `motion.spectrumBars(analysis)`.

```ts
import { composition, motion, text, textFx } from 'tasweerix';

type Props = { revenue: number[] };

export default composition<Props>({ width: 1920, height: 1080, fps: 30, duration: 8, background: '#0b1120', props: { revenue: [12, 18, 15, 26, 31, 29, 42, 48] } }, (c, { revenue }) => {
  c.add(text('Quarterly report', { at: [120, 110], align: 'left', size: 64, weight: 800, fill: '#fff' }).glyphs(textFx.fadeUp({ by: 'word', stagger: 0.12 })));
  c.add(motion.lineChart(revenue, { size: [900, 360], at: [560, 420], colors: ['#22d3ee'], animateIn: { start: 0.6, duration: 2.2 } }));
  c.add(motion.numberCounter(revenue[revenue.length - 1]! * 1000, { prefix: '$', size: 88, at: [560, 720], start: 0.8, duration: 2 }));
  c.add(motion.barChart(revenue.map((v, i) => ({ label: `Q${i + 1}`, value: v })), { size: [1680, 160], at: [960, 960], animateIn: { start: 3.5, stagger: 0.08 } }));
});
```

## Illustration and SVG

`pen()` path builder, `boolean.union|intersect|subtract|xor`, `offsetPath`, `strokeToPath`,
`simplifyPath`, `smoothPath`, `poissonDisc`, `delaunay`, `voronoi`, `flowField`, `ridgeLines`,
`lSystem`, `blob`, `spirograph`, `patterns.*`, and `svgFile('assets/logo.svg')` to import artwork.
`tasweerix svg poster.ts -o out/poster.svg` exports a frame as vectors (text becomes outlines; GPU
filters are raster-only and left out). See `read_docs` topic `illustration`.

## Design checks before rendering

- Keep text inside the title-safe area (about 90% of the frame) and check contrast on a still.
- Stagger entrances (0.03 to 0.08 s per glyph, 0.1 to 0.15 s per word) and leave each title readable
  for at least as long as it takes to read aloud.
- One easing family per piece reads as deliberate: `outCubic`/`outBack` for entrances, `inCubic` for exits.
