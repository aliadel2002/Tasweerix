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
8-bit steps; 8-bit sources are decoded by the browser as before.

## Operations (`op`)

| Group | Operations |
| --- | --- |
| Geometry | `crop`, `cropAspect(aspect, focus?)`, `rotate(deg, { expand, autoCrop })`, `straighten(deg)`, `flip`, `resize({ width, height, scale, maxSize })` (Lanczos-3), `perspective(corners, size)` |
| Tone and color | `autoLevels`, `autoWhiteBalance`, `adjust` (exposure, brightness, contrast, highlights, shadows, whites, blacks, saturation, vibrance, temperature, tint, hue, gamma), `curves`, `hsl` (per hue range) |
| Detail | `sharpen`, `clarity`, `dehaze`, `denoise` (bilateral), `dust` (median), `blur` |
| Retouch | `heal` (texture from source, tone from destination), `clone`, `redEye`, `vignette` |
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
