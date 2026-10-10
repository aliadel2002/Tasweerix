---
description: Create a Tasweerix project from a description of what you want (video, photo edit, audio, motion graphics, Arabic titles or 3D)
argument-hint: <what to make, e.g. "a 10s Arabic title card with a gold 3D logo">
---

Create a new Tasweerix project for this idea: $ARGUMENTS

1. If the idea is empty, ask what to make in one short question and stop.
2. Pick the closest `init` template: `video`, `photo`, `audio`, `motion`, `arabic` or `3d`. Pick a short
   kebab-case directory name from the idea (ask only if the user named a location you can't infer).
   Run `tasweerix init <dir> -t <template>` (see the `cli` skill for how to run the CLI here).
3. Load the skills that match the idea (`scenes` always, plus `video`, `photo`, `audio`,
   `motion-type` or `3d`) and rewrite `<dir>/index.ts` to realize it. Use only assets that exist; if
   the idea needs footage, photos, music or a font file the user hasn't given, use generated
   content (shapes, gradients, `sfx`, `tone`) or a font from the repository's `assets/fonts/` when
   there is one, and list what they can drop into `<dir>/assets/` later.
4. Check it loads with `inspect_composition`, then `render_still` two or three key moments and fix
   what looks wrong (overlaps, text off-frame, weak contrast, empty frames).
5. Finish with a short summary: what you made, the stills you checked, and the next commands:
   `/tasweerix:preview`, `/tasweerix:render` and `/tasweerix:studio`.
