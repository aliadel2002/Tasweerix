import { mkdirSync, writeFileSync } from 'node:fs';
import { defineConfig } from 'tsup';
import { buildStudioApp } from './src/studio-app';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  // The published package has no apps/studio, so ship the studio UI prebuilt (see loadStudioApp).
  onSuccess: async () => {
    const { js, css } = await buildStudioApp('../../apps/studio');
    mkdirSync('dist/studio', { recursive: true });
    writeFileSync('dist/studio/studio.js', js);
    writeFileSync('dist/studio/studio.css', css);
  },
});
