---
description: Render one frame of a Tasweerix composition and review it (layout, text, color, timing)
argument-hint: [entry] [time in seconds, several times, or "keyframes"]
---

Preview a Tasweerix composition. Arguments: $ARGUMENTS

1. Entry: the first `.ts` argument, else `index.ts`. Times: the numbers given, in seconds. With no
   time, or `keyframes`, use `inspect_composition` to pick 3 to 5 telling moments: just after each
   title finishes animating in, transition midpoints, and one second before the end.
2. Call `render_still` for each time (with `root: '.'` for repository examples that need it) and look
   at every image.
3. Review what you see against what the code intends: text cut off or outside the safe area,
   overlapping elements, low contrast, wrong fonts or broken Arabic joining, empty or black frames,
   colors that clash. Be concrete ("the subtitle overlaps the logo at 2.5 s").
4. If the user asked for changes, or there are clear defects, propose the code edits; apply them
   when the user asked you to fix things, then preview the same times again.
