---
name: 3d
description: Tasweerix 3D scenes as layers - scene3d, cameras and orbit, lights and shadows, boxes, spheres, tori, extruded SVG paths, extruded Arabic and Latin text3d, glTF/GLB and OBJ models with animation and morphs, PBR materials, environment lighting, fog, and 2D layers placed in 3D. Use for 3D titles, product shots and logo reveals in Tasweerix.
---

# 3D scenes in Tasweerix

`scene3d(options, ...objects)` is a 2D node that renders real 3D with WebGL2. Put 2D graphics above
or below it, mask it, filter it or nest it like any node.

```ts
import { composition, scene3d, camera3d, light, plane, box, text3d, torus, orbit, keys } from 'tasweerix';

export default composition({ width: 1920, height: 1080, fps: 30, duration: 6, background: '#0b1020' }, (c) => {
  c.add(
    scene3d(
      { environment: 'studio', toneMapping: 'aces', fog: { color: '#0b1020', near: 8, far: 20 } },
      camera3d({ position: orbit({ radius: 7, height: 2, speed: 12 }), target: [0, 0.5, 0], fov: 40 }),
      light.directional({ position: [4, 6, 3], castShadow: true }),
      plane({ size: [20, 20], rotation: [-90, 0, 0], position: [0, -0.5, 0], color: '#334155', roughness: 0.9 }),
      text3d('تصوير', { font: 'assets/fonts/Cairo-Bold.ttf', size: 1.2, depth: 0.3, color: '#fbbf24', metalness: 0.6, roughness: 0.3 }),
      torus({ radius: 2.4, tube: 0.06, position: [0, 0.6, -0.6], color: '#f472b6', metalness: 1, roughness: 0.2, rotation: keys([[0, [70, 0, 0]], [6, [70, 0, 180]]]) }),
      box({ size: [0.5, 0.5, 0.5], position: [2, 0, 1], rotation: keys([[0, [0, 0, 0]], [6, [0, 360, 0]]]), color: '#22d3ee' }),
    ),
  );
});
```

## Coordinates

World units, **y up**, right-handed; the camera looks down -Z by default. `position` is a Vec3,
`rotation` is Euler degrees (X, then Y, then Z), `scale` a number or Vec3. Every prop animates with
`keys`, drivers or `start`/`duration`. `group3d(...)` children inherit its transform. A camera at
`[0, 2, 7]` looking at the origin frames a 3 to 4 unit wide subject.

## Objects

| Factory | Props |
| --- | --- |
| `box`, `sphere`, `plane`, `cylinder`, `cone`, `torus` | `size`, `radius`, `radiusTop`, `height`, `tube`, `segments` (`plane` faces +Z: rotate `[-90, 0, 0]` for a floor) |
| `extrude(d)` | SVG path data, `depth`, `scale` (world units per path unit, default 0.01) |
| `text3d(text, { font })` | `size`, `depth`, `align`, `letterSpacing`, `lineHeight`, `direction`; needs a font **file** |
| `model(src)` | glTF/GLB and OBJ: `animation` (clip name, index, or `null`), `animationSpeed`, `loop`, `animationTime`, `morphs` |
| `mesh(geometry)` | `{ positions, normals, uvs, indices, colors? }` |
| `layer3d(node, { size, position, rotation })` | Any 2D node (video, text, group, `comp()`) as a plane in 3D |

## Materials

`color`, `map` (image path or a node), `metalness`, `roughness`, `emissive`, `emissiveIntensity`,
`opacity`, `transparent`, `unlit`, `doubleSided`, `castShadow`, `receiveShadow`.

## Lights, cameras, environment

- `light.directional({ position, target, intensity, color, castShadow })` (up to 4),
  `light.point({ position, intensity, range, castShadow })` (up to 8), `light.ambient()`.
- `camera3d({ position, target, fov, near, far, roll, orthographic })`. The last active camera wins,
  so cuts are timing: `camera3d({ ..., duration: 2 })`, `camera3d({ ..., start: 2 })`.
  `orbit({ radius, height, speed, startAngle })` drives a circling camera.
- Scene options: `background` (`null` = transparent), `fog`, `exposure`, `toneMapping: 'aces'`,
  `samples`, `environment: 'studio' | 'sky' | 'assets/hall.hdr'` with `environmentIntensity`,
  `environmentRotation`, `environmentBackground`, `environmentBlur`. Metals look flat without an
  environment: use `'studio'` for product shots.

## Checking a 3D shot

Render stills at the start, middle and end of camera moves: objects leaving frame, text facing
away, and shadows clipping at the floor's edge are the usual problems. Without a GPU, exports run on
SwiftShader (correct but slow); preview with `scale: 0.5` and keep shadow-casting point lights few.
