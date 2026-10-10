import { SourceMapConsumer, type RawSourceMap } from 'source-map-js';

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

/** Extracts the inline source map from bundled code. */
export function inlineSourceMap(code: string): RawSourceMap | undefined {
  const m = /\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)\s*$/.exec(code);
  if (!m) return undefined;
  return JSON.parse(Buffer.from(m[1]!, 'base64').toString('utf8')) as RawSourceMap;
}

/**
 * Maps captured stack frames ("url:line:col") through a bundle source map and returns the first
 * frame that belongs to user project code (not Tasweerix internals or node_modules).
 */
export class FrameMapper {
  private consumer: SourceMapConsumer;
  constructor(map: RawSourceMap, private isUserFile: (source: string) => boolean) {
    this.consumer = new SourceMapConsumer(map);
  }
  resolve(frames: string[]): SourceLocation | undefined {
    for (const f of frames) {
      const m = /:(\d+):(\d+)$/.exec(f);
      if (!m) continue;
      const pos = this.consumer.originalPositionFor({ line: Number(m[1]), column: Number(m[2]) - 1 });
      if (pos.source && pos.line && this.isUserFile(pos.source)) return { file: pos.source, line: pos.line, column: pos.column ?? 0 };
    }
    return undefined;
  }
}
