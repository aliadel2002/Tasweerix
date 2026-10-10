// Audio-reactive motion graphics driven by beat & spectrum analysis.
import { composition, rect, circle, text, analyze, fx, range, palette, toCss, group } from 'tasweerix';

export default composition({ width: 1280, height: 720, fps: 30, duration: 8, background: '#07070c' }, (c) => {
  const music = c.audio('assets/beat.mp3');
  const a = analyze(music);
  const bars = 48;
  const colors = palette(['#22d3ee', '#a855f7', '#f43f5e'], bars).map((x) => toCss(x));
  const spectrum = group({ at: [640, 600] });
  for (const i of range(bars)) {
    const h = (f: Parameters<typeof a.level>[0]) => 8 + a.spectrum(f, bars)[i]! * 380;
    spectrum.add(
      rect({
        at: [(i - bars / 2 + 0.5) * 24, 0],
        // Pivot at the bottom edge so bars grow upwards.
        anchor: (f) => [0, h(f) / 2],
        fill: colors[i],
        radius: 4,
        size: (f) => [16, h(f)],
      }),
    );
  }
  c.add(spectrum);
  c.add(circle(120, { at: [640, 300], fill: null, stroke: '#fff', strokeWidth: 10, scale: (f) => 1 + a.beat(f) * 0.35 })).filter(fx.glow({ radius: 24, threshold: 0.2 }));
  c.add(text('BEAT', { at: [640, 300], size: 64, weight: 900, fill: '#fff', opacity: (f) => 0.4 + a.level(f) * 0.6 }));
});
