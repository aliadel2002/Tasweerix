// A synthesized drum loop + bassline. Render it with:
//   tasweerix audio examples/beat-viz/beat.ts -o examples/beat-viz/assets/beat.mp3
import { soundscape, sfx, sequenceSynth, afx } from 'tasweerix';

export default soundscape({ sampleRate: 48000, duration: 8 }, (c) => {
  for (let b = 0; b < 16; b++) {
    c.audio(sfx('kick', { start: b * 0.5 }));
    c.audio(sfx('hat', { start: b * 0.5 + 0.25, gain: -6 }));
    if (b % 2 === 1) c.audio(sfx('snare', { start: b * 0.5, gain: -3 }));
  }
  const bass = ['E2', 'E2', 'G2', 'A2', 'E2', 'E2', 'D2', 'B1'];
  c.audio(
    sequenceSynth(
      Array.from({ length: 16 }, (_, i) => ({ note: bass[i % 8]!, start: i * 0.5, duration: 0.4 })),
      { wave: 'saw', envelope: { attack: 0.005, decay: 0.2, sustain: 0.4, release: 0.1 }, gain: 0.25 },
    ).effect(afx.lowpass(900, 1.2)),
  );
  c.master(afx.compressor({ threshold: -14, ratio: 3 }), afx.limiter({ ceiling: -1 }));
});
