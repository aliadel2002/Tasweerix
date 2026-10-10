---
description: Open the Tasweerix studio (live preview, timeline, inspector and two-way code editing) for a project
argument-hint: [project dir] [entry]
---

Start the Tasweerix studio. Arguments: $ARGUMENTS

1. Project directory: the first argument, else the current directory. Entry: a `.ts` argument, else the
   studio's default (`index.ts`). In the Tasweerix repository with no arguments, use `examples/promo`.
2. Start it in the background so the session stays usable:
   `tasweerix studio <dir> [--entry <file>] [--port 3000]` (see the `cli` skill), and wait for it to
   print its URL. If the port is taken, try the next one.
3. Give the user the URL (default http://127.0.0.1:3000) and remind them that dragging on the canvas,
   trimming clips and editing the inspector rewrites the source file, so they should reload files
   you are editing after using the studio.
4. If the studio runs on a remote machine, say that the URL is local to that machine.
