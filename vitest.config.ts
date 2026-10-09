import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    exclude: ['**/*.browser.test.ts', '**/node_modules/**'],
    testTimeout: 60_000,
  },
});
