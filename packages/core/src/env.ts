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
