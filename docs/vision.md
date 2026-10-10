# Stabilization and tracking

`@tasweerix/vision` measures motion in footage with classic computer vision written in TypeScript
(no native dependencies): Shi–Tomasi corners, pyramidal Lucas–Kanade optical flow with
forward–backward checks, and RANSAC similarity or homography fitting. FFmpeg decodes small gray frames on the host;
results are cached in `.tasweerix/cache` like every other analysis.

## Stabilize a clip

```ts
c.add(await stabilize(video('handheld.mp4', { trim: [2, 9] })));                    // smooth the camera
c.add(await stabilize(video('handheld.mp4'), { mode: 'lock' }));                     // tripod look
c.add(await stabilize(video('walk.mp4'), { smoothing: 2, rotation: false, crop: 'none' }));
c.add(await stabilize(video('drone.mp4'), { model: 'perspective' }));               // keystone wobble too
c.add(await stabilize(video('phone.mp4'), { rollingShutter: 'auto' }));             // skew and jello too
```

| Option | Meaning |
| --- | --- |
| `mode` | `'smooth'` (default) keeps intended pans and removes shake; `'lock'` holds the frame still |
| `smoothing` | Seconds of camera motion averaged in smooth mode (default 1) |
| `rotation`, `scale` | Correct roll and zoom wobble too (default true) |
| `crop` | `'auto'` zooms in just enough to hide the moving edges (up to `maxZoom`, default 1.3); a number is a fixed zoom; `'none'` keeps edges visible |
| `model` | `'similarity'` (default) corrects translation, rotation and zoom; `'perspective'` also removes perspective (keystone) wobble from a camera turning and tilting |
| `rollingShutter` | `'auto'` estimates the sensor readout time and removes rolling-shutter skew and wobble; a number (0–1) sets the readout as a fraction of the frame interval. Off by default |
| `analysisWidth` | Analysis resolution in pixels (default 480) |

Only the trimmed range is analysed. The correction is applied at render time through
`VideoNode.mediaTransform` (clipped to the picture), so trims, speed changes, reverse, fitting and
filters keep working. Frames whose shake is too large to hide within `maxZoom` are corrected only
partially rather than showing borders.

### Perspective

`model: 'perspective'` measures a homography between consecutive frames (RANSAC over 4-point
samples, normalized DLT refits) next to the similarity. The camera path is split into its closest
similarity, smoothed exactly like the default model, and a small perspective residual, smoothed
element-wise (or held at its mean when locking). The warp runs on the GPU at render time, and
`follow()` maps tracked points through it. Frames whose perspective cannot be measured reliably (few
inliers, or a change far larger than camera shake, which usually means a moving foreground) fall back
to their similarity. Perspective analyses are cached separately from similarity ones.

### Rolling shutter

Phone and most mirrorless sensors read rows one after another, so a moving camera skews verticals
and fast shake turns the picture to jelly. With `rollingShutter`, motion analysis fits each frame's
similarity jointly with a row shear (rows read later move further when the camera speeds up or slows
down), which keeps the similarity unbiased and measures the shear. `'auto'` solves the readout time
from the shear against the change of camera speed by least squares (`estimateReadout()`); the
estimate can read a little high on very fast shake, which the correction compensates for. Each row
is then moved back to where it would have been at the frame's center time, assuming the image
velocity changes linearly between frames, before the stabilization transform applies; the warp runs
on the GPU and `follow()` maps tracked points through it. Shake faster than about half the frame rate
(engine or rotor vibration) is not recoverable from frame-to-frame motion.

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

## Track a plane

```ts
const v = video('desk.mp4');
const screen = await trackPlane('desk.mp4', { corners: [[410, 220], [880, 250], [870, 560], [400, 520]], time: 1 });
v.add(image('ui.png', { cornerPin: pinToPlane(v, screen) }));      // replace the screen's content
v.add(text('Live', { at: follow(v, planePoint(screen, [640, 240])) })); // a point of the plane
c.add(v);
```

`trackPlane` follows a flat surface (a screen, a sign, a wall, a table top) from its four corners
(top-left, top-right, bottom-right, bottom-left, in source pixels at source time `time`). Features
inside the quad are tracked frame to frame and fitted with a RANSAC homography, so the plane keeps
its perspective as the camera moves around it. Each estimate is then refined against the reference
frame (the new frame is warped back into the reference geometry and the reference features are
tracked into it), so errors do not accumulate into drift. Frames where the plane cannot be followed
are marked `lost` and hold the last position.

Images and videos have a `cornerPin` prop: four points (tl, tr, br, bl) in the node's local
coordinates where the picture's corners go. It can be keyframed by hand; `pinToPlane(video, track)`
drives it from a tracked plane, mapping through the video's trim, fit and stabilization (pass a quad
in reference-frame pixels to pin to part of the plane). `planePoint(track, point)` turns a point of
the plane into a point track for `follow()`.

## CLI

```sh
tasweerix stabilize handheld.mp4                       # → handheld.stabilized.mp4
tasweerix stabilize handheld.mp4 --mode lock --max-zoom 1.2 -o steady.mp4
tasweerix stabilize drone.mp4 --model perspective      # also removes keystone wobble
tasweerix stabilize phone.mp4 --rolling-shutter auto   # also removes skew and jello
tasweerix stabilize handheld.mp4 --analyze             # just measure the shake
tasweerix track street.mp4 --at 812,440 --time 3       # prints keys([...]) you can paste
tasweerix track desk.mp4 --corners 410,220,880,250,870,560,400,520 --time 1   # a plane's corners
```

Analysis runs at about 30 ms per frame at the default resolution and is cached afterwards.
