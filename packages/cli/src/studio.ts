import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { applyEdit, CodemodError, FrameMapper, inlineSourceMap, readProp, type Edit } from '@tasweerix/codemod';
import { createMediaHandler, createRequestGuard, isLoopbackHost, resolveProjectPath, serveStatic, MIME, TOKEN_PARAM } from '@tasweerix/media/node';
import { bundle, CLI_ROOT } from './bundle';
import { render } from './render';
import { renderAudioForExport } from './audio';
import { pluginCommands, type CommandContext } from '@tasweerix/core';
import { setupPlugins } from './plugins';
import { buildStudioApp } from './studio-app';

export interface StudioOptions {
  root: string;
  entry?: string;
  port?: number;
  host?: string;
  log?: (m: string) => void;
  /** Access token (random by default). Every request must carry it; see createRequestGuard. */
  token?: string;
}

/** A running studio. `url` is the server's address; `link` adds the access token and is what a browser opens. */
export interface Studio {
  url: string;
  link: string;
  token: string;
  close(): Promise<void>;
}

const STUDIO_APP = resolve(CLI_ROOT, '../../apps/studio');
const IGNORE = /(^|[\\/])(node_modules|\.git|\.tasweerix|out|dist)([\\/]|$)/;

function findEntry(root: string): string {
  for (const f of ['index.ts', 'main.ts', 'index.tsx', 'composition.ts', 'index.js']) if (existsSync(join(root, f))) return f;
  const ts = readdirSync(root).find((f) => /\.(ts|tsx|js)$/.test(f));
  if (!ts) throw new Error(`No entry file found in ${root}`);
  return ts;
}

function listFiles(root: string, dir = root, out: { path: string; size: number }[] = []): { path: string; size: number }[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(root, full);
    if (IGNORE.test(rel) || name.startsWith('.')) continue;
    const st = statSync(full);
    if (st.isDirectory()) listFiles(root, full, out);
    else out.push({ path: rel.split(sep).join('/'), size: st.size });
  }
  return out;
}

/** Maximum accepted request body (uploads, file writes, API posts). */
const MAX_BODY_BYTES = 100 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      req.destroy();
      throw new Error(`Request body too large (limit ${MAX_BODY_BYTES} bytes)`);
    }
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

const json = (res: ServerResponse, code: number, body: unknown) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));

/** The studio UI: built from apps/studio in a checkout, prebuilt into dist/studio in the published package. */
async function loadStudioApp(): Promise<{ js: string; css: string }> {
  if (existsSync(STUDIO_APP)) return buildStudioApp(STUDIO_APP);
  const dir = join(CLI_ROOT, 'dist/studio');
  return { js: readFileSync(join(dir, 'studio.js'), 'utf8'), css: readFileSync(join(dir, 'studio.css'), 'utf8') };
}

/**
 * Starts the studio: a local web editor for a project with live preview, timeline, inspector,
 * code editor and two-way editing (canvas / timeline / inspector changes rewrite the source).
 */
export async function startStudio(opts: StudioOptions): Promise<Studio> {
  const log = opts.log ?? (() => {});
  const root = resolve(opts.root);
  let entryRel = opts.entry ? relative(root, resolve(root, opts.entry)) : findEntry(root);
  // Built-in and tasweerix.config.ts plugins: host analyses for previews and studio commands.
  await setupPlugins(root);
  const app = await loadStudioApp();
  const media = createMediaHandler({ root });
  const host = opts.host ?? '127.0.0.1';
  // Binding to a LAN address is deliberate, so any Host header is accepted there; the token still is required.
  const guard = createRequestGuard({ allowAnyHost: !isLoopbackHost(host), token: opts.token });
  const projectPath = (p: string) => resolveProjectPath(root, p);
  /** A project-relative path for an entry file, which must exist inside the project. */
  const entryPath = (p: string) => {
    const abs = projectPath(p);
    if (!/\.(ts|tsx|mts|js|jsx|mjs)$/.test(abs) || !existsSync(abs) || !statSync(abs).isFile()) throw new Error(`Not a script file in the project: ${p}`);
    return relative(root, abs);
  };

  // ---- preview bundle state
  let version = 0;
  let preview = { code: '', error: '' as string | null, mapper: undefined as FrameMapper | undefined };
  // Tasweerix's own sources (monorepo packages) are never "user code", unless the project itself
  // lives inside that folder (as in tests).
  const packagesDir = resolve(CLI_ROOT, '..');
  const isUserFile = (absPath: string) => {
    const abs = resolve(absPath);
    if (!abs.startsWith(root + sep) || abs.includes(`${sep}node_modules${sep}`)) return false;
    if (abs.startsWith(packagesDir + sep) && !root.startsWith(packagesDir + sep)) return false;
    return true;
  };
  const rebuild = async () => {
    try {
      const { code } = await bundle({ entry: join(root, entryRel), platform: 'browser', runtime: join(CLI_ROOT, 'src/runtime/preview.ts'), sourcemap: true, outfile: join(root, '__preview.js') });
      const map = inlineSourceMap(code);
      // Source map paths are relative to the output dir (= project root).
      preview = { code, error: null, mapper: map ? new FrameMapper(map, (s) => isUserFile(resolve(root, s))) : undefined };
    } catch (e) {
      preview = { ...preview, error: String((e as Error).message ?? e) };
    }
    version++;
    broadcast({ type: 'reload', version, error: preview.error });
  };

  // ---- events (SSE)
  const clients = new Set<ServerResponse>();
  const broadcast = (msg: unknown) => {
    for (const c of clients) c.write(`data: ${JSON.stringify(msg)}\n\n`);
  };

  // ---- file history for undo/redo
  const history: { path: string; before: string; after: string }[] = [];
  let historyPos = 0;
  const writeTracked = (path: string, content: string) => {
    const abs = projectPath(path);
    const before = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
    if (before === content) return;
    history.splice(historyPos);
    history.push({ path, before, after: content });
    historyPos = history.length;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  // ---- watcher
  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(root, { recursive: true }, (_ev, file) => {
    if (!file || IGNORE.test(String(file)) || String(file).startsWith('__preview')) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      broadcast({ type: 'files', file: String(file).split(sep).join('/') });
      if (/\.(ts|tsx|js|mjs|json)$/.test(String(file))) void rebuild();
      else broadcast({ type: 'asset', file: String(file) });
    }, 80);
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    try {
      if (!guard.check(req, res)) return;
      // Opening the link sets the cookie; drop the token from the address bar.
      if (req.method === 'GET' && url.searchParams.has(TOKEN_PARAM)) {
        url.searchParams.delete(TOKEN_PARAM);
        return void res.writeHead(302, { location: `${url.pathname}${url.search}` }).end();
      }
      if (p === '/' || p === '/index.html') {
        res.writeHead(200, { 'content-type': MIME['.html']! }).end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tasweerix Studio</title><link rel="stylesheet" href="/studio.css"></head><body><div id="app"></div><script type="module" src="/studio.js"></script></body></html>`);
        return;
      }
      if (p === '/studio.js') return void res.writeHead(200, { 'content-type': MIME['.js']! }).end(app.js);
      if (p === '/studio.css') return void res.writeHead(200, { 'content-type': MIME['.css']! }).end(app.css);
      if (p === '/api/preview.js') {
        if (preview.error) return void res.writeHead(500, { 'content-type': 'text/plain' }).end(preview.error);
        return void res.writeHead(200, { 'content-type': MIME['.js']!, 'cache-control': 'no-store' }).end(preview.code);
      }
      if (p === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ type: 'hello', version, error: preview.error })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (p === '/api/state') return json(res, 200, { root, entry: entryRel, files: listFiles(root), version, error: preview.error, canUndo: historyPos > 0, canRedo: historyPos < history.length });
      if (p === '/api/file') {
        const path = url.searchParams.get('path') ?? entryRel;
        if (req.method === 'PUT') {
          writeTracked(path, (await readBody(req)).toString('utf8'));
          return json(res, 200, { ok: true });
        }
        // Read before writing the head, so a refused path still gets an error response.
        const content = readFileSync(projectPath(path), 'utf8');
        return void res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(content);
      }
      if (p === '/api/entry' && req.method === 'POST') {
        entryRel = entryPath((JSON.parse((await readBody(req)).toString()) as { entry: string }).entry);
        await rebuild();
        return json(res, 200, { entry: entryRel });
      }
      if (p === '/api/upload' && req.method === 'POST') {
        const path = url.searchParams.get('path') ?? '';
        const abs = projectPath(path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, await readBody(req));
        return json(res, 200, { path });
      }
      if (p === '/api/locate' && req.method === 'POST') {
        const { frames } = JSON.parse((await readBody(req)).toString()) as { frames: string[] };
        const loc = preview.mapper?.resolve(frames);
        return json(res, 200, loc ? { ...loc, file: relative(root, resolve(root, loc.file)).split(sep).join('/') } : null);
      }
      if (p === '/api/read-prop' && req.method === 'POST') {
        const { frames, key } = JSON.parse((await readBody(req)).toString()) as { frames: string[]; key: string };
        const loc = preview.mapper?.resolve(frames);
        if (!loc) return json(res, 200, { present: false, computed: true });
        return json(res, 200, readProp(readFileSync(resolve(root, loc.file), 'utf8'), loc.line, loc.column, key));
      }
      if (p === '/api/edit' && req.method === 'POST') {
        const { frames, edit } = JSON.parse((await readBody(req)).toString()) as { frames: string[]; edit: Omit<Edit, 'line' | 'column'> };
        const loc = preview.mapper?.resolve(frames);
        if (!loc) return json(res, 409, { error: 'Could not map this element back to source code' });
        const file = relative(root, resolve(root, loc.file)).split(sep).join('/');
        const src = readFileSync(resolve(root, file), 'utf8');
        try {
          const next = applyEdit(src, { ...edit, line: loc.line, column: loc.column } as Edit);
          writeTracked(file, next);
          return json(res, 200, { file, line: loc.line });
        } catch (e) {
          return json(res, e instanceof CodemodError ? 409 : 500, { error: (e as Error).message });
        }
      }
      if (p === '/api/commands') {
        const list = Object.entries(pluginCommands())
          .filter(([, d]) => d.studio)
          .map(([name, d]) => ({ name, label: d.studio!.label, prompt: d.studio!.prompt ?? null, description: d.description }));
        return json(res, 200, list);
      }
      if (p === '/api/command' && req.method === 'POST') {
        const { name, input, file } = JSON.parse((await readBody(req)).toString()) as { name: string; input?: string; file?: string };
        const def = pluginCommands()[name];
        if (!def?.studio) return json(res, 404, { error: `No studio command "${name}"` });
        const logs: string[] = [];
        const ctx: CommandContext = {
          args: [input ?? '', file ?? entryRel],
          options: {},
          cwd: root,
          host: 'studio',
          entry: entryRel,
          log: (m) => logs.push(m),
          readFile: async (path) => readFileSync(projectPath(path), 'utf8'),
          writeFile: async (path, content) => writeTracked(path, content),
          render: async (o) => {
            const r = await render({ entry: projectPath(o.entry), output: projectPath(o.output), root: o.root ? projectPath(o.root) : root, codec: o.codec as never, scale: o.scale, concurrency: o.concurrency ?? 2, props: o.props, renderAudio: renderAudioForExport, onProgress: o.onProgress });
            return { output: r.output, seconds: r.seconds };
          },
        };
        try {
          await def.run(ctx);
          return json(res, 200, { ok: true, log: logs });
        } catch (e) {
          return json(res, 500, { ok: false, log: logs, error: String((e as Error).message ?? e) });
        }
      }
      if ((p === '/api/undo' || p === '/api/redo') && req.method === 'POST') {
        const undo = p === '/api/undo';
        const step = undo ? history[historyPos - 1] : history[historyPos];
        if (!step) return json(res, 200, { ok: false });
        writeFileSync(projectPath(step.path), undo ? step.before : step.after);
        historyPos += undo ? -1 : 1;
        return json(res, 200, { ok: true, path: step.path });
      }
      if (p === '/api/export' && req.method === 'POST') {
        const o = JSON.parse((await readBody(req)).toString()) as { output: string; codec?: string; scale?: number; still?: boolean; frame?: number; comp?: string; concurrency?: number };
        const output = projectPath(o.output);
        json(res, 202, { output: relative(root, output) });
        broadcast({ type: 'export', state: 'start', output: relative(root, output) });
        render({
          entry: join(root, entryRel),
          root,
          output,
          comp: o.comp,
          codec: o.codec as never,
          scale: o.scale,
          still: o.still ? (o.frame ?? 0) : undefined,
          concurrency: o.concurrency ?? 2,
          renderAudio: renderAudioForExport,
          onProgress: (pr) => broadcast({ type: 'export', state: 'progress', ...pr }),
        })
          .then((r) => broadcast({ type: 'export', state: 'done', output: relative(root, r.output), seconds: r.seconds }))
          .catch((e) => broadcast({ type: 'export', state: 'error', error: String((e as Error).message ?? e) }));
        return;
      }
      if (await media(req, res)) return;
      if (p.startsWith('/project/') && serveStatic(root, req, res, p.slice('/project/'.length))) return;
      res.writeHead(404).end('not found');
    } catch (e) {
      log(`[studio] ${(e as Error)?.stack ?? e}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }).end((e as Error)?.message || 'Internal Server Error');
    }
  });
  await rebuild();
  await new Promise<void>((r) => server.listen(opts.port ?? 3000, host, r));
  const addr = server.address() as AddressInfo;
  const url = `http://${addr.family === 'IPv6' ? `[${addr.address}]` : addr.address}:${addr.port}`;
  const link = guard.link(url);
  log(`Tasweerix Studio → ${link}  (project: ${root}, entry: ${entryRel})`);
  if (!isLoopbackHost(host)) log('[studio] Listening beyond this machine: anyone with the link above can edit the project and run code in it. Share it only with people you trust.');
  return {
    url,
    link,
    token: guard.token,
    async close() {
      watcher.close();
      for (const c of clients) c.end();
      media.frames.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
