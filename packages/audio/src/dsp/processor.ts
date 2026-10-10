/** Block-based audio processor used by clip, bus and master effect chains. */
export interface AudioProcessor {
  /**
   * Processes `n` samples in place starting at sample `offset` of each channel buffer.
   * `params` are resolved for this block. `side` holds the sidechain signal, if any.
   */
  process(chs: Float32Array[], offset: number, n: number, params: Record<string, any>, side?: Float32Array[]): void;
  /** Seconds of signal the effect produces after the input ends (reverb, delay). */
  tail?(params: Record<string, any>): number;
}

export interface OfflineProcessor {
  /** Whole-buffer processing (normalization, noise reduction, time stretching). */
  offline(chs: Float32Array[], sampleRate: number, params: Record<string, any>, side?: Float32Array[]): Float32Array[];
  tail?(params: Record<string, any>): number;
}

export type ProcessorFactory = (sampleRate: number, channels: number) => AudioProcessor | OfflineProcessor;

export function isOffline(p: AudioProcessor | OfflineProcessor): p is OfflineProcessor {
  return typeof (p as OfflineProcessor).offline === 'function';
}
