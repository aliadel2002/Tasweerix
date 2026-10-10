import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PluginFormat, PluginRef, PluginRunRequest } from '../plugin-host';

/** A way to run plugins of some formats. Backends run synchronously because effect chains do. */
export interface PluginBackend {
  name: string;
  formats(): PluginFormat[];
  process(req: PluginRunRequest & { plugin: PluginRef & { format: PluginFormat } }): Float32Array[];
}

/** Version of the stdio protocol spoken with external plugin hosts (see docs/audio.md). */
export const PLUGIN_HOST_PROTOCOL = 1;

const MAX_BUFFER = 2 ** 31;

export function interleave(chs: Float32Array[]): Buffer {
  const n = chs[0]?.length ?? 0;
  const c = chs.length;
  const out = new Float32Array(n * c);
  for (let ch = 0; ch < c; ch++) {
    const src = chs[ch]!;
    for (let i = 0; i < n; i++) out[i * c + ch] = src[i]!;
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

export function deinterleave(buf: Buffer, channels: number): Float32Array[] {
  const frames = Math.floor(buf.length / 4 / channels);
  // Copy into an aligned buffer: child-process output can start at any byte offset.
  const all = new Float32Array(frames * channels);
  new Uint8Array(all.buffer).set(buf.subarray(0, frames * channels * 4));
  return Array.from({ length: channels }, (_, ch) => {
    const o = new Float32Array(frames);
    for (let i = 0; i < frames; i++) o[i] = all[i * channels + ch]!;
    return o;
  });
}

function spawnOrThrow(cmd: string[], input: Buffer, what: string, env?: NodeJS.ProcessEnv): Buffer {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { input, maxBuffer: MAX_BUFFER, env: env ?? process.env });
  if (r.error) throw new Error(`${what}: could not run ${cmd[0]}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${what}: ${cmd[0]} exited with ${r.status}: ${r.stderr.toString().slice(-2000)}`);
  return r.stdout;
}

/** Escapes a value for an ffmpeg filter option inside a filtergraph (both quoting levels). */
export function ffmpegFilterEscape(v: string): string {
  return v.replace(/[\\':]/g, '\\$&').replace(/[\\'[\],;]/g, '\\$&');
}

/** The `-af` filter for an LV2 or LADSPA plugin. */
export function ffmpegPluginFilter(plugin: PluginRef & { format: PluginFormat }, params: Record<string, unknown>): string {
  const controls = Object.entries(params)
    .map(([k, v]) => `${k}=${Number(v)}`)
    .join('|');
  const c = controls ? `:c=${ffmpegFilterEscape(controls)}` : '';
  if (plugin.format === 'lv2') {
    if (!plugin.uri) throw new Error('LV2 plugins need a URI');
    return `lv2=p=${ffmpegFilterEscape(plugin.uri)}${c}`;
  }
  if (!plugin.path) throw new Error('LADSPA plugins need the library path');
  return `ladspa=f=${ffmpegFilterEscape(plugin.path)}${plugin.id ? `:p=${ffmpegFilterEscape(plugin.id)}` : ''}${c}`;
}

let ffmpegFormats: PluginFormat[] | undefined;

/** LV2 and LADSPA through ffmpeg's `lv2` and `ladspa` filters (available when ffmpeg is built with them). */
export function ffmpegBackend(ffmpeg = process.env.TASWEERIX_FFMPEG ?? 'ffmpeg'): PluginBackend {
  return {
    name: 'ffmpeg',
    formats() {
      if (!ffmpegFormats) {
        const r = spawnSync(ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8' });
        const text = r.status === 0 ? r.stdout : '';
        ffmpegFormats = (['lv2', 'ladspa'] as const).filter((f) => new RegExp(`^\\s*\\S+\\s+${f}\\s`, 'm').test(text));
      }
      return ffmpegFormats;
    },
    process({ plugin, sampleRate, channels, params }) {
      const c = String(channels.length);
      const sr = String(sampleRate);
      const filter = ffmpegPluginFilter(plugin, params);
      const args = ['-v', 'error', '-f', 'f32le', '-ar', sr, '-ac', c, '-i', '-', '-af', filter, '-f', 'f32le', '-ar', sr, '-ac', c, '-'];
      // lilv only finds bundles on LV2_PATH; make sure a bundle given by path is on it.
      const env = { ...process.env };
      if (plugin.format === 'lv2' && plugin.path) {
        const sep = process.platform === 'win32' ? ';' : ':';
        env.LV2_PATH = [dirname(plugin.path), env.LV2_PATH ?? [join(homedir(), '.lv2'), '/usr/local/lib/lv2', '/usr/lib/lv2'].join(sep)].join(sep);
      }
      const out = spawnOrThrow([ffmpeg, ...args], interleave(channels), `${plugin.format} plugin ${plugin.uri ?? plugin.path}`, env);
      return deinterleave(out, channels.length);
    },
  };
}

/** Header the host sends back before the processed audio. */
interface HostReply {
  protocol: number;
  channels: number;
  frames: number;
}

function hostCommand(host: string | string[]): string[] {
  return Array.isArray(host) ? host : [host];
}

const hostFormats = new Map<string, PluginFormat[]>();

/**
 * VST3, CLAP and AU through an external host executable speaking the Tasweerix plugin-host
 * protocol over stdio:
 *
 *   `<host> capabilities` → stdout `{"protocol":1,"formats":["vst3","clap"]}`
 *   `<host> process` ← stdin: one JSON header line, then interleaved float32 little-endian frames
 *                    → stdout: one JSON header line `{"protocol":1,"channels":C,"frames":N}`, then frames
 *
 * The host returns as many frames as it received, already compensated for plugin latency.
 */
export function externalHostBackend(host: string | string[]): PluginBackend {
  const cmd = hostCommand(host);
  const key = JSON.stringify(cmd);
  return {
    name: `host:${cmd.join(' ')}`,
    formats() {
      let f = hostFormats.get(key);
      if (!f) {
        try {
          const out = spawnOrThrow([...cmd, 'capabilities'], Buffer.alloc(0), 'plugin host');
          const caps = JSON.parse(out.toString('utf8')) as { protocol?: number; formats?: PluginFormat[] };
          f = caps.protocol === PLUGIN_HOST_PROTOCOL ? (caps.formats ?? []) : [];
        } catch {
          f = [];
        }
        hostFormats.set(key, f);
      }
      return f;
    },
    process({ plugin, sampleRate, channels, params, state }) {
      const frames = channels[0]?.length ?? 0;
      const header = { protocol: PLUGIN_HOST_PROTOCOL, ...plugin, sampleRate, channels: channels.length, frames, params, state };
      const input = Buffer.concat([Buffer.from(JSON.stringify(header) + '\n', 'utf8'), interleave(channels)]);
      const out = spawnOrThrow([...cmd, 'process'], input, `${plugin.format} plugin ${plugin.path ?? plugin.id ?? plugin.name}`);
      const nl = out.indexOf(0x0a);
      if (nl < 0) throw new Error('plugin host: missing reply header');
      const reply = JSON.parse(out.subarray(0, nl).toString('utf8')) as HostReply;
      if (reply.protocol !== PLUGIN_HOST_PROTOCOL) throw new Error(`plugin host: unsupported protocol ${reply.protocol}`);
      return deinterleave(out.subarray(nl + 1), reply.channels);
    },
  };
}

/** Clears cached capability probes (after installing ffmpeg or a host, and in tests). */
export function resetPluginBackendCache(): void {
  ffmpegFormats = undefined;
  hostFormats.clear();
}
