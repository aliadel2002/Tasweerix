# Smart editing

The smart helpers analyze media and return **plain data** (cut lists, beat times, gains). You keep full
control, and every result can be printed as code.

```ts
export default composition({ width: 1920, height: 1080, fps: 30 }, async (c) => {
  const talk = await smart.autoCut('talk.mp4', { minSilence: 0.6, padding: 0.1 });   // jump cuts
  const grid = await smart.beatGrid('music.mp3', { every: 2 });                      // every other beat
  const broll = clips.map((src) => video(src, { trim: [0, 4] }));
  smart.snapToBeats(broll, grid, { beatsPerItem: 1 });                               // cut on the beat
  c.add(sequence([talk, transition.sequence(broll, 'flash')]));
  const vo = [c.audio('vo1.wav'), c.audio('vo2.wav', { start: 12 })];
  await smart.matchLoudness(vo, -16);                                                // even levels
  smart.autoDuck(c.audio(audio('music.mp3', { loop: true })), vo, { amount: -14 });
});
```

| Helper | Result |
| --- | --- |
| `silences(src, opts)`, `silenceCuts(src, opts)`, `autoCut(src, opts)` | Silent ranges, the cut list that keeps speech, and a ready sequence |
| `cutsToSequence(src, cuts)`, `cutsToCode(src, cuts)` | Nodes from a cut list, or paste-able TypeScript |
| `beats(src)`, `onsets(src)`, `beatGrid(src, { every, offset })` | Tempo, beats and transients |
| `snapToBeats(items, beats, { beatsPerItem })`, `beatMontage(music, clips)` | Beat-synced edits |
| `scenes(src, { threshold })`, `shots(src)` | Scene changes (ffmpeg scene score) and the shot list |
| `loudness(src)`, `matchLoudness(clips, lufs)`, `loudnessFollow(src, { target })` | Gain matching and leveling automation (keyframes) |
| `autoDuck(music, voices)` | Routes voices to a bus and ducks the music under it |

Analyses are cached in `.tasweerix/cache` and invalidated when the source file changes. The same cache
serves the studio, export workers and CLI.

```sh
tasweerix cuts talk.mp4 --mode silence --min-silence 0.5    # prints sequence([...]) code
tasweerix cuts film.mp4 --mode shots --json
tasweerix cuts song.mp3 --mode beats
```
