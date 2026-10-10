import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/main.ts'],
  format: ['esm'],
  dts: { entry: 'src/server.ts' },
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
});
