import type { Env } from '@tasweerix/core';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodePcm, probe } from './ffmpeg';
import { AnalysisCache, hostAnalyze } from './analysis';
import { resolveAsset } from './handler';

/** Env for Node tooling (audio rendering, interchange export, smart analysis). */
export function nodeEnv(root: string): Env {
  const cache = new AnalysisCache(join(root, '.tasweerix', 'cache'));
  return {
    cache: {
      get: async <T,>(key: string, src?: string) => cache.get<T>(key, src ? resolveAsset(root, src) : undefined),
      set: async (key, value, src) => cache.set(key, value, src ? resolveAsset(root, src) : undefined),
    },
    analyze: (kind, src, params) => hostAnalyze(kind, resolveAsset(root, src), params, { root, resolve: (s) => resolveAsset(root, s) }),
    kind: 'node',
    probe: (src) => probe(resolveAsset(root, src)),
    loadPcm: (src, rate, ch) => decodePcm(resolveAsset(root, src), rate, ch),
    loadBinary: async (src) => {
      const b = await readFile(resolveAsset(root, src));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
  };
}
