import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { audio, soundscape } from '@tasweerix/core';
import { afx, renderMix, toPluginRef } from '../src';
import {
  bundledPluginHost,
  defaultPluginPaths,
  describePlugin,
  externalHostBackend,
  ffmpegBackend,
  ffmpegFilterEscape,
  ffmpegPluginFilter,
  findPlugin,
  lv2PluginUris,
  resetPluginBackendCache,
  runPlugin,
  scanPlugins,
} from '../src/node';

const SR = 48000;
const HOST = [process.execPath, fileURLToPath(new URL('./fixtures/fake-plugin-host.mjs', import.meta.url))];
const sine = (n: number, amp = 0.5) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / SR) * amp);
const peak = (a: Float32Array) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);

afterEach(() => resetPluginBackendCache());

describe('plugin references', () => {
  it('infers formats from paths and URIs', () => {
    expect(toPluginRef('/x/Reverb.vst3')).toEqual({ path: '/x/Reverb.vst3', format: 'vst3' });
    expect(toPluginRef('C:\\Plugins\\Synth.clap').format).toBe('clap');
    expect(toPluginRef('/Library/Audio/Plug-Ins/Components/Delay.component/').format).toBe('au');
    expect(toPluginRef('/usr/lib/ladspa/amp.so').format).toBe('ladspa');
    expect(toPluginRef('http://plugin.org.uk/swh-plugins/amp')).toEqual({ uri: 'http://plugin.org.uk/swh-plugins/amp', format: 'lv2' });
    expect(toPluginRef('Valhalla Supermassive')).toEqual({ name: 'Valhalla Supermassive' });
  });

  it('builds an effect spec with flattened, animatable params and a tail', () => {
    const spec = afx.plugin('/x/Reverb.clap', { params: { mix: 0.3 }, tail: 4 });
    expect(spec.kind).toBe('plugin');
    expect(spec.params).toMatchObject({ plugin: { path: '/x/Reverb.clap', format: 'clap' }, 'param:mix': 0.3, tail: 4 });
  });
});

describe('plugin scanning', () => {
  it('uses the standard folders for each platform', () => {
    const env = {};
    expect(defaultPluginPaths('vst3', { platform: 'darwin', home: '/Users/a', env })).toEqual(['/Users/a/Library/Audio/Plug-Ins/VST3', '/Library/Audio/Plug-Ins/VST3']);
    expect(defaultPluginPaths('clap', { platform: 'linux', home: '/home/a', env })).toContain('/usr/lib/clap');
    expect(defaultPluginPaths('au', { platform: 'linux', home: '/home/a', env })).toEqual([]);
    expect(defaultPluginPaths('lv2', { platform: 'linux', home: '/home/a', env: { LV2_PATH: '/opt/lv2' } })).toEqual(['/opt/lv2']);
    expect(defaultPluginPaths('vst3', { platform: 'win32', home: 'C:\\Users\\a', env: { COMMONPROGRAMFILES: 'C:\\CPF' } })[0]).toMatch(/CPF.VST3$/);
  });

  it('parses LV2 manifests with prefixed and full URIs', () => {
    const ttl = `@prefix : <http://lv2plug.in/ns/lv2core#> .
@prefix lv2: <http://lv2plug.in/ns/lv2core#> .
@prefix swh: <http://plugin.org.uk/swh-plugins/> .
swh:amp a :Plugin ;
  :binary <plugin-linux.so> .
<http://example.org/verb>
    a lv2:Plugin, lv2:ReverbPlugin ;
    lv2:binary <verb.so> .
<http://example.org/ui> a <http://lv2plug.in/ns/extensions/ui#X11UI> .`;
    expect(lv2PluginUris(ttl)).toEqual(['http://plugin.org.uk/swh-plugins/amp', 'http://example.org/verb']);
  });

  it('finds bundles in vendor subfolders and reads their metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'tsx-plugins-'));
    const vst = join(root, 'vst3', 'Acme', 'Space.vst3', 'Contents', 'Resources');
    mkdirSync(vst, { recursive: true });
    writeFileSync(join(vst, 'moduleinfo.json'), `{ "Version": "1.2", "Factory Info": { "Vendor": "Acme", }, "Classes": [ { "Name": "Space Verb", "Category": "Audio Module Class", }, ], }`);
    mkdirSync(join(root, 'clap'), { recursive: true });
    writeFileSync(join(root, 'clap', 'Synth.clap'), '');
    const lv2 = join(root, 'lv2', 'amp.lv2');
    mkdirSync(lv2, { recursive: true });
    writeFileSync(join(lv2, 'manifest.ttl'), '@prefix lv2: <http://lv2plug.in/ns/lv2core#> .\n<urn:amp> a lv2:Plugin .');
    const plugins = scanPlugins({ paths: { vst3: [join(root, 'vst3')], clap: [join(root, 'clap')], lv2: [join(root, 'lv2')], au: [], ladspa: [] } });
    expect(plugins.map((p) => [p.format, p.name])).toEqual([
      ['clap', 'Synth'],
      ['lv2', 'amp'],
      ['vst3', 'Space Verb'],
    ]);
    expect(plugins.find((p) => p.format === 'vst3')).toMatchObject({ vendor: 'Acme', version: '1.2' });
    expect(findPlugin('space verb', plugins)?.format).toBe('vst3');
    expect(findPlugin('amp', plugins)?.uri).toBe('urn:amp');
  });
});

describe('external plugin host', () => {
  it('reports capabilities and processes audio over stdio', () => {
    const b = externalHostBackend(HOST);
    expect(b.formats()).toEqual(['vst3', 'clap']);
    const input = [sine(4800), sine(4800, 0.25)];
    const out = b.process({ plugin: { format: 'clap', path: '/p/gain.clap' }, sampleRate: SR, channels: input, params: { gain: -6.0206 } });
    expect(out).toHaveLength(2);
    expect(out[0]).toHaveLength(4800);
    expect(peak(out[0]!)).toBeCloseTo(0.25, 3);
    expect(peak(out[1]!)).toBeCloseTo(0.125, 3);
  });

  it('surfaces host errors', () => {
    expect(() => runPlugin({ plugin: { path: '/p/missing.vst3' }, sampleRate: SR, channels: [sine(10)], params: {}, host: HOST })).toThrow(/cannot load/);
  });

  it('runs as a clip effect inside a mix', async () => {
    const def = soundscape({ sampleRate: SR }, (c) => void c.audio(audio('a.wav').effect(afx.plugin('/p/gain.vst3', { params: { gain: -12 }, host: HOST }))));
    const comp = await def.create({ env: { kind: 'none', probe: async () => ({ duration: 1, hasAudio: true }) } });
    const { master } = await renderMix(comp, { load: async () => [sine(SR), sine(SR)], sampleRate: SR, channels: 2 });
    expect(peak(master.channels[0]!)).toBeCloseTo(0.5 * Math.pow(10, -12 / 20), 2);
  });
});

describe('ffmpeg LV2 and LADSPA backend', () => {
  it('escapes filter options at both filtergraph levels', () => {
    expect(ffmpegFilterEscape('http://x/y')).toBe('http\\\\://x/y');
    expect(ffmpegPluginFilter({ format: 'lv2', uri: 'urn:a' }, { gain: -6 })).toBe('lv2=p=urn\\\\:a:c=gain=-6');
    expect(ffmpegPluginFilter({ format: 'ladspa', path: '/l/amp.so', id: 'amp_mono' }, { c0: 0.5 })).toBe('ladspa=f=/l/amp.so:p=amp_mono:c=c0=0.5');
  });

  const ff = ffmpegBackend();
  const swhAmp = scanPlugins({ formats: ['lv2'] }).find((p) => p.uri === 'http://plugin.org.uk/swh-plugins/amp');
  it.skipIf(!ff.formats().includes('lv2') || !swhAmp)('hosts an installed LV2 plugin', () => {
    const out = runPlugin({ plugin: { uri: swhAmp!.uri }, sampleRate: SR, channels: [sine(4800), sine(4800)], params: { gain: -6.0206 } });
    expect(out[0]).toHaveLength(4800);
    expect(peak(out[1]!)).toBeCloseTo(0.25, 2);
  });

  const ladspaAmp = scanPlugins({ formats: ['ladspa'] }).find((p) => p.name === 'amp');
  it.skipIf(!ff.formats().includes('ladspa') || !ladspaAmp)('hosts an installed LADSPA plugin', () => {
    const out = runPlugin({ plugin: { path: ladspaAmp!.path, id: 'amp_mono' }, sampleRate: SR, channels: [sine(4800)], params: { c0: 0.5 } });
    expect(peak(out[0]!)).toBeCloseTo(0.25, 2);
  });
});

// Needs `pnpm build:plugin-host`, which also builds the test plugins next to the host.
describe('native plugin host', () => {
  const host = bundledPluginHost();
  const build = host ? dirname(host) : '';
  const clap = join(build, 'test-gain.clap');
  const vst3 = join(build.replace(/[\\/]Release$/, ''), 'VST3', 'Release', 'vst3-test-gain.vst3');
  const impulse = (n: number, at: number) => Float32Array.from({ length: n }, (_, i) => (i === at ? 1 : 0));
  const run = (path: string, channels: Float32Array[], params: Record<string, unknown> = {}, state?: string) =>
    runPlugin({ plugin: { path }, sampleRate: SR, channels, params, state, host: host! });

  it.skipIf(!host || !existsSync(clap))('hosts CLAP plugins with latency compensation, params and state', () => {
    expect(externalHostBackend(host!).formats()).toContain('clap');
    const d = describePlugin(clap, host!);
    expect(d).toMatchObject({ name: 'Test Gain', inputs: 2, outputs: 2 });
    expect(d.params[0]).toMatchObject({ id: '1', name: 'Gain', min: -60, max: 24 });
    // The plugin delays by 64 samples; the host must line the output back up.
    const [l, r] = run(clap, [impulse(2000, 100), impulse(2000, 700)], { Gain: -6.0206 });
    expect(l).toHaveLength(2000);
    expect(l![100]).toBeCloseTo(0.5, 4);
    expect(r![700]).toBeCloseTo(0.5, 4);
    expect(peak(l!.subarray(101))).toBe(0);
    // By id; a mono input feeds both channels of a stereo plugin.
    expect(run(clap, [impulse(1000, 10)], { '1': 6.0206 })[0]![10]).toBeCloseTo(2, 4);
    const state = join(mkdtempSync(join(tmpdir(), 'tsx-state-')), 'gain.bin');
    writeFileSync(state, Buffer.from(new Float32Array([-20]).buffer));
    expect(run(clap, [impulse(1000, 10)], {}, state)[0]![10]).toBeCloseTo(0.1, 4);
    expect(() => run(clap, [impulse(10, 0)], { Volume: 1 })).toThrow(/unknown parameter "Volume".*has: Gain/);
  });

  it.skipIf(!host || !existsSync(vst3))('hosts VST3 plugins with latency compensation and params', () => {
    expect(externalHostBackend(host!).formats()).toContain('vst3');
    const d = describePlugin(vst3, host!);
    expect(d).toMatchObject({ name: 'Test Gain VST3', vendor: 'Tasweerix', inputs: 2, outputs: 2 });
    expect(d.params[0]).toMatchObject({ name: 'Gain', min: -60, max: 24, default: 0 });
    const [l, r] = run(vst3, [impulse(3000, 1500), impulse(3000, 20)], { Gain: -6.0206 });
    expect(l).toHaveLength(3000);
    expect(l![1500]).toBeCloseTo(0.5, 3);
    expect(r![20]).toBeCloseTo(0.5, 3);
    expect(peak(r!.subarray(21))).toBe(0);
    expect(run(vst3, [impulse(600, 0)])[0]![0]).toBeCloseTo(1, 4);
  });

  it.skipIf(!host || !existsSync(clap))('runs CLAP plugins inside a mix', async () => {
    const def = soundscape({ sampleRate: SR }, (c) => void c.audio(audio('a.wav').effect(afx.plugin(clap, { params: { Gain: -12 }, host: host! }))));
    const comp = await def.create({ env: { kind: 'none', probe: async () => ({ duration: 1, hasAudio: true }) } });
    const { master } = await renderMix(comp, { load: async () => [sine(SR), sine(SR)], sampleRate: SR, channels: 2 });
    expect(peak(master.channels[1]!)).toBeCloseTo(0.5 * Math.pow(10, -12 / 20), 2);
  });
});
