import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/node.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  // The assistant sends the API docs as context; ship a copy since the repo's docs/ isn't published.
  onSuccess: async () => {
    rmSync('docs', { recursive: true, force: true });
    mkdirSync('docs');
    for (const f of readdirSync('../../docs').filter((f) => f.endsWith('.md'))) copyFileSync(`../../docs/${f}`, `docs/${f}`);
  },
});
