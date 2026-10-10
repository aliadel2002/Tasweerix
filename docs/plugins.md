# Plugins

Plugins extend every layer from one object:

```ts
import { definePlugin, usePlugin } from 'tasweerix';

usePlugin(
  definePlugin({
    name: 'my-studio-kit',
    easings: { anticipate: (t) => (t < 0.2 ? -t * 0.5 : ((t - 0.2) / 0.8) * 1.1 - 0.1) },
    drawers: {
      // A custom node kind: create nodes with new SceneNode('heart', props) and draw them here.
      heart: (d) => { /* d.ctx, d.props, d.frame */ },
    },
    filters: {
      invertRed: { apply: (input, params, fc) => fc.gl.run(`${GLSL_PRELUDE} void main(){ vec4 c = texture(uTex, vUv); outColor = vec4(1.0 - c.r, c.gb, c.a); }`, { uTex: input }) },
    },
    transitions: { split: { frag: '…GLSL using getFrom/getTo/uProgress…' } },
    audioEffects: { telephone: (sr, ch) => /* AudioProcessor */ ({ process(chs, off, n, p) { /* … */ } }) },
    generators: { drone: (params, sr, len) => [new Float32Array(len)] },
    interpolators: [{ name: 'my-type', test: (a, b) => /* … */ false, mix: (a, b, t) => a }],
    importers: { csv: { label: 'CSV cut list', extensions: ['csv'], read: (text) => /* TimelineModel */ model } },
    exporters: { csv: { label: 'CSV cut list', extensions: ['csv'], write: (model) => '…' } },
    analyses: { 'my.loudest-frame': async (file, params, ctx) => ({ time: 3.2 }) },   // Env.analyze kinds (Node)
    aiProviders: { local: { generate: async ({ prompt }) => ({ text: '…' }) } },    // see AI features
    commands: {
      hello: {
        description: 'Say hello',
        args: ['<name>'],
        options: [{ flags: '--shout', description: 'uppercase' }],
        studio: { label: 'Hello', prompt: 'Who?' },                                   // optional studio action
        async run(ctx) {
          const msg = `hello ${ctx.args[0]}`;
          await ctx.writeFile('hello.txt', ctx.options.shout ? msg.toUpperCase() : msg);
          ctx.log('done');
        },
      },
    },
  }),
);
```

| Section | Registered into |
| --- | --- |
| `easings` | Anywhere an easing name is accepted |
| `drawers` | Renderer node kinds (with optional `{ draw, options: { prepare, collect, drawsChildren } }`) |
| `filters`, `transitions` | The WebGL filter and transition registries (`fx.custom(kind)`, `transition.sequence(..., kind)`) |
| `audioEffects`, `generators` | The audio engine (`afx.custom(kind)`, `generator(kind, params)`) |
| `interpolators` | Value interpolation for keyframes |
| `exporters`, `importers` | Timeline formats for `export-timeline`, `import-timeline` and `importTimeline()` |
| `analyses` | Host analyses served through `Env.analyze` (Node: CLI, studio and render server) |
| `aiProviders` | Generation and speech-to-text backends for the AI features |
| `commands` | CLI subcommands (`tasweerix <name>`) and, with `studio`, actions in the studio's command bar |

Lower-level registries are exported too: `registerDrawer`, `registerFilter`, `registerTransition`,
`registerTextEngine`, `registerAudioEffect`, `registerGenerator`, `registerPhotoOp`, `registerEasing`
and `registerModelLoader` from `tasweerix`; `registerTimelineFormat` from `@tasweerix/interchange`;
`registerHostAnalysis` from `@tasweerix/media/node`; `registerAiProvider` from `@tasweerix/ai/node`.

## Plugins for the CLI and studio

Plugins used inside a composition (drawers, filters, transitions, easings …) are registered by the
project code itself. Plugins that act on the **host** — commands, host analyses, AI providers, timeline
formats for the CLI — go in a `tasweerix.config.ts` next to your project (or any parent folder):

```ts
import { definePlugin } from 'tasweerix';
import myPlugin from './plugins/my-plugin';

export default { plugins: [myPlugin, definePlugin({ name: 'inline', commands: { /* … */ } })] };
```

The CLI and the studio load it at startup. Commands receive a context with `args`, `options`, `cwd`,
`log`, `readFile`, `writeFile` (undoable in the studio) and `render` (the export pipeline). The
built-in `import-timeline`, `stabilize`, `track`, `ai` and `transcribe` commands are plugins too.
