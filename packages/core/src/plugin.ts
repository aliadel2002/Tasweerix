import { registerEasing, type Easing } from './easing';
import { registerInterpolator, type Interpolator } from './interpolate';

/** An option of a plugin command, in commander syntax (`'-o, --output <file>'`). */
export interface CommandOption {
  flags: string;
  description?: string;
  default?: string | number | boolean;
}

/** Services the host (CLI or studio) hands to a running command. */
export interface CommandContext {
  /** Positional arguments in declaration order. */
  args: string[];
  /** Parsed options (camelCased, as commander produces them). */
  options: Record<string, any>;
  /** Working directory (CLI) or project root (studio). */
  cwd: string;
  /** Where the command runs. */
  host: 'cli' | 'studio';
  log(message: string): void;
  /** Reads a project file (relative to `cwd`). */
  readFile(path: string): Promise<string>;
  /** Writes a project file. In the studio, writes join the undo history. */
  writeFile(path: string, content: string): Promise<void>;
  /** The entry file of the current project, when known. */
  entry?: string;
  /** Renders a composition entry to a file with the host's export pipeline. */
  render(o: CommandRenderOptions): Promise<{ output: string; seconds: number }>;
}

export interface CommandRenderOptions {
  entry: string;
  output: string;
  /** Asset root (default: the entry's folder). */
  root?: string;
  codec?: string;
  scale?: number;
  concurrency?: number;
  props?: Record<string, unknown>;
  onProgress?(p: { done: number; total: number }): void;
}

/** A CLI subcommand and, optionally, a studio action contributed by a plugin. */
export interface CommandDef {
  description: string;
  /** Positional arguments in commander syntax: `'<file>'`, `'[dir]'`. */
  args?: string[];
  options?: CommandOption[];
  /**
   * Shows the command in the studio. `prompt` is the placeholder of a text box whose content is passed
   * as the first argument; the second argument is the current file.
   */
  studio?: { label: string; prompt?: string };
  run(ctx: CommandContext): unknown | Promise<unknown>;
}

/**
 * Plugins extend Tasweerix with new node drawers, filters, transitions, audio effects, timeline
 * formats, host analyses, AI providers and studio/CLI commands. Each package reads the sections it
 * understands.
 */
export interface Plugin {
  name: string;
  /** Node kind → renderer drawer (see @tasweerix/render). */
  drawers?: Record<string, unknown>;
  /** Filter kind → shader / implementation (see @tasweerix/render). */
  filters?: Record<string, unknown>;
  transitions?: Record<string, unknown>;
  /** Audio effect kind → processor factory (see @tasweerix/audio). */
  audioEffects?: Record<string, unknown>;
  /** Audio generator kind → generator factory. */
  generators?: Record<string, unknown>;
  easings?: Record<string, Easing>;
  interpolators?: Interpolator[];
  /** Timeline formats that can be written (see @tasweerix/interchange `TimelineFormat`). */
  exporters?: Record<string, unknown>;
  /** Timeline formats that can be read (see @tasweerix/interchange `TimelineFormat`). */
  importers?: Record<string, unknown>;
  /** Host-side analyses served through `Env.analyze` (see @tasweerix/media/node `HostAnalysis`). */
  analyses?: Record<string, unknown>;
  /** AI providers (see @tasweerix/ai `AiProvider`). */
  aiProviders?: Record<string, unknown>;
  /** CLI subcommands and studio actions. */
  commands?: Record<string, CommandDef>;
  setup?(): void;
}

const plugins = new Map<string, Plugin>();
const listeners = new Set<(p: Plugin) => void>();

export function definePlugin(p: Plugin): Plugin {
  return p;
}

export function usePlugin(...ps: Plugin[]): void {
  for (const p of ps) {
    if (plugins.has(p.name)) continue;
    plugins.set(p.name, p);
    p.interpolators?.forEach(registerInterpolator);
    for (const [name, e] of Object.entries(p.easings ?? {})) registerEasing(name, e);
    p.setup?.();
    listeners.forEach((l) => l(p));
  }
}

export function getPlugins(): Plugin[] {
  return [...plugins.values()];
}

/** Lets packages react to plugin registration (e.g. the renderer registering drawers). */
export function onPlugin(fn: (p: Plugin) => void): () => void {
  listeners.add(fn);
  for (const p of plugins.values()) fn(p);
  return () => listeners.delete(fn);
}

/** Collects a section across all plugins. */
export function pluginSection<T>(key: keyof Plugin): Record<string, T> {
  const out: Record<string, T> = {};
  for (const p of plugins.values()) Object.assign(out, (p[key] as Record<string, T> | undefined) ?? {});
  return out;
}

/** All commands contributed by registered plugins. */
export function pluginCommands(): Record<string, CommandDef> {
  return pluginSection<CommandDef>('commands');
}
