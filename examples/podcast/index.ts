// Podcast mix in code: remove long pauses from the recording, clean the voice (high-pass, EQ,
// de-esser, compressor), duck the music bed under it, add an intro sting, and master to -16 LUFS.
//   tasweerix audio examples/podcast/index.ts -o out/podcast.mp3
import { soundscape, audio, afx, smart, sequenceSynth, sfx } from 'tasweerix';

export default soundscape({ name: 'Episode 1', sampleRate: 48000 }, async (c) => {
  // Intro sting (synth chord + hit).
  c.audio(sequenceSynth([{ note: 'C4', start: 0, duration: 1.4 }, { note: 'E4', start: 0, duration: 1.4 }, { note: 'G4', start: 0, duration: 1.4 }], { wave: 'saw', gain: 0.18 }).effect(afx.lowpass(2400), afx.reverb({ mix: 0.3 })));
  c.audio(sfx('ding', { start: 0.1, gain: -10 }));

  // Voice: jump-cut the pauses, then lay the kept segments back to back after the intro.
  const cuts = await smart.silenceCuts('assets/interview.m4a', { minSilence: 0.5, padding: 0.12 });
  let t = 1.6;
  for (const cut of cuts) {
    c.audio(
      audio('assets/interview.m4a', { trim: [cut.in, cut.out], start: t, bus: 'voice' }).fadeIn(0.02).fadeOut(0.03),
    );
    t += cut.out - cut.in;
  }
  c.bus('voice', {
    effects: [
      afx.highpass(80),
      afx.eq([{ type: 'lowshelf', frequency: 200, gain: -2 }, { frequency: 3200, gain: 3, q: 0.9 }]),
      afx.deesser({ threshold: -28 }),
      afx.compressor({ threshold: -20, ratio: 3, attack: 0.005, release: 0.12, makeup: 4 }),
    ],
  });

  // Music bed under the whole episode, ducked by the voice bus.
  c.audio(audio('assets/bed.mp3', { loop: true, gain: -10 }).lasting(t + 1).duck('voice', { amount: -14 }).fadeOut(1.5));

  // Master: loudness-normalize and limit.
  c.master(afx.normalize({ lufs: -16 }), afx.limiter({ ceiling: -1 }));
});
