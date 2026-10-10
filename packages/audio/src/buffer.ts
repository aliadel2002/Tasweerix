/** Planar float32 audio. */
export interface AudioData {
  sampleRate: number;
  channels: Float32Array[];
}

export function createAudio(channels: number, length: number, sampleRate: number): AudioData {
  return { sampleRate, channels: Array.from({ length: channels }, () => new Float32Array(Math.max(0, Math.ceil(length)))) };
}

export function lengthOf(a: AudioData): number {
  return a.channels[0]?.length ?? 0;
}

export function durationOf(a: AudioData): number {
  return lengthOf(a) / a.sampleRate;
}

export function cloneAudio(a: AudioData): AudioData {
  return { sampleRate: a.sampleRate, channels: a.channels.map((c) => new Float32Array(c)) };
}

/** Converts to the requested channel count (mono↔stereo up/down mix). */
export function toChannels(a: AudioData, n: number): AudioData {
  if (a.channels.length === n) return a;
  const len = lengthOf(a);
  if (n === 1) {
    const m = new Float32Array(len);
    for (const c of a.channels) for (let i = 0; i < len; i++) m[i]! += c[i]! / a.channels.length;
    return { sampleRate: a.sampleRate, channels: [m] };
  }
  return { sampleRate: a.sampleRate, channels: Array.from({ length: n }, (_, i) => new Float32Array(a.channels[Math.min(i, a.channels.length - 1)]!)) };
}

/** Slice by sample indices (clamped, zero-padded when out of range). */
export function sliceAudio(a: AudioData, start: number, end: number): AudioData {
  const len = Math.max(0, Math.round(end - start));
  const out = createAudio(a.channels.length, len, a.sampleRate);
  const s = Math.round(start);
  a.channels.forEach((c, ch) => {
    const from = Math.max(0, s);
    const to = Math.min(c.length, s + len);
    if (to > from) out.channels[ch]!.set(c.subarray(from, to), from - s);
  });
  return out;
}

export function reverseAudio(a: AudioData): AudioData {
  return { sampleRate: a.sampleRate, channels: a.channels.map((c) => new Float32Array(c).reverse()) };
}

/** Mixes src into dst at a sample offset, with gain. */
export function mixInto(dst: AudioData, src: AudioData, offset = 0, gain = 1): void {
  const off = Math.round(offset);
  for (let ch = 0; ch < dst.channels.length; ch++) {
    const d = dst.channels[ch]!;
    const s = src.channels[Math.min(ch, src.channels.length - 1)]!;
    const from = Math.max(0, -off);
    const to = Math.min(s.length, d.length - off);
    for (let i = from; i < to; i++) d[i + off]! += s[i]! * gain;
  }
}

export function peak(a: AudioData): number {
  let p = 0;
  for (const c of a.channels) for (let i = 0; i < c.length; i++) p = Math.max(p, Math.abs(c[i]!));
  return p;
}

export function rms(a: AudioData, start = 0, end = lengthOf(a)): number {
  let s = 0;
  let n = 0;
  for (const c of a.channels)
    for (let i = Math.max(0, start); i < Math.min(end, c.length); i++) {
      s += c[i]! * c[i]!;
      n++;
    }
  return n ? Math.sqrt(s / n) : 0;
}

export function scaleAudio(a: AudioData, g: number): AudioData {
  for (const c of a.channels) for (let i = 0; i < c.length; i++) c[i]! *= g;
  return a;
}

/**
 * High-quality resampling with a windowed-sinc (Lanczos, a=8) kernel.
 * `ratio` = output rate / input rate. Used for sample-rate conversion and varispeed.
 */
export function resample(a: AudioData, ratio: number, outRate = a.sampleRate * ratio): AudioData {
  if (Math.abs(ratio - 1) < 1e-9) return { sampleRate: outRate, channels: a.channels.map((c) => new Float32Array(c)) };
  const len = lengthOf(a);
  const outLen = Math.max(0, Math.floor(len * ratio));
  const A = 8;
  const cutoff = Math.min(1, ratio); // anti-alias when downsampling
  const out = createAudio(a.channels.length, outLen, outRate);
  for (let ch = 0; ch < a.channels.length; ch++) {
    const src = a.channels[ch]!;
    const dst = out.channels[ch]!;
    for (let i = 0; i < outLen; i++) {
      const x = i / ratio;
      const center = Math.floor(x);
      let sum = 0;
      let wsum = 0;
      const span = Math.ceil(A / cutoff);
      for (let k = center - span + 1; k <= center + span; k++) {
        if (k < 0 || k >= len) continue;
        const d = (x - k) * cutoff;
        let w: number;
        if (Math.abs(d) < 1e-9) w = 1;
        else if (Math.abs(d) >= A) w = 0;
        else {
          const pd = Math.PI * d;
          w = ((A * Math.sin(pd) * Math.sin(pd / A)) / (pd * pd));
        }
        sum += src[k]! * w;
        wsum += w;
      }
      dst[i] = wsum > 0 ? sum / wsum : 0;
    }
  }
  return out;
}

/** Fast linear-interpolation resample (for previews / analysis). */
export function resampleLinear(a: AudioData, ratio: number, outRate = a.sampleRate * ratio): AudioData {
  const len = lengthOf(a);
  const outLen = Math.max(0, Math.floor(len * ratio));
  const out = createAudio(a.channels.length, outLen, outRate);
  for (let ch = 0; ch < a.channels.length; ch++) {
    const s = a.channels[ch]!;
    const d = out.channels[ch]!;
    for (let i = 0; i < outLen; i++) {
      const x = i / ratio;
      const k = Math.floor(x);
      const f = x - k;
      d[i] = (s[k] ?? 0) * (1 - f) + (s[k + 1] ?? s[k] ?? 0) * f;
    }
  }
  return out;
}
