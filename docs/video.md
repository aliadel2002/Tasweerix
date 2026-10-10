# Video editing, filters and transitions

## Clips and timing

```ts
video('assets/a.mp4', { trim: [2, 6] })            // in/out in source seconds
video('assets/b.mp4', { speed: 2 })                // fast motion (negative = reverse)
video('assets/c.mp4', { loop: true, muted: true }).lasting(10)
video('assets/d.mp4').remap(keys([[0, 0], [1, 1], [3, 1.2]]))   // speed ramp into a near-freeze
```

Each video node's audio is added to the mix (route it with `node.meta.audioBus = 'voice'`, set `volume`, or use `muted`).

Layout helpers:

```ts
sequence([a, b, c], { gap: 0.2 })                     // one after another (durations resolved after probing)
parallel([a, b])                                       // start together
stagger([t1, t2, t3], 0.15)                           // cascading starts
transition.sequence([a, b, c], { type: 'wipe', duration: 0.6, angle: 30 })
transition.chain(a, 'zoom', b, { type: 'glitch', duration: 0.3 }, c)
transition.sequence([a, b], { source: 'void main(){ outColor = mix(getFrom(vUv), getTo(vUv), step(vUv.x, uProgress)); }' })
```

Built-in transitions are `crossfade`, `dip` (color), `flash`, `wipe` (angle, softness), `clock`, `iris`,
`slide` (direction, push), `zoom`, `blur`, `pixelate`, `glitch`, `luma`, `ripple` and `spin`.

## Filters (`fx`)

All parameters are animatable. A second argument to most builders sets a mix amount.

| Group | Filters |
| --- | --- |
| Color | `grade` (exposure, contrast, saturation, vibrance, temperature, tint, highlights, shadows, whites, blacks, hue, lift/gammaRGB/gain), `curves`, `levels`, `hsl` (per hue range), `lut(src, intensity)`, `grayscale`, `sepia`, `invert`, `tint`, `colorize`, `duotone`, `gradientMap`, `posterize`, `threshold`, `opacity` |
| Keying | `chromaKey` (color, similarity, smoothness, spill), `lumaKey` |
| Blur and sharpen | `blur`, `directionalBlur`, `zoomBlur`, `radialBlur`, `sharpen`, `unsharp` |
| Light and stylize | `glow`, `dropShadow`, `vignette`, `grain`, `chromaticAberration`, `pixelate`, `halftone`, `edges`, `emboss`, `noise`, `glitch` |
| Distort | `wave`, `twirl`, `bulge`, `displace`, `kaleidoscope`, `mirror`, `tile`, `crop` |
| Custom | `fx.shader(glslBody, uniforms)`, which has access to `uTex`, `vUv`, `uSize`, `uTime` and helpers (`luma`, `rgb2hsv`, `hsv2rgb`, `hash12`, `premul`) |

```ts
video('greenscreen.mp4').filter(fx.chromaKey({ color: '#00ff00', similarity: 0.15, spill: 0.6 }));
c.add(adjustment(fx.grade({ temperature: 0.3 }), fx.vignette({ amount: 0.4 })));     // grade everything below
rect().filter(fx.blur({ radius: keys([[0, 30], [1, 0]]) }));
```

## Masks and blend modes

```ts
image('city.jpg').mask(text('CITY', { size: 400, weight: 900 }));           // text as alpha matte
video('a.mp4').mask(image('gradient.png'), 'luma-inverted');
rect({ blend: 'screen', fill: '#ff0055' });
```

## Captions

```ts
const cues = parseSubtitles(await (await fetch('/project/subs.srt')).text());   // or getEnv().loadBinary
c.add(captions(cues, { size: 48, at: [960, 980], highlight: '#22d3ee' }));      // word highlight needs word timings
```

`toSrt(cues)` and `toVtt(cues)` serialize cues back to subtitle files.
