import { describe, expect, it } from 'vitest';
import { definePlugin, getPlugins, keys, usePlugin } from '../src';
import { getDrawer, getFilter, getTransition } from '@tasweerix/render';
import { getAudioEffect, getGenerator } from '@tasweerix/audio';

describe('plugins', () => {
  it('register easings, drawers, filters, transitions and audio extensions', () => {
    const plugin = definePlugin({
      name: 'test-plugin',
      easings: { stepHalf: (t) => (t < 0.5 ? 0 : 1) },
      drawers: { dot: (d: { ctx: CanvasRenderingContext2D }) => d.ctx.fillRect(0, 0, 1, 1) },
      filters: { identity: { apply: (input: unknown) => input } },
      transitions: { instant: { frag: 'void main(){ outColor = getTo(vUv); }' } },
      audioEffects: { silence: () => ({ process: (chs: Float32Array[]) => chs.forEach((c) => c.fill(0)) }) },
      generators: { dc: (_p: Record<string, unknown>, _sr: number, len: number) => [new Float32Array(len).fill(0.5)] },
    });
    usePlugin(plugin);
    usePlugin(plugin); // idempotent
    expect(getPlugins().filter((p) => p.name === 'test-plugin')).toHaveLength(1);
    expect(keys<number>([[0, 0], [1, 10, 'stepHalf' as never]]).at(0.6)).toBe(10);
    expect(getDrawer('dot')).toBeDefined();
    expect(getFilter('identity')).toBeDefined();
    expect(getTransition('instant')).toBeDefined();
    expect(getAudioEffect('silence')).toBeDefined();
    expect(getGenerator('dc')).toBeDefined();
  });
});
