// A 3D title: shaped Arabic and Latin text extruded from a font file, a glossy ring, shadows, a
// slow orbiting camera and a 2D layer (a card made of shapes and text) placed in 3D space.
//   tasweerix render examples/3d-title/index.ts --root . -o out/3d-title.mp4
import { box, camera3d, composition, gradient, group, keys, layer3d, light, orbit, plane, rect, scene3d, text, text3d, torus } from 'tasweerix';

const FONT = 'assets/fonts/Cairo-Bold.ttf';

export default composition({ width: 1280, height: 720, fps: 30, duration: 6, background: gradient.linear([0, -360], [0, 360], ['#101a33', '#05070d']) }, (c) => {
  const card = group(rect({ size: [1280, 720], radius: 48, fill: '#f8fafc' }), text('Made in code', { size: 120, weight: 800, fill: '#0f172a' }));
  c.add(
    scene3d(
      { ambientIntensity: 0.25, fog: { color: '#05070d', near: 9, far: 18 } },
      camera3d({ position: orbit({ radius: 7.5, height: 1.8, speed: 8, startAngle: -24 }), target: [0, 0.6, 0], fov: 40 }),
      light.directional({ position: [4, 7, 5], intensity: 1.3, castShadow: true }),
      light.point({ position: [-3, 1.5, 2], color: '#38bdf8', intensity: 3, range: 8 }),
      plane({ size: [30, 30], rotation: [-90, 0, 0], position: [0, -0.6, 0], color: '#1e293b', roughness: 0.9 }),
      text3d('تصوير', { font: FONT, size: 1.3, depth: 0.35, position: [0, 1.7, 0], color: '#fbbf24', metalness: 0.6, roughness: 0.3 }),
      text3d('Tasweerix', { font: FONT, size: 0.8, depth: 0.25, position: [0, 0.35, 0], color: '#e2e8f0', roughness: 0.4, scale: keys([[0, 0.001], [1.2, 1, 'outBack']]) }),
      torus({ radius: 2.6, tube: 0.06, position: [0, 1.2, -0.6], color: '#f472b6', metalness: 1, roughness: 0.2, rotation: keys([[0, [70, 0, 0]], [6, [70, 0, 180]]]) }),
      box({ size: [0.5, 0.5, 0.5], position: [2.4, -0.35, 1.2], rotation: keys([[0, [0, 0, 0]], [6, [0, 360, 0]]]), color: '#22d3ee' }),
      layer3d(card, { size: [2.4, 1.35], position: [-3.2, 0.9, -1.8], rotation: [0, 32, 0], start: 1.5 }),
    ),
  );
});
