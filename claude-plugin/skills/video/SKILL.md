---
name: video
description: Tasweerix video editing - clips, trims, speed, sequences, GPU transitions, fx filters and color grading, LUTs, keying, masks, captions, smart editing (jump cuts, beat sync), stabilization, tracking and importing edits from Final Cut, Premiere, Resolve or OTIO. Use when a Tasweerix project works with footage.
---

# Video editing in Tasweerix

Read the `scenes` skill first for the basics. Probe footage with `probe_media` before laying it out
so trims, sizes and frame rates are real.

## Clips and timing

```ts
video('assets/a.mp4', { trim: [2, 6] })                          // in/out in source seconds
video('assets/b.mp4', { speed: 2 })                              // negative = reverse
video('assets/c.mp4', { loop: true, muted: true }).lasting(10)
video('assets/d.mp4').remap(keys([[0, 0], [1, 1], [3, 1.2]]))    // speed ramp into a near-freeze
video('assets/e.mp4', { size: [1920, 1080], fit: 'cover' })      // fill the frame
```

A video's audio joins the mix automatically (`muted: true` to drop it, `volume`, or route it with
`node.meta.audioBus = 'voice'`).

## Layout

```ts
sequence([a, b, c], { gap: 0.2 })                 // one after another
parallel([a, b])                                   // start together
stagger([t1, t2, t3], 0.15)                       // cascading starts
transition.sequence([a, b, c], { type: 'wipe', duration: 0.6, angle: 30 })
transition.chain(a, 'zoom', b, { type: 'glitch', duration: 0.3 }, c)
```

Transitions: `crossfade`, `dip` (color), `flash`, `wipe` (angle, softness), `clock`, `iris`, `slide`
(direction, push), `zoom`, `blur`, `pixelate`, `glitch`, `luma`, `ripple`, `spin`, or a custom GLSL
`{ source: 'void main(){ outColor = mix(getFrom(vUv), getTo(vUv), uProgress); }' }`.
A transition overlaps its neighbours, so the cut is shorter than the sum of the clips.

## Filters (`fx`), all parameters animatable

| Group | Filters |
| --- | --- |
| Color | `grade` (exposure, contrast, saturation, vibrance, temperature, tint, highlights, shadows, whites, blacks, hue, brightness, gamma, pivot, lift/gammaRGB/gain as RGB triples), `curves`, `levels`, `hsl`, `lut(src, intensity)`, `grayscale`, `sepia`, `invert`, `tint`, `colorize`, `duotone`, `gradientMap`, `posterize`, `threshold`, `toneMap` |
| Keying | `chromaKey({ color, similarity, smoothness, spill })`, `lumaKey` |
| Blur | `blur`, `directionalBlur`, `zoomBlur`, `radialBlur`, `sharpen`, `unsharp` |
| Stylize | `glow`, `dropShadow`, `vignette`, `grain`, `chromaticAberration`, `pixelate`, `halftone`, `edges`, `emboss`, `noise`, `glitch` |
| Distort | `wave`, `twirl`, `bulge`, `displace`, `kaleidoscope`, `mirror`, `tile`, `crop` |
| Custom | `fx.shader(glslBody, uniforms)` with `uTex`, `vUv`, `uSize`, `uTime` |

```ts
video('assets/green.mp4').filter(fx.chromaKey({ color: '#00ff00', similarity: 0.15, spill: 0.6 }));
c.add(adjustment(fx.grade({ temperature: 0.3 }), fx.vignette({ amount: 0.4 })));   // grade everything below
image('assets/city.jpg').mask(text('CITY', { size: 400, weight: 900 }));         // text as a matte
```

## A complete edit

```ts
import { composition, video, transition, fx, text, textFx, motion, audio, sfx } from 'tasweerix';

export default composition({ width: 1280, height: 720, fps: 30, duration: 10, background: '#000' }, (c) => {
  const grade = [fx.lut('assets/look.cube', 0.8), fx.grade({ contrast: 0.08, vibrance: 0.15 }), fx.vignette({ amount: 0.35 })];
  const clip = (src: string) => video(src, { trim: [0, 3.5], size: [1280, 720], fit: 'cover', muted: true }).filter(...grade);
  c.add(transition.chain(clip('assets/a.mp4'), { type: 'zoom', duration: 0.6 }, clip('assets/b.mp4'), { type: 'wipe', duration: 0.5, angle: 20 }, clip('assets/c.mp4')));
  c.add(text('Summer Recap', { size: 110, weight: 900, fill: '#fff', at: [640, 330] }).glyphs(textFx.pop({ stagger: 0.04 })));
  c.add(motion.lowerThird('Made with Tasweerix', 'code-first video', { at: [80, 560], start: 3, duration: 3 }));
  c.audio(audio('assets/music.mp3', { gain: -4 }).fadeIn(0.8).fadeOut(1.5));
  c.audio(sfx('whoosh', { start: 3, gain: -6 }));
});
```

## Captions

```ts
const srt = new TextDecoder().decode(await getEnv().loadBinary!('assets/captions.srt'));
c.add(captions(parseSubtitles(srt), { size: 40, at: [640, 650], maxWidth: 1100 }));
```

(The build must be `async` for the `await`.) Speech-to-captions is `ai.captions(src, { language, translateTo })`;
see `read_docs` topic `ai`.

## Smart editing (results are plain data, cached in `.tasweerix/cache`)

```ts
const talk = await smart.autoCut('assets/talk.mp4', { minSilence: 0.6, padding: 0.1 });   // jump cuts
const grid = await smart.beatGrid('assets/music.mp3', { every: 2 });
smart.snapToBeats(broll, grid, { beatsPerItem: 1 });                                      // cut on the beat
smart.autoDuck(c.audio(audio('assets/music.mp3', { loop: true })), voices, { amount: -14 });
```

Also `silenceCuts`, `cutsToSequence`, `cutsToCode`, `beats`, `onsets`, `scenes`, `shots`,
`matchLoudness`, `beatMontage`. The `suggest_cuts` tool prints a cut list as code to paste.

## Stabilization and tracking

```ts
c.add(await stabilize(video('assets/handheld.mp4'), { mode: 'lock', maxZoom: 1.25 }));     // or 'smooth' (default)
await stabilize(video('assets/drone.mp4'), { model: 'perspective', rollingShutter: 'auto' });
const bus = await trackPoint('assets/street.mp4', { at: [812, 440], time: 3 });           // source pixels at source time
v.add(text('Bus 42', { at: follow(v, bus, [0, -60]) }));                                  // a child of video v
const screen = await trackPlane('assets/desk.mp4', { corners: [[410, 220], [880, 250], [870, 560], [400, 520]], time: 1 });
v.add(image('assets/ui.png', { cornerPin: pinToPlane(v, screen) }));
```

`smooth` keeps intended pans; `lock` holds the frame like a tripod. `crop: 'auto'` (default) zooms
just enough to hide moving edges. Use `perspective` for keystone wobble from turning cameras and
`rollingShutter: 'auto'` for phone footage with jello. `/tasweerix:stabilize` bakes a stabilized copy.

## Timelines from other editors

```ts
c.add(await importTimeline('edits/rough-cut.fcpxml', { mediaDir: 'footage' }));   // at build time
```

Or `tasweerix import-timeline cut.fcpxml -o my-project` turns FCPXML, FCP7 XML (Premiere), OTIO or
EDL into editable TypeScript (`/tasweerix:import`). `tasweerix export-timeline index.ts -f fcpxml`
goes the other way (`--graphics` renders text and effects as a ProRes 4444 overlay).
