// Animated data storytelling: bar, line and donut charts, counters and callouts — data in, video out.
// Pass your own data with --props '{"revenue":[...]}'.
//   tasweerix render examples/data-viz/index.ts -o out/data.mp4
import { composition, motion, text, textFx, rect } from 'tasweerix';

type Props = { revenue: number[]; regions: { label: string; value: number }[] };

export default composition<Props>(
  { width: 1920, height: 1080, fps: 30, duration: 8, background: '#0b1120', props: { revenue: [12, 18, 15, 26, 31, 29, 42, 48], regions: [{ label: 'MENA', value: 38 }, { label: 'EU', value: 27 }, { label: 'NA', value: 22 }, { label: 'APAC', value: 13 }] } },
  (c, { revenue, regions }) => {
    c.add(text('Quarterly report', { at: [120, 110], align: 'left', size: 64, weight: 800, fill: '#fff' }).glyphs(textFx.fadeUp({ by: 'word', stagger: 0.12 })));
    c.add(rect({ at: [960, 560], size: [1680, 2], fill: 'rgba(255,255,255,0.08)' }));
    c.add(motion.lineChart(revenue, { size: [900, 360], at: [560, 420], colors: ['#22d3ee'], animateIn: { start: 0.6, duration: 2.2 } }));
    c.add(motion.numberCounter(revenue[revenue.length - 1]! * 1000, { prefix: '$', size: 88, at: [560, 720], start: 0.8, duration: 2 }));
    c.add(text('revenue this quarter', { at: [560, 790], size: 30, fill: '#94a3b8', start: 1 }));
    c.add(motion.pieChart(regions, { radius: 210, donut: 0.32, at: [1460, 430], animateIn: { start: 1.6, duration: 1.6 } }));
    regions.forEach((r, i) => c.add(text(`${r.label} ${r.value}%`, { at: [1460, 720 + i * 44], size: 30, fill: '#cbd5e1', start: 2.4 + i * 0.15 }).glyphs(textFx.fadeUp())));
    c.add(motion.barChart(revenue.map((v, i) => ({ label: `Q${i + 1}`, value: v })), { size: [1680, 160], at: [960, 960], animateIn: { start: 3.5, stagger: 0.08 } }));
    c.add(motion.callout([1010, 240], 'record high', { start: 3, offset: [-140, -50] }));
  },
);
