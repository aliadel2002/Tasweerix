// AI inside a build: Claude looks at the footage and writes the title, speech becomes word-timed
// captions translated to Arabic, and chapters become markers. Every answer is cached in
// .tasweerix/cache, so re-renders, parallel export workers and the studio all see the same result.
//
// Needs credentials on the machine that runs the CLI or studio (never in the browser):
//   - Claude: ANTHROPIC_API_KEY, or `ant auth login`
//   - Speech: whisper.cpp (`whisper-cli`) with TASWEERIX_WHISPER_MODEL=/path/to/ggml-model.bin,
//     or any provider registered in tasweerix.config.ts
//   tasweerix render examples/ai/index.ts --root . -o out/ai.mp4
import { ai, composition, text, textFx, video } from 'tasweerix';

const TALK = 'examples/smart-edit/assets/talk.mp4';

export default composition({ width: 1280, height: 720, fps: 30, background: '#000' }, async (c) => {
  c.add(video(TALK, { size: [1280, 720], fit: 'cover' }));

  // Vision: a title written from a frame of the clip (one short line, cached).
  const title = await ai.generate('Write a title of at most four words for this video. Reply with the title only.', { images: [{ src: TALK, time: 1 }], effort: 'low' });
  c.add(text(title.trim(), { size: 72, weight: 800, fill: '#fff', at: [640, 120], duration: 3 }).glyphs(textFx.fadeUp({ by: 'word', stagger: 0.08 })));

  // Speech: captions from the voice, translated to Arabic (timings kept).
  c.add(await ai.captions(TALK, { translateTo: 'Arabic', style: { font: 'assets/fonts/Cairo-Bold.ttf', size: 46, at: [640, 670] } }));

  // Chapters from the transcript become composition markers (visible on the studio timeline).
  await ai.chapters(TALK, { max: 4 });
});
