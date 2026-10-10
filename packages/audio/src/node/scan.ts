import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { PLUGIN_FORMATS, type PluginFormat, type PluginRef } from '../plugin-host';

/** An installed plugin found by `scanPlugins()`. */
export interface PluginInfo extends PluginRef {
  format: PluginFormat;
  name: string;
  path: string;
  vendor?: string;
  version?: string;
}

export interface ScanOptions {
  formats?: PluginFormat[];
  /** Folders to search instead of the platform defaults, per format. */
  paths?: Partial<Record<PluginFormat, string[]>>;
  platform?: NodeJS.Platform;
  home?: string;
  env?: Record<string, string | undefined>;
}

const EXT: Record<PluginFormat, RegExp> = {
  vst3: /\.vst3$/i,
  clap: /\.clap$/i,
  au: /\.component$/i,
  lv2: /\.lv2$/i,
  ladspa: /\.(so|dll|dylib)$/i,
};

/** Format-specific environment variable holding extra search folders. */
const ENV_VAR: Record<PluginFormat, string> = { vst3: 'VST3_PATH', clap: 'CLAP_PATH', au: 'AU_PATH', lv2: 'LV2_PATH', ladspa: 'LADSPA_PATH' };

/** The standard install folders for each format on each platform (the ones DAWs search). */
export function defaultPluginPaths(format: PluginFormat, o: Pick<ScanOptions, 'platform' | 'home' | 'env'> = {}): string[] {
  const platform = o.platform ?? process.platform;
  const home = o.home ?? homedir();
  const env = o.env ?? process.env;
  const extra = (env[ENV_VAR[format]] ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const common = env.COMMONPROGRAMFILES ?? 'C:\\Program Files\\Common Files';
  const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
  const mac = (dir: string) => [join(home, 'Library/Audio/Plug-Ins', dir), join('/Library/Audio/Plug-Ins', dir)];
  let std: string[] = [];
  if (platform === 'darwin') {
    std = { vst3: mac('VST3'), clap: mac('CLAP'), au: mac('Components'), lv2: mac('LV2'), ladspa: [join(home, '.ladspa'), '/usr/local/lib/ladspa'] }[format];
  } else if (platform === 'win32') {
    std = {
      vst3: [join(common, 'VST3'), join(local, 'Programs', 'Common', 'VST3')],
      clap: [join(common, 'CLAP'), join(local, 'Programs', 'Common', 'CLAP')],
      au: [],
      lv2: [join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'LV2'), join(common, 'LV2')],
      ladspa: [],
    }[format];
  } else {
    const lib = (dir: string) => [join(home, `.${dir}`), `/usr/local/lib/${dir}`, `/usr/lib/${dir}`, `/usr/lib/x86_64-linux-gnu/${dir}`, `/usr/lib/aarch64-linux-gnu/${dir}`];
    std = { vst3: lib('vst3'), clap: lib('clap'), au: [], lv2: lib('lv2'), ladspa: lib('ladspa') }[format];
  }
  // LV2_PATH and LADSPA_PATH replace the defaults by convention; the others add to them.
  const replaces = format === 'lv2' || format === 'ladspa';
  return [...new Set(replaces && extra.length ? extra : [...extra, ...std])];
}

/** Lists installed plugins by walking the standard folders. Nothing is loaded or executed. */
export function scanPlugins(o: ScanOptions = {}): PluginInfo[] {
  const out: PluginInfo[] = [];
  for (const format of o.formats ?? PLUGIN_FORMATS) {
    const seen = new Set<string>();
    for (const dir of o.paths?.[format] ?? defaultPluginPaths(format, o)) {
      for (const path of findBundles(dir, EXT[format], 4)) {
        if (seen.has(path)) continue;
        seen.add(path);
        out.push(...describeBundle(format, path));
      }
    }
  }
  return out.sort((a, b) => a.format.localeCompare(b.format) || a.name.localeCompare(b.name));
}

/** Finds a scanned plugin by name (case-insensitive), optionally restricted to a format. */
export function findPlugin(name: string, plugins: PluginInfo[], format?: PluginFormat): PluginInfo | undefined {
  const n = name.toLowerCase();
  const pool = plugins.filter((p) => !format || p.format === format);
  return pool.find((p) => p.name.toLowerCase() === n) ?? pool.find((p) => basename(p.path, extname(p.path)).toLowerCase() === n);
}

/** Bundles (folders or files with the format's extension), searching vendor subfolders. */
function findBundles(dir: string, ext: RegExp, depth: number): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries.sort()) {
    const p = join(dir, e);
    if (ext.test(e)) out.push(p);
    else if (depth > 0 && isDir(p)) out.push(...findBundles(p, ext, depth - 1));
  }
  return out;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readText(p: string): string | undefined {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

function describeBundle(format: PluginFormat, path: string): PluginInfo[] {
  const base: PluginInfo = { format, path, name: basename(path, extname(path)) };
  if (format === 'lv2') {
    const uris = lv2PluginUris(readText(join(path, 'manifest.ttl')) ?? '');
    return uris.length ? uris.map((uri) => ({ ...base, uri, name: uris.length > 1 ? `${base.name} ${uri.split(/[/#]/).pop()}` : base.name })) : [];
  }
  if (format === 'vst3') return [{ ...base, ...vst3ModuleInfo(path) }];
  if (format === 'au') return [{ ...base, ...auComponentInfo(path) }];
  return [base];
}

/** Subjects declared `a lv2:Plugin` in a bundle's manifest.ttl (prefixed names are expanded). */
export function lv2PluginUris(ttl: string): string[] {
  const prefixes = new Map<string, string>();
  for (const m of ttl.matchAll(/@prefix\s+([\w-]*):\s*<([^>]*)>\s*\./g)) prefixes.set(m[1]!, m[2]!);
  const expand = (t: string) => {
    if (t.startsWith('<')) return t.slice(1, -1);
    const i = t.indexOf(':');
    return (prefixes.get(t.slice(0, i)) ?? `${t.slice(0, i)}:`) + t.slice(i + 1);
  };
  const out: string[] = [];
  const body = ttl.replace(/^\s*#.*$/gm, '');
  for (const m of body.matchAll(/(<[^>\s]+>|[\w-]*:[\w.-]*)\s+a\s+((?:<[^>]*>|[^;.<])+)/g)) {
    const types = m[2]!.split(',').map((t) => expand(t.trim()));
    if (types.includes('http://lv2plug.in/ns/lv2core#Plugin')) out.push(expand(m[1]!));
  }
  return [...new Set(out)];
}

/** Name, vendor and version from a VST3 bundle's `Contents/Resources/moduleinfo.json` (VST3 SDK 3.7.5+). */
function vst3ModuleInfo(path: string): Partial<PluginInfo> {
  const text = readText(join(path, 'Contents', 'Resources', 'moduleinfo.json'));
  if (!text) return {};
  try {
    // moduleinfo.json is JSON5-ish: tolerate comments and trailing commas.
    const json = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')) as {
      Version?: string;
      'Factory Info'?: { Vendor?: string };
      Classes?: { Name?: string; Category?: string; Vendor?: string; Version?: string }[];
    };
    const cls = json.Classes?.find((c) => c.Category === 'Audio Module Class') ?? json.Classes?.[0];
    return defined({ name: cls?.Name, vendor: cls?.Vendor ?? json['Factory Info']?.Vendor, version: cls?.Version ?? json.Version });
  } catch {
    return {};
  }
}

/** Name and `type:subtype:manufacturer` id from an Audio Unit's Info.plist (first AudioComponents entry). */
function auComponentInfo(path: string): Partial<PluginInfo> {
  const plist = readText(join(path, 'Contents', 'Info.plist'));
  const section = plist?.split(/<key>AudioComponents<\/key>/)[1];
  if (!section) return {};
  const key = (k: string) => new RegExp(`<key>${k}</key>\\s*<(?:string|integer)>([^<]*)<`).exec(section)?.[1];
  const [type, subtype, manufacturer] = [key('type'), key('subtype'), key('manufacturer')];
  const full = key('name');
  // AU names are "Vendor: Plugin".
  const [vendor, name] = full?.includes(':') ? full.split(/:\s*/, 2) : [undefined, full];
  return defined({ name: name || undefined, vendor, id: type && subtype && manufacturer ? `${type}:${subtype}:${manufacturer}` : undefined });
}

/** Drops undefined fields so they don't override defaults when spread. */
function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
