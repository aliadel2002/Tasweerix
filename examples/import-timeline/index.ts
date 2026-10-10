// Importing an edit from another editor at build time: a Final Cut Pro rough cut (FCPXML) becomes
// nodes — clips, the dissolve, the title, the music bed and the marker — and you keep editing in
// code on top of it. Media is relinked by file name into this project's footage folder.
//   tasweerix render examples/import-timeline/index.ts --root . -o out/import-timeline.mp4
// To turn the edit into editable source code instead, run:
//   tasweerix import-timeline examples/import-timeline/assets/rough-cut.fcpxml -o my-cut --media examples/promo/assets
import { composition, fx, importTimeline, rect, text, textFx } from 'tasweerix';

export default composition({ width: 1280, height: 720, fps: 30, background: '#000' }, async (c) => {
  const cut = await importTimeline('examples/import-timeline/assets/rough-cut.fcpxml', { mediaDir: 'examples/promo/assets' });
  // Imported nodes are ordinary nodes: grade the whole cut and add a finishing touch.
  cut.filter(fx.grade({ contrast: 0.15, saturation: 0.1 }), fx.vignette({ amount: 0.35 }));
  c.add(cut);
  c.add(rect({ size: [1280, 70], fill: 'rgba(0,0,0,0.55)', at: [640, 685], start: 4.5 }));
  c.add(text('Finished in Tasweerix', { size: 34, weight: 700, fill: '#fff', at: [640, 690], start: 4.5 }).glyphs(textFx.fadeUp({ stagger: 0.03 })));
});
