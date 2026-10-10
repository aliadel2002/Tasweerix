import { resolve, type Animatable, type Driver } from '@tasweerix/core';

/** Arabic letters that connect to the following letter (dual-joining). */
const DUAL_JOINING = new Set(
  'بتثجحخسشصضطظعغفقكلمنهيئـڤگپچکیہۀ'.split(''),
);
const ARABIC_LETTER = /[ؠ-يٮ-ۓۺ-ۿݐ-ݿ]/;
const TATWEEL = 'ـ';

/**
 * Kashida (tatweel) elongation: inserts up to `amount` tatweels at each joinable position,
 * distributing fractional amounts from the end of each word. Animate `amount` for the classic
 * calligraphic "stretch" effect without breaking letter joining.
 */
export function kashida(text: string, amount: number): string {
  const n = Math.max(0, amount);
  const chars = [...text];
  const slots: number[] = [];
  for (let i = 0; i < chars.length - 1; i++) {
    if (DUAL_JOINING.has(chars[i]!) && ARABIC_LETTER.test(chars[i + 1]!) && chars[i + 1] !== 'ء') slots.push(i);
  }
  if (!slots.length || n <= 0) return text;
  const whole = Math.floor(n);
  const frac = n - whole;
  const extraSlots = Math.round(frac * slots.length);
  const counts = new Map<number, number>();
  slots.forEach((s, k) => counts.set(s, whole + (k >= slots.length - extraSlots ? 1 : 0)));
  return chars.map((c, i) => c + TATWEEL.repeat(counts.get(i) ?? 0)).join('');
}

/** Animated kashida driver for a text node's `text` prop. */
export function kashidaText(text: Animatable<string>, amount: Animatable<number>): Driver<string> {
  return (ctx) => kashida(resolve(text, ctx), Math.round(resolve(amount, ctx) * 4) / 4);
}

/** Converts Western digits to Arabic-Indic (٠١٢…) or Eastern Arabic-Indic (۰۱۲…). */
export function arabicDigits(s: string | number, style: 'arabic' | 'persian' = 'arabic'): string {
  const base = style === 'arabic' ? 0x0660 : 0x06f0;
  return String(s).replace(/[0-9]/g, (d) => String.fromCharCode(base + Number(d)));
}

/** Strips Arabic diacritics (harakat) — useful for display sizes or search. */
export function stripDiacritics(s: string): string {
  return s.replace(/[ً-ٰٟۖ-ۭ]/g, '');
}
