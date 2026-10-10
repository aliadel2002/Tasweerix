# Guide: concepts and animation

## Compositions

A project file exports one or more composition definitions. A definition is lazy: the `build` function
runs wherever the composition renders (the studio, a headless export worker or Node tooling), so it must
only *describe* the scene.

```ts
import { composition, still, soundscape } from 'tasweerix';

export default composition({ width: 1920, height: 1080, fps: 30, duration: 10, background: '#000' }, (c, props) => {
  // c.add(...) visual nodes, c.audio(...) audio clips, c.bus(...) mixer buses, c.marker(...) markers
});

export const thumbnail = still({ width: 1280, height: 720 }, (c) => { /* one frame */ });
export const podcast = soundscape({ sampleRate: 48000 }, async (c) => { /* audio only */ });
```

| Option | Meaning |
| --- | --- |
| `width`, `height`, `fps` | Output geometry and frame rate. |
| `duration` | Total length. When it is omitted, the length is the end of the last finite node or audio clip. |
| `background` | Any paint (color, gradient) or `null` for transparency. |
| `sampleRate` | Audio sample rate (default 48000). |
| `props` | Default input props. Override them per render with `--props '{…}'`; `batch` sets them per file. |
| `scale` | Default output pixel density. |

Builds may be **async**: `await smart.silenceCuts(...)`, read files with `getEnv().loadBinary(...)` and so on.
Use `--comp <exportName>` (CLI) or the studio's selector to pick a non-default export.

## Time

All times are **seconds**. Anything that accepts a time also accepts these strings:

| Input | Seconds |
| --- | --- |
| `2.5`, `'2.5s'` | 2.5 |
| `'250ms'` | 0.25 |
| `'90f'` | 90 frames at the composition fps |
| `'01:02.5'` | 62.5 |
| `'00:01:02:15'` | SMPTE timecode (last field is frames) |

## Animatable values

Every node property is an `Animatable<T>`, which can be any of these:

```ts
rect({ opacity: 0.5 });                                         // static
rect({ opacity: keys([[0, 0], ['1s', 1, 'outCubic']]) });       // keyframes (easing = arrival easing)
rect({ rotation: (f) => f.time * 90 });                         // driver: function of the frame context
rect().animate({ opacity: [0, 1] }, { duration: 0.5 })          // tween helper (chains)
      .animate({ scale: 1.2 }, { start: 2, duration: 1, ease: 'outBack' });
```

The frame context `f` provides `time` (node-local seconds), `globalTime`, `frame`, `fps`, `duration`,
`progress`, `width`, `height`, `props`, a seeded `random(seed)` and seeded `noise(seed)`.

Values interpolate by type: numbers, vectors and arrays, CSS colors (mixed in OKLab), units such as `'10px'`,
objects (key by key) and **SVG paths**, which morph once `@tasweerix/motion` is loaded.

**Tracks** support per-segment easing, `hold` keys and `loop` (`'loop' | 'pingpong' | 'continue'`). They can
be shifted (`track.shift(1)`) or mapped (`track.map(v => v * 2)`). Expressions in `expr` include `wiggle`,
`wiggle2`, `oscillate`, `ramp`, `delay`, `remap`, `freeze` and `combine`.

**Easings:** `linear`, `in/out/inOut` × `Quad/Cubic/Quart/Quint/Sine/Expo/Circ/Back/Elastic/Bounce`, plus
`smooth`, `snappy`, `cinematic`, `bezier(x1, y1, x2, y2)`, `steps(n)`, `spring({ stiffness, damping, mass })`,
`reverse`, `mirror` and `chain`. Plugins can register more.

## Nodes

All nodes share timing and transform:

| Prop / method | Meaning |
| --- | --- |
| `start`, `duration`, `end` (options) / `.span()`, `.startAt()`, `.lasting()`, `.endAt()` | Visibility window, in the parent's timeline. |
| `.rate(speed)`, `.remap(animatable)` | Content time for media and children (speed ramps, freeze frames, reverse). |
| `position` (or `at`), `anchor`, `scale`, `rotation` (degrees), `skew`, `opacity` | Transform. Nodes draw centered on their origin; root-level nodes default to the frame center. |
| `blend` | `normal`, `multiply`, `screen`, `overlay`, `darken`, `lighten`, `color-dodge`, `color-burn`, `hard-light`, `soft-light`, `difference`, `exclusion`, `hue`, `saturation`, `color`, `luminosity`, `add`. |
| `shadow`, `motionBlur` (shutter degrees) | Built-in drop shadow and sub-frame motion blur. |
| `.filter(...fx)`, `.mask(node, mode)` | GPU filter chain, alpha or luma mask (with inverted variants). |
| `.use(...behaviors)` | Apply presets such as `motion.enter.fade()`. |

Node factories:

| Factory | Node |
| --- | --- |
| `rect`, `ellipse`, `circle`, `polygon`, `star`, `path`, `polyline`, `line` | Shapes with `fill`, `stroke`, `strokeWidth`, dashes, caps and joins, `trimStart`/`trimEnd`/`trimOffset`. |
| `text(content, opts)` | Text with font family or font file, size, weight, alignment, line height, letter and word spacing, `maxWidth` wrapping, direction, OpenType features, variable axes, and `.glyphs(...)` animators. |
| `image(src)`, `video(src, { trim, speed, loop, muted })` | Media with `size`, `fit` (`contain`/`cover`/`fill`/`none`) and `crop`. Video audio is mixed automatically. |
| `photo(src, ops)` | Image with a photo-edit pipeline (see [photo](photo.md)). |
| `solid(paint)`, `canvas(draw)` | A full-frame fill, and an immediate-mode Canvas2D escape hatch. |
| `group(...children, opts)` | Container (`size` plus `clip: true` to clip). |
| `comp(definition, { props })` | Nested composition (pre-comp) with its own timeline. |
| `adjustment(...fx)` | Applies filters to everything below it in the same parent. |
| `sequence`, `parallel`, `stagger`, `transition.sequence`, `transition.chain` | Timeline layout. |

## Paints

Colors are any CSS color string or RGBA array. Gradients:

```ts
gradient.linear([-200, 0], [200, 0], ['#f43f5e', '#facc15'])
gradient.angled(35, [1920, 1080], ['#1e1b4b', '#0b1020'])
gradient.radial([0, 0], 400, [[0, '#fff'], [1, 'transparent']])
gradient.conic([0, 0], 0, ['red', 'yellow', 'lime', 'cyan', 'blue', 'magenta', 'red'])
gradient.pattern('assets/texture.png', { scale: 0.5 })
```

## Determinism

Rendering never reads the wall clock and never calls `Math.random`. Use `f.random(seed)` and
`f.noise(seed)`, or `createRandom(seed)` while building. Particles re-simulate from birth every frame.
Because of this, every frame is reproducible, and that is what lets exports run in parallel.
