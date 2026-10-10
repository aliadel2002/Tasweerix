import { mapKeyed, type TEffect, type TKeyed } from './model';

/** Reads a numeric effect parameter by any of its names (case-insensitive), static or keyframed. */
export type ParamReader = (...names: string[]) => TKeyed<number> | undefined;

export interface MappedEffect {
  effect: TEffect;
  /** Units or behavior differ from the editor's: the import lists it for a check. */
  approximate: boolean;
}

/** Percent values (−100 … 100) become fractions; values already in −1.5 … 1.5 stay. */
const pct = (v: number) => (Math.abs(v) > 1.5 ? v / 100 : v);
const div = (k: number) => (v: number) => v / k;

/** Grade parameters found by their usual names in color tools. */
const GRADE_PARAMS: [string, string[], (v: number) => number][] = [
  ['exposure', ['exposure', 'exposure global', 'master exposure'], pct],
  ['contrast', ['contrast', 'master contrast'], pct],
  ['saturation', ['saturation', 'saturation global', 'master saturation'], pct],
  ['vibrance', ['vibrance'], pct],
  ['temperature', ['temperature', 'temp', 'warmth'], pct],
  ['tint', ['tint'], pct],
  ['highlights', ['highlights', 'exposure highlights'], pct],
  ['shadows', ['shadows', 'exposure shadows'], pct],
  ['whites', ['whites', 'white point'], pct],
  ['blacks', ['blacks', 'black point'], pct],
  ['brightness', ['brightness', 'lightness'], pct],
  ['hue', ['hue', 'master hue', 'hue angle'], (v) => v],
];

function grade(p: ParamReader): TEffect | null {
  const params: Record<string, TKeyed<unknown>> = {};
  for (const [key, names, f] of GRADE_PARAMS) {
    const v = p(...names);
    if (v !== undefined) params[key] = mapKeyed(v, f);
  }
  return Object.keys(params).length ? { kind: 'grade', params } : null;
}

/** Collects the parameters that are present. */
function some(entries: [string, TKeyed<number> | undefined][]): Record<string, TKeyed<unknown>> {
  const out: Record<string, TKeyed<unknown>> = {};
  for (const [k, v] of entries) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * Maps an editor effect (by its display name or id) to a Tasweerix filter. Returns null for effects
 * without a counterpart. Blurs, keys, stylize effects and color corrections (Brightness & Contrast,
 * Proc Amp, Hue/Saturation, Color Board, Color Adjustments and similar) are covered.
 */
export function mapEffect(name: string, p: ParamReader): MappedEffect | null {
  const n = name.toLowerCase().replace(/[_-]+/g, ' ').trim();
  const fx = (kind: string, params: Record<string, TKeyed<unknown>>, approximate = true): MappedEffect => ({ effect: { kind, params }, approximate });
  if (/gaussian ?blur|^blur$|fast blur|box blur|camera blur|defocus/.test(n)) return fx('blur', some([['radius', p('amount', 'radius', 'blurriness', 'blur amount', 'size')]]), false);
  if (/directional ?blur/.test(n)) return fx('directionalBlur', some([['angle', p('angle', 'direction')], ['distance', p('amount', 'blur length', 'distance')]]));
  if (/zoom ?blur/.test(n)) return fx('zoomBlur', some([['amount', mapKeyed(p('amount'), pct)]]));
  if (/unsharp|sharpen/.test(n)) return fx('sharpen', some([['amount', mapKeyed(p('amount', 'sharpen amount'), pct)]]));
  if (/black ?(&|and) ?white|monochrome|desaturate|grayscale|greyscale|^b ?& ?w$/.test(n)) return fx('grayscale', some([['amount', mapKeyed(p('amount'), pct)]]), false);
  if (/sepia/.test(n)) return fx('sepia', some([['amount', mapKeyed(p('amount'), pct)]]), false);
  if (/^invert/.test(n)) return fx('invert', {}, false);
  if (/vignette/.test(n)) return fx('vignette', some([['amount', mapKeyed(p('amount'), pct)]]));
  if (/grain|^noise|add noise/.test(n)) return fx('grain', some([['amount', mapKeyed(p('amount'), pct)]]));
  if (/glow|bloom/.test(n)) return fx('glow', some([['radius', p('radius')]]));
  if (/drop ?shadow/.test(n)) return fx('dropShadow', some([['blur', p('softness', 'blur')], ['opacity', mapKeyed(p('opacity'), pct)]]));
  if (/pixelate|mosaic/.test(n)) return fx('pixelate', some([['size', p('amount', 'block size', 'size', 'scale')]]));
  if (/posterize/.test(n)) return fx('posterize', some([['levels', p('levels', 'level')]]));
  if (/kaleidoscope/.test(n)) return fx('kaleidoscope', some([['segments', p('segments', 'count')]]));
  if (/^mirror|flop/.test(n)) return fx('mirror', {});
  if (/luma ?key/.test(n)) return fx('lumaKey', some([['threshold', mapKeyed(p('threshold'), pct)]]));
  if (/chroma ?key|ultra ?key|^keyer$|green ?screen|blue ?screen|color ?key/.test(n)) return fx('chromaKey', {});
  if (/brightness ?(&|and) ?contrast|brightness contrast/.test(n)) return fx('grade', some([['brightness', mapKeyed(p('brightness'), div(100))], ['contrast', mapKeyed(p('contrast'), div(100))]]), false);
  if (/proc ?amp/.test(n)) {
    // Chroma is in percent of the original saturation (100 = unchanged), phase in degrees.
    return fx('grade', some([['saturation', mapKeyed(p('chroma', 'saturation'), (v: number) => v / 100 - 1)], ['hue', p('phase', 'hue')], ['brightness', mapKeyed(p('setup', 'brightness'), div(100))]]));
  }
  // Color tools: map whatever grade-like parameters they carry.
  const g = grade(p);
  if (g) return { effect: g, approximate: true };
  return null;
}
