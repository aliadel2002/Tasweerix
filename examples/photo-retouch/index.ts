// Photo retouching in code: white balance, straighten, local adjustments through masks,
// healing, sharpening, then GPU finishing filters. Render with:
//   tasweerix still examples/photo-retouch/index.ts -o out/retouched.jpg
import { still, photo, op, mask, fx, text } from 'tasweerix';

export default still({ width: 960, height: 640, background: '#000' }, (c) => {
  c.add(
    photo('assets/landscape.png', [
      op.autoWhiteBalance('gray-world', 0.8),
      op.heal({ from: [560, 208], to: [607, 208], radius: 12 }),
      op.straighten(-1.5),
      // Graduated filter: darken & saturate the sky.
      op.adjust({ exposure: -0.4, saturation: 0.25 }, { mask: mask.linear([480, 0], [480, 380]) }),
      // Lift the foreground shadows only.
      op.adjust({ shadows: 0.5, vibrance: 0.3 }, { mask: mask.luminance(0, 0.35, 0.15) }),
      op.clarity(0.15),
      op.sharpen({ amount: 0.5 }),
    ], { size: [960, 640], fit: 'cover' }),
  ).filter(fx.vignette({ amount: 0.35 }), fx.grain({ amount: 0.04, animated: false }));
  c.add(text('TASWEERIX', { at: [940, 615], align: 'right', baseline: 'bottom', size: 22, weight: 700, letterSpacing: 6, fill: 'rgba(255,255,255,0.8)' }));
});
