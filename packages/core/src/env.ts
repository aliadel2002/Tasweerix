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
  /** Bits per color channel of the video/image stream (8 for most JPEG/PNG; 10, 12, 16 or 32 for high bit-depth sources). */
  bitDepth?: number;
  /** Color primaries the stream is tagged with, as ffprobe names them (bt709, bt2020, smpte432...). */
  colorPrimaries?: string;
  /** Transfer characteristic tag (bt709, smpte2084, arib-std-b67...). */
  colorTransfer?: string;
}

/** Host environment services (browser preview, headless export, Node tooling). */
export interface Env {
  kind: 'browser' | 'node' | 'none';
  probe(src: string): Promise<MediaInfo>;
  /** Decoded audio as planar float32 channels at the requested sample rate. */
  loadPcm?(src: string, sampleRate: number, channels: number): Promise<Float32Array[]>;
  /** Raw file bytes (fonts, impulse responses, LUTs …). */
  loadBinary?(src: string): Promise<ArrayBuffer>;
  /** Persistent analysis cache (invalidated when `src` changes on disk). */
  cache?: {
    get<T>(key: string, src?: string): Promise<T | undefined>;
    set(key: string, value: unknown, src?: string): Promise<void>;
  };
  /** Heavy media analysis performed by the host (e.g. ffmpeg scene detection). */
  analyze?(kind: string, src: string, params: Record<string, unknown>): Promise<unknown>;
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
