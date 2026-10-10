# Illustration and SVG

```ts
import { still, path, pen, boolean, offsetPath, poissonDisc, voronoi, flowField, lSystem, blob, patterns, svgFile } from 'tasweerix';

const ring = boolean.subtract(pen().arcAround(0, 0, 200, 0, 360).close().d, pen().arcAround(0, 0, 120, 0, 360).close().d);
c.add(path(ring, { fill: '#0ea5e9' }));
c.add(path(offsetPath(starD, 12), { fill: null, stroke: '#fff', strokeWidth: 2 }));
```

| Tool | What it does |
| --- | --- |
| `pen()` | Fluent path builder (`move`, `line`, `by`, `quad`, `curve`, `arc`, `arcAround`, `close`). |
| `boolean.union / intersect / subtract / xor` | Polygon booleans (curves are flattened). |
| `offsetPath(d, ±px)`, `strokeToPath(d, width)` | Outline growth and shrinkage, and turning strokes into fills. |
| `simplifyPath`, `smoothPath` | Ramer–Douglas–Peucker simplification and Catmull-Rom smoothing. |
| `transformPath`, `translatePath`, `scalePath`, `rotatePath`, `centerPath` | Geometry utilities. |
| `poissonDisc`, `delaunay`, `voronoi` | Even sampling, triangulation, cells clipped to bounds. |
| `flowField`, `ridgeLines`, `lSystem`, `blob`, `spirograph` | Generative line art. |
| `patterns.stripes / dots / grid / checker / hexagons` | Repeating patterns. |

Path geometry in core (`parsePath`, `serializePath`, `flattenPath`, `pathLength`, `pathBounds`,
`pointAtLength`, `trimPolylines`, `resamplePolyline`) underpins trim paths, morphing and SVG export.

## SVG import and export

```ts
c.add(svgFile('assets/logo.svg'));               // shapes, groups, transforms, styles, gradients, text, images
const g = importSVG(markup, { center: true });   // synchronous, from a string
```

```sh
tasweerix svg poster.ts -o out/poster.svg -f 0   # vector export; text from font files becomes glyph outlines
```

SVG export writes shapes, gradients, trim paths, masks (`<mask>`), blend modes and nested compositions.
GPU filters are raster-only, so they are left out of the SVG.
