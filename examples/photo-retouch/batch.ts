// One edit applied to a folder of photos:
//   tasweerix batch examples/photo-retouch/batch.ts -i "examples/photo-retouch/photos/*.jpg" -o out/batch
import { still, photo, op, fx } from 'tasweerix';

export default still<{ src: string; name: string }>({ width: 480, height: 320 }, (c, { src, name }) => {
  c.name = name ?? 'batch';
  c.add(photo(src ?? 'photos/shot1.jpg', [op.autoWhiteBalance(), op.autoLevels({ clip: 0.01 }), op.sharpen()], { size: [480, 320], fit: 'cover' })).filter(
    fx.grade({ contrast: 0.1, vibrance: 0.2 }),
  );
});
