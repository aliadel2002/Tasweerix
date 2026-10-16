import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle';

const dir = join(__dirname, '.tmp-bundle');

beforeAll(() => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Emscripten-style CommonJS (like HarfBuzz) that calls require() and reads __dirname.
  writeFileSync(join(dir, 'legacy.cjs'), `module.exports = { read: typeof require('fs').readFileSync, dir: __dirname };`);
  // A project importing the same names the ESM shims use.
  writeFileSync(
    join(dir, 'entry.ts'),
    `import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import legacy from './legacy.cjs';
export const here = dirname(fileURLToPath(import.meta.url));
export const req = typeof createRequire(import.meta.url);
console.log(JSON.stringify({ here: typeof here, req, legacy }));`,
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('Node bundle', () => {
  it('lets bundled CommonJS use require/__dirname without clashing with project imports', async () => {
    const { code } = await bundle({ entry: join(dir, 'entry.ts'), platform: 'node' });
    writeFileSync(join(dir, 'out.mjs'), code);
    // A separate process: the test runner's own globals could stand in for a missing shim.
    const out = execFileSync(process.execPath, [join(dir, 'out.mjs')]).toString();
    expect(JSON.parse(out)).toEqual({ here: 'string', req: 'function', legacy: { read: 'function', dir } });
  });
});
