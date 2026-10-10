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
  pipeline uses half-float intermediates on GPUs and 8-bit on software rasterizers.
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
- **Packages.** The packages are independent and ESM-only, with no build step inside the monorepo.
  The CLI runs TypeScript through tsx, and bundles use esbuild.
