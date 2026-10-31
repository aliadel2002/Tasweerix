import { existsSync, readdirSync } from 'node:fs';
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

// The same-origin policy stays on: the page talks only to its own render server.
const BASE_ARGS = ['--autoplay-policy=no-user-gesture-required', '--font-render-hinting=none', '--force-color-profile=srgb', '--disable-lcd-text'];

export async function launchBrowser(extraArgs: string[] = []): Promise<Browser> {
  return chromium.launch({ executablePath: findChromium(), headless: true, args: [...BASE_ARGS, ...extraArgs] });
}

/** 'auto' uses a hardware GPU when one answers, 'on' insists on trying, 'off' always renders in software. */
export type GpuMode = 'auto' | 'on' | 'off';

export interface RenderBrowser {
  browser: Browser;
  /** WebGL renderer string, e.g. "ANGLE (NVIDIA, ...)" or "... SwiftShader ...". */
  renderer: string;
  /** False when WebGL runs on a software rasterizer (SwiftShader / llvmpipe). */
  gpu: boolean;
  /** Launches another browser with the same GL setup (for parallel workers). */
  launchAnother(): Promise<Browser>;
}

const SOFTWARE_GL = /swiftshader|llvmpipe|softpipe|software/i;

/** Chromium flag sets that put headless WebGL on the hardware GPU, most likely to work first. */
export function gpuFlagSets(): string[][] {
  const common = ['--enable-gpu', '--ignore-gpu-blocklist'];
  if (process.platform === 'darwin') return [[...common, '--use-angle=metal']];
  if (process.platform === 'win32') return [[...common, '--use-angle=d3d11']];
  return [
    [...common, '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface'],
    [...common, '--use-gl=angle', '--use-angle=gl-egl'],
  ];
}

/** On Linux a GPU shows up as a DRM render node or an NVIDIA device; elsewhere assume one may exist. */
function mayHaveGpu(): boolean {
  if (process.platform !== 'linux') return true;
  try {
    if (readdirSync('/dev/dri').some((f) => f.startsWith('renderD'))) return true;
  } catch {
    // no DRM devices
  }
  return existsSync('/dev/nvidia0');
}

export async function webglRenderer(browser: Browser): Promise<string> {
  const page = await browser.newPage();
  try {
    return await page.evaluate(() => {
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2');
      if (!gl) return '';
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    });
  } finally {
    await page.close();
  }
}

/** Flags that worked earlier in this process, so parallel workers and later renders skip probing. */
const chosenFlags = new Map<GpuMode, string[]>();

/**
 * Launches the browser used for export. With a GPU present (and `gpu` not 'off'), WebGL runs on it;
 * otherwise Chromium falls back to SwiftShader, which works everywhere but is far slower for heavy
 * filter stacks. `TASWEERIX_GPU` sets the default mode.
 */
export async function launchRenderBrowser(gpu: GpuMode = (process.env.TASWEERIX_GPU as GpuMode | undefined) ?? 'auto', flags?: string[]): Promise<RenderBrowser> {
  if (!['auto', 'on', 'off'].includes(gpu)) throw new Error(`GPU mode must be auto, on or off (got "${gpu}")`);
  const open = async (flags: string[]) => {
    const browser = await launchBrowser(flags);
    const renderer = await webglRenderer(browser).catch(() => '');
    return { browser, renderer, gpu: !!renderer && !SOFTWARE_GL.test(renderer), launchAnother: () => launchBrowser(flags) };
  };
  // Explicit GL flags (tests compare backends) skip the probing.
  if (flags) return open(flags);
  const known = chosenFlags.get(gpu);
  if (known) return open(known);
  const candidates = gpu === 'off' || (gpu === 'auto' && !mayHaveGpu()) ? [] : gpuFlagSets();
  for (const flags of candidates) {
    const b = await open(flags).catch(() => undefined);
    if (b?.gpu) {
      chosenFlags.set(gpu, flags);
      return b;
    }
    await b?.browser.close().catch(() => {});
  }
  chosenFlags.set(gpu, []);
  return open([]);
}
