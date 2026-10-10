# Photo editing

Photos are stills (`still(...)`) or any image inside a composition. `photo(src, ops)` applies a
non-destructive pipeline of operations, then the result can take GPU filters like any node.

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
      op.hsl({ range: 'blues', saturation: 0.3 }),
      op.clarity(0.2),
      op.sharpen({ amount: 0.5 }),
    ], { size: [1600, 1067], fit: 'cover' }),
  ).filter(fx.vignette({ amount: 0.3 }), fx.grain({ amount: 0.04, animated: false }));
});
```

```sh
tasweerix still edit.ts -o out/edited.jpg          # png | jpg | webp | avif
tasweerix batch edit.ts -i "photos/*.jpg" -o out   # same script for every photo (props.src / props.name)
```

Ops run on 32-bit float pixels. Sources with more than 8 bits per channel (16-bit PNG or TIFF) are
decoded at full depth by the Tasweerix server, so heavy grades and shadow lifts don't start from
8-bit steps; 8-bit sources are decoded by the browser as before. Embedded color profiles are applied
on both paths (the server handles matrix/TRC profiles such as Display P3, Adobe RGB, ProPhoto and
Rec. 2020; LUT-based profiles fall back to sRGB with a warning). With `--gamut p3` the ops work on
Display P3 pixels, so a P3 photo keeps its range from file to export.

## Camera RAW

`photo('IMG_0042.CR3', ops)` and `image('scene.dng')` accept camera RAW files (DNG, CR2, CR3, NEF,
ARW, RAF, ORF, RW2, PEF and the other formats LibRaw reads). The server develops them with LibRaw's
`dcraw_emu`, which you install alongside FFmpeg (`apt install libraw-bin`, `brew install libraw`, or
point `TASWEERIX_DCRAW_EMU` at it):

- Demosaic, the camera's color matrix and its as-shot white balance, with orientation applied.
- No tone curve and no auto brightening: the result is linear light in BT.2020 where the sensor's
  white level is 1.0. Use `op.adjust({ exposure })` to place it; RAWs usually want +0.5 to +1.
- 16 bits through the ops at any `--depth`, so the photo keeps the sensor's range until export.
  With `--gamut p3` it keeps P3 colors, and with `--hdr` pushed exposure lands above white instead
  of clipping, so highlights the sensor caught become HDR highlights.

```ts
photo('raw/IMG_0042.CR3', [op.adjust({ exposure: 0.7, shadows: 0.3 }), op.toneMap()])
```

`op.toneMap({ knee, white })` rolls off highlights above 1.0 toward white for SDR output after a
strong exposure push.

## Operations (`op`)

| Group | Operations |
| --- | --- |
| Geometry | `crop`, `cropAspect(aspect, focus?)`, `rotate(deg, { expand, autoCrop })`, `straighten(deg)`, `flip`, `resize({ width, height, scale, maxSize })` (Lanczos-3), `perspective(corners, size)` |
| Tone and color | `autoLevels`, `autoWhiteBalance`, `adjust` (exposure, brightness, contrast, highlights, shadows, whites, blacks, saturation, vibrance, temperature, tint, hue, gamma), `curves`, `hsl` (per hue range) |
| Detail | `sharpen`, `clarity`, `dehaze`, `denoise` (bilateral), `dust` (median), `blur` |
| Retouch | `heal` (texture from source, tone from destination), `clone`, `redEye`, `vignette` |
| HDR | `toneMap({ knee, white })` |
| Custom | `op.custom(kind, params)` after `registerPhotoOp(kind, fn)` |

Every tone, detail and retouch op accepts `{ mask }`.

## Selections and masks (`mask`)

| Builder | Selects |
| --- | --- |
| `mask.rect`, `mask.ellipse`, `mask.polygon` | Shapes (with feather) |
| `mask.radial(center, radius, feather)` | Radial gradient (spotlights, vignettes) |
| `mask.linear(from, to)` | Graduated filter |
| `mask.color(color, tolerance, feather, 'rgb' \| 'hue')` | Color range |
| `mask.luminance(min, max, softness)` | Luminosity masks |
| `mask.wand(x, y, tolerance, contiguous)` | Magic wand |
| `mask.brush(strokes)` | Painted strokes (size, hardness, erase) |
| `mask.add / subtract / intersect / invert / refine(grow, feather, contrast)` | Combining and refining masks |

## CPU API

The same operations are plain functions over float bitmaps, so they work in Node too:
`fromRGBA8`, `toRGBA8`, `applyOps`, `histogram`, `percentile`, `resize`, `rotate`, `perspective`,
`adjust`, `curves`, `blur`, `unsharp`, `denoise`, `heal`, `resolveMask` and more from `@tasweerix/image`.
