import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { createMediaHandler, serveStatic } from '@tasweerix/media/node';

export interface RenderServerOptions {
  projectRoot: string;
  /** Bundled page script. */
  script: string;
  /** Extra route handler (studio API etc.). Return true when handled. */
  extra?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean;
  onFrame?: (client: number, frame: number, data: Buffer) => void;
}

export interface RenderServer {
  url: string;
  server: Server;
  close(): Promise<void>;
  setScript(code: string): void;
  sockets: Map<number, WebSocket>;
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Tasweerix render</title>
<style>html,body{margin:0;background:transparent}</style></head><body><script type="module" src="/__tx/bundle.js"></script></body></html>`;

export async function startRenderServer(opts: RenderServerOptions): Promise<RenderServer> {
  let script = opts.script;
  const media = createMediaHandler({ root: opts.projectRoot });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (opts.extra && (await opts.extra(req, res))) return;
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
        return;
      }
      if (url.pathname === '/__tx/bundle.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }).end(script);
        return;
      }
      if (await media(req, res)) return;
      if (url.pathname.startsWith('/project/') && serveStatic(opts.projectRoot, req, res, url.pathname.slice('/project/'.length))) return;
      res.writeHead(404).end('not found');
    } catch (e) {
      if (!res.headersSent) res.writeHead(500).end(String(e));
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 * 1024 });
  const sockets = new Map<number, WebSocket>();
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/__tx/ws') return socket.destroy();
    const client = Number(url.searchParams.get('client') ?? 0);
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.set(client, ws);
      ws.on('message', (data: Buffer, isBinary) => {
        if (!isBinary) return;
        const frame = data.readUInt32LE(0);
        opts.onFrame?.(client, frame, data.subarray(4));
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    sockets,
    setScript: (c) => (script = c),
    async close() {
      media.frames.close();
      for (const s of sockets.values()) s.terminate();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
