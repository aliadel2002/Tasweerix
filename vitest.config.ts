import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);

/**
 * Serves `*.wasm` imports as Uint8Array (mirrors the esbuild 'binary' loader used for bundles).
 * Resolved to virtual ids so vitest doesn't externalize them to Node's native wasm loader.
 */
const wasmBinary = {
  name: 'wasm-binary',
  enforce: 'pre' as const,
  resolveId(source: string, importer?: string) {
    if (!source.endsWith('.wasm')) return null;
    const from = importer ? createRequire(importer) : require;
    // Hex-encode the path: ids containing /node_modules/ would be externalized by vite-node.
    return `virtual-wasm:${Buffer.from(from.resolve(source)).toString('hex')}`;
  },
  load(id: string) {
    if (!id.startsWith('virtual-wasm:')) return null;
    const b64 = readFileSync(Buffer.from(id.slice('virtual-wasm:'.length), 'hex').toString()).toString('base64');
    return `export default Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));`;
  },
};

export default defineConfig({
  plugins: [wasmBinary],
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
