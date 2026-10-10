---
name: scenes
description: Core Tasweerix API for writing scene files - compositions, stills, soundscapes, time strings, keyframes, drivers, nodes, transforms, paints and props. Use whenever you create or edit a Tasweerix project file (a .ts file importing from 'tasweerix').
---

# Writing Tasweerix scenes

Tasweerix renders TypeScript scene files to video, images and audio. A project file exports a
**composition definition**; its `build` function only *describes* the scene (it runs in the studio,
in export workers and in Node tooling), so it must be deterministic.

## Workflow

1. Read the existing entry file (usually `index.ts`) and `inspect_composition` it if it's large.
2. Write or edit the scene. Import everything from `'tasweerix'`.
3. Check it loads: `inspect_composition` (or `tasweerix inspect <entry>`).
4. Look at it: `render_still` at the key moments (a title's end pose, a transition midpoint, the
   last second). Fix layout, overlap, contrast and timing from what you see, then look again.
5. Render with `render_video` (or `/tasweerix:render`). Use `scale: 0.5` and a `range` for fast drafts.

For API pages not covered by these skills (AI, illustration, smart editing, stabilization, plugins,
export details), call the `read_docs` tool with a topic.

## Minimal file

```ts
import { composition, rect, text, gradient, keys, textFx, motion } from 'tasweerix';

export default composition({ width: 1920, height: 1080, fps: 30, duration: 6, background: '#0b1020' }, (c) => {
  c.add(rect({ size: [1920, 1080], fill: gradient.angled(35, [1920, 1080], ['#1e1b4b', '#0b1020']) }));
  c.add(text('Hello, Tasweerix', { size: 140, weight: 800, fill: '#ffffff' }).glyphs(textFx.pop({ stagger: 0.04 })));
  c.add(rect({ size: [520, 8], radius: 4, fill: '#22d3ee', at: [960, 640], scale: keys([[0.6, [0, 1]], [1.4, [1, 1], 'outCubic']]) }));
  c.add(motion.particlePresets.fireflies({ seed: 3 }));
});
```

## Definitions

| Factory | Use |
| --- | --- |
| `composition(opts, build)` | Video. `opts`: `width`, `height`, `fps`, `duration` (omit to end with the last finite node or clip), `background` (paint or `null` for transparency), `sampleRate`, `props` (defaults), `scale`, `name`. |
| `still(opts, build)` | One frame: photos, posters, thumbnails, illustrations (no `fps`/`duration`). |
| `soundscape(opts, build)` | Audio only (no `width`/`height`). |

`build(c, props)` may be `async` (await analyses such as `smart.autoCut`, `stabilize`,
`importTimeline`). Inside it: `c.add(...nodes)`, `c.audio(clip)`, `c.bus(name, opts)`, `c.master(...fx)`,
`c.marker(time, label)`. Extra exports are other compositions, rendered with `--comp <name>`.

Typed props: `composition<{ title: string }>({ ..., props: { title: 'Hi' } }, (c, { title }) => ...)`,
overridden per render with `--props '{"title":"Launch"}'`.

## Time

Seconds everywhere. Strings also work: `'2.5s'`, `'250ms'`, `'90f'` (frames), `'01:02.5'`,
`'00:01:02:15'` (SMPTE, last field frames).

## Animating any property

```ts
rect({ opacity: 0.5 });                                       // static
rect({ opacity: keys([[0, 0], ['1s', 1, 'outCubic']]) });     // keyframes: [time, value, easing-into-this-key]
rect({ rotation: (f) => f.time * 90 });                       // driver of the frame context
rect().animate({ opacity: [0, 1] }, { duration: 0.5 })        // tween helper, chainable
      .animate({ scale: 1.2 }, { start: 2, duration: 1, ease: 'outBack' });
```

Frame context `f`: `time` (node-local), `globalTime`, `frame`, `fps`, `duration`, `progress`, `width`,
`height`, `props`, `random(seed)`, `noise(seed)`. Values interpolate by type: numbers, vectors, CSS
colors (in OKLab), units, objects and SVG path data (morphs).

Easings: `linear`, `in|out|inOut` + `Quad|Cubic|Quart|Quint|Sine|Expo|Circ|Back|Elastic|Bounce`
(e.g. `'outBack'`), `smooth`, `snappy`, `cinematic`, `bezier(x1,y1,x2,y2)`, `steps(n)`,
`spring({ stiffness, damping, mass })`. Tracks support `hold` keys and `loop: 'loop' | 'pingpong' | 'continue'`.

**Determinism:** never use `Math.random()` or `Date`. Use `f.random(seed)`, `f.noise(seed)` or
`createRandom(seed)` while building.

## Nodes

Every node has timing (`start`, `duration`, `end`; `.startAt()`, `.lasting()`, `.endAt()`, `.span()`),
content time (`.rate(speed)`, `.remap(track)`) and transform (`at`/`position`, `anchor`, `scale`,
`rotation` in degrees, `skew`, `opacity`, `blend`, `shadow`, `motionBlur`). Plus `.filter(...fx)`,
`.mask(node, 'alpha' | 'luma' | 'alpha-inverted' | 'luma-inverted')` and `.use(...behaviors)`.

**Coordinates:** composition pixels, origin top-left, y down. Nodes draw **centered** on their
position, and root-level nodes default to the frame center. `text(..., { align: 'left' })` anchors
the left edge at `at`.

| Factory | Node |
| --- | --- |
| `rect`, `ellipse`, `circle`, `polygon`, `star`, `path`, `polyline`, `line` | Shapes: `size`, `radius`, `fill`, `stroke`, `strokeWidth`, dashes, `trimStart`/`trimEnd`/`trimOffset` |
| `text(content, opts)` | `size`, `weight`, `font` (file path for HarfBuzz shaping) or font family, `fill`, `align`, `baseline`, `lineHeight`, `letterSpacing`, `maxWidth`, `direction`; `.glyphs(...)` animators |
| `image(src)`, `video(src, opts)`, `photo(src, ops)` | Media with `size`, `fit` (`contain`/`cover`/`fill`/`none`), `crop` |
| `solid(paint)`, `canvas(draw)` | Full-frame fill; Canvas2D escape hatch |
| `group(...children, opts)` | Container (`size` + `clip: true` to clip) |
| `comp(definition, { props })` | Nested composition with its own timeline |
| `adjustment(...fx)` | Filters everything below it in the same parent |
| `sequence`, `parallel`, `stagger`, `transition.sequence`, `transition.chain` | Timeline layout (see the video skill) |

## Paints

CSS color strings (including `color(display-p3 ...)`) or RGBA arrays, and gradients:

```ts
gradient.linear([-200, 0], [200, 0], ['#f43f5e', '#facc15'])
gradient.angled(35, [1920, 1080], ['#1e1b4b', '#0b1020'])
gradient.radial([0, 0], 400, [[0, '#fff'], [1, 'transparent']])
gradient.conic([0, 0], 0, ['red', 'yellow', 'lime', 'cyan', 'blue', 'magenta', 'red'])
gradient.pattern('assets/texture.png', { scale: 0.5 })
```

Gradient coordinates are relative to the node's center.

## Assets

Paths are relative to the asset root (the entry's directory by default; `--root .` to use the
current directory). Put media in `assets/`. Check files exist before referencing them, and use
`probe_media` to read a clip's size, duration and frame rate rather than guessing.

## Common mistakes

- Forgetting `duration` on a composition with only infinite nodes (shapes, text): it then has no end.
- Positioning as if the origin were top-left: shapes are centered on `at`.
- Changing `start` of items inside `sequence(...)`: the layout sets them; change order or durations.
- Non-literal values where the studio should edit them: prefer literals (`at: [960, 540]`) so
  two-way editing can rewrite them.
