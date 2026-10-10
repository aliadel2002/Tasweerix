# AI features

`@tasweerix/ai` brings language, vision and speech models into projects, the CLI and the studio:

```ts
export default composition({ width: 1920, height: 1080, fps: 30 }, async (c) => {
  c.add(video('interview.mp4'));
  const title = await ai.generate('A four-word title for this interview', { images: [{ src: 'interview.mp4', time: 4 }] });
  c.add(text(title, { size: 96, weight: 800, at: [960, 140] }));
  c.add(await ai.captions('interview.mp4', { language: 'en', translateTo: 'Arabic', style: { font: 'assets/fonts/Cairo-Bold.ttf' } }));
  await ai.chapters('interview.mp4');                                            // → markers
  const cuts = await ai.textCuts('interview.mp4', 'Only the answers about pricing');
  c.add(smart.cutsToSequence('interview.mp4', cuts));
});
```

## How it runs

- Model calls happen on the **host** (the CLI, the studio or render server), through the same
  `Env.analyze` channel as other analyses. Credentials never reach the browser preview or export pages.
- Every answer is **cached** on disk by its inputs. Re-renders, parallel export workers and the studio
  get the same text, so renders stay deterministic. Change `variant` to ask again.
- Images and video frames are extracted with FFmpeg and scaled to 1568 px before they are sent.

## API

| Call | Result |
| --- | --- |
| `ai.generate(prompt, { system, images, effort, maxTokens, model, variant })` | Text |
| `ai.generateJSON(prompt, schema, opts)` | JSON matching a JSON Schema (structured output) |
| `ai.describe(src, { time, prompt })` | A description of an image or video frame |
| `ai.transcribe(src, { language, prompt, from, to })` | `{ language, segments: [{ start, end, text, words? }] }` in source time |
| `ai.captions(src, { language, translateTo, start, trimIn, style, maxChars })` | A captions group (karaoke `highlight` works when words are timed) |
| `ai.transcriptToCues(t, { maxChars, maxDuration, offset })`, `ai.translateCues(cues, lang)` | Caption cues |
| `ai.textCuts(src, instruction, { padding })` | A cut list (`{ in, out }[]`) chosen from the transcript |
| `ai.chapters(src, { max })` | `[{ time, label }]`, also added as composition markers |

## Providers

| Capability | Built in | Configuration |
| --- | --- | --- |
| Text, JSON, vision | Claude via the Anthropic API (`claude-opus-5-5`) | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or an `ant auth login` profile; `TASWEERIX_AI_MODEL` to choose another model |
| Speech to text | whisper.cpp (`whisper-cli`, local) | `TASWEERIX_WHISPER_MODEL=/path/to/ggml-model.bin`, `TASWEERIX_WHISPER_BIN` |

The Claude provider streams responses, uses adaptive thinking with an `effort` level (default
`medium`; the assistant uses `high`), returns JSON through structured outputs, caches the large
reference context, and opts into server-side refusal fallbacks.

Add or replace providers with a plugin in `tasweerix.config.ts` (see [Plugins](plugins.md)):

```ts
export default {
  plugins: [
    definePlugin({
      name: 'my-stt',
      aiProviders: {
        cloudStt: { async transcribe({ file, language }) { /* POST the 16 kHz WAV to your service */ return { segments: [] }; } },
      },
    }),
  ],
};
```

A plugin provider wins for the capabilities it has; `TASWEERIX_AI_PROVIDER` and
`TASWEERIX_STT_PROVIDER` pick one by name.

## The assistant

```sh
tasweerix ai "make the title gold and fade it in over a second"           # edits the entry file
tasweerix ai "add Arabic captions from the voiceover" -e scenes/intro.ts --dry-run   # shows a diff
tasweerix transcribe interview.mp4 --translate Arabic -o interview.ar.srt
```

The assistant reads the file, the project's file list and the Tasweerix docs, and returns the whole
new file. It keeps your formatting and writes literal values so the studio can keep editing them. In
the studio the same command is the **Assistant** bar above the code editor; its edits join the
undo history (⌘Z).
