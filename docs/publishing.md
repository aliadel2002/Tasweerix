# Publishing Tasweerix packages

All 15 `packages/*` are publishable to npm as-is. This doc covers the release workflow.

## How the build works

- Each package builds with [tsup](https://tsup.egoist.dev) (ESM + CJS + `.d.ts` into `dist/`).
  Run `pnpm -r build` from the repo root, or `pnpm --filter <pkg> build` for one package.
- `package.json` `exports` point at `dist/`; `files: ["dist"]` keeps tarballs lean;
  `publishConfig.access: "public"` is set because the `@tasweerix/*` scope defaults
  to restricted on npm.
- Cross-package deps use the `workspace:*` protocol — pnpm rewrites them to real
  version numbers at publish time, so intra-monorepo versions always stay in sync.
- `prepublishOnly` runs the build automatically, so `pnpm publish` never ships
  a stale `dist/`.

## Special cases

- **Dev still needs no build step.** `tsconfig.base.json` `paths` map `@tasweerix/*`
  to TypeScript sources, and `vitest.config.ts` uses `vite-tsconfig-paths`, so
  `pnpm typecheck`, `pnpm test` and `pnpm tasweerix` all run from source.
  The CLI launcher (`packages/cli/bin/tasweerix.mjs`) uses `dist/` when it exists
  and falls back to `tsx` on sources otherwise.
- **`@tasweerix/type` inlines HarfBuzz.** Its `tsup.config.ts` resolves the
  package's own `#hbwasm` import to the static variant and bundles `harfbuzzjs`
  (JS glue + `.wasm` bytes) into `dist`, so the published output is fully
  self-contained and still works when the CLI re-bundles it for user projects.
  The `imports` field in its `package.json` intentionally still points at `src/`
  — it is only consulted during monorepo development; nothing in `dist/`
  references `#hbwasm`.
- **Native `plugin-host` is not published.** The VST3/CLAP/LV2 host in
  `native/plugin-host` is platform-specific and opt-in (built via
  `pnpm build:plugin-host`); consumers point `TASWEERIX_PLUGIN_HOST` (or the
  plugin config) at their own binary. It is deliberately excluded from `files`.

## Releasing

1. `pnpm changeset` — describe the change (patch/minor/major per package).
2. `pnpm version-packages` — applies version bumps and updates the changelog.
3. Review the diff, commit, push, merge.
4. For each changed package: `cd packages/<pkg> && pnpm publish`.
   (First publish of a scoped package needs `--access public`; `publishConfig`
   already sets this.)

## Verifying a package before publishing

```sh
cd packages/<pkg>
pnpm run build
npm pack --dry-run   # inspect tarball contents: should be dist/ + package.json only
```

`pnpm typecheck` must be green. The full `pnpm test` suite has pre-existing
environmental failures (headless-Chromium and ffmpeg-dependent tests) in
environments without those binaries — those are unrelated to packaging.
