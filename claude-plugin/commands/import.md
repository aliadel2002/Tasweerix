---
description: Import an edit from Final Cut Pro, DaVinci Resolve, Premiere Pro, an OTIO file or an EDL as an editable Tasweerix project
argument-hint: <timeline file> [output dir] [media folder]
---

Import a timeline into Tasweerix. Arguments: $ARGUMENTS

1. Find the timeline file (`.fcpxml`, `.fcpxmld`, Premiere/FCP7 `.xml`, `.otio`, `.edl`). Ask if none
   was given and none is in the current directory.
2. Run `tasweerix import-timeline <file> -o <dir>` (see the `cli` skill). Add `--media <folders>` when
   the media moved, `--copy-media` if the user wants the project self-contained, and `--fps` for EDLs.
3. Read the generated `<dir>/index.ts`. Report what came across and the comment at the top that lists
   what was skipped or approximated (effects without an equivalent, inactive multicam angles, offline media).
4. Check it with `inspect_composition` and `render_still` at a couple of cut points. Offline media
   shows up as load errors: offer to relink with `--media`.
5. Next steps: edit in code or `/tasweerix:studio`, render with `/tasweerix:render`, or keep the
   original file and import at build time with `importTimeline()` (see the `video` skill).
