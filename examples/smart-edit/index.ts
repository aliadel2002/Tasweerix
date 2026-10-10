// Smart editing inside a build function: jump-cut a talk by removing pauses, duck the music under
// the voice, and cut a B-roll montage on the beat. Analysis results are cached in .tasweerix/cache.
//   tasweerix render examples/smart-edit/index.ts -o out/smart.mp4
import { composition, smart, audio, text, textFx, transition, sequence, video, fx } from 'tasweerix';

export default composition({ width: 1280, height: 720, fps: 30, background: '#000' }, async (c) => {
  // 1. Remove pauses longer than 0.6s (the cut list is plain data — print it with `tasweerix cuts`).
  const talk = await smart.autoCut('assets/talk.mp4', { minSilence: 0.6, padding: 0.1, size: [1280, 720], fit: 'cover' });
  // The talk's own audio plays through a "voice" bus so the music can duck under it.
  talk.walk((n) => void (n.kind === 'video' && (n.meta.audioBus = 'voice')));

  // 2. B-roll montage cut on every other beat of the music.
  const grid = await smart.beatGrid('assets/beat.mp3', { every: 2 });
  const broll = [0, 3, 6, 1, 5].map((t) =>
    video('assets/talk.mp4', { trim: [t, t + 2], muted: true, size: [1280, 720], fit: 'cover' }).filter(fx.grade({ saturation: -0.6, contrast: 0.2 })),
  );
  smart.snapToBeats(broll, grid, { beatsPerItem: 1 });
  const montage = transition.sequence(broll, { type: 'flash', duration: 0.15 });

  c.add(sequence([talk, montage]));
  c.add(text('Auto-edited by code', { at: [640, 640], size: 40, weight: 800, fill: '#fff' }).glyphs(textFx.fadeUp({ by: 'word', stagger: 0.1 })));

  // 3. Looping music bed, ducked under the voice.
  c.audio(audio('assets/beat.mp3', { loop: true, gain: -6 })).duck('voice', { amount: -16 }).fadeOut(1);
});
