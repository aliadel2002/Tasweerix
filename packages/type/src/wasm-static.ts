// Used by bundles (browser export page, studio, Node bundles): esbuild inlines the binary.
import wasm from 'harfbuzzjs/hb.wasm';
export const loadWasm = async (): Promise<Uint8Array> => wasm;
