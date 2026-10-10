// A 12-second promo: footage with GPU transitions and a LUT grade, kinetic titles, captions from
// an SRT file, a lower third, a confetti finale, music with fades and transition whooshes.
//   tasweerix render examples/promo/index.ts -o out/promo.mp4 -j 3
//   tasweerix studio examples/promo
import { composition, video, transition, fx, text, textFx, motion, audio, sfx, captions, parseSubtitles, rect, gradient, getEnv } from 'tasweerix';

export default composition({ name: 'Tasweerix Promo', width: 1280, height: 720, fps: 30, duration: 12, background: '#05060a' }, async (c) => {
  const grade = [fx.lut('assets/teal-orange.cube', 0.85), fx.grade({ contrast: 0.08, vibrance: 0.15 }), fx.vignette({ amount: 0.35 })];
  const clip = (src: string) => video(src, { trim: [0, 3], size: [1280, 720], fit: 'cover', muted: true }).filter(...grade);

  // Footage: shots chained with different GPU transitions (the last one slowed down).
  c.add(
    transition.chain(
      clip('assets/fractal.mp4'),
      { type: 'zoom', duration: 0.6 },
      clip('assets/life.mp4'),
      { type: 'wipe', duration: 0.5, angle: 20, softness: 0.08 },
      clip('assets/flow.mp4'),
      { type: 'glitch', duration: 0.4 },
      clip('assets/fractal.mp4').rate(0.6),
    ),
  );

  // Opening title.
  c.add(motion.titleCard('TASWEERIX', { kicker: 'video · photo · audio · code', at: [640, 330], size: 120, duration: 2.6 })).filter(
    fx.dropShadow({ blur: 30, y: 10, color: 'rgba(0,0,0,0.6)' }),
  );

  // Captions from an SRT file.
  const srt = new TextDecoder().decode(await getEnv().loadBinary!('assets/captions.srt'));
  c.add(captions(parseSubtitles(srt), { size: 40, at: [640, 650], maxWidth: 1100 }));

  // Lower third mid-way.
  c.add(motion.lowerThird('Made with Tasweerix', 'A code-first media engine', { at: [80, 520], start: 3.4, duration: 3.2 }));

  // Finale: dark card, title, counter and confetti.
  c.add(rect({ size: [1280, 720], fill: gradient.radial([0, 0], 800, ['rgba(15,23,42,0.85)', 'rgba(5,6,10,0.98)']), start: 9.6, opacity: 0 }).animate({ opacity: 1 }, { duration: 0.5 }));
  c.add(text('Make something.', { size: 96, weight: 900, fill: '#fff', at: [640, 320], start: 9.8 }).glyphs(textFx.pop({ stagger: 0.04 })));
  c.add(motion.numberCounter(100, { from: 0, suffix: '% code', size: 40, at: [640, 430], start: 10, duration: 1.2 }));
  c.add(motion.particlePresets.confetti({ seed: 7, speed: [500, 1100] }).at([640, 700]).startAt(10.2));

  // Sound: music bed, whooshes on the transitions and a hit on the finale.
  c.audio(audio('assets/music.mp3', { loop: true, gain: -4 }).fadeIn(0.8).fadeOut(1.5));
  for (const t of [2.4, 4.9, 7.5]) c.audio(sfx('whoosh', { start: t - 0.4, gain: -6 }));
  c.audio(sfx('impact', { start: 9.8, gain: -3 }));
  c.marker(9.8, 'Finale');
});
