import { composition, ellipse, fx, gradient, keys, rect, star, text, transition, group } from 'tasweerix';

export default composition({ width: 640, height: 360, fps: 30, duration: 3, background: '#0b1020' }, (c) => {
  const a = group(
    rect({ size: [640, 360], fill: gradient.linear([-320, 0], [320, 0], ['#ff3d6e', '#ffb03d']) }),
    text('Tasweerix', { size: 72, weight: 800, fill: '#fff' }),
  ).lasting(1.6);
  const b = group(
    rect({ size: [640, 360], fill: '#1d4ed8' }),
    star({ outerRadius: 90, innerRadius: 40, fill: '#fde047', rotation: keys([[0, 0], [2, 180]]) }),
  ).lasting(1.8);
  c.add(transition.sequence([a, b], { type: 'wipe', duration: 0.5, angle: 30 }));
  c.add(
    ellipse({ size: [80, 80], fill: null, stroke: '#fff', strokeWidth: 6, trimEnd: keys([[0, 0], [2, 1]]), at: [580, 300] }),
  ).filter(fx.glow({ radius: 12, threshold: 0.3 }));
});
