/** Deterministic PRNG (sfc32) seeded from numbers or strings. Never use Math.random in renders. */
export function hashSeed(seed: number | string): number {
  const s = String(seed);
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

export interface Random {
  (): number;
  range(min: number, max: number): number;
  int(min: number, maxInclusive: number): number;
  pick<T>(items: readonly T[]): T;
  bool(p?: number): boolean;
  gaussian(mean?: number, std?: number): number;
  shuffle<T>(items: T[]): T[];
  fork(sub: string | number): Random;
}

export function createRandom(seed: number | string = 0): Random {
  let a = hashSeed(seed);
  let b = hashSeed(`${seed}:b`);
  let c = hashSeed(`${seed}:c`);
  let d = hashSeed(`${seed}:d`);
  const next = (() => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  }) as Random;
  for (let i = 0; i < 12; i++) next();
  next.range = (min, max) => min + (max - min) * next();
  next.int = (min, max) => Math.floor(min + (max - min + 1) * next());
  next.pick = (items) => items[Math.floor(next() * items.length)]!;
  next.bool = (p = 0.5) => next() < p;
  next.gaussian = (mean = 0, std = 1) => {
    const u = 1 - next();
    const v = next();
    return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  next.shuffle = (items) => {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items;
  };
  next.fork = (sub) => createRandom(`${seed}/${sub}`);
  return next;
}
