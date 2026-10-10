# Tasweerix

**A code-first media engine.** You write TypeScript that describes edits and animations. Tasweerix
renders it to video, photos, audio, motion graphics, 3D scenes and vector illustrations, all from one
scene graph.

```ts
import { composition, video, transition, fx, text, textFx, audio, motion } from 'tasweerix';

export default composition({ width: 1920, height: 1080, fps: 30 }, (c) => {
  c.add(
    transition.chain(
      video('assets/beach.mp4', { trim: [2, 6] }).filter(fx.lut('assets/teal.cube'), fx.grade({ exposure: 0.2 })),
      { type: 'zoom', duration: 0.6 },
      video('assets/city.mp4', { trim: [0, 5], speed: 1.25 }),
    ),
  );
  c.add(text('Summer Recap', { size: 140, weight: 900 }).glyphs(textFx.pop({ stagger: 0.04 })));
  c.add(motion.lowerThird('Tasweerix', 'made in code', { start: 2 }));
  c.audio(audio('assets/track.mp3').fadeIn(1).fadeOut(2));
});
```

```sh
tasweerix render index.ts -o out/recap.mp4 -j 4   # parallel headless export
tasweerix studio .                                # live editor with two-way editing
```

> *Tasweer* (تصوير) is Arabic for photography and image-making.

---

## What's inside

| Area | What you get |
| --- | --- |
| **Video editing** | Trims, speed and reverse, time remapping, sequences and overlaps, nested compositions, masks (alpha and luma), blend modes, adjustment layers, motion blur, 14 GPU transitions plus custom GLSL, captions from SRT/VTT, frame-exact decoding. |
| **Color and effects** | 43 WebGL2 filters: grade, curves, levels, HSL per range, 3D LUTs (.cube), chroma and luma key, blur family, glow, drop shadow, grain, halftone, glitch, distortions, custom shaders. |
| **Photo editing** | Crop and straighten, Lanczos resize, perspective correction, auto levels and white balance, local adjustments through masks (radial, gradient, color range, luminance, magic wand, brush, polygon), heal and clone, denoise, dehaze, clarity. There is also batch mode. |
| **Audio** | A pure-TypeScript engine with identical output in Node and the browser. It covers EQ, compressor, limiter, gate, de-esser, reverb (algorithmic and convolution), delay, chorus, phaser, distortion, time-stretch, pitch shift and noise reduction. It also has sidechain ducking, buses, stems, BS.1770 loudness, synth voices and SFX. |
| **Motion graphics** | Kinetic typography, enter/exit/loop behaviors, path morphing, trim paths, follow-path, repeaters, deterministic particles, animated charts, lower thirds, title cards, callouts and audio-reactive visuals. |
| **Illustration** | Path builder, boolean operations, offset, stroke-to-path, Poisson disc, Delaunay and Voronoi, flow fields, L-systems, patterns, SVG import, and SVG export of any frame. |
| **Typography** | HarfBuzz shaping and the Unicode bidi algorithm. **Arabic and other RTL or joining scripts animate letter by letter without breaking their joined forms.** Kashida stretching and Arabic-Indic digits are included. |
| **Smart editing** | Silence jump-cuts, beat detection and beat-synced montages, scene detection, loudness matching and leveling, and auto-ducking. Results are plain cut lists that stay editable as code. |
| **Studio** | A web editor with live preview, timeline, inspector and code editor. Dragging on the canvas, trimming or moving clips on the timeline, moving keyframes or editing the inspector **rewrites your source code** and keeps its formatting. |
| **3D** | Real 3D scenes as layers: boxes, spheres, tori, extruded SVG paths, **extruded Arabic and Latin text** shaped by HarfBuzz, glTF/GLB and OBJ models. Metalness/roughness materials, textures (images, live video, any 2D layer), directional lights with soft shadows, point lights, fog, animated cameras with cuts, and After Effects-style 3D layers. Rendered with WebGL2. |
| **Stabilization and tracking** | Pure-TypeScript computer vision (corner detection, pyramidal optical flow, RANSAC). Smooth or tripod-lock shaky footage with automatic edge cropping, and pin graphics to moving objects with point tracking. |
| **AI** | Claude writes and reads in your builds: generated titles and copy, structured JSON, image and video-frame descriptions. Speech becomes word-timed captions (translated if you like), transcript-based cuts and chapter markers. The **assistant** edits your project code from a sentence, in the CLI and in the studio. Answers are cached so renders stay deterministic; providers are pluggable. |
| **Interchange** | Export the edit to **FCPXML** (Final Cut Pro, DaVinci Resolve), **FCP7 XML** (Premiere Pro), **OpenTimelineIO** or **EDL**, and **import** edits from all four as editable TypeScript or at build time. Graphics can optionally be rendered as a ProRes 4444 alpha layer. |

## Quick start

Requirements: Node ≥ 20, pnpm, FFmpeg/ffprobe on `PATH`, and a Chromium for exports (Playwright's is
detected automatically, or set `TASWEERIX_CHROMIUM`).

```sh
pnpm install
pnpm tasweerix init my-video -t video      # templates: video | photo | audio | motion | arabic | 3d
pnpm tasweerix studio my-video             # open http://127.0.0.1:3000
pnpm tasweerix render my-video/index.ts -o my-video/out/video.mp4
```

Inside this repository, `pnpm tasweerix <command>` runs the CLI from source. No build step is needed.

## CLI

| Command | Purpose |
| --- | --- |
| `render <entry> -o out.mp4` | Render video, animated images or a PNG sequence. Codecs: `h264`, `h265`, `vp9`, `av1`, `prores`, `gif`, `webp`, `apng`, `png`. Options include `-j` parallel workers, `--range`, `--scale`, `--transparent` and `--props '{…}'`. |
| `still <entry> -o out.png` | Render one frame to PNG, JPG, WebP or AVIF (photos, thumbnails, posters). |
| `audio <entry> -o mix.mp3` | Render the mix to wav, mp3, flac, aac, ogg or opus, with optional `--stems`. |
| `svg <entry> -o frame.svg` | Export a frame as vector SVG. Text is converted to glyph outlines. |
| `studio [dir]` | Open the web studio. |
| `batch <entry> -i "photos/*.jpg"` | Apply one edit script to many files. Each render gets `props.src`. |
| `cuts <file> --mode silence\|shots\|beats` | Suggest an edit and print it as code. |
| `analyze <file>` | Loudness, true peak, tempo, beats and silences. |
| `export-timeline <entry> -f fcpxml\|otio\|xmeml\|edl` | Export the edit for Final Cut Pro, Resolve, Premiere or OTIO tools (add `--graphics`). |
| `import-timeline <file> -o <dir>` | Turn an FCPXML, OTIO, FCP7 XML or EDL edit into an editable project, relinking media. |
| `stabilize <file>` | Render a stabilized copy (`--mode smooth\|lock`, `--analyze` to measure only). |
| `track <file> --at x,y --time t` | Track a point and print its path as keyframes. |
| `ai "<request>"` | Ask the assistant to edit the project's code (`--dry-run` shows a diff). |
| `transcribe <file>` | Speech to `.srt`/`.vtt`/`.json`, optionally `--translate <language>`. |
| `inspect <entry>` | Print the composition tree as JSON. |
| `probe <file>` | Show media info. |
| `init [dir] -t <template>` | Scaffold a project. |

Plugins add commands too: put them in a `tasweerix.config.ts` (see [Plugins](docs/plugins.md)).

## Concepts in one minute

- **Compositions** are functions. `composition(options, build)` returns a definition. Its `build` runs once
  and creates a retained scene graph. Use `still()` for photos and illustrations and `soundscape()` for
  audio-only projects. Builds may be `async`, for example to await smart-editing analysis.
- **Time is in seconds.** Strings such as `'2.5s'`, `'500ms'`, `'90f'` (frames) and `'00:01:02:15'` (timecode)
  also work.
- **Every property is animatable.** A property can be a plain value, a keyframe track
  (`keys([[0, 0], ['1s', 1, 'outBack']])`), or a function of the frame context (`(f) => Math.sin(f.time)`).
  Evaluation is stateless, so any frame renders in any order. That is what makes scrubbing and
  parallel export exact.
- **Nodes** have their own timing (`start`, `duration`, `speed`, `remap`) and transform (`position`/`at`,
  `anchor`, `scale`, `rotation`, `skew`, `opacity`, `blend`). They also take `filters`, an optional `mask`
  and children.
- **One renderer** (Canvas2D plus a WebGL2 filter graph) draws both the studio preview and the headless
  export. Video frames come from an FFmpeg-backed frame server, so exports are frame-exact.

See [`docs/`](docs) for guides and the API reference:

- [Guide: concepts and animation](docs/guide.md)
- [Video editing, filters and transitions](docs/video.md)
- [Photo editing](docs/photo.md)
- [Audio](docs/audio.md)
- [Motion graphics and typography (including Arabic/RTL)](docs/motion-and-type.md)
- [Illustration and SVG](docs/illustration.md)
- [Smart editing](docs/smart.md)
- [3D scenes](docs/3d.md)
- [Stabilization and tracking](docs/vision.md)
- [AI features](docs/ai.md)
- [Studio and two-way editing](docs/studio.md)
- [Export, interchange and the CLI](docs/export.md)
- [Plugins](docs/plugins.md)
- [Architecture](docs/architecture.md)

## Examples

| Example | Shows |
| --- | --- |
| [`examples/hello`](examples/hello) | Shapes, text, a GPU wipe and a glow. |
| [`examples/promo`](examples/promo) | Footage, transitions, LUT grade, titles, SRT captions, lower third, confetti, music and SFX. |
| [`examples/beat-viz`](examples/beat-viz) | A synthesized drum loop and audio-reactive spectrum bars. |
| [`examples/arabic-kinetic`](examples/arabic-kinetic) | HarfBuzz-shaped Arabic animating per glyph, kashida stretch and bidi text. |
| [`examples/photo-retouch`](examples/photo-retouch) | White balance, straighten, healing, graduated and luminosity masks, plus a batch script. |
| [`examples/generative-poster`](examples/generative-poster) | Voronoi mosaic with boolean clipping, flow fields and an Arabic title (PNG and SVG). |
| [`examples/smart-edit`](examples/smart-edit) | Auto jump-cut, ducking under the voice and a beat-synced montage. |
| [`examples/podcast`](examples/podcast) | A voice chain, music bed ducking and mastering to −16 LUFS. |
| [`examples/data-viz`](examples/data-viz) | Animated line, donut and bar charts, counters and callouts, driven by props. |
| [`examples/3d-title`](examples/3d-title) | Extruded Arabic and Latin 3D type, shadows, fog, an orbiting camera and a 2D card in 3D space. |
| [`examples/stabilize`](examples/stabilize) | Handheld footage beside its tripod-locked version, with a label pinned by point tracking. |
| [`examples/import-timeline`](examples/import-timeline) | A Final Cut Pro rough cut imported at build time, relinked, graded and finished in code. |
| [`examples/ai`](examples/ai) | A title written from a video frame, translated captions from speech and chapter markers (needs credentials). |

Render any example from the repository root, for example
`pnpm tasweerix render examples/promo/index.ts -o out/promo.mp4 -j 3`. The Arabic, 3D, AI and
timeline-import examples use files from elsewhere in the repository (fonts in `assets/fonts`, footage in
other examples), so pass `--root .` for them.

## Packages

| Package | Role |
| --- | --- |
| `tasweerix` | Umbrella API: one import for everything below. |
| `@tasweerix/core` | Time, easing, keyframes, scene graph, compositions, timeline helpers, color, noise, path geometry, plugins. |
| `@tasweerix/render` | Canvas2D compositor, WebGL2 filters and transitions, text layout. |
| `@tasweerix/media` | Browser asset provider, FFmpeg/ffprobe services, frame server, SRT/VTT. |
| `@tasweerix/audio` | DSP, mixer, loudness, analysis, synthesis. |
| `@tasweerix/image` | Photo operations, selections and masks, retouching. |
| `@tasweerix/type` | HarfBuzz shaping, bidi and glyph-path text. |
| `@tasweerix/motion` | Kinetic typography, behaviors, morphing, particles, charts and presets. |
| `@tasweerix/illustrate` | Vector tools, generative art, SVG import and export. |
| `@tasweerix/smart` | Analysis-driven editing. |
| `@tasweerix/3d` | WebGL2 3D renderer, geometry, extrusion and 3D text, glTF/OBJ loaders, 3D nodes. |
| `@tasweerix/vision` | Feature tracking, optical flow, stabilization and point tracking. |
| `@tasweerix/ai` | Claude generation and vision, speech to text, captions, transcript cuts, the code assistant. |
| `@tasweerix/codemod` | GUI edits turned into source code edits. |
| `@tasweerix/interchange` | FCPXML, OTIO, FCP7 XML and EDL import and export. |
| `@tasweerix/cli` | The `tasweerix` command, export pipeline and studio server. |
| `apps/studio` | Studio UI (Preact and CodeMirror 6). |

## Development

```sh
pnpm install
pnpm typecheck     # strict TypeScript across all packages
pnpm test          # unit, pixel (headless Chromium + WebGL2), DSP, vision, interchange, AI and studio end-to-end tests
```

The tests render real frames in headless Chromium, decode real media with FFmpeg, measure stabilization
against footage with known shake, read timelines written by OpenTimelineIO's adapters (and check that
they read ours, when OpenTimelineIO is installed), exercise the Claude provider against a local stub of
the Messages API, and drive the studio with Playwright. No test needs network access or API keys.

## Limitations

- Exports use a GPU for WebGL when one is present. Without one, WebGL runs in software (SwiftShader):
  filter passes are fused and workers run in parallel, but heavy filter stacks at high resolutions
  stay slow on CPU-only machines.
- Studio preview playback of heavy compositions may run below real time. Exports are always exact.
- Photos are processed at 8 bits per channel for display. There is no RAW decoding and no HDR or
  wide-gamut pipeline.
- The audio DSP is solid but basic next to dedicated tools, and there is no VST/AU hosting.
- Two-way editing only rewrites values written as literals. Computed values are flagged in the
  inspector and must be edited in code.
- 3D renders through WebGL2: one shadow-casting light, no image-based lighting or reflections, no
  skeletal animation or morph targets from glTF files. Without a GPU, exports use SwiftShader.
- Stabilization corrects translation, rotation and zoom (a similarity model). It does not correct
  rolling-shutter wobble or perspective changes, and tracking follows points, not planes.
- AI features need credentials on the host (Claude) and a speech-to-text provider (whisper.cpp or a
  plugin). Answers are cached; delete `.tasweerix/cache` or pass a `variant` to regenerate.
- Timeline import keeps edits, speed, dissolves, titles, audio gain and markers. Effects, transforms,
  color corrections, multicam and variable speed ramps are listed as not imported.

## License

MIT. The bundled fonts (Cairo, Amiri) are under the SIL Open Font License; see `assets/fonts`.
