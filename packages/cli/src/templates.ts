import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const TEMPLATES: Record<string, string> = {
  video: `import { composition, rect, text, gradient, keys, textFx, motion } from 'tasweerix';

export default composition({ width: 1920, height: 1080, fps: 30, duration: 6, background: '#0b1020' }, (c) => {
  c.add(rect({ size: [1920, 1080], fill: gradient.angled(35, [1920, 1080], ['#1e1b4b', '#0b1020']) }));
  c.add(text('Hello, Tasweerix', { size: 140, weight: 800, fill: '#ffffff' }).glyphs(textFx.pop({ stagger: 0.04 })));
  c.add(rect({ size: [520, 8], radius: 4, fill: '#22d3ee', at: [960, 640], scale: keys([[0.6, [0, 1]], [1.4, [1, 1], 'outCubic']]) }));
  c.add(motion.particlePresets.fireflies({ seed: 3 }));
  // Add media: c.add(video('assets/clip.mp4', { trim: [0, 3] }).filter(fx.grade({ exposure: 0.2 })));
});
`,
  photo: `import { still, photo, op, mask, fx } from 'tasweerix';

// Put a photo at assets/photo.jpg, then: tasweerix still index.ts -o out/edited.jpg
export default still({ width: 1600, height: 1067 }, (c) => {
  c.add(
    photo('assets/photo.jpg', [
      op.autoWhiteBalance(),
      op.autoLevels({ clip: 0.005 }),
      op.adjust({ shadows: 0.3, vibrance: 0.2 }),
      op.adjust({ exposure: -0.3 }, { mask: mask.linear([800, 0], [800, 500]) }),
      op.sharpen({ amount: 0.4 }),
    ], { size: [1600, 1067], fit: 'cover' }),
  ).filter(fx.vignette({ amount: 0.3 }));
});
`,
  audio: `import { soundscape, sfx, tone, sequenceSynth, afx } from 'tasweerix';

// tasweerix audio index.ts -o out/mix.mp3
export default soundscape({ duration: 8 }, (c) => {
  for (let b = 0; b < 16; b++) c.audio(sfx('kick', { start: b * 0.5 }));
  c.audio(sequenceSynth([0, 3, 7, 10].map((n, i) => ({ note: 57 + n, start: i * 2, duration: 1.8 })), { wave: 'saw' }).effect(afx.lowpass(1200), afx.reverb({ mix: 0.25 })));
  c.audio(tone({ freq: 'A5', duration: 0.3, start: 7.5 }));
  c.master(afx.compressor({ threshold: -16 }), afx.limiter({ ceiling: -1 }));
});
`,
  motion: `import { composition, motion, text, textFx } from 'tasweerix';

export default composition({ width: 1080, height: 1080, fps: 30, duration: 6, background: '#0f172a' }, (c) => {
  c.add(motion.titleCard('Motion', { kicker: 'Tasweerix', at: [540, 360] }));
  c.add(motion.barChart([{ label: 'Q1', value: 12 }, { label: 'Q2', value: 19 }, { label: 'Q3', value: 27 }], { size: [700, 320], at: [540, 760], animateIn: { start: 1 } }));
  c.add(text('code-first motion graphics', { at: [540, 1000], size: 36, fill: '#94a3b8' }).glyphs(textFx.wipe({ by: 'word', start: 2 })));
});
`,
  arabic: `import { composition, text, textFx, kashidaText, keys } from 'tasweerix';

// Use any Arabic TTF/OTF font file (e.g. assets/Cairo-Bold.ttf). Glyphs animate in reading order.
export default composition({ width: 1920, height: 1080, fps: 30, duration: 5, background: '#111827' }, (c) => {
  c.add(text('مرحبا بالعالم', { font: 'assets/font.ttf', size: 160, fill: '#fff' }).glyphs(textFx.dropIn({ stagger: 0.06 })));
  c.add(text(kashidaText('جميل', keys([[1, 0], [2.5, 4]])), { font: 'assets/font.ttf', size: 110, fill: '#facc15', at: [960, 760] }));
});
`,
};

export function scaffold(dir: string, template: string): string[] {
  const body = TEMPLATES[template];
  if (!body) throw new Error(`Unknown template "${template}" (choose: ${Object.keys(TEMPLATES).join(', ')})`);
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} is not empty`);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  const name = basename(dir);
  const files: Record<string, string> = {
    'index.ts': body,
    'package.json': JSON.stringify({ name, private: true, type: 'module', scripts: { studio: 'tasweerix studio .', render: 'tasweerix render index.ts -o out/video.mp4' }, dependencies: { tasweerix: '*' } }, null, 2) + '\n',
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, lib: ['ES2022', 'DOM'], skipLibCheck: true, noEmit: true } }, null, 2) + '\n',
    '.gitignore': 'node_modules/\nout/\n.tasweerix/\n',
    'assets/.gitkeep': '',
  };
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  return Object.keys(files);
}
