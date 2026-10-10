/** A timed piece of speech. Times are in source seconds. */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  /** Word timings when the provider returns them. */
  words?: { start: number; end: number; text: string }[];
}

export interface Transcript {
  /** Detected or requested language (BCP 47 / ISO 639-1, e.g. "ar", "en"). */
  language?: string;
  segments: TranscriptSegment[];
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** An image handed to a model: encoded bytes plus their media type. */
export interface AiImage {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  /** Base64 data (no data: prefix). */
  data: string;
}

export interface GenerateRequest {
  prompt: string;
  system?: string;
  images?: AiImage[];
  /** JSON Schema of the expected answer (the provider returns JSON text matching it). */
  schema?: Record<string, unknown>;
  effort?: Effort;
  maxTokens?: number;
  /** Model override (provider specific). */
  model?: string;
  /** Large stable text sent before the prompt (cached by providers that support it). */
  context?: string;
}

export interface GenerateResult {
  text: string;
  model?: string;
  /** Provider usage numbers, when known. */
  usage?: Record<string, number>;
}

export interface TranscribeRequest {
  /** Absolute path of a 16 kHz mono WAV file prepared by the host. */
  file: string;
  language?: string;
  /** Vocabulary or context that helps recognition (names, terms). */
  prompt?: string;
}

/**
 * An AI backend. Register providers with `registerAiProvider` or a plugin's `aiProviders` section.
 * A provider implements any subset of the capabilities.
 */
export interface AiProvider {
  name: string;
  generate?(req: GenerateRequest): Promise<GenerateResult>;
  transcribe?(req: TranscribeRequest): Promise<Transcript>;
}
