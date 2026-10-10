#!/usr/bin/env node
// Tasweerix CLI launcher.
//
// Prefers the built output (dist/main.js) when present — this is the path used
// by the published npm package. Falls back to running the TypeScript sources
// directly through tsx, so monorepo development still needs no build step.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

if (existsSync(join(root, 'dist', 'main.js'))) {
  await import('../dist/main.js');
} else {
  const { register } = await import('tsx/esm/api');
  register();
  await import('../src/main.ts');
}
