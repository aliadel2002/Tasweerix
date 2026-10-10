import type { Env } from '@tasweerix/core';
import { readFile } from 'node:fs/promises';
import { decodePcm, probe } from './ffmpeg';
import { resolveAsset } from './handler';

/** Env for Node tooling (audio rendering, interchange export, smart analysis). */
export function nodeEnv(root: string): Env {
  return {
    kind: 'node',
    probe: (src) => probe(resolveAsset(root, src)),
    loadPcm: (src, rate, ch) => decodePcm(resolveAsset(root, src), rate, ch),
    loadBinary: async (src) => {
      const b = await readFile(resolveAsset(root, src));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
  };
}
