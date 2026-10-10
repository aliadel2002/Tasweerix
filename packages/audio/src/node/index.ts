import { inferPluginFormat, setPluginRunner, type PluginFormat, type PluginRef, type PluginRunRequest } from '../plugin-host';
import { externalHostBackend, ffmpegBackend, type PluginBackend } from './backends';
import { findPlugin, scanPlugins, type PluginInfo } from './scan';

export * from './backends';
export * from './scan';

const backends: PluginBackend[] = [];
let scanned: PluginInfo[] | undefined;

/** Adds a backend; later registrations win for the formats they support. */
export function registerPluginBackend(b: PluginBackend): void {
  backends.unshift(b);
}

/** Uses an external host executable for VST3/CLAP/AU (same as setting `TASWEERIX_PLUGIN_HOST`). */
export function usePluginHost(host: string | string[]): void {
  registerPluginBackend(externalHostBackend(host));
}

/** Backends in priority order: registered ones, `TASWEERIX_PLUGIN_HOST`, then ffmpeg. */
export function pluginBackends(): PluginBackend[] {
  const env = process.env.TASWEERIX_PLUGIN_HOST;
  return [...backends, ...(env ? [externalHostBackend(env)] : []), ffmpegBackend()];
}

/** Formats that can be hosted right now, with the backend that runs each. */
export function hostableFormats(): Partial<Record<PluginFormat, string>> {
  const out: Partial<Record<PluginFormat, string>> = {};
  for (const b of pluginBackends()) for (const f of b.formats()) out[f] ??= b.name;
  return out;
}

/** Fills in path, URI and format for a plugin given by name, using a cached scan. */
export function resolvePluginRef(ref: PluginRef): PluginRef & { format: PluginFormat } {
  let r: PluginRef = { ...ref, format: inferPluginFormat(ref) };
  if (!r.path && !r.uri) {
    if (!r.name) throw new Error('afx.plugin: give a path, an LV2 URI or a plugin name');
    scanned ??= scanPlugins();
    const hit = findPlugin(r.name, scanned, r.format);
    if (!hit) throw new Error(`afx.plugin: no installed plugin named "${r.name}" (see \`tasweerix audio-plugins\`)`);
    r = { ...hit, ...r, path: hit.path, uri: hit.uri, format: hit.format };
  }
  if (!r.format) throw new Error(`afx.plugin: cannot tell the format of ${r.path}; pass { format }`);
  return r as PluginRef & { format: PluginFormat };
}

/** Runs a plugin over a buffer with the first backend that supports its format. */
export function runPlugin(req: PluginRunRequest): Float32Array[] {
  const plugin = resolvePluginRef(req.plugin);
  const pool = req.host ? [externalHostBackend(req.host), ...pluginBackends()] : pluginBackends();
  const backend = pool.find((b) => b.formats().includes(plugin.format));
  if (!backend) {
    const hint =
      plugin.format === 'lv2' || plugin.format === 'ladspa'
        ? `ffmpeg was built without the ${plugin.format} filter`
        : 'set TASWEERIX_PLUGIN_HOST to a plugin host executable (see docs/audio.md)';
    throw new Error(`afx.plugin: no backend can host ${plugin.format.toUpperCase()} plugins: ${hint}`);
  }
  return backend.process({ ...req, plugin });
}

/** Forgets the cached plugin scan (after installing plugins). */
export function rescanPlugins(): PluginInfo[] {
  scanned = scanPlugins();
  return scanned;
}

setPluginRunner(runPlugin);
