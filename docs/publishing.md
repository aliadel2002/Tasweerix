# Publishing Tasweerix packages

All 16 `packages/*` (the `tasweerix` umbrella and the `@tasweerix/*` packages) publish to npm. This doc covers how the
build works and the release workflow.

## How it works

- **Development uses sources, published packages use `dist/`.** In the repo, `main`, `types`, `exports` and `bin` point
  at TypeScript sources, so `pnpm typecheck`, `pnpm test`, `pnpm examples` and `pnpm tasweerix` need no build step and
  never run a stale build. Each package's `publishConfig` swaps those fields for `dist/` when `pnpm pack` or
  `pnpm publish` writes the tarball. That override is a pnpm feature: always publish with pnpm, never `npm publish`.
- **ESM only.** Every package is `"type": "module"` and builds with [tsup](https://tsup.egoist.dev) to ESM plus `.d.ts`
  (`pnpm build` from the root, or `pnpm --filter <pkg> build`). Code relies on `import.meta.url`, which CommonJS lacks.
- `files` keeps tarballs to `dist/` (plus the extras below), `publishConfig.access` is `public` because scoped packages
  default to restricted, and `prepublishOnly` rebuilds so a publish never ships a stale `dist/`.
- `workspace:*` dependencies are rewritten to real versions at publish time.

## Special cases

- **`@tasweerix/type` keeps HarfBuzz external.** `harfbuzzjs` stays a dependency and the `#hbwasm` import stays in
  `dist/`. The published `imports` map points it at `dist/wasm-static.js` for bundles (the CLI's `tasweerix-bundle`
  condition and browsers, where esbuild inlines the wasm) and at `dist/wasm-node.js` in plain Node (reads the wasm from
  `harfbuzzjs` on disk).
- **`@tasweerix/cli`** publishes `bin` as `dist/main.js` and ships `src/runtime/` (the export and preview page runtimes
  it bundles with each user project) and `dist/studio/` (the studio UI, prebuilt from `apps/studio`).
- **`@tasweerix/ai`** ships a copy of `docs/*.md` (made by its build) because the assistant sends the API docs as
  context.
- **The native plugin host is not published.** `native/plugin-host` is platform-specific and opt-in
  (`pnpm build:plugin-host`); users point `TASWEERIX_PLUGIN_HOST` at their own binary.

## Releasing

1. `pnpm changeset` to describe the change (patch, minor or major per package).
2. `pnpm version-packages` to apply the version bumps and changelogs; review, commit and merge.
3. `pnpm -r publish` from the root publishes every package whose new version isn't on npm yet.

## Checking before a release

`bash scripts/check-packed.sh` (also run in CI) builds and packs every package, installs the tarballs into a fresh
project outside the monorepo, imports every published entry point, renders a still, an SVG with HarfBuzz text and an
audio mix with the installed CLI, and starts the studio.
