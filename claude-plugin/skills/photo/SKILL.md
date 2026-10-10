---
name: photo
description: Tasweerix photo editing - still() files, photo() op pipelines (white balance, levels, crop, straighten, perspective, local adjustments through masks, heal, clone, denoise, dehaze, clarity), camera RAW, batch editing and still export formats. Use when editing or retouching images with Tasweerix.
---

# Photo editing in Tasweerix

A photo edit is a `still(...)` file whose main node is `photo(src, ops)`: a non-destructive list of
operations on float pixels, then optional GPU filters like any node. Probe the photo first
(`probe_media`) so the still matches its size or aspect ratio.

```ts
import { still, photo, op, mask, fx } from 'tasweerix';

export default still({ width: 1600, height: 1067 }, (c) => {
  c.add(
    photo('assets/portrait.jpg', [
      op.autoWhiteBalance('gray-world', 0.8),
      op.autoLevels({ clip: 0.005 }),
      op.straighten(-1.5),
      op.heal({ from: [520, 300], to: [560, 310], radius: 14 }),
      op.adjust({ exposure: -0.4, saturation: 0.2 }, { mask: mask.linear([800, 0], [800, 400]) }),   // graduated sky
      op.adjust({ shadows: 0.4 }, { mask: mask.luminance(0, 0.35) }),                               // lift shadows only
      op.hsl({ range: 220, width: 60, saturation: 0.3 }),                                          // blues
      op.clarity(0.2),
      op.sharpen({ amount: 0.5 }),
    ], { size: [1600, 1067], fit: 'cover' }),
  ).filter(fx.vignette({ amount: 0.3 }), fx.grain({ amount: 0.04, animated: false }));
});
```

Render with `render_still` (it returns a preview you can look at) or
`tasweerix still edit.ts -o out/edited.jpg` (png, jpg, webp, avif, tiff).

## Operations (`op`)

| Group | Operations |
| --- | --- |
| Geometry | `crop`, `cropAspect(aspect, focus?)`, `rotate(deg, { expand, autoCrop })`, `straighten(deg)`, `flip`, `resize({ width, height, scale, maxSize })`, `perspective(corners, size)` |
| Tone and color | `autoLevels`, `autoWhiteBalance`, `adjust({ exposure, brightness, contrast, highlights, shadows, whites, blacks, saturation, vibrance, temperature, tint, hue, gamma })`, `curves`, `hsl({ range, width, hue, saturation, lightness })` (`range` is a hue in degrees: reds 0, yellows 60, greens 120, blues 220) |
| Detail | `sharpen`, `clarity`, `dehaze`, `denoise`, `dust`, `blur` |
| Retouch | `heal({ from, to, radius })` (texture from source, tone from destination), `clone`, `redEye`, `vignette` |
| HDR | `toneMap({ knee, white })` |

Every tone, detail and retouch op takes `{ mask }`. Coordinates are source-image pixels.

## Masks (`mask`)

| Builder | Selects |
| --- | --- |
| `mask.rect`, `mask.ellipse`, `mask.polygon` | Shapes, with feather |
| `mask.radial(center, radius, feather)` | Spotlights and vignettes |
| `mask.linear(from, to)` | Graduated filter (full effect at `from`, none at `to`) |
| `mask.color(color, tolerance, feather, 'rgb' \| 'hue')` | A color range |
| `mask.luminance(min, max, softness)` | Luminosity ranges |
| `mask.wand(x, y, tolerance, contiguous)` | Magic wand |
| `mask.brush(strokes)` | Painted strokes |
| `mask.add / subtract / intersect / invert / refine(grow, feather, contrast)` | Combining and refining |

## Working method

1. Look at the original first: `render_still` of a file with just `photo(src, [])`.
2. Fix global problems (white balance, levels, straighten, crop), then local ones (masks), then
   detail and retouching. Render after each group and compare.
3. To find heal and clone coordinates, view the original and estimate pixel positions; verify by rendering.
4. Avoid crushing: watch skies for clipping and shadows for noise after big `shadows` lifts.

## Camera RAW

`photo('raw/IMG_0042.CR3', ops)` develops DNG, CR2, CR3, NEF, ARW, RAF, ORF, RW2 and more through
LibRaw's `dcraw_emu` (check with `doctor`). The result is linear and unbrightened: RAWs usually want
`op.adjust({ exposure: 0.5 to 1 })`, and `op.toneMap()` after big pushes for SDR output.

## Quality

- `--depth 16` keeps 16 bits through to PNG or TIFF (removes banding from heavy grades).
- `--gamut p3` keeps wide-gamut photos wide and embeds a Display P3 profile.
- `--hdr pq` writes an HDR AVIF or PNG.

## Batch

One script for a folder of photos: each render receives `props.src`, `props.name`, `props.index`.

```ts
import { still, photo, op, fx } from 'tasweerix';

export default still<{ src: string; name: string }>({ width: 1200, height: 800 }, (c, { src, name }) => {
  c.name = name ?? 'batch';
  c.add(photo(src ?? 'photos/sample.jpg', [op.autoWhiteBalance(), op.autoLevels({ clip: 0.01 }), op.sharpen()], { size: [1200, 800], fit: 'cover' })).filter(
    fx.grade({ contrast: 0.1, vibrance: 0.2 }),
  );
});
```

```sh
tasweerix batch batch.ts -i "photos/*.jpg" -o out/batch -f jpg
```
