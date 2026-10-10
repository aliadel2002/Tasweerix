import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// The Claude Code plugin's skills teach the API through complete example files. They must keep
// compiling as the API changes, or Claude would learn calls that no longer exist.
const repo = resolve(__dirname, '../../..');
const skills = join(repo, 'claude-plugin', 'skills');
const dir = join(__dirname, '.tmp-snippets');

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('Claude Code plugin skills', () => {
  it('have complete example files that typecheck against the current API', () => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    for (const skill of readdirSync(skills)) {
      const md = readFileSync(join(skills, skill, 'SKILL.md'), 'utf8');
      expect(md).toMatch(new RegExp(`^---\\nname: ${skill}\\ndescription: .+\\n---\\n`));
      [...md.matchAll(/```ts\n([\s\S]*?)```/g)]
        .map((m) => m[1]!)
        .filter((code) => code.includes("from 'tasweerix'") && code.includes('export default'))
        .forEach((code, i) => {
          const name = `${skill}-${i}.ts`;
          writeFileSync(join(dir, name), code);
          files.push(name);
        });
    }
    expect(files.length).toBeGreaterThanOrEqual(7);
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ extends: '../../../../tsconfig.base.json', compilerOptions: { noEmit: true, paths: { tasweerix: ['../../../tasweerix/src/index.ts'] } }, include: ['*.ts', '../../../type/src/wasm.d.ts'] }),
    );
    const tsc = join(repo, 'node_modules', 'typescript', 'bin', 'tsc');
    try {
      execFileSync(process.execPath, [tsc, '-p', dir], { stdio: 'pipe' });
    } catch (e) {
      throw new Error(`Skill examples fail to typecheck:\n${String((e as { stdout?: Buffer }).stdout ?? e)}`);
    }
  }, 180_000);
});
