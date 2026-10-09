import type { Env } from '@tasweerix/core';
import { probe } from './ffmpeg';
import { resolveAsset } from './handler';

/** Env for Node tooling (audio rendering, interchange export, smart analysis). */
export function nodeEnv(root: string): Env {
  return { kind: 'node', probe: (src) => probe(resolveAsset(root, src)) };
}
