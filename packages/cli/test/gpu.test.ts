import { describe, expect, it } from 'vitest';
import { launchRenderBrowser } from '../src/browser';

describe('export browser GPU selection', () => {
  it('reports the WebGL renderer and whether it is hardware', async () => {
    const rb = await launchRenderBrowser('off');
    try {
      expect(rb.renderer).not.toBe('');
      expect(rb.gpu).toBe(false);
      const another = await rb.launchAnother();
      await another.close();
    } finally {
      await rb.browser.close();
    }
  });

  it('rejects unknown modes', async () => {
    await expect(launchRenderBrowser('fast' as never)).rejects.toThrow(/auto, on or off/);
  });
});
