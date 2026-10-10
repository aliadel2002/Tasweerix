# Motion graphics and typography

## Kinetic typography

Text nodes accept glyph animators. Units are `glyph`, `cluster`, `char`, `word` or `line`. The order is
`reading` (respects RTL), `visual`, `reverse`, `center-out`, `edges-in` or `random`.

```ts
text('Hello world', { size: 120 }).glyphs(textFx.pop({ stagger: 0.04 }));
text('Words fly in', { size: 80 }).glyphs(textFx.fadeUp({ by: 'word', stagger: 0.1 }), textFx.out({ start: 3, by: 'word' }));
text('Typing…').glyphs(textFx.typewriter({ cps: 20 }));
text(scramble('DECODED', { duration: 1.5 }), { size: 90 });
text(counter(0, 1_000_000, { duration: 2, prefix: '$' }));
```

The presets are `reveal`, `fadeUp`, `fadeDown`, `pop`, `blurIn`, `spinIn`, `dropIn`, `stretchIn`, `typewriter`,
`wipe`, `out`, `wave`, `jitter` and `highlight`. To build your own, pass `{ from, to, ease, stagger }` or a
`custom({ index, count, progress, ctx })` function.

## Arabic and right-to-left text

When `font` is a font file, Tasweerix shapes text with **HarfBuzz** and applies the **Unicode bidi**
algorithm. Glyphs are real outlines with correct contextual forms, ligatures (for example lam-alef) and
marks. Per-glyph animation then moves joined letters individually, in reading order, without breaking the script.

```ts
text('مرحبا بالعالم', { font: 'assets/Cairo-Bold.ttf', size: 140 }).glyphs(textFx.dropIn({ stagger: 0.06 }));
text(kashidaText('جميل', keys([[0, 0], [1, 4]])), { font: 'assets/Amiri-Regular.ttf' });  // animated tatweel
text(`أهلاً بكم في Tasweerix ${arabicDigits(2026)}`, { font: 'assets/Cairo-Bold.ttf' });   // mixed bidi line
```

`direction` (`auto` | `ltr` | `rtl`), `script`, `language`, `features` (for example `{ liga: 0 }`) and
`variations` (for example `{ wght: 650 }`) pass through to HarfBuzz. Without a font file, text uses the
browser's shaping. RTL text then animates per word, so joining stays intact.

## Behaviors

```ts
node.use(motion.enter.slideUp({ duration: 0.6 }), motion.exit.fade(), motion.loop.float());
```

| Kind | Behaviors |
| --- | --- |
| Enter | `fade`, `scale`, `pop`, `rotate`, `blur`, `slideLeft`, `slideRight`, `slideUp`, `slideDown`, `draw` (trim paths) |
| Exit | `fade`, `scale`, `slide*`, `erase` |
| Loop | `float`, `pulse`, `spin`, `shake` |

## Shapes, paths and morphing

Shapes support `trimStart`, `trimEnd` and `trimOffset` for draw-on strokes, plus dashes and gradients.
Animating `path` data between shapes morphs them, even with different subpath counts:

```ts
path(motion.morph([starD, circleD, heartD], { each: 0.8, hold: 0.4 }), { fill: '#22d3ee' });
rect().use(motion.followPath('M0 0 C 200 -200 400 200 600 0', { duration: 3, rotate: true }));
motion.repeat(12, (i) => star({ fill: palette[i] }), { type: 'circle', radius: 300, rotate: true }, { stagger: 0.05 });
```

## Particles

Particles are deterministic: each one is re-simulated from birth every frame. Options include emitter
shapes, rate and burst, life, speed and spread, gravity, drag, curl-noise turbulence, size, color and
opacity over life, shapes (circle, square, star, line, spark) and additive blending. The presets are
`confetti`, `sparks`, `snow`, `smoke` and `fireflies`.

## Charts and presets

`motion.barChart`, `lineChart` (draws itself), `pieChart` (or donut), `numberCounter`, `progressBar`,
`lowerThird` (RTL aware), `titleCard`, `callout` and `spectrumBars`.
