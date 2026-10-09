import { clamp, lerp } from './math';

/** Straight (non-premultiplied) sRGB color with components in 0..1. */
export type RGBA = [number, number, number, number];
export type ColorInput = string | RGBA | [number, number, number];

const NAMED: Record<string, string> = {
  transparent: '#0000',
  black: '#000',
  white: '#fff',
  red: '#f00',
  green: '#008000',
  lime: '#0f0',
  blue: '#00f',
  yellow: '#ff0',
  cyan: '#0ff',
  aqua: '#0ff',
  magenta: '#f0f',
  fuchsia: '#f0f',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  maroon: '#800000',
  olive: '#808000',
  navy: '#000080',
  purple: '#800080',
  teal: '#008080',
  orange: '#ffa500',
  pink: '#ffc0cb',
  gold: '#ffd700',
  coral: '#ff7f50',
  crimson: '#dc143c',
  indigo: '#4b0082',
  violet: '#ee82ee',
  turquoise: '#40e0d0',
  salmon: '#fa8072',
  skyblue: '#87ceeb',
  tomato: '#ff6347',
  khaki: '#f0e68c',
  beige: '#f5f5dc',
  chocolate: '#d2691e',
  tan: '#d2b48c',
  slategray: '#708090',
  darkgray: '#a9a9a9',
  lightgray: '#d3d3d3',
  whitesmoke: '#f5f5f5',
};

const cache = new Map<string, RGBA | null>();

function parseComponent(s: string, max: number): number {
  s = s.trim();
  if (s.endsWith('%')) return clamp(parseFloat(s) / 100);
  return clamp(parseFloat(s) / max);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

export function tryParseColor(input: unknown): RGBA | null {
  if (Array.isArray(input)) {
    if ((input.length === 3 || input.length === 4) && input.every((n) => typeof n === 'number')) {
      return [input[0], input[1], input[2], input.length === 4 ? input[3] : 1];
    }
    return null;
  }
  if (typeof input !== 'string') return null;
  const key = input.trim().toLowerCase();
  if (cache.has(key)) return cache.get(key)!;
  let out: RGBA | null = null;
  const s = NAMED[key] ?? key;
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (/^[0-9a-f]+$/.test(hex)) {
      if (hex.length === 3 || hex.length === 4) {
        const v = hex.split('').map((c) => parseInt(c + c, 16) / 255);
        out = [v[0]!, v[1]!, v[2]!, v[3] ?? 1];
      } else if (hex.length === 6 || hex.length === 8) {
        const v = hex.match(/../g)!.map((c) => parseInt(c, 16) / 255);
        out = [v[0]!, v[1]!, v[2]!, v[3] ?? 1];
      }
    }
  } else {
    const m = /^(rgba?|hsla?)\((.*)\)$/.exec(s);
    if (m) {
      const parts = m[2]!.split(/[\s,/]+/).filter(Boolean);
      if (m[1]!.startsWith('rgb') && parts.length >= 3) {
        out = [
          parseComponent(parts[0]!, 255),
          parseComponent(parts[1]!, 255),
          parseComponent(parts[2]!, 255),
          parts[3] !== undefined ? parseComponent(parts[3], 1) : 1,
        ];
      } else if (parts.length >= 3) {
        const [r, g, b] = hslToRgb(
          parseFloat(parts[0]!),
          parseComponent(parts[1]!, 100),
          parseComponent(parts[2]!, 100),
        );
        out = [r, g, b, parts[3] !== undefined ? parseComponent(parts[3], 1) : 1];
      }
    }
  }
  cache.set(key, out);
  return out;
}

export function parseColor(input: ColorInput): RGBA {
  const c = tryParseColor(input);
  if (!c) throw new Error(`Invalid color: ${JSON.stringify(input)}`);
  return c;
}

export function isColorLike(v: unknown): boolean {
  return typeof v === 'string' && tryParseColor(v) !== null;
}

export function toCss(c: ColorInput): string {
  if (typeof c === 'string') return c;
  const [r, g, b, a] = parseColor(c);
  return `rgba(${Math.round(clamp(r) * 255)}, ${Math.round(clamp(g) * 255)}, ${Math.round(clamp(b) * 255)}, ${+clamp(a).toFixed(4)})`;
}

export function toHex(c: ColorInput, withAlpha = false): string {
  const [r, g, b, a] = parseColor(c);
  const h = (n: number) =>
    Math.round(clamp(n) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}${withAlpha ? h(a) : ''}`;
}

export const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export const linearToSrgb = (c: number): number =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;

/** sRGB (0..1) → OKLab */
export function rgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToRgb(L: number, A: number, B: number): [number, number, number] {
  const l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3);
  const m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3);
  const s = Math.pow(L - 0.0894841775 * A - 1.291485548 * B, 3);
  return [
    clamp(linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    clamp(linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    clamp(linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  ];
}

export type ColorSpace = 'oklab' | 'srgb' | 'linear' | 'hsl';

/** Perceptual color mix (OKLab by default). Alpha is mixed linearly. */
export function mixColor(colorA: ColorInput, colorB: ColorInput, t: number, space: ColorSpace = 'oklab'): RGBA {
  const ca = parseColor(colorA);
  const cb = parseColor(colorB);
  const alpha = lerp(ca[3], cb[3], t);
  if (space === 'srgb') {
    return [lerp(ca[0], cb[0], t), lerp(ca[1], cb[1], t), lerp(ca[2], cb[2], t), alpha];
  }
  if (space === 'linear') {
    return [
      linearToSrgb(lerp(srgbToLinear(ca[0]), srgbToLinear(cb[0]), t)),
      linearToSrgb(lerp(srgbToLinear(ca[1]), srgbToLinear(cb[1]), t)),
      linearToSrgb(lerp(srgbToLinear(ca[2]), srgbToLinear(cb[2]), t)),
      alpha,
    ];
  }
  if (space === 'hsl') {
    const ha = rgbToHsl(ca[0], ca[1], ca[2]);
    const hb = rgbToHsl(cb[0], cb[1], cb[2]);
    let dh = hb[0] - ha[0];
    if (dh > 180) dh -= 360;
    if (dh < -180) dh += 360;
    const [r, g, b] = hslToRgb(ha[0] + dh * t, lerp(ha[1], hb[1], t), lerp(ha[2], hb[2], t));
    return [r, g, b, alpha];
  }
  // Treat fully transparent endpoints as having the other color's hue so fades don't go grey.
  const la = rgbToOklab(...((ca[3] === 0 ? cb : ca).slice(0, 3) as [number, number, number]));
  const lb = rgbToOklab(...((cb[3] === 0 ? ca : cb).slice(0, 3) as [number, number, number]));
  const [r, g, b] = oklabToRgb(lerp(la[0], lb[0], t), lerp(la[1], lb[1], t), lerp(la[2], lb[2], t));
  return [r, g, b, alpha];
}

export function withAlpha(c: ColorInput, a: number): RGBA {
  const p = parseColor(c);
  return [p[0], p[1], p[2], a];
}

/** Relative luminance (Rec. 709 / sRGB). */
export function luminance(c: ColorInput): number {
  const [r, g, b] = parseColor(c);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

export function hsl(h: number, s: number, l: number, a = 1): RGBA {
  const [r, g, b] = hslToRgb(h, s, l);
  return [r, g, b, a];
}
export function rgb(r: number, g: number, b: number, a = 1): RGBA {
  return [r / 255, g / 255, b / 255, a];
}

/** Builds an evenly spaced palette between colors (OKLab). */
export function palette(colors: ColorInput[], count: number): RGBA[] {
  if (colors.length === 1) return Array.from({ length: count }, () => parseColor(colors[0]!));
  return Array.from({ length: count }, (_, i) => {
    const t = count === 1 ? 0 : (i / (count - 1)) * (colors.length - 1);
    const k = Math.min(Math.floor(t), colors.length - 2);
    return mixColor(colors[k]!, colors[k + 1]!, t - k);
  });
}
