import { build } from 'esbuild';
import { join } from 'node:path';

/** Bundles the studio UI (Preact app in `appDir`, normally apps/studio) with esbuild. */
export async function buildStudioApp(appDir: string): Promise<{ js: string; css: string }> {
  const result = await build({
    entryPoints: [join(appDir, 'src/main.tsx')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'chrome110',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    minify: true,
    outdir: '/out',
    logLevel: 'silent',
    nodePaths: [join(appDir, 'node_modules')],
  });
  const js = result.outputFiles.find((f) => f.path.endsWith('.js'))!.text;
  const css = result.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';
  return { js, css };
}
