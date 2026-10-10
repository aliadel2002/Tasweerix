import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/wasm-static.ts', 'src/wasm-node.ts'],
  format: ['esm'],
  // The wasm variants are internal (reached only through #hbwasm), so only the entry needs types.
  dts: { entry: 'src/index.ts' },
  clean: true,
  // Keep the `#hbwasm` import in dist so the published package's "imports" map (see publishConfig)
  // still picks the variant per consumer: inlined wasm for CLI/browser bundles, read from disk in Node.
  external: ['#hbwasm'],
});
