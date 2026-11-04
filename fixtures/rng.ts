// A small seeded pseudo-random generator (mulberry32), so every randomised
// fixture and property test in this repository is reproducible from a single
// integer. Not for anything security-related: it exists to make "random" test
// data the same on every machine and every run.

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform float in [lo, hi). */
  float(lo: number, hi: number): number;
  /** Uniform integer in [lo, hi] (inclusive). */
  int(lo: number, hi: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** One element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
}

export function createRng(seed: number): Rng {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    float: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (items) => {
      if (!items.length) throw new Error("pick: empty array");
      return items[Math.floor(next() * items.length)]!;
    },
  };
}
