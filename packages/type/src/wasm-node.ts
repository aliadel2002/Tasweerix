// Used when running unbundled in Node (CLI via tsx, vitest): read the binary from disk.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
export const loadWasm = async (): Promise<Uint8Array> => new Uint8Array(await readFile(createRequire(import.meta.url).resolve('harfbuzzjs/hb.wasm')));
