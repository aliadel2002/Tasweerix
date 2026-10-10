declare module '*.wasm' {
  const bytes: Uint8Array;
  export default bytes;
}
declare module 'harfbuzzjs/hb.js' {
  const createHarfBuzz: (opts: { wasmBinary?: Uint8Array | ArrayBuffer }) => Promise<unknown>;
  export default createHarfBuzz;
}
declare module 'harfbuzzjs/hbjs.js' {
  const hbjs: (module: unknown) => HarfBuzz;
  export default hbjs;
}

interface HbFont {
  ptr: number;
  glyphToPath(gid: number): string;
  setScale(x: number, y: number): void;
  setVariations(v: Record<string, number>): void;
  destroy(): void;
}
interface HbFace {
  ptr: number;
  upem: number;
  reference_table(tag: string): Uint8Array | undefined;
  collectUnicodes(): Uint32Array;
  destroy(): void;
}
interface HbBuffer {
  addText(t: string): void;
  guessSegmentProperties(): void;
  setDirection(d: 'ltr' | 'rtl' | 'ttb' | 'btt'): void;
  setScript(s: string): void;
  setLanguage(l: string): void;
  setClusterLevel(level: number): void;
  json(): { g: number; cl: number; ax: number; ay: number; dx: number; dy: number; flags: number }[];
  destroy(): void;
}
interface HarfBuzz {
  createBlob(data: ArrayBuffer | Uint8Array): { ptr: number; destroy(): void };
  createFace(blob: { ptr: number }, index: number): HbFace;
  createFont(face: HbFace): HbFont;
  createBuffer(): HbBuffer;
  shape(font: HbFont, buffer: HbBuffer, features?: string): void;
  version_string(): string;
}
