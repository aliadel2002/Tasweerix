import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequestGuard, isLoopbackHost, resolveProjectPath, serveStatic } from '../src/node';

describe('resolveProjectPath', () => {
  const base = mkdtempSync(join(tmpdir(), 'tasweerix-paths-'));
  const root = join(base, 'proj');
  mkdirSync(join(root, 'assets'), { recursive: true });
  mkdirSync(join(base, 'outside'));
  symlinkSync(join(base, 'outside'), join(root, 'escape'));
  symlinkSync(join(root, 'assets'), join(root, 'inner'));
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('keeps paths inside the project, following symlinks', () => {
    expect(resolveProjectPath(root, 'assets/a.png')).toBe(join(root, 'assets/a.png'));
    expect(resolveProjectPath(root, 'new/dir/file.ts')).toBe(join(root, 'new/dir/file.ts'));
    expect(resolveProjectPath(root, join(root, 'index.ts'))).toBe(join(root, 'index.ts'));
    expect(resolveProjectPath(root, 'inner/a.png')).toBe(join(root, 'inner/a.png'));
    expect(() => resolveProjectPath(root, '../outside/x')).toThrow(/escapes/);
    expect(() => resolveProjectPath(root, '/etc/passwd')).toThrow(/escapes/);
    expect(() => resolveProjectPath(root, 'escape/x.txt')).toThrow(/symlink/);
    expect(() => resolveProjectPath(root, 'escape/new/x.txt')).toThrow(/symlink/);
    expect(() => resolveProjectPath(root, 'https://example.com/x')).not.toThrow(); // a relative file name, never fetched
    expect(() => resolveProjectPath(root, 'a\0b')).toThrow(/Invalid/);
  });
});

describe('createRequestGuard', () => {
  let server: Server;
  let port: number;
  const guard = createRequestGuard({ token: 'secret-token' });
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (guard.check(req, res)) res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const send = (path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; cookie?: string }>((res, rej) => {
      const r = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (resp) => {
        resp.resume();
        resp.on('end', () => res({ status: resp.statusCode!, cookie: resp.headers['set-cookie']?.[0] }));
      });
      r.on('error', rej);
      r.end();
    });

  it('needs the token from a header, the query or the cookie', async () => {
    expect((await send('/x')).status).toBe(401);
    expect((await send('/x', { 'x-tasweerix-token': 'wrong' })).status).toBe(401);
    expect((await send('/x', { 'x-tasweerix-token': 'secret-token' })).status).toBe(200);
    const q = await send('/x?token=secret-token');
    expect(q.status).toBe(200);
    expect(q.cookie).toBe(`tasweerix-${port}=secret-token; HttpOnly; SameSite=Strict; Path=/`);
    expect((await send('/x', { cookie: `other=1; tasweerix-${port}=secret-token` })).status).toBe(200);
    expect((await send('/x', { cookie: `tasweerix-1=secret-token` })).status).toBe(401);
  });

  it('refuses foreign hosts and other origins even with the token', async () => {
    const t = { 'x-tasweerix-token': 'secret-token' };
    expect((await send('/x', { ...t, host: `evil.example:${port}` })).status).toBe(403);
    expect((await send('/x', { ...t, origin: 'https://evil.example' })).status).toBe(403);
    expect((await send('/x', { ...t, origin: 'http://127.0.0.1:1' })).status).toBe(403);
    expect((await send('/x', { ...t, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await send('/x', { ...t, 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await send('/x', { ...t, origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await send('/x', { ...t, host: `localhost:${port}` })).status).toBe(200);
  });

  it('links carry the token', () => {
    expect(guard.link('http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000/?token=secret-token');
    expect(createRequestGuard().token).not.toBe(createRequestGuard().token);
    expect(isLoopbackHost('[::1]') && isLoopbackHost('localhost') && !isLoopbackHost('0.0.0.0')).toBe(true);
  });
});

describe('serveStatic ranges', () => {
  const root = mkdtempSync(join(tmpdir(), 'tasweerix-static-'));
  writeFileSync(join(root, 'a.txt'), '0123456789');
  let server: Server;
  let port: number;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (!serveStatic(root, req, res)) res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  });
  const get = async (range: string) => {
    const r = await fetch(`http://127.0.0.1:${port}/a.txt`, { headers: { range } });
    return [r.status, await r.text()] as const;
  };

  it('answers valid ranges and refuses impossible ones', async () => {
    expect(await get('bytes=2-4')).toEqual([206, '234']);
    expect(await get('bytes=7-')).toEqual([206, '789']);
    expect(await get('bytes=-3')).toEqual([206, '789']);
    expect(await get('bytes=5-100')).toEqual([206, '56789']);
    expect((await get('bytes=8-2'))[0]).toBe(416);
    expect((await get('bytes=50-60'))[0]).toBe(416);
  });
});
