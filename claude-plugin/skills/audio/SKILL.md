---
name: audio
description: Tasweerix audio - clips, fades, buses, sidechain ducking, afx effects (EQ, compressor, limiter, de-esser, reverb, delay, denoise, loudness normalize), VST3/CLAP/LV2/LADSPA plugins, synthesis and SFX, audio analysis and audio-reactive visuals. Use for soundtracks, podcasts, music beds and mixing in Tasweerix.
---

# Audio in Tasweerix

The audio engine is pure TypeScript and produces the same samples in the studio and in exports.
Sound comes from `c.audio(...)` clips, the soundtrack of `video()` nodes, and generators. For audio-only
projects use `soundscape(...)` and render with `render_audio` (or `tasweerix audio entry.ts -o mix.mp3`).

## Clips, buses and the master

```ts
const music = c.audio(audio('assets/track.mp3', { start: 1, trim: [10], gain: -6, loop: true }).fadeIn(2).fadeOut(3, 's-curve'));
const voice = c.audio(audio('assets/vo.wav', { start: 2, bus: 'voice' }));
music.duck('voice', { amount: -14 });                                   // sidechain ducking under the voice bus
c.bus('voice', { effects: [afx.highpass(80), afx.compressor({ threshold: -20, ratio: 3 })] });
c.master(afx.normalize({ lufs: -14 }), afx.limiter({ ceiling: -1 }));
```

Clip options: `start`, `trim: [in, out]`, `duration`, `speed` (with `preservePitch` for time-stretch),
`pitch` (semitones), `reverse`, `loop`, `gain` (dB), `volume` (linear), `pan`, `bus`. `gain`,
`volume` and `pan` are animatable. Fade curves: `linear`, `equal-power`, `exponential`,
`logarithmic`, `s-curve`. Add effects with `.effect(...afx)`.

## Effects (`afx`), every parameter animatable, each with `mix`

| Group | Effects |
| --- | --- |
| Filters | `lowpass`, `highpass`, `bandpass`, `notch`, `eq([{ type, frequency, gain, q }])` |
| Dynamics | `compressor`, `limiter`, `gate`, `deesser`, `duck` |
| Space | `reverb`, `convolver`, `delay`, `chorus`, `flanger`, `phaser`, `stereo` |
| Color | `distortion`, `bitcrush`, `gain` |
| Offline | `normalize({ lufs } \| { peak })`, `denoise`, `stretch` |

Loudness targets: about -14 LUFS for streaming music and video, -16 for podcasts, true peak at -1 dBTP.

## A podcast chain

```ts
import { soundscape, audio, afx, smart, sfx } from 'tasweerix';

export default soundscape({ name: 'Episode', sampleRate: 48000 }, async (c) => {
  c.audio(sfx('ding', { start: 0.1, gain: -10 }));
  const cuts = await smart.silenceCuts('assets/interview.m4a', { minSilence: 0.5, padding: 0.12 });
  let t = 1;
  for (const cut of cuts) {
    c.audio(audio('assets/interview.m4a', { trim: [cut.in, cut.out], start: t, bus: 'voice' }).fadeIn(0.02).fadeOut(0.03));
    t += cut.out - cut.in;
  }
  c.bus('voice', {
    effects: [afx.highpass(80), afx.deesser({ threshold: -28 }), afx.compressor({ threshold: -20, ratio: 3, attack: 0.005, release: 0.12, makeup: 4 })],
  });
  c.audio(audio('assets/bed.mp3', { loop: true, gain: -10 }).lasting(t + 1).duck('voice', { amount: -14 }).fadeOut(1.5));
  c.master(afx.normalize({ lufs: -16 }), afx.limiter({ ceiling: -1 }));
});
```

## Third-party plugins

`afx.plugin(ref, { params, tail, state })` runs VST3, CLAP, LV2 and LADSPA plugins when rendering
from Node (the studio preview bypasses them). `ref` is a path, an LV2 URI, or a plugin name. Use the
`list_audio_plugins` tool to see what's installed and hostable, and `describe` to get parameter ids
and ranges. Plugins process the whole clip, so animated params are read once.

## Synthesis

`tone({ freq: 'A4', to: 'A5', duration: 1, wave: 'saw' })`, `sequenceSynth(notes, { wave, gain })` and
`sfx('whoosh' | 'riser' | 'impact' | 'kick' | 'snare' | 'hat' | 'click' | 'pop' | 'ding', { start, gain })`
need no assets. Good for motion-graphics sound design: a whoosh 0.3 to 0.4 s before a transition,
an impact on a title hit.

## Analysis and audio-reactive visuals

```ts
const music = c.audio('assets/track.mp3');
const a = analyze(music);
rect({ scale: (f) => 1 + a.beat(f) * 0.3 });      // pulse on the beat
rect({ opacity: (f) => a.level(f) });             // follow loudness
c.add(motion.spectrumBars(a, { bars: 64 }));
```

`analyze_audio` (or `tasweerix analyze file`) reports LUFS, true peak, BPM, beats and silences of
any file, which helps place cuts and choose gains before writing code.
