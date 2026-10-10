import createHarfBuzz from 'harfbuzzjs/hb.js';
import hbjs from 'harfbuzzjs/hbjs.js';
import { loadWasm } from '#hbwasm';

let hbPromise: Promise<HarfBuzz> | undefined;
let hbSync: HarfBuzz | undefined;

/** Loads the HarfBuzz WebAssembly module (once). */
export function loadHarfBuzz(): Promise<HarfBuzz> {
  hbPromise ??= loadWasm().then((wasmBinary) => createHarfBuzz({ wasmBinary })).then((m) => (hbSync = hbjs(m)));
  return hbPromise;
}

export function harfbuzz(): HarfBuzz {
  if (!hbSync) throw new Error('HarfBuzz not loaded yet (await loadHarfBuzz())');
  return hbSync;
}
