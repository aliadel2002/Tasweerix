// Tasweerix showreel: a ~42s tour of the engine — kinetic titles, footage montage with
// GPU transitions and a LUT grade, Arabic kinetic typography (HarfBuzz shaping),
// audio-reactive motion graphics, a 3D title, animated data-viz, and a confetti finale.
//   tasweerix render examples/showreel/index.ts -o out/showreel.mp4 --root . -j 4
import {
  composition, text, rect, gradient, kashidaText, keys, textFx, motion, fx, arabicDigits,
  video, transition, audio, sfx, circle, analyze, range, palette, toCss, group,
  camera3d, light, orbit, plane, scene3d, text3d, torus,
} from 'tasweerix';

const CAIRO = 'assets/fonts/Cairo-Bold.ttf';
const AMIRI = 'assets/fonts/Amiri-Regular.ttf';

const label = (s: string, start: number, duration: number) =>
  text(s, { size: 26, fill: '#94a3b8', at: [80, 660], align: 'left', start, duration });

export default composition({ name: 'Tasweerix Showreel', width: 1280, height: 720, fps: 30, duration: 42, background: '#05060a' }, (c) => {
  // ---------- 0–4.5s: opening title card ----------
  c.add(rect({ size: [1280, 720], fill: gradient.radial([0, 0], 760, ['#1e1b4b', '#05060a']), duration: 4.5 }));
  c.add(motion.titleCard('TASWEERIX', { kicker: 'video · photo · audio · code', at: [640, 330], size: 120, duration: 3.6 }));
  c.add(motion.particlePresets.fireflies({ seed: 4 }).at([640, 360]).lasting(4.5));

  // ---------- 4.5–12s: footage montage with GPU transitions + LUT grade ----------
  const grade = [fx.lut('assets/teal-orange.cube', 0.85), fx.grade({ contrast: 0.08, vibrance: 0.15 }), fx.vignette({ amount: 0.35 })];
  const clip = (src: string) => video(src, { trim: [0, 2.6], size: [1280, 720], fit: 'cover', muted: true }).filter(...grade);
  c.add(
    transition
      .chain(
        clip('assets/fractal.mp4'),
        { type: 'zoom', duration: 0.6 },
        clip('assets/life.mp4'),
        { type: 'wipe', duration: 0.5, angle: 20, softness: 0.08 },
        clip('assets/flow.mp4'),
        { type: 'glitch', duration: 0.4 },
        clip('assets/fractal.mp4').rate(0.6),
      )
      .lasting(7.5)
      .startAt(4.5),
  );
  c.add(label('footage · gpu transitions · cinematic grades', 4.8, 6.9));

  // ---------- 12–19s: Arabic kinetic typography ----------
  c.add(rect({ size: [1280, 720], fill: '#0b0d17', start: 12, duration: 7 }));
  c.add(
    text('تصوير بالكود', { font: CAIRO, size: 140, fill: '#ffffff', at: [640, 250], start: 12.2, duration: 6.8 }).glyphs(
      textFx.dropIn({ by: 'glyph', order: 'reading', stagger: 0.06, duration: 0.7 }),
    ),
  ).filter(fx.glow({ radius: 18, threshold: 0.55, intensity: 0.6 }));
  c.add(
    text(kashidaText('جميل', keys([[13.2, 0], [14.4, 4, 'inOutCubic'], [15.6, 0, 'inOutCubic']])), {
      font: AMIRI, size: 110, fill: gradient.linear([-300, 0], [300, 0], ['#f472b6', '#facc15']),
      at: [640, 450], start: 13, duration: 6,
    }),
  );
  c.add(
    text('أهلاً بكم في Tasweerix ' + arabicDigits(2026), { font: CAIRO, size: 44, fill: 'rgba(255,255,255,0.75)', at: [640, 600], start: 13.6, duration: 5.4 }).glyphs(
      textFx.fadeUp({ by: 'word', stagger: 0.12 }),
      textFx.highlight({ color: '#22d3ee', by: 'word', start: 1, stagger: 0.4 }),
    ),
  );
  c.add(label('arabic kinetic typography · harfbuzz shaping', 12.4, 6.2));

  // ---------- 19–26s: audio-reactive motion graphics ----------
  const beatNode = c.audio(audio('assets/beat.mp3', { start: 19, duration: 7, gain: -2 }));
  const a = analyze(beatNode);
  const bars = 48;
  const colors = palette(['#22d3ee', '#a855f7', '#f43f5e'], bars).map((x) => toCss(x));
  const spectrum = group({ at: [640, 600], start: 19, duration: 7 });
  for (const i of range(bars)) {
    const h = (f: Parameters<typeof a.level>[0]) => 8 + a.spectrum(f, bars)[i]! * 380;
    spectrum.add(
      rect({
        at: [(i - bars / 2 + 0.5) * 24, 0],
        anchor: (f) => [0, h(f) / 2],
        fill: colors[i],
        radius: 4,
        size: (f) => [16, h(f)],
      }),
    );
  }
  c.add(spectrum);
  c.add(circle(120, { at: [640, 300], fill: null, stroke: '#fff', strokeWidth: 10, scale: (f) => 1 + a.beat(f) * 0.35, start: 19, duration: 7 })).filter(fx.glow({ radius: 24, threshold: 0.2 }));
  c.add(text('BEAT', { at: [640, 300], size: 64, weight: 900, fill: '#fff', opacity: (f) => 0.4 + a.level(f) * 0.6, start: 19, duration: 7 }));
  c.add(label('audio-reactive graphics · beat + spectrum analysis', 19.4, 6.2));

  // ---------- 26–33s: 3D title ----------
  c.add(
    scene3d(
      { start: 26, duration: 7, ambientIntensity: 0.25, fog: { color: '#05070d', near: 9, far: 18 } },
      camera3d({ position: orbit({ radius: 7.5, height: 1.8, speed: 8, startAngle: -24 }), target: [0, 0.6, 0], fov: 40 }),
      light.directional({ position: [4, 7, 5], intensity: 1.3, castShadow: true }),
      light.point({ position: [-3, 1.5, 2], color: '#38bdf8', intensity: 3, range: 8 }),
      plane({ size: [30, 30], rotation: [-90, 0, 0], position: [0, -0.6, 0], color: '#1e293b', roughness: 0.9 }),
      text3d('تصوير', { font: CAIRO, size: 1.3, depth: 0.35, position: [0, 1.7, 0], color: '#fbbf24', metalness: 0.6, roughness: 0.3 }),
      text3d('Tasweerix', { font: CAIRO, size: 0.8, depth: 0.25, position: [0, 0.35, 0], color: '#e2e8f0', roughness: 0.4, scale: keys([[0, 0.001], [1.2, 1, 'outBack']]) }),
      torus({ radius: 2.6, tube: 0.06, position: [0, 1.2, -0.6], color: '#f472b6', metalness: 1, roughness: 0.2, rotation: keys([[0, [70, 0, 0]], [7, [70, 0, 180]]]) }),
    ),
  );
  c.add(label('3d titles · extruded type · orbiting camera', 26.4, 6.2));

  // ---------- 33–38.5s: animated data story ----------
  const revenue = [12, 18, 15, 26, 31, 29, 42, 48];
  c.add(rect({ size: [1280, 720], fill: '#0b1120', start: 33, duration: 5.5 }));
  c.add(text('Quarterly report', { at: [640, 90], size: 56, weight: 800, fill: '#fff', start: 33.2, duration: 5.3 }).glyphs(textFx.fadeUp({ by: 'word', stagger: 0.12 })));
  c.add(motion.lineChart(revenue, { size: [620, 300], at: [400, 400], colors: ['#22d3ee'], start: 33, duration: 5.5, animateIn: { start: 0.6, duration: 2.2 } }));
  c.add(motion.numberCounter(revenue[revenue.length - 1]! * 1000, { prefix: '$', size: 80, at: [400, 620], start: 33.8, duration: 2 }).lasting(4.7));
  c.add(motion.pieChart([{ label: 'MENA', value: 38 }, { label: 'EU', value: 27 }, { label: 'NA', value: 22 }, { label: 'APAC', value: 13 }], { radius: 170, donut: 0.32, at: [980, 400], start: 33, duration: 5.5, animateIn: { start: 1.4, duration: 1.6 } }));
  c.add(label('data stories · charts · counters', 33.4, 4.8));

  // ---------- 38.5–42s: finale ----------
  c.add(rect({ size: [1280, 720], fill: gradient.radial([0, 0], 800, ['rgba(15,23,42,0.85)', 'rgba(5,6,10,0.98)']), start: 38.5, opacity: 0 }).animate({ opacity: 1 }, { duration: 0.5 }));
  c.add(text('Make something.', { size: 96, weight: 900, fill: '#fff', at: [640, 320], start: 38.7 }).glyphs(textFx.pop({ stagger: 0.04 })));
  c.add(motion.numberCounter(100, { from: 0, suffix: '% code', size: 40, at: [640, 430], start: 39, duration: 1.2 }));
  c.add(motion.particlePresets.confetti({ seed: 7, speed: [500, 1100] }).at([640, 700]).startAt(39.2));

  // ---------- sound ----------
  c.audio(audio('assets/music.mp3', { loop: true, gain: -6 }).fadeIn(1).fadeOut(2));
  for (const t of [4.5, 12, 19, 26, 33, 38.5]) c.audio(sfx('whoosh', { start: t - 0.4, gain: -8 }));
  c.audio(sfx('impact', { start: 38.5, gain: -4 }));
});
