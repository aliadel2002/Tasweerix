import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../src/server';

const repo = resolve(__dirname, '../../..');
const out = join('packages', 'mcp', 'test', '.tmp-out');
let client: Client;

const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult;
const textOf = (r: CallToolResult) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

beforeAll(async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer({ projectDir: repo }).connect(a);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
});

afterAll(async () => {
  await client.close();
  rmSync(join(repo, out), { recursive: true, force: true });
});

describe('tasweerix MCP server', () => {
  it('lists its tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['analyze_audio', 'doctor', 'inspect_composition', 'list_audio_plugins', 'probe_media', 'read_docs', 'render_audio', 'render_still', 'render_video', 'suggest_cuts'].sort(),
    );
  });

  it('checks the setup', async () => {
    expect(textOf(await call('doctor'))).toMatch(/FFmpeg[\s\S]*Chromium/);
  });

  it('reads the docs', async () => {
    expect(textOf(await call('read_docs'))).toMatch(/^3d: 3D scenes$/m);
    expect(textOf(await call('read_docs', { topic: 'vision' }))).toContain('# Stabilization and tracking');
    expect((await call('read_docs', { topic: 'nope' })).isError).toBe(true);
  });

  it('inspects a composition as a compact tree', async () => {
    const info = JSON.parse(textOf(await call('inspect_composition', { entry: 'examples/hello/index.ts', depth: 1 })));
    expect(info).toMatchObject({ width: 640, height: 360, fps: 30, duration: 3 });
    expect(info.root.kind).toBe('group');
    expect(JSON.stringify(info.root)).toContain('children (raise depth');
  });

  it('reports a composition that fails to load', async () => {
    const r = await call('inspect_composition', { entry: 'examples/missing.ts' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('failed');
  });

  it('renders a frame and returns a preview image', async () => {
    const output = join(out, 'hello.png');
    const r = await call('render_still', { entry: 'examples/hello/index.ts', time: 1, output });
    expect(r.isError).toBeFalsy();
    const image = r.content.find((c) => c.type === 'image');
    expect(image?.mimeType).toBe('image/jpeg');
    expect(textOf(r)).toContain('frame 30');
    expect(existsSync(join(repo, output))).toBe(true);
  });

  it('renders a short video with progress', async () => {
    const output = join(out, 'hello.mp4');
    const progress: number[] = [];
    const r = (await client.callTool({ name: 'render_video', arguments: { entry: 'examples/hello/index.ts', output, range: '0-9', concurrency: 1 } }, undefined, {
      onprogress: (p) => progress.push(p.progress),
    })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('hello.mp4');
    expect(existsSync(join(repo, output))).toBe(true);
    expect(progress.at(-1)).toBe(10);
  });

  it('probes, analyzes and cuts media', async () => {
    expect(textOf(await call('probe_media', { file: 'examples/smart-edit/assets/talk.mp4' }))).toContain('duration');
    const a = JSON.parse(textOf(await call('analyze_audio', { file: 'examples/smart-edit/assets/beat.mp3' })));
    expect(a.bpm).toBeGreaterThan(0);
    expect(a.beats.length).toBeLessThanOrEqual(32);
    expect(textOf(await call('suggest_cuts', { file: 'examples/smart-edit/assets/talk.mp4', mode: 'silence' }))).toContain('sequence(');
  });
});
