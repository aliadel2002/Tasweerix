// Arabic kinetic typography: HarfBuzz-shaped glyphs animate individually in reading order (right
// to left) while keeping their contextual forms; kashida stretches a word; mixed-direction text.
//   tasweerix render examples/arabic-kinetic/index.ts -o out/arabic.mp4 --root .
import { composition, text, rect, gradient, kashidaText, keys, textFx, motion, fx, arabicDigits } from 'tasweerix';

const CAIRO = 'assets/fonts/Cairo-Bold.ttf';
const AMIRI = 'assets/fonts/Amiri-Regular.ttf';

export default composition({ width: 1280, height: 720, fps: 30, duration: 6, background: '#0b0d17' }, (c) => {
  c.add(rect({ size: [1280, 720], fill: gradient.radial([0, 0], 760, ['#1e1b4b', '#0b0d17']) }));

  // 1. Title: glyphs drop in, in Arabic reading order.
  c.add(
    text('تصوير بالكود', { font: CAIRO, size: 140, fill: '#ffffff', at: [640, 230] }).glyphs(
      textFx.dropIn({ by: 'glyph', order: 'reading', stagger: 0.06, duration: 0.7 }),
      textFx.out({ by: 'glyph', order: 'reverse', start: 5.2, stagger: 0.02, duration: 0.3, to: { opacity: 0, y: -40 } }),
    ),
  ).filter(fx.glow({ radius: 18, threshold: 0.55, intensity: 0.6 }));

  // 2. Kashida stretch on a calligraphic word.
  c.add(
    text(kashidaText('جميل', keys([[1.2, 0], [2.4, 4, 'inOutCubic'], [3.6, 0, 'inOutCubic']])), {
      font: AMIRI,
      size: 110,
      fill: gradient.linear([-300, 0], [300, 0], ['#f472b6', '#facc15']),
      at: [640, 420],
      start: 1,
    }),
  );

  // 3. Mixed Arabic / English line with word-by-word highlight (bidi aware).
  c.add(
    text('أهلاً بكم في Tasweerix ' + arabicDigits(2026), { font: CAIRO, size: 48, fill: 'rgba(255,255,255,0.75)', at: [640, 580], start: 1.5 }).glyphs(
      textFx.fadeUp({ by: 'word', stagger: 0.12 }),
      textFx.highlight({ color: '#22d3ee', by: 'word', start: 1.2, stagger: 0.4 }),
    ),
  );

  c.add(motion.particlePresets.fireflies({ seed: 4 }).at([640, 360]));
});
