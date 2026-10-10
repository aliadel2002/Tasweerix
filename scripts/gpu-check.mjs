#!/usr/bin/env node
// Checks GPU export on this machine: renders test frames on the GPU and with SwiftShader and compares
// them, then times the same export both ways. Run with `npm run gpu-check` and share the summary.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'out/gpu-check');
mkdirSync(out, { recursive: true });
const win = process.platform === 'win32';

function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', shell: win, maxBuffer: 1 << 26 });
  return { ok: r.status === 0, text: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

console.log('1/2 Comparing GPU frames with SwiftShader...');
const parity = run('npx', ['vitest', 'run', 'packages/cli/test/gpu-parity.test.ts'], { TASWEERIX_GPU_TEST: 'require' });
const frames = parity.text.split('\n').filter((l) => / dB, .*pixels off/.test(l)).map((l) => l.trim());
const compared = /GPU parity: (.*)/.exec(parity.text)?.[1] ?? '';
const noGpu = /no hardware GPU answered/.test(parity.text);
if (!parity.ok && !frames.length && !noGpu) console.log(parity.text.split('\n').slice(-40).join('\n'));

console.log('2/2 Timing a 3 s export of examples/promo on the GPU and in software...');
function bench(gpu) {
  const t = performance.now();
  const r = run('node', ['packages/cli/bin/tasweerix.mjs', 'render', 'examples/promo/index.ts', '--range', '0-89', '--muted', '--gpu', gpu, '-o', join(out, `promo-${gpu}.mp4`)]);
  const secs = (performance.now() - t) / 1000;
  const renderer = /WebGL on GPU: .*|WebGL in software \(.*\)(?=: heavy)/.exec(r.text)?.[0] ?? 'renderer not logged';
  if (!r.ok) console.log(r.text.split('\n').slice(-20).join('\n'));
  return { ok: r.ok, secs, renderer };
}
const gpu = bench('on');
const cpu = bench('off');

const line = '-'.repeat(72);
console.log(`\n${line}\nGPU check on ${process.platform} ${process.arch}\n${line}`);
console.log(`Backends: ${compared || 'none reported'}`);
for (const f of frames) console.log(`  ${f}`);
const parityResult = parity.ok ? 'PASS' : noGpu ? 'FAIL (no hardware GPU answered; check drivers)' : 'FAIL';
console.log(`Parity with SwiftShader: ${parityResult}`);
if (!parity.ok && !noGpu) console.log(`  Diff images: ${join(root, 'packages/cli/test/.tmp-gpu')}`);
const fmt = (b) => (b.ok ? `${b.secs.toFixed(1)} s (${(90 / b.secs).toFixed(1)} fps)` : 'FAILED');
console.log(`Export, 90 frames, GPU:      ${fmt(gpu)}\n  ${gpu.renderer}`);
console.log(`Export, 90 frames, software: ${fmt(cpu)}\n  ${cpu.renderer}`);
if (gpu.ok && cpu.ok) console.log(`GPU speedup: ${(cpu.secs / gpu.secs).toFixed(2)}x`);
const pass = parity.ok && gpu.ok && cpu.ok && /on GPU/.test(gpu.renderer);
console.log(`${line}\nOverall: ${pass ? 'PASS' : 'FAIL'}\n${line}`);
process.exit(pass ? 0 : 1);
