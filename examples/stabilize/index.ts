// Stabilization and tracking: the same handheld shot raw (left) and locked off like a tripod shot
// (right), with a label pinned to the moving square by point tracking. Motion analysis runs once
// and is cached in .tasweerix/cache.
//   tasweerix render examples/stabilize/index.ts -o out/stabilize.mp4
//   tasweerix stabilize examples/stabilize/assets/handheld.mp4 --mode lock    (bake a stabilized copy)
import { composition, follow, group, rect, stabilize, text, trackPoint, video } from 'tasweerix';

export default composition({ width: 1280, height: 400, fps: 30, duration: 4, background: '#0b0f17' }, async (c) => {
  const raw = video('assets/handheld.mp4', { size: [620, 349], at: [320, 200] });
  // 'smooth' would keep the slow pan; 'lock' holds the frame still.
  const steady = await stabilize(video('assets/handheld.mp4', { size: [620, 349], at: [960, 200] }), { mode: 'lock', maxZoom: 1.25 });

  // Follow the white square (picked at source time 0) and hang a tag on it.
  const square = await trackPoint('assets/handheld.mp4', { at: [310, 168], time: 0, from: 0, to: 4 });
  steady.add(group(rect({ size: [96, 30], radius: 8, fill: '#f43f5e', at: [0, -48] }), text('subject', { size: 18, weight: 700, fill: '#fff', at: [0, -48] }), { at: follow(steady, square) }));

  c.add(raw, steady);
  c.add(text('handheld', { size: 22, fill: '#94a3b8', at: [320, 390] }));
  c.add(text('stabilize({ mode: "lock" }) + trackPoint()', { size: 22, fill: '#94a3b8', at: [960, 390] }));
});
