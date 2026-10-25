import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import { definePlugin, usePlugin } from '@tasweerix/core';
import { launchBrowser } from '../src/browser';
import { startStudio } from '../src/studio';

// An AI provider from a plugin: the studio's Assistant (a plugin command) uses it.
usePlugin(
  definePlugin({
    name: 'studio-test-ai',
    aiProviders: {
      echo: {
        async generate(req: { prompt: string }) {
          const code = /<file path="index.ts">\n([\s\S]*?)\n<\/file>/.exec(req.prompt)![1]!;
          return { text: JSON.stringify({ summary: 'Recolored the rectangle.', code: code.replace("fill: '#22d3ee'", "fill: '#ffd400'") }) };
        },
      },
    },
  }),
);

const proj = join(__dirname, '.tmp', 'studio-proj');
const SRC = `import { composition, rect, text, keys, circle } from 'tasweerix';

export default composition({ width: 1280, height: 720, fps: 30, duration: 4, background: '#101827' }, (c) => {
  c.add(rect({ size: [300, 160], fill: '#22d3ee', radius: 24, at: [400, 300] }));
  c.add(circle(80, { fill: '#f43f5e', at: [900, 360], opacity: keys([[0, 0], [1, 1]]) }));
  c.add(text('Studio', { size: 90, weight: 800, fill: '#ffffff', at: [640, 600] }));
});
`;

let studio: Awaited<ReturnType<typeof startStudio>>;
let browser: Browser;
let page: Page;
const logs: string[] = [];
const file = () => readFileSync(join(proj, 'index.ts'), 'utf8');
const waitFor = async (cond: () => boolean, ms = 10_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout; file is:\n${file()}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

beforeAll(async () => {
  rmSync(proj, { recursive: true, force: true });
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, 'index.ts'), SRC);
  studio = await startStudio({ root: proj, port: 0, log: (m) => logs.push(m) });
  browser = await launchBrowser();
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(studio.url);
  await page.waitForSelector('.tl-row');
  await page.waitForTimeout(500);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await studio?.close();
});

async function toScreen(x: number, y: number) {
  const box = (await page.locator('svg.overlay').boundingBox())!;
  return [box.x + (x / 1280) * box.width, box.y + (y / 720) * box.height] as const;
}

describe('studio (two-way editing)', () => {
  it('renders the preview, timeline and code', async () => {
    expect(await page.locator('.tl-row').count()).toBe(3);
    expect(await page.locator('.cm-content').innerText()).toContain("text('Studio'");
    const lit = await page.evaluate(() => {
      const c = document.querySelector('canvas')!;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 1]! > 150) n++;
      return n;
    });
    expect(lit).toBeGreaterThan(1000);
  });

  it('drags an element on the canvas and writes the new position to source', async () => {
    const [sx, sy] = await toScreen(400, 300);
    const [tx, ty] = await toScreen(520, 340);
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(tx, ty, { steps: 6 });
    await page.mouse.up();
    await waitFor(() => file().includes('at: [520, 340]'));
    expect(file()).toContain("c.add(rect({ size: [300, 160], fill: '#22d3ee', radius: 24, at: [520, 340] }));");
  });

  it('edits a prop from the inspector', async () => {
    await page.waitForSelector('.inspector .insp-grid');
    const input = page.locator('.insp-grid label', { hasText: /^radius$/ }).locator('xpath=following-sibling::*[1]');
    await input.click();
    await input.fill('48');
    await input.press('Enter');
    await waitFor(() => file().includes('radius: 48'));
  });

  it('moves a keyframe on the timeline', async () => {
    await page.waitForTimeout(1000);
    const key = page.locator('.tl-key').nth(1);
    const b = (await key.boundingBox())!;
    const px = await page.evaluate(() => Number((document.querySelector('.tl-toolbar input') as HTMLInputElement).value));
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + px * 0.5, b.y + b.height / 2, { steps: 5 });
    await page.mouse.up();
    await waitFor(() => file().includes('[1.5, 1]'));
  });

  it('undoes and redoes edits', async () => {
    await page.waitForTimeout(800);
    await page.locator('header button[title^="Undo"]').click();
    await waitFor(() => file().includes('[[0, 0], [1, 1]]'));
    await page.waitForTimeout(800);
    await page.locator('header button[title^="Redo"]').click();
    await waitFor(() => file().includes('[1.5, 1]'));
  });

  it('reloads the editor and preview when the file changes on disk', async () => {
    writeFileSync(join(proj, 'index.ts'), file().replace("text('Studio'", "text('Edited'"));
    await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes("text('Edited'"), null, { timeout: 15_000 });
  });

  it('runs a plugin command (the AI assistant) from the command bar, undoably', async () => {
    await page.waitForSelector('.command-bar');
    expect(await page.locator('.command-label').innerText()).toMatch(/assistant/i);
    await page.locator('.command-bar input').fill('make the rectangle yellow');
    await page.locator('.command-bar button[type=submit]').click();
    await waitFor(() => file().includes("fill: '#ffd400'"));
    await page.waitForSelector('.command-status:has-text("Recolored the rectangle.")');
    await page.waitForTimeout(800);
    await page.locator('header button[title^="Undo"]').click();
    await waitFor(() => file().includes("fill: '#22d3ee'"));
  });

  it('answers unexpected errors with the message only and logs the stack', async () => {
    const r = await fetch(`${studio.url}/api/entry`, { method: 'POST', body: '{not json' });
    expect(r.status).toBe(500);
    const body = await r.text();
    expect(body).toBeTruthy();
    expect(body).not.toMatch(/\n\s+at /);
    expect(logs.some((m) => m.startsWith('[studio] SyntaxError') && /\n\s+at /.test(m))).toBe(true);
  });
});
