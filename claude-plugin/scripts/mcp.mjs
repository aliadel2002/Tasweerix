#!/usr/bin/env node
// Starts the Tasweerix MCP server for Claude Code. In order: TASWEERIX_MCP (a server script), the copy
// in the Tasweerix monorepo when Claude Code runs inside it, the project's installed @tasweerix/mcp,
// and finally the published package through npx.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const project = resolve(process.env.TASWEERIX_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd());

function serverCommand() {
  if (process.env.TASWEERIX_MCP) return [process.execPath, process.env.TASWEERIX_MCP];
  for (let dir = project; ; dir = dirname(dir)) {
    const bin = join(dir, 'packages', 'mcp', 'bin', 'tasweerix-mcp.mjs');
    if (existsSync(bin)) {
      if (existsSync(join(dir, 'packages', 'mcp', 'node_modules'))) return [process.execPath, bin];
      console.error('[tasweerix] Found the Tasweerix repository but its dependencies are not installed: run `pnpm install`. Using the published server meanwhile.');
      break;
    }
    if (dirname(dir) === dir) break;
  }
  try {
    const pkgPath = createRequire(join(project, 'package.json')).resolve('@tasweerix/mcp/package.json');
    const { bin } = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return [process.execPath, resolve(dirname(pkgPath), typeof bin === 'string' ? bin : bin['tasweerix-mcp'])];
  } catch {
    return ['npx', '-y', '@tasweerix/mcp'];
  }
}

const [cmd, ...args] = serverCommand();
const child = spawn(cmd, args, {
  cwd: project,
  stdio: 'inherit',
  env: { ...process.env, TASWEERIX_PROJECT_DIR: project },
  shell: process.platform === 'win32' && cmd === 'npx',
});
child.on('error', (e) => {
  console.error(`[tasweerix] Could not start the MCP server (${cmd}): ${e.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));
