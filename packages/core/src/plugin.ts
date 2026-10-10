import { registerEasing, type Easing } from './easing';
import { registerInterpolator, type Interpolator } from './interpolate';

/**
 * Plugins extend Tasweerix with new node drawers, filters, transitions, audio effects, exporters
 * and studio commands. Each package reads the sections it understands.
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
  /** Exporters (e.g. timeline interchange formats). */
  exporters?: Record<string, unknown>;
  /** Studio / CLI commands (e.g. future AI assistants). */
  commands?: Record<string, unknown>;
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
