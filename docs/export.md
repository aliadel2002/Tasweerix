# Export, interchange and the CLI

## How export works

1. esbuild bundles your entry with a small render runtime.
2. A local server serves the bundle, your assets and the `/__tx` media API. That API covers ffprobe,
   frame-exact FFmpeg decoding with sequential stream reuse, PCM decoding and analysis caching.
3. Headless Chromium workers (`-j N`) each render a frame range with the same renderer as the studio.
   They stream raw RGBA over a WebSocket into FFmpeg.
4. The audio mix is rendered in Node by the same TypeScript engine, then segments are joined and muxed.

```sh
tasweerix render index.ts -o out/video.mp4 -j 4            # h264 by default for .mp4
tasweerix render index.ts -o out/video.webm                # vp9 (+ --transparent for alpha)
tasweerix render index.ts -o out/master.mov --codec prores --transparent   # ProRes 4444 with alpha
tasweerix render index.ts -o out/loop.gif --scale 0.5      # palette-optimized GIF
tasweerix render index.ts -o out/frames --codec png        # PNG sequence
tasweerix render index.ts -o out/clip.mp4 --range 0-120 --props '{"title":"Hi"}'
```

`--scale` sets the output resolution multiplier, `--crf`/`--preset` control quality, and
`--motion-blur-samples` sets the sub-frame samples for nodes with `motionBlur`.

### Bit depth (`--depth 16`)

By default frames are composited and sent to FFmpeg at 8 bits per channel. `--depth 16` (on
`render` and `still`) keeps more precision from decode to file, which removes banding from heavy
grades, shadow lifts and smooth gradients:

- 16-bit PNG/TIFF and 10-bit video sources are decoded at full depth.
- Layers are composited in float16 canvases and GPU filters write half-float output.
- Frames reach FFmpeg as `rgba64le`. PNG and TIFF are written at 16 bits, ProRes, h265, av1 and
  vp9 at 10 bits, and AVIF stills at 10 bits.
- Outputs that only store 8 bits (h264, jpg, webp, gif) get dithered frames instead of truncated
  ones. JPEG and lossy WebP compression can still flatten very gentle gradients.

```sh
tasweerix render index.ts -o out/master.mov --codec prores --depth 16
tasweerix render index.ts -o out/video.mp4 --codec h265 --depth 16   # 10-bit HEVC
tasweerix still edit.ts -o out/edited.tif --depth 16                  # 16-bit TIFF
```

Float16 keeps about 11 bits in highlights and more in shadows. Export takes longer: the promo
example rendered about 1.75x slower than at 8 bits. 16-bit compositing needs Chromium, which the
CLI bundles.

## Interchange

### Export

```sh
tasweerix export-timeline index.ts -f fcpxml -o out/edit.fcpxml --graphics
tasweerix export-timeline index.ts -f otio -o out/edit.otio
tasweerix export-timeline index.ts -f xmeml -o out/edit.xml        # Final Cut Pro 7 XML (Premiere Pro)
tasweerix export-timeline index.ts -f edl -o out/edit.edl          # CMX 3600, first video track
```

- Media clips (video and images) are laid out on tracks that preserve z-order. Trims, speed (timeMap,
  LinearTimeWarp, Time Remap, M2), cross-dissolves, audio clips with gain, and markers are exported.
- Shapes, text, particles, 3D scenes and filters can't be expressed in these formats. With
  `--graphics` they are rendered once as a ProRes 4444 clip with alpha and placed on the top track.
- FCPXML 1.10 opens in Final Cut Pro and DaVinci Resolve, FCP7 XML in Premiere Pro and Resolve, OTIO in
  tools built on OpenTimelineIO, and EDLs nearly everywhere.

### Import

```sh
tasweerix import-timeline cut.fcpxml -o my-project               # → my-project/index.ts + assets/
tasweerix import-timeline cut.xml --media /Volumes/Footage       # relink moved media by file name
tasweerix import-timeline cut.edl --fps 25 --copy-media
```

The edit becomes **plain, editable TypeScript**: `video()`/`image()`/`text()` calls with literal
`start` and `trim`, `transition.chain()` for dissolves, `c.audio()` for audio and `c.marker()` for
markers, so the studio can keep editing it two ways. Transforms from Final Cut Pro (`adjust-transform`,
`adjust-crop`, `adjust-blend`) and Premiere (Basic Motion, Opacity, Crop) become `position`, `scale`,
`rotation`, `anchor`, `opacity` and `crop` options, with `keys([...])` where they are keyframed.
Variable speed ramps and reverse playback become `.remap(keys([...]))`. Effects and color
corrections become `filters: [fx.blur(...), fx.grade(...)]` (color tools are matched by parameter
name, so they are flagged for a look check), and multicam clips are flattened to their active video
and audio angles. Media outside the project is symlinked into `assets/` (or copied with
`--copy-media`); anything that could not be imported or was approximated (effects without an `fx`
counterpart, inactive angles) is listed as a comment at the top of the file.

To keep the edit in its original file and build on it, import at build time instead:

```ts
c.add(await importTimeline('edits/rough-cut.fcpxml', { mediaDir: 'footage' }));
```

| Format | Read | Write | Notes |
| --- | --- | --- | --- |
| FCPXML 1.6–1.11 (`.fcpxml`) | ✓ | ✓ | Spines, connected clips and secondary storylines, compound clips, transitions, retimes, volume, titles, markers |
| OpenTimelineIO (`.otio`) | ✓ | ✓ | Tracks, gaps, transitions, LinearTimeWarp and FreezeFrame, nested stacks, markers |
| FCP7 XML / xmeml (`.xml`) | ✓ | ✓ | Premiere Pro's exchange format: clip items, transitions, Time Remap, audio levels, text generators |
| CMX 3600 EDL (`.edl`) | ✓ | ✓ | Cuts, dissolves and wipes, M2 speed, clip-name comments, LOC markers; pass `--fps` (EDLs store none) |

The readers are tested against files written by OpenTimelineIO's own adapters, and the writers'
output is read back by them. Plugins can add formats through `importers` and `exporters` (see
[Plugins](plugins.md)); the API is `readTimeline()`, `writeTimeline()`, `timelineToCode()` and
`timelineToNodes()` in `@tasweerix/interchange`.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `TASWEERIX_CHROMIUM` | Path to a Chromium/Chrome binary |
| `TASWEERIX_FFMPEG`, `TASWEERIX_FFPROBE` | Custom FFmpeg binaries |
| `PLAYWRIGHT_BROWSERS_PATH` | Where to look for Playwright's Chromium |
| `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`, `ant auth login`) | Credentials for the AI features |
| `TASWEERIX_AI_MODEL`, `TASWEERIX_AI_PROVIDER`, `TASWEERIX_STT_PROVIDER` | Model and provider selection (see [AI](ai.md)) |
| `TASWEERIX_WHISPER_BIN`, `TASWEERIX_WHISPER_MODEL` | whisper.cpp binary and model for speech to text |
