import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const dir = join(__dirname, '.tmp-plugins');
const bin = join(__dirname, '../bin/tasweerix.mjs');
const cli = (args: string[], cwd = dir) => execFileSync(process.execPath, [bin, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const cliErr = (args: string[], cwd = dir) => {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd });
  return { code: r.status as number, out: String(r.stdout), err: String(r.stderr) };
};

beforeAll(() => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'footage'), { recursive: true });
  // A config plugin contributing a command that writes a file through the command context.
  writeFileSync(
    join(dir, 'tasweerix.config.ts'),
    `import { definePlugin } from 'tasweerix';
export default {
  plugins: [definePlugin({ name: 'greeter', commands: { greet: { description: 'Say hello', args: ['<who>'], options: [{ flags: '--shout', description: 'uppercase' }], async run(ctx) {
    const msg = 'hello ' + ctx.args[0];
    await ctx.writeFile('greeting.txt', ctx.options.shout ? msg.toUpperCase() : msg);
    ctx.log('greeted');
  } } } })],
};
`,
  );
  for (const f of ['a', 'b', 'c', 'd']) execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=64x36:r=24:d=30', join(dir, 'footage', `${f}.mov`)]);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=d=20', join(dir, 'footage', 'music.wav')]);
});

describe('plugin commands in the CLI', () => {
  it('runs commands from tasweerix.config.ts', () => {
    expect(cli(['--help'])).toContain('greet');
    cliErr(['greet', 'studio', '--shout']);
    expect(readFileSync(join(dir, 'greeting.txt'), 'utf8')).toBe('HELLO STUDIO');
  });

  it('imports a timeline as a project (built-in plugin command) that builds', () => {
    const r = cliErr(['import-timeline', join(__dirname, '../../interchange/test/fixtures/otio-adapter.otio'), '-o', 'imported', '--media', 'footage', '--copy-media']);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain('4 video clips');
    const code = readFileSync(join(dir, 'imported/index.ts'), 'utf8');
    expect(code).toContain("video('assets/a.mov', { start: 0, trim: [2, 6], muted: true, size: [1920, 1080] })");
    expect(existsSync(join(dir, 'imported/assets/music.wav'))).toBe(true);
    const json = JSON.parse(cli(['inspect', 'imported/index.ts']));
    expect(json.duration).toBe(15);
    expect(json.audio).toHaveLength(1);
  });

  it('exports every timeline format', () => {
    for (const f of ['fcpxml', 'otio', 'xmeml', 'edl']) {
      const r = cliErr(['export-timeline', 'imported/index.ts', '-f', f, '-o', `out/cut.${f}`]);
      expect(r.code, r.err).toBe(0);
      expect(existsSync(join(dir, `out/cut.${f}`))).toBe(true);
    }
    expect(readFileSync(join(dir, 'out/cut.edl'), 'utf8')).toContain('* FROM CLIP NAME: a.mov');
  });
});
