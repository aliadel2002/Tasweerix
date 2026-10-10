import type { AudioData } from './buffer';

export type WavFormat = 'pcm16' | 'pcm24' | 'float32';

/** Encodes planar audio as a RIFF/WAVE file. */
export function encodeWav(a: AudioData, format: WavFormat = 'pcm16'): Uint8Array {
  const ch = a.channels.length;
  const len = a.channels[0]?.length ?? 0;
  const bps = format === 'pcm16' ? 2 : format === 'pcm24' ? 3 : 4;
  const dataSize = len * ch * bps;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, format === 'float32' ? 3 : 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, a.sampleRate, true);
  v.setUint32(28, a.sampleRate * ch * bps, true);
  v.setUint16(32, ch * bps, true);
  v.setUint16(34, bps * 8, true);
  str(36, 'data');
  v.setUint32(40, dataSize, true);
  let o = 44;
  // TPDF dither for integer formats.
  let seed = 22222;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const s = a.channels[c]![i]!;
      if (format === 'float32') {
        v.setFloat32(o, s, true);
        o += 4;
      } else if (format === 'pcm16') {
        const d = (rnd() - rnd()) / 32768;
        const x = Math.max(-1, Math.min(1, s + d));
        v.setInt16(o, Math.round(x < 0 ? x * 32768 : x * 32767), true);
        o += 2;
      } else {
        const x = Math.max(-1, Math.min(1, s));
        const n = Math.round(x < 0 ? x * 8388608 : x * 8388607);
        v.setUint8(o, n & 0xff);
        v.setUint8(o + 1, (n >> 8) & 0xff);
        v.setUint8(o + 2, (n >> 16) & 0xff);
        o += 3;
      }
    }
  }
  return new Uint8Array(buf);
}

/** Decodes PCM16/24/32 and float32 WAV files. */
export function decodeWav(bytes: ArrayBuffer | Uint8Array): AudioData {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = (o: number) => String.fromCharCode(u8[o]!, u8[o + 1]!, u8[o + 2]!, u8[o + 3]!);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let o = 12;
  let fmt = 1;
  let ch = 2;
  let rate = 48000;
  let bits = 16;
  while (o + 8 <= u8.length) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    if (id === 'fmt ') {
      fmt = v.getUint16(o + 8, true);
      ch = v.getUint16(o + 10, true);
      rate = v.getUint32(o + 12, true);
      bits = v.getUint16(o + 22, true);
      if (fmt === 0xfffe) fmt = v.getUint16(o + 32, true);
    } else if (id === 'data') {
      const bps = bits / 8;
      const n = Math.floor(size / (bps * ch));
      const out = Array.from({ length: ch }, () => new Float32Array(n));
      let p = o + 8;
      for (let i = 0; i < n; i++)
        for (let c = 0; c < ch; c++) {
          let s: number;
          if (fmt === 3) s = bits === 64 ? v.getFloat64(p, true) : v.getFloat32(p, true);
          else if (bits === 16) s = v.getInt16(p, true) / 32768;
          else if (bits === 24) {
            let x = u8[p]! | (u8[p + 1]! << 8) | (u8[p + 2]! << 16);
            if (x & 0x800000) x |= ~0xffffff;
            s = x / 8388608;
          } else if (bits === 32) s = v.getInt32(p, true) / 2147483648;
          else s = (u8[p]! - 128) / 128;
          out[c]![i] = s;
          p += bps;
        }
      return { sampleRate: rate, channels: out };
    }
    o += 8 + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}
