// Generative illustration: Voronoi mosaic, flow-field strokes, boolean shapes, Arabic title.
//   tasweerix still examples/generative-poster/index.ts --root . -o out/poster.png
//   tasweerix svg   examples/generative-poster/index.ts --root . -o out/poster.svg
import { still, path, group, text, poissonDisc, voronoi, flowField, boolean, pen, palette, toCss, createRandom } from 'tasweerix';

export default still({ width: 1080, height: 1350, background: '#f4efe6' }, (c) => {
  const rnd = createRandom('poster');
  const colors = palette(['#0f172a', '#1d4ed8', '#22d3ee', '#f59e0b', '#ef4444'], 9).map((x) => toCss(x));

  // Voronoi mosaic inside a circle (boolean intersection per cell).
  const disc = pen().arcAround(540, 560, 380, 0, 360).close().d;
  const cells = voronoi(poissonDisc(1080, 1350, 46, { seed: 7 }), [0, 0, 1080, 1350]);
  const mosaic = group({ position: [0, 0] });
  for (const cell of cells) {
    if (cell.length < 3) continue;
    const d = boolean.intersect(cell.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join('') + 'Z', disc);
    if (d) mosaic.add(path(d, { position: [0, 0], fill: rnd.pick(colors), stroke: '#f4efe6', strokeWidth: 3 }));
  }
  c.add(mosaic);

  // Flow-field strokes across the lower part.
  const flow = group({ position: [0, 900] });
  for (const d of flowField(1080, 380, { lines: 160, steps: 70, seed: 3, scale: 0.004 })) flow.add(path(d, { position: [0, 0], fill: null, stroke: 'rgba(15,23,42,0.45)', strokeWidth: 1.5, lineCap: 'round' }));
  c.add(flow);

  c.add(text('فن بالكود', { font: 'assets/fonts/Cairo-Bold.ttf', size: 120, fill: '#0f172a', at: [540, 1080] }));
  c.add(text('GENERATIVE · TASWEERIX', { at: [540, 1220], size: 28, letterSpacing: 10, weight: 700, fill: '#0f172a' }));
});
