# Audio

The audio engine is pure TypeScript. The studio's preview and the export produce the **same samples**.
Audio comes from three places: `c.audio(...)` clips, the soundtrack of video nodes, and synthesized
generators.

```ts
const music = c.audio(audio('assets/track.mp3', { start: 1, trim: [10], gain: -6, loop: true }).fadeIn(2).fadeOut(3, 's-curve'));
const voice = c.audio(audio('assets/vo.wav', { start: 2, bus: 'voice' }));
music.duck('voice', { amount: -14 });                   // sidechain ducking under the voice bus
c.bus('voice', { effects: [afx.highpass(80), afx.compressor({ threshold: -20, ratio: 3 })] });
c.master(afx.normalize({ lufs: -14 }), afx.limiter({ ceiling: -1 }));
```

## Clip controls

Clips support `start`, `trim: [in, out]`, `duration`, `speed` (varispeed, or time-stretch with
`preservePitch`), `pitch` (semitones), `reverse`, `loop`, `gain` (dB, animatable), `volume` (linear,
animatable), `pan` (animatable), fades with curves (`linear`, `equal-power`, `exponential`,
`logarithmic`, `s-curve`), an effect chain, and the bus to route to.

## Effects (`afx`)

| Group | Effects |
| --- | --- |
| Filters | `lowpass`, `highpass`, `bandpass`, `notch` (with 12–48 dB/oct slopes), `eq(bands)` (peaking, shelves …) |
| Dynamics | `compressor` (peak/RMS, knee, makeup, sidechain), `limiter` (lookahead), `gate`, `deesser`, `duck(under)` |
| Space and modulation | `reverb` (algorithmic), `convolver` (impulse response or synthetic), `delay` (ping-pong, damping), `chorus`, `flanger`, `phaser`, `stereo` (pan and width) |
| Color | `distortion` (soft, hard, fold, tube), `bitcrush`, `gain` |
| Offline | `normalize` (peak or LUFS), `denoise` (spectral gating), `stretch` |

Every parameter is animatable, for example `afx.lowpass(keys([[0, 200], [4, 18000]]))` for a filter sweep.
Each effect also takes a `mix`.

## Synthesis

`tone({ freq: 'A4', to: 'A5', duration: 1, wave: 'saw' })`, `sequenceSynth(notes, { wave, envelope })`
and `sfx('whoosh' | 'riser' | 'impact' | 'kick' | 'snare' | 'hat' | 'click' | 'pop' | 'ding')` produce
procedural clips. These are useful for motion-graphics sound design and need no assets.

## Analysis and audio-reactive visuals

```ts
const music = c.audio('assets/track.mp3');
const a = analyze(music);                         // loads and analyzes before the first frame
rect({ scale: (f) => 1 + a.beat(f) * 0.3 });      // beat pulse
rect({ opacity: (f) => a.level(f) });             // loudness
motion.spectrumBars(a, { bars: 64 });             // spectrum
a.bpm; a.beats; a.transients; a.waveform(800);
```

Standalone functions include `integratedLoudness`, `loudnessCurve`, `truePeakDb`, `detectBeats`,
`detectOnsets`, `detectSilence`, `waveformPeaks` and `spectrumBands`.

## CLI

```sh
tasweerix audio mix.ts -o out/mix.mp3 --stems     # also writes one file per bus and clip
tasweerix analyze music.mp3                       # LUFS, true peak, BPM, beats, silences
```
