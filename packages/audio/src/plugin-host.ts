import type { AudioEffectSpec } from '@tasweerix/core';

/** Third-party audio plugin formats Tasweerix can host (out of process, see `@tasweerix/audio/node`). */
export type PluginFormat = 'vst3' | 'clap' | 'au' | 'lv2' | 'ladspa';

export const PLUGIN_FORMATS: readonly PluginFormat[] = ['vst3', 'clap', 'au', 'lv2', 'ladspa'];

/**
 * Identifies a plugin. Give a `path` (bundle or library), an LV2 `uri`, or just a `name` that the
 * scanner resolves against the installed plugins.
 */
export interface PluginRef {
  format?: PluginFormat;
  /** Bundle or library on disk (`Reverb.vst3`, `Synth.clap`, `amp.so`, `Delay.component`). */
  path?: string;
  /** LV2 plugin URI. */
  uri?: string;
  /** Plugin inside a multi-plugin file: CLAP id, VST3 class name, LADSPA label, AU `type:subtype:manufacturer`. */
  id?: string;
  /** Display name, resolved with `scanPlugins()` when no path or URI is given. */
  name?: string;
}

export interface PluginEffectOptions {
  /**
   * Parameter values by id or symbol (LV2 symbol, LADSPA `c0`…, VST3/CLAP parameter id or name).
   * Plugins are rendered offline, so animated values are sampled once at the start of the clip or bus.
   */
  params?: Record<string, unknown>;
  /** Preset or saved state file passed to the host (`.vstpreset`, `.clap-state`, `.aupreset`). */
  state?: string;
  /** Seconds of signal the plugin produces after the input ends (reverb and delay tails). */
  tail?: number;
  /** Host executable for VST3/CLAP/AU (overrides `TASWEERIX_PLUGIN_HOST`); an array is a command with arguments. */
  host?: string | string[];
}

/** Infers the format from a path's extension or an LV2 URI. */
export function inferPluginFormat(ref: PluginRef): PluginFormat | undefined {
  if (ref.format) return ref.format;
  if (ref.uri) return 'lv2';
  const p = (ref.path ?? '').replace(/[\\/]+$/, '').toLowerCase();
  if (p.endsWith('.vst3')) return 'vst3';
  if (p.endsWith('.clap')) return 'clap';
  if (p.endsWith('.component')) return 'au';
  if (p.endsWith('.lv2')) return 'lv2';
  if (/\.(so|dll|dylib)$/.test(p)) return 'ladspa';
  return undefined;
}

/** Normalizes the argument of `afx.plugin()`: a path, an LV2 URI, a plugin name or a full reference. */
export function toPluginRef(ref: string | PluginRef): PluginRef {
  if (typeof ref !== 'string') return { ...ref, format: inferPluginFormat(ref) };
  if (/^[a-z][\w+.-]*:\/\//i.test(ref) || ref.startsWith('urn:')) return { uri: ref, format: 'lv2' };
  const asPath: PluginRef = { path: ref };
  const format = inferPluginFormat(asPath);
  if (format || /[\\/]/.test(ref)) return { ...asPath, format };
  return { name: ref };
}

/** The request a plugin runner receives: input channels (already padded for the tail) and settings. */
export interface PluginRunRequest {
  plugin: PluginRef;
  sampleRate: number;
  channels: Float32Array[];
  params: Record<string, unknown>;
  state?: string;
  host?: string | string[];
}

/** Processes a whole buffer through a plugin and returns as many frames as it was given. */
export type PluginRunner = (req: PluginRunRequest) => Float32Array[];

const PARAM_PREFIX = 'param:';
let runner: PluginRunner | undefined;
let warned = false;

/** Installs the plugin runner. `@tasweerix/audio/node` installs one that drives ffmpeg and external hosts. */
export function setPluginRunner(r: PluginRunner | undefined): void {
  runner = r;
}

export function getPluginRunner(): PluginRunner | undefined {
  return runner;
}

/** Spec for the `plugin` effect (see `afx.plugin`). */
export function pluginEffectSpec(ref: string | PluginRef, o: PluginEffectOptions = {}): AudioEffectSpec {
  const params: Record<string, unknown> = { plugin: toPluginRef(ref) };
  // Flattened so the mixer resolves animated values like any other effect parameter.
  for (const [k, v] of Object.entries(o.params ?? {})) params[PARAM_PREFIX + k] = v;
  if (o.state !== undefined) params.state = o.state;
  if (o.tail !== undefined) params.tail = o.tail;
  if (o.host !== undefined) params.host = o.host;
  return { kind: 'plugin', params: params as AudioEffectSpec['params'] };
}

function pluginValues(p: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) if (k.startsWith(PARAM_PREFIX)) out[k.slice(PARAM_PREFIX.length)] = v;
  return out;
}

export const pluginProcessor = () => ({
  offline(chs: Float32Array[], sampleRate: number, p: Record<string, any>): Float32Array[] {
    if (!runner) {
      if (!warned) console.warn('[tasweerix] audio plugins need Node: import "@tasweerix/audio/node" (plugins are bypassed in the browser preview)');
      warned = true;
      return chs;
    }
    const out = runner({ plugin: p.plugin as PluginRef, sampleRate, channels: chs, params: pluginValues(p), state: p.state, host: p.host });
    // Keep the buffer length the mixer allotted (clip duration plus the declared tail).
    const len = chs[0]?.length ?? 0;
    return chs.map((_, c) => {
      const src = out[c] ?? out[out.length - 1] ?? new Float32Array(0);
      if (src.length === len) return src;
      const o = new Float32Array(len);
      o.set(src.subarray(0, len));
      return o;
    });
  },
  tail: (p: Record<string, any>) => Number(p.tail) || 0,
});
