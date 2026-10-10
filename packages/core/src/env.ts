/** Information about a media file. */
export interface MediaInfo {
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasVideo?: boolean;
  hasAudio?: boolean;
  sampleRate?: number;
  channels?: number;
  codec?: string;
  rotation?: number;
}

/** Host environment services (browser preview, headless export, Node tooling). */
export interface Env {
  kind: 'browser' | 'node' | 'none';
  probe(src: string): Promise<MediaInfo>;
  /** Decoded audio as planar float32 channels at the requested sample rate. */
  loadPcm?(src: string, sampleRate: number, channels: number): Promise<Float32Array[]>;
  /** Raw file bytes (fonts, impulse responses, LUTs …). */
  loadBinary?(src: string): Promise<ArrayBuffer>;
}

/** Anything that needs async loading before rendering (audio analysis, fonts, data files). */
export interface Preparable {
  prepare(env: Env): Promise<void>;
}

export const nullEnv: Env = {
  kind: 'none',
  probe: async () => ({}),
};

let currentEnv: Env = nullEnv;
export function setEnv(env: Env): void {
  currentEnv = env;
}
export function getEnv(): Env {
  return currentEnv;
}
