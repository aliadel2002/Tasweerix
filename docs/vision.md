# Stabilization and tracking

`@tasweerix/vision` measures motion in footage with classic computer vision written in TypeScript
(no native dependencies): Shi–Tomasi corners, pyramidal Lucas–Kanade optical flow with
forward–backward checks, and RANSAC similarity fitting. FFmpeg decodes small gray frames on the host;
results are cached in `.tasweerix/cache` like every other analysis.

## Stabilize a clip

```ts
c.add(await stabilize(video('handheld.mp4', { trim: [2, 9] })));                    // smooth the camera
c.add(await stabilize(video('handheld.mp4'), { mode: 'lock' }));                     // tripod look
c.add(await stabilize(video('walk.mp4'), { smoothing: 2, rotation: false, crop: 'none' }));
```

| Option | Meaning |
| --- | --- |
| `mode` | `'smooth'` (default) keeps intended pans and removes shake; `'lock'` holds the frame still |
| `smoothing` | Seconds of camera motion averaged in smooth mode (default 1) |
| `rotation`, `scale` | Correct roll and zoom wobble too (default true) |
| `crop` | `'auto'` zooms in just enough to hide the moving edges (up to `maxZoom`, default 1.3); a number is a fixed zoom; `'none'` keeps edges visible |
| `analysisWidth` | Analysis resolution in pixels (default 480) |

Only the trimmed range is analysed. The correction is applied at render time through
`VideoNode.mediaTransform` (clipped to the picture), so trims, speed changes, reverse, fitting and
filters keep working. Frames whose shake is too large to hide within `maxZoom` are corrected only
partially rather than showing borders.

Lower-level pieces are exported: `analyzeMotion()` (frame-to-frame motion as plain data),
`computeStabilization()` (path smoothing and crop, pure), `applyStabilization()`.

## Track a point

```ts
const v = video('street.mp4', { trim: [2, 8] });
const bus = await trackPoint('street.mp4', { at: [812, 440], time: 3 });   // source pixels at source time 3 s
v.add(text('Bus 42', { at: follow(v, bus, [0, -60]) }));                   // a child of the video
c.add(v);
```

`trackPoint` follows the features around the point forward and backward from `time` (default range:
2.5 s each way; set `from`/`to`). `follow(video, track, offset)` is a position driver for children of
that video: it maps source pixels through trim, size, fit and stabilization. `trackToKeys(track)`
gives the path as editable keyframes.

## CLI

```sh
tasweerix stabilize handheld.mp4                       # → handheld.stabilized.mp4
tasweerix stabilize handheld.mp4 --mode lock --max-zoom 1.2 -o steady.mp4
tasweerix stabilize handheld.mp4 --analyze             # just measure the shake
tasweerix track street.mp4 --at 812,440 --time 3       # prints keys([...]) you can paste
```

Analysis runs at about 30 ms per frame at the default resolution and is cached afterwards.
