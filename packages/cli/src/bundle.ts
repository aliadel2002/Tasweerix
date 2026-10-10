import { build, type Plugin } from 'esbuild';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const CLI_ROOT = resolve(here, '..');
const require = createRequire(import.meta.url);

/** Resolves bare imports like "tasweerix" and "@tasweerix/*" even for projects outside the monorepo. */
function workspaceResolver(): Plugin {
  return {
    name: 'tasweerix-resolve',
    setup(b) {
      b.onResolve({ filter: /^(tasweerix|@tasweerix\/[a-z-]+)(\/.*)?$/ }, (args) => {
        try {
          // Prefer the project's own installation.
          const fromProject = createRequire(join(args.resolveDir, 'noop.js'));
          return { path: fromProject.resolve(args.path) };
        } catch {
          try {
            return { path: require.resolve(args.path) };
          } catch {
            return undefined;
          }
        }
      });
    },
  };
}

function entryPlugin(entryFile: string): Plugin {
  return {
    name: 'tasweerix-entry',
    setup(b) {
      b.onResolve({ filter: /^tasweerix:entry$/ }, () => ({ path: entryFile }));
    },
  };
}

export interface BundleOptions {
  entry: string;
  /** 'browser' bundles the export page runtime; 'node' bundles the module for Node tooling. */
  platform: 'browser' | 'node';
  runtime?: string;
  outfile?: string;
  sourcemap?: boolean;
  define?: Record<string, string>;
}

export async function bundle(opts: BundleOptions): Promise<{ code: string; map?: string }> {
  const entry = resolve(opts.entry);
  if (!existsSync(entry)) throw new Error(`Entry not found: ${entry}`);
  const isBrowser = opts.platform === 'browser';
  const result = await build({
    entryPoints: [isBrowser ? (opts.runtime ?? join(CLI_ROOT, 'src/runtime/page.ts')) : entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: opts.platform,
    target: isBrowser ? 'chrome120' : 'node20',
    sourcemap: opts.sourcemap ? (isBrowser ? 'inline' : 'inline') : false,
    sourcesContent: true,
    plugins: [entryPlugin(entry), workspaceResolver()],
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"', ...(opts.define ?? {}) },
    // Emscripten modules reference Node built-ins in branches never taken in browsers.
    external: isBrowser ? ['fs', 'path', 'module', 'url', 'crypto', 'worker_threads'] : ['node:*', 'playwright-core', 'esbuild'],
    nodePaths: [join(CLI_ROOT, 'node_modules')],
    outfile: opts.outfile ?? 'bundle.js',
    loader: { '.wasm': 'binary' },
    // Selects bundle-friendly module variants (e.g. inlined wasm) via package.json conditions.
    conditions: ['tasweerix-bundle'],
  });
  const out = result.outputFiles.find((f) => f.path.endsWith('.js'))!;
  return { code: out.text };
}

/** Bundles and imports a project entry in Node (for audio rendering, interchange, smart edits). */
export async function importForNode(entry: string): Promise<Record<string, unknown>> {
  const { code } = await bundle({ entry, platform: 'node', sourcemap: true });
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'tasweerix-'));
  const file = join(dir, 'entry.mjs');
  writeFileSync(file, code);
  return (await import(file)) as Record<string, unknown>;
}
