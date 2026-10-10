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
    commands: { /* reserved for future studio and CLI commands (e.g. AI assistants) */ },
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
| `exporters`, `commands` | Hooks for tooling (timeline formats, studio and CLI commands) |

Lower-level registries are exported too: `registerDrawer`, `registerFilter`, `registerTransition`,
`registerTextEngine`, `registerAudioEffect`, `registerGenerator`, `registerPhotoOp` and `registerEasing`.
