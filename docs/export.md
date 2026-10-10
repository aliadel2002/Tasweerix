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

## Interchange

```sh
tasweerix export-timeline index.ts -f fcpxml -o out/edit.fcpxml --graphics
tasweerix export-timeline index.ts -f otio -o out/edit.otio
```

- Media clips (video and images) are laid out on tracks that preserve z-order. Trims, speed (timeMap,
  LinearTimeWarp), cross-dissolves, audio clips with gain, and markers are exported.
- Shapes, text, particles and filters can't be expressed in these formats. With `--graphics` they are
  rendered once as a ProRes 4444 clip with alpha and placed on the top track.
- FCPXML 1.10 opens in Final Cut Pro and DaVinci Resolve. OTIO opens in tools built on OpenTimelineIO,
  and adapters convert it to Premiere, Avid and others.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `TASWEERIX_CHROMIUM` | Path to a Chromium/Chrome binary |
| `TASWEERIX_FFMPEG`, `TASWEERIX_FFPROBE` | Custom FFmpeg binaries |
| `PLAYWRIGHT_BROWSERS_PATH` | Where to look for Playwright's Chromium |
