import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pluginCommands, usePlugin, type CommandContext, type CommandDef, type Plugin } from '@tasweerix/core';
import { importForNode } from './bundle';

/** Plugins that ship with the CLI. Their commands use the same hook as third-party plugins. */
export async function builtinPlugins(): Promise<Plugin[]> {
  const [{ interchangePlugin }, { visionPlugin }] = await Promise.all([import('@tasweerix/interchange/node'), import('@tasweerix/vision/node')]);
  return [interchangePlugin, visionPlugin];
}

const CONFIG_FILES = ['tasweerix.config.ts', 'tasweerix.config.mts', 'tasweerix.config.js', 'tasweerix.config.mjs'];

/** Finds the nearest tasweerix.config.* from a folder upwards. */
export function findConfig(from: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    for (const f of CONFIG_FILES) if (existsSync(join(dir, f))) return join(dir, f);
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/**
 * Loads `plugins` from a tasweerix.config.ts (`export default { plugins: [...] }`). The CLI registers
 * them with its own core, so plugin commands, host analyses, timeline formats and AI providers work
 * in every command, the render server and the studio.
 */
export async function loadConfigPlugins(cwd: string): Promise<Plugin[]> {
  const file = findConfig(cwd);
  if (!file) return [];
  const mod = (await importForNode(file)) as { default?: { plugins?: Plugin[] }; plugins?: Plugin[] };
  return mod.default?.plugins ?? mod.plugins ?? [];
}

let loaded: Promise<void> | undefined;
/** Registers built-in and configured plugins once per process. */
export function setupPlugins(cwd = process.cwd()): Promise<void> {
  loaded ??= (async () => {
    usePlugin(...(await builtinPlugins()));
    usePlugin(...(await loadConfigPlugins(cwd)));
  })();
  return loaded;
}

/** Context for a command run from the terminal. */
export function cliContext(args: string[], options: Record<string, any>, cwd = process.cwd()): CommandContext {
  return {
    args,
    options,
    cwd,
    host: 'cli',
    log: (m) => console.error(m),
    readFile: (p) => readFile(resolve(cwd, p), 'utf8'),
    async writeFile(p, content) {
      await mkdir(dirname(resolve(cwd, p)), { recursive: true });
      await writeFile(resolve(cwd, p), content);
    },
    async render(o) {
      const { render } = await import('./render');
      const { renderAudioForExport } = await import('./audio');
      const r = await render({ entry: resolve(cwd, o.entry), output: resolve(cwd, o.output), root: o.root ? resolve(cwd, o.root) : undefined, codec: o.codec as never, scale: o.scale, concurrency: o.concurrency ?? 2, props: o.props, renderAudio: renderAudioForExport, onProgress: o.onProgress });
      return { output: r.output, seconds: r.seconds };
    },
  };
}

/** Adds every plugin command as a CLI subcommand (built-in names win over plugin names). */
export function registerPluginCommands(program: Command): void {
  const taken = new Set(program.commands.map((c) => c.name()));
  for (const [name, def] of Object.entries(pluginCommands())) {
    if (taken.has(name)) {
      console.error(`[tasweerix] plugin command "${name}" is shadowed by a built-in command`);
      continue;
    }
    addCommand(program, name, def);
  }
}

function addCommand(program: Command, name: string, def: CommandDef): void {
  const cmd = program.command(name).description(def.description);
  for (const a of def.args ?? []) cmd.argument(a);
  for (const o of def.options ?? []) cmd.option(o.flags, o.description ?? '', o.default as string | boolean | undefined);
  cmd.action(async (...params: unknown[]) => {
    // commander passes positional args, then the options object, then the command.
    const n = def.args?.length ?? 0;
    const args = params.slice(0, n).flatMap((v) => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]));
    const options = (params[n] ?? {}) as Record<string, any>;
    await def.run(cliContext(args, options));
  });
}
