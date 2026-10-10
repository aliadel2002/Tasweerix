---
description: Render a Tasweerix composition to video, an animated image, frames or audio with sensible defaults
argument-hint: [entry] [output] [draft|final] [extra CLI flags]
---

Render a Tasweerix project. Arguments: $ARGUMENTS

1. Entry: the first `.ts`/`.js` argument, else `index.ts` in the current directory, else the only
   composition file you can find. Output: an argument with a media extension, else `out/<entry name>.mp4`
   (or `out/<entry name>.wav` for a `soundscape`, `out/<entry name>.png` for a `still`).
2. Use `inspect_composition` first to learn the kind (video, still or audio), size, fps and duration.
   Report errors from it before trying to render.
3. Render with the matching tool: `render_video`, `render_still` or `render_audio`.
   - `draft` means `scale: 0.5` and `preset: 'veryfast'`; `final` (the default) uses full size.
   - Pass through anything the user asked for (codec, range, transparency, `--depth 16`, P3, HDR,
     props). Choose the codec from the output extension unless told otherwise (see the `cli` skill).
   - Examples in the Tasweerix repository that use `assets/fonts` or other examples' footage need `root: '.'`.
   Without the MCP tools, run the CLI command through the shell instead.
4. Report the output path, its size and how long it took. If it failed, show the relevant error
   lines, fix the cause when it is in the project (wrong asset path, missing root, code error), and
   offer to re-render.
