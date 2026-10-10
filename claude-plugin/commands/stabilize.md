---
description: Stabilize shaky footage with Tasweerix (smooth handheld moves or lock it like a tripod)
argument-hint: <video file> [smooth|lock] [output]
---

Stabilize a video with Tasweerix. Arguments: $ARGUMENTS

1. Find the video (ask if none was given and none is obvious). `probe_media` it for size, fps and duration.
2. Measure first: `tasweerix stabilize <file> --analyze` (see the `cli` skill for running the CLI).
3. Choose settings from the footage and the request:
   - `--mode smooth` (default) keeps intentional pans; `--mode lock` holds a static shot still.
   - `--model perspective` when the camera turns or tilts (keystone wobble, drone shots).
   - `--rolling-shutter auto` for phone or mirrorless footage with skew or jello.
   - Keep `--max-zoom` at 1.3 or lower unless the user accepts more crop.
4. Render: `tasweerix stabilize <file> [options] [-o output]` (default `<name>.stabilized.mp4`). This
   can take a while on long clips; tell the user it is running.
5. Compare: `render_still` isn't for raw files, so extract a frame of the input and output with
   `ffmpeg -ss <t> -i <file> -frames:v 1 out/compare-<n>.png` at two or three times and look at both.
   Report the result, the zoom used, and suggest a different mode or model if shake remains.
6. If the user wants it inside a project instead of a baked file, show the code:
   `c.add(await stabilize(video('...'), { mode: 'lock' }))` (see the `video` skill).
