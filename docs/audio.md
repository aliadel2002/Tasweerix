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

## Third-party plugins

`afx.plugin()` runs VST3, CLAP, AU, LV2 and LADSPA plugins in clip and bus chains. Plugins run out of
process when you render from Node (`tasweerix audio`, `tasweerix render`). The studio preview bypasses them.

```ts
c.bus('voice', { effects: [afx.plugin('http://plugin.org.uk/swh-plugins/amp', { params: { gain: -6 } })] });
music.effect(afx.plugin('/usr/lib/ladspa/delay.so', { params: { c0: 0.25, c1: 0.4 } }));
music.effect(afx.plugin('Valhalla Supermassive', { params: { Mix: 0.3 }, tail: 8 }));   // found by name
```

The first argument is a path to the bundle or library, an LV2 URI, a plugin name found by the scanner, or
`{ format, path, uri, id }`. Use `id` to pick one plugin from a file that holds several, such as a LADSPA label.
`params` are set by LV2 symbol, LADSPA control (`c0`, `c1` …) or VST3/CLAP parameter. Plugins process the
whole clip at once, so an animated value is read once, at the start. `tail` adds seconds for reverbs and delays
to ring out. `state` passes a preset or state file to the host.

| Format | Hosted by |
| --- | --- |
| LV2, LADSPA | ffmpeg's `lv2` and `ladspa` filters, when ffmpeg was built with them (most Linux builds) |
| VST3, CLAP, AU | an external host executable set with `TASWEERIX_PLUGIN_HOST`, `usePluginHost()` from `@tasweerix/audio/node`, or the effect's `host` option |

`tasweerix audio-plugins` lists the installed plugins in the standard folders for each OS, and shows which
formats can be hosted right now. In code, use `scanPlugins()` and `hostableFormats()` from
`@tasweerix/audio/node`. The `VST3_PATH`, `CLAP_PATH` and `AU_PATH` variables add folders.
`LV2_PATH` and `LADSPA_PATH` replace the defaults.

### Plugin host protocol

A host is any executable that speaks this protocol (version 1) over stdio:

- **`<host> capabilities`** prints `{"protocol":1,"formats":["vst3","clap"]}`.
- **`<host> process`** reads one JSON header line from stdin, then interleaved little-endian float32
  frames. The header is `{"protocol":1,"format","path","id","uri","name","sampleRate","channels","frames","params","state"}`.
  The host writes `{"protocol":1,"channels":C,"frames":N}` and a newline to stdout, then the processed
  frames. It returns as many frames as it received, already compensated for plugin latency. A non-zero exit
  status fails the render and shows stderr.

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
