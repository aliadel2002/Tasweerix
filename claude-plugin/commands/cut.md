---
description: Auto-edit media with Tasweerix - jump-cut silences, split shots, or cut to the beat - and add the edit to a project
argument-hint: <media file> [silence|shots|beats] [entry to add it to]
---

Suggest and apply an edit with Tasweerix. Arguments: $ARGUMENTS

1. Mode: `silence` for talks, interviews and podcasts (removes pauses); `shots` for footage with
   several shots; `beats` for music. Infer it from the file and request if not given.
2. Call `suggest_cuts` (or `tasweerix cuts <file> --mode <mode>`). For silence, start with
   `minSilence: 0.5`, `padding: 0.1`; use `analyze_audio` first if the levels look unusual.
3. Summarize the result: how many cuts, how much time removed (silence), the shot count, or the BPM
   and beat count.
4. If the user named an entry file, or there is an `index.ts`, insert the generated code into its
   build function: a `sequence([...])` for silence and shots, or beat times used with
   `smart.snapToBeats` for beats (see the `video` and `audio` skills). Check it with
   `inspect_composition` and preview a cut point with `render_still`.
5. Mention that the edit stays editable code and analysis results are cached in `.tasweerix/cache`.
