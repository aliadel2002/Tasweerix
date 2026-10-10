import createHarfBuzz from 'harfbuzzjs/hb.js';
import hbjs from 'harfbuzzjs/hbjs.js';
import wasm from 'harfbuzzjs/hb.wasm';

let hbPromise: Promise<HarfBuzz> | undefined;
let hbSync: HarfBuzz | undefined;

/** Loads the HarfBuzz WebAssembly module (once). */
export function loadHarfBuzz(): Promise<HarfBuzz> {
  hbPromise ??= createHarfBuzz({ wasmBinary: wasm }).then((m) => (hbSync = hbjs(m)));
  return hbPromise;
}

export function harfbuzz(): HarfBuzz {
  if (!hbSync) throw new Error('HarfBuzz not loaded yet (await loadHarfBuzz())');
  return hbSync;
}
