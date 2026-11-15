// Arabic kinetic typography: HarfBuzz-shaped letters are written on one by one in reading order (right
// to left) with the arabicFx presets, keeping their joined forms; kashida stretches a word; a mixed
// Arabic and English line rises word by word.
//   tasweerix render examples/arabic-kinetic/index.ts -o out/arabic.mp4 --root .
import { composition, text, rect, gradient, kashidaText, keys, textFx, arabicFx, motion, fx, arabicDigits } from 'tasweerix';

const CAIRO = 'assets/fonts/Cairo-Bold.ttf';
const AMIRI = 'assets/fonts/Amiri-Regular.ttf';

export default composition({ width: 1280, height: 720, fps: 30, duration: 6, background: '#0b0d17' }, (c) => {
  c.add(rect({ size: [1280, 720], fill: gradient.radial([0, 0], 760, ['#2a1f0c', '#0b0d17']) }));

  // 1. Title: each letter is wiped in from its right edge, then the letters lift away, last one first.
  c.add(
    text('تصوير بالكود', { font: CAIRO, size: 140, fill: '#ffffff', at: [640, 230] }).glyphs(
      arabicFx.write({ start: 0.2 }),
      arabicFx.lift({ start: 5.2 }),
    ),
  ).filter(fx.glow({ radius: 18, threshold: 0.55, intensity: 0.6 }));

  // 2. Kashida stretch on a calligraphic word.
  c.add(
    text(kashidaText('جميل', keys([[1.2, 0], [2.4, 4, 'inOutCubic'], [3.6, 0, 'inOutCubic']])), {
      font: AMIRI,
      size: 110,
      fill: gradient.linear([-300, 0], [300, 0], ['#f2a93b', '#fde68a']),
      at: [640, 420],
      start: 1,
    }),
  );

  // 3. Mixed Arabic / English line with word-by-word highlight (bidi aware).
  c.add(
    text('أهلاً بكم في Tasweerix ' + arabicDigits(2026), { font: CAIRO, size: 48, fill: 'rgba(255,255,255,0.75)', at: [640, 580], start: 1.5 }).glyphs(
      arabicFx.rise({ stagger: 0.12 }),
      textFx.highlight({ color: '#f2a93b', by: 'word', start: 1.2, stagger: 0.4 }),
    ),
  );

  c.add(motion.particlePresets.fireflies({ seed: 4 }).at([640, 360]));
});
