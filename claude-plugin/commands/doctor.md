---
description: Check that this machine can render with Tasweerix and explain how to fix anything missing
---

Check the Tasweerix setup.

1. Run the `doctor` tool (or `tasweerix doctor` through the CLI, see the `cli` skill).
2. Report the result in plain words: what is ready, what is missing, and what each missing optional
   tool would enable (camera RAW, speech to text, AI features, audio plugins).
3. For each required item that is missing (Node 20+, FFmpeg, ffprobe, Chromium), give the exact install
   command for this operating system. Offer to run it; don't install anything without the user's yes.
4. If everything required is present, offer a quick test: render frame 0 of a project here (or of
   `examples/hello/index.ts` in the Tasweerix repository) with `render_still`.
