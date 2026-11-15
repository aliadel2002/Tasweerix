import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
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
  await page.goto(studio.link);
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
    const input = page.locator('.insp-grid label', { hasText: /^radius$/ }).locator('xpath=following-sibling::*[1]/descendant-or-self::input');
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
    const r = await fetch(`${studio.url}/api/entry`, { method: 'POST', body: '{not json', headers: { 'x-tasweerix-token': studio.token } });
    expect(r.status).toBe(500);
    const body = await r.text();
    expect(body).toBeTruthy();
    expect(body).not.toMatch(/\n\s+at /);
    expect(logs.some((m) => m.startsWith('[studio] SyntaxError') && /\n\s+at /.test(m))).toBe(true);
  });
});

const SRC2 = `import { composition, rect, text } from 'tasweerix';

export default composition({ width: 1280, height: 720, fps: 30, duration: 4, background: '#101827' }, (c) => {
  c.add(rect({ size: [300, 160], fill: '#22d3ee', at: [400, 300], duration: 2 }));
  c.add(text('Studio', { size: 90, weight: 800, fill: '#ffffff', at: [640, 600] }));
});
`;

describe('studio (editing surface)', () => {
  const editorText = () => page.locator('.cm-content').innerText();
  const center = async (selector: string, nth = 0) => {
    const b = (await page.locator(selector).nth(nth).boundingBox())!;
    return [b.x + b.width / 2, b.y + b.height / 2] as const;
  };
  const drag = async (from: readonly [number, number], to: readonly [number, number]) => {
    await page.mouse.move(from[0], from[1]);
    await page.mouse.down();
    await page.mouse.move(to[0], to[1], { steps: 6 });
    await page.mouse.up();
  };

  beforeAll(async () => {
    writeFileSync(join(proj, 'index.ts'), SRC2);
    await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('duration: 2 }'), null, { timeout: 15_000 });
    await page.waitForTimeout(800);
  });

  it('names timeline rows after their content and labels every button', async () => {
    expect(await page.locator('.tl-name').allInnerTexts()).toEqual(['rect', 'Studio']);
    const unnamed = await page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => !b.getAttribute('aria-label') && !b.textContent?.trim()).length);
    expect(unnamed).toBe(0);
    // Play and next-frame are different controls with different names.
    const names = await page.locator('.transport button').evaluateAll((list) => list.map((b) => b.getAttribute('aria-label')));
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps text typed just before a canvas edit, and the canvas edit too', async () => {
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('// typed');
    // No pause: the typed text is still unsaved when the drag rewrites the source.
    await drag(await toScreen(400, 300), await toScreen(520, 340));
    await waitFor(() => file().includes('at: [520, 340]') && file().includes('// typed'));
    await page.waitForFunction(() => /at: \[520, 340\]/.test(document.querySelector('.cm-content')?.textContent ?? ''), null, { timeout: 10_000 });
    expect(await editorText()).toContain('// typed');
    // Nothing writes the older text back afterwards.
    await page.waitForTimeout(1500);
    expect(file()).toContain('at: [520, 340]');
    expect(file()).toContain('// typed');
  });

  it('undoes a canvas edit with the keyboard from inside the code editor', async () => {
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+z');
    await waitFor(() => file().includes('at: [400, 300]'));
    expect(file()).toContain('// typed');
    await page.waitForFunction(() => /at: \[400, 300\]/.test(document.querySelector('.cm-content')?.textContent ?? ''), null, { timeout: 10_000 });
    await page.keyboard.press('Control+Shift+Z');
    await waitFor(() => file().includes('at: [520, 340]'));
    await page.waitForTimeout(800);
  });

  it('scales and rotates an element with the canvas handles', async () => {
    const [ox, oy] = await toScreen(520, 340);
    await page.mouse.click(ox, oy);
    await page.waitForSelector('.sel-handle.scale');
    // Bottom-right corner, pulled to one and a half times its distance from the element's anchor.
    const corner = await center('.sel-handle.scale', 2);
    await drag(corner, [ox + (corner[0] - ox) * 1.5, oy + (corner[1] - oy) * 1.5]);
    await waitFor(() => /scale: 1\.5\b/.test(file()));
    await page.waitForTimeout(1000);
    // The rotate handle sits above the element; a quarter turn puts it to the right.
    const knob = await center('.sel-handle.rotate');
    const r = Math.hypot(knob[0] - ox, knob[1] - oy);
    await drag(knob, [ox + r, oy]);
    await waitFor(() => /rotation: 90\b/.test(file()));
    await page.waitForTimeout(1000);
  });

  it('trims a clip from its left edge, keeping its end where it was', async () => {
    const px = await page.evaluate(() => Number((document.querySelector('.tl-toolbar input') as HTMLInputElement).value));
    const edge = await center('.tl-trim.start', 0);
    await drag(edge, [edge[0] + px * 0.5, edge[1]]);
    await waitFor(() => file().includes('start: 0.5') && file().includes('duration: 1.5'));
    await page.waitForTimeout(800);
  });

  it('moves a focused clip by one frame with the arrow keys', async () => {
    await page.locator('.tl-bar').first().focus();
    await page.keyboard.press('ArrowRight');
    await waitFor(() => file().includes('start: 0.533'));
  });

  it('switches the interface to Arabic, mirroring panels but not the timeline or code', async () => {
    await page.locator('button.lang').click();
    await page.waitForFunction(() => document.documentElement.dir === 'rtl');
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('ar');
    expect(await page.locator('.files .panel-title').innerText()).toBe('المشروع');
    expect(await page.locator('.timeline').getAttribute('dir')).toBe('ltr');
    expect(await page.locator('.code').getAttribute('dir')).toBe('ltr');
    const files = (await page.locator('.files').boundingBox())!;
    const stage = (await page.locator('.stage').boundingBox())!;
    expect(files.x).toBeGreaterThan(stage.x);
    await page.locator('button.lang').click();
    await page.waitForFunction(() => document.documentElement.dir === 'ltr');
    expect(await page.locator('.files .panel-title').innerText()).toMatch(/project/i);
  });
});

/** A raw request, so the Host / Origin headers a browser would send can be set. */
function send(method: string, path: string, headers: Record<string, string> = {}, body: string | Buffer = ''): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  const u = new URL(studio.url);
  return new Promise((res, rej) => {
    const r = request({ host: u.hostname, port: u.port, method, path, headers: { host: u.host, 'content-type': 'text/plain', ...headers } }, (resp) => {
      let d = '';
      resp.on('data', (c) => (d += c));
      resp.on('end', () => res({ status: resp.statusCode!, body: d, headers: resp.headers }));
    });
    r.on('error', rej);
    r.end(body);
  });
}

describe('studio (access control)', () => {
  const token = () => ({ 'x-tasweerix-token': studio.token });

  it('refuses requests without the token, from other sites and with a foreign Host (DNS rebinding)', async () => {
    expect((await send('GET', '/api/file?path=index.ts')).status).toBe(401);
    expect((await send('POST', '/api/upload?path=evil.ts', {}, 'x')).status).toBe(401);
    expect((await send('GET', '/__tx/probe?src=http://169.254.169.254/')).status).toBe(401);
    expect((await send('GET', '/project/index.ts')).status).toBe(401);
    // Even with the token: another origin, another local port, or a rebound host name.
    expect((await send('POST', '/api/upload?path=evil.ts', { ...token(), origin: 'https://evil.example' }, 'x')).status).toBe(403);
    expect((await send('GET', '/api/file?path=index.ts', { ...token(), 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await send('GET', '/api/file?path=index.ts', { ...token(), host: `rebind.evil.example:${new URL(studio.url).port}` })).status).toBe(403);
    expect(existsSync(join(proj, 'evil.ts'))).toBe(false);
    expect((await send('GET', '/api/file?path=index.ts', token())).status).toBe(200);
  });

  it('turns the link into an HttpOnly SameSite=Strict cookie', async () => {
    const r = await send('GET', `/?token=${studio.token}`, { 'sec-fetch-site': 'none' });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/');
    const cookie = String(r.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect((await send('GET', '/api/file?path=index.ts', { cookie: cookie.split(';')[0]! })).status).toBe(200);
    expect((await send('GET', `/?token=wrong`)).status).toBe(401);
  });

  it('keeps file, entry and export paths inside the project', async () => {
    const outside = join(tmpdir(), `tasweerix-outside-${process.pid}`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.json'), '{"secret":"OUTSIDE"}');
    try {
      expect((await send('GET', '/api/file?path=../../package.json', token())).status).toBe(500);
      expect((await send('POST', '/api/entry', token(), JSON.stringify({ entry: join(outside, 'secret.json') }))).status).toBe(500);
      expect((await send('POST', '/api/entry', token(), JSON.stringify({ entry: '../../package.json' }))).status).toBe(500);
      expect((await send('GET', '/api/state', token())).body).toContain('"entry":"index.ts"');
      expect((await send('POST', '/api/export', token(), JSON.stringify({ output: join(outside, 'x.png'), still: true }))).status).toBe(500);
      expect((await send('POST', '/api/export', token(), JSON.stringify({ output: '../x.png', still: true }))).status).toBe(500);
      // A symlink inside the project that points outside it.
      symlinkSync(outside, join(proj, 'link'));
      expect((await send('GET', '/api/file?path=link/secret.json', token())).status).toBe(500);
      expect((await send('POST', '/api/upload?path=link/evil.ts', token(), 'x')).status).toBe(500);
      expect(existsSync(join(outside, 'evil.ts'))).toBe(false);
    } finally {
      rmSync(join(proj, 'link'), { force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('streams uploads larger than the buffered-body cap to disk', async () => {
    const big = Buffer.alloc(101 * 1024 * 1024, 7);
    expect((await send('POST', '/api/upload?path=assets/big.bin', token(), big)).status).toBe(200);
    expect(readFileSync(join(proj, 'assets/big.bin')).equals(big)).toBe(true);
    rmSync(join(proj, 'assets/big.bin'));
  });
});
