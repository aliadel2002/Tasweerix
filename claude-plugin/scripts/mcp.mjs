#!/usr/bin/env node
// Starts the Tasweerix MCP server for Claude Code. In order: TASWEERIX_MCP (a server script), the copy
// in the Tasweerix monorepo when Claude Code runs at its root, or the project's installed @tasweerix/mcp.
// There is deliberately no `npx -y` fallback: it would download and run whatever is published under
// that name on npm.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const project = resolve(process.env.TASWEERIX_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd());

function serverCommand() {
  if (process.env.TASWEERIX_MCP) return [process.execPath, process.env.TASWEERIX_MCP];
  // Only the project folder itself, never its parents: code outside the project is not trusted with it.
  const bin = join(project, 'packages', 'mcp', 'bin', 'tasweerix-mcp.mjs');
  if (existsSync(join(project, 'pnpm-workspace.yaml')) && existsSync(bin)) {
    if (existsSync(join(project, 'packages', 'mcp', 'node_modules'))) return [process.execPath, bin];
    console.error('[tasweerix] Found the Tasweerix repository but its dependencies are not installed: run `pnpm install`.');
  }
  try {
    const pkgPath = createRequire(join(project, 'package.json')).resolve('@tasweerix/mcp/package.json');
    const { bin } = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return [process.execPath, resolve(dirname(pkgPath), typeof bin === 'string' ? bin : bin['tasweerix-mcp'])];
  } catch {
    console.error('[tasweerix] The Tasweerix MCP server is not installed in this project: run `npm i -D @tasweerix/mcp` (or set TASWEERIX_MCP to a server script).');
    process.exit(1);
  }
}

const [cmd, ...args] = serverCommand();
const child = spawn(cmd, args, {
  cwd: project,
  stdio: 'inherit',
  env: { ...process.env, TASWEERIX_PROJECT_DIR: project },
});
child.on('error', (e) => {
  console.error(`[tasweerix] Could not start the MCP server (${cmd}): ${e.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));
