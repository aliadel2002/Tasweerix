# Architecture

```
            your project (TypeScript)
                     │  composition(options, build)
        ┌────────────┴─────────────┐
        ▼                          ▼
  @tasweerix/core            @tasweerix/audio (pure TS)
  scene graph, time,         mixer, DSP, loudness,
  Animatable, tracks         analysis, synthesis
        │                          │
        ▼                          │
  @tasweerix/render                │
  Canvas2D compositor ─ WebGL2     │
  filters/transitions, text        │
        │                          │
 ┌──────┴───────────┐              │
 ▼                  ▼              ▼
Studio (browser)   Export workers (headless Chromium) ──RGBA──► FFmpeg ◄── WAV ── Node mix
 preview, timeline,   │                                          │
 inspector, codemod   └──── /__tx media API (Node): ffprobe, frame-exact decoding, PCM, cache
```

- **Stateless evaluation.** Nodes hold animatable props. Evaluating a frame never mutates state, so
  frames render in any order and in parallel processes.
- **One renderer.** Preview and export share the same code. Layers (pooled offscreen canvases) are used
  only when needed (filters, masks, group opacity or blend, motion blur, adjustment layers). The WebGL2
  pipeline uses half-float intermediates (export forces them on software rasterizers too); `--depth 16`
  also composites in float16 canvases and sends 16-bit frames to FFmpeg, and `--gamut p3` runs the
  canvases and GL output in Display P3 (ICC profiles are read and written by `@tasweerix/core`'s
  `icc.ts` and `@tasweerix/media`'s `node/icc.ts`). `--hdr` composites in extended-range sRGB float16
  canvases (1.0 = 203-nit white) and the encoder converts frames to BT.2020 PQ or HLG (`core/hdr.ts`).
- **Media.** Video frames are decoded by FFmpeg processes that stream sequentially per worker, which
  makes them frame-exact (the tests verify this out of order). The studio uses the same API, so the
  preview matches the export.
- **Text engines.** A Canvas engine and a HarfBuzz engine (glyph outlines plus bidi) are pluggable through
  `registerTextEngine`.
- **Audio.** Clips are rendered into buffers, effects run per block with automation, ducking uses
  sidechains from other clips or buses, then buses go to master. The result is identical in browser
  and Node.
- **Two-way editing.** Creation call stacks are mapped through source maps to call sites, and recast
  rewrites only the touched expressions.
- **3D.** A `scene3d` node is drawn by its own WebGL2 renderer (`@tasweerix/3d`) into the 2D compositor.
  3D objects are ordinary scene nodes with Vec3 transforms, so timing, keyframes and the studio work
  unchanged. Video and 2D-layer textures are rendered by the main renderer each frame.
- **Host analyses.** Heavy or privileged work — scene detection, motion estimation, AI model calls,
  speech recognition — runs in Node behind `Env.analyze(kind, src, params)` (`/__tx/analyze` for
  browser pages). Kinds are registered by packages and plugins; results are cached by input and source
  file stamp, which keeps parallel export workers consistent.
- **Packages.** The packages are independent and ESM-only, with no build step inside the monorepo.
  The CLI runs TypeScript through tsx, and bundles use esbuild.
