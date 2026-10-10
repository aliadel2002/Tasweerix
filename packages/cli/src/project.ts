import { dirname, resolve } from 'node:path';
import { isCompositionDefinition, setEnv, type Composition, type CompositionDefinition } from '@tasweerix/core';
import { nodeEnv } from '@tasweerix/media/node';
import { importForNode } from './bundle';

export function pickDefinition(mod: Record<string, unknown>, name?: string): CompositionDefinition {
  if (name) {
    const d = mod[name];
    if (!isCompositionDefinition(d)) throw new Error(`Export "${name}" is not a composition`);
    return d;
  }
  if (isCompositionDefinition(mod.default)) return mod.default;
  const first = Object.values(mod).find(isCompositionDefinition);
  if (!first) throw new Error('Entry has no composition export (export default composition(...))');
  return first;
}

/** Builds a composition in Node (no rendering) for audio, interchange and analysis tooling. */
export async function loadComposition(entry: string, opts: { comp?: string; props?: Record<string, unknown>; root?: string } = {}): Promise<{ comp: Composition; root: string; env: ReturnType<typeof nodeEnv> }> {
  const file = resolve(entry);
  const root = resolve(opts.root ?? dirname(file));
  const env = nodeEnv(root);
  setEnv(env);
  const mod = await importForNode(file);
  const def = pickDefinition(mod, opts.comp);
  const comp = await def.create({ props: opts.props, env });
  return { comp, root, env };
}
