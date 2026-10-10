import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  outDir: 'dist',
  clean: true,
  // Bundle harfbuzzjs (JS glue + .wasm) instead of leaving it external, so the
  // wasm binary loader below can inline it and dist is fully self-contained.
  noExternal: ['harfbuzzjs'],
  // Inline harfbuzzjs/hb.wasm as bytes (mirrors the esbuild 'binary' loader
  // the CLI bundler uses for the tasweerix-bundle condition).
  loader: { '.wasm': 'binary' },
  esbuildOptions(options) {
    // Resolve the package's own `#hbwasm` import (see package.json "imports")
    // to the static variant so the wasm binary is inlined into dist.
    // Published dist must work when the CLI re-bundles it: that esbuild step
    // runs far from node_modules, so the disk-reading wasm-node variant would
    // fail there. Inlining keeps every consumer (Node, browser, CLI bundles)
    // working identically.
    options.conditions = ['tasweerix-bundle', ...(options.conditions ?? [])];
  },
});
