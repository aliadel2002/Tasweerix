import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright-core';

/** Locates a Chromium binary (Playwright cache, env override, or system install). */
export function findChromium(): string | undefined {
  if (process.env.TASWEERIX_CHROMIUM) return process.env.TASWEERIX_CHROMIUM;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', `${process.env.HOME}/.cache/ms-playwright`].filter(Boolean) as string[];
  for (const r of roots) {
    for (const rel of ['chromium_headless_shell-1194/chrome-linux/headless_shell', 'chromium-1194/chrome-linux/chrome']) {
      if (existsSync(`${r}/${rel}`)) return `${r}/${rel}`;
    }
  }
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) if (existsSync(p)) return p;
  return undefined;
}

export async function launchBrowser(): Promise<Browser> {
  const executablePath = findChromium();
  return chromium.launch({
    executablePath,
    headless: true,
    args: ['--disable-web-security', '--autoplay-policy=no-user-gesture-required', '--font-render-hinting=none', '--force-color-profile=srgb', '--disable-lcd-text'],
  });
}
