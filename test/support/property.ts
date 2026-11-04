import { createRng, type Rng } from "../../fixtures/rng.js";

// A minimal seeded property-test runner. Trial i of a property gets its own
// generator seeded with (PROPERTY_SEED + i), salted by the property's name so
// different properties see different data. A failure is re-thrown with the
// trial seed and the command that replays exactly that trial:
//
//   PROPERTY_SEED=1234 PROPERTY_TRIALS=1 npm test
//
// PROPERTY_TRIALS overrides every property's trial count; set it high locally
// to search harder (e.g. PROPERTY_TRIALS=2000), and PROPERTY_SEED to explore
// different data. Without them the counts written in the tests are used, with
// base seed 1, so CI is deterministic.

const BASE_SEED = Number(process.env.PROPERTY_SEED ?? 1);
const TRIALS = process.env.PROPERTY_TRIALS === undefined ? null : Number(process.env.PROPERTY_TRIALS);

if (!Number.isInteger(BASE_SEED)) throw new Error("PROPERTY_SEED must be an integer");
if (TRIALS !== null && !(Number.isInteger(TRIALS) && TRIALS > 0)) {
  throw new Error("PROPERTY_TRIALS must be a positive integer");
}

function salt(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Run `body` once per seeded trial; `trials` unless PROPERTY_TRIALS overrides it. */
export function forAll(name: string, trials: number, body: (rng: Rng, seed: number) => void): void {
  const total = TRIALS ?? trials;
  for (let i = 0; i < total; i++) {
    const seed = BASE_SEED + i;
    try {
      body(createRng((seed ^ salt(name)) >>> 0), seed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${name}: failed on trial seed ${seed}\n` +
          `  replay: PROPERTY_SEED=${seed} PROPERTY_TRIALS=1 npm test\n  ${msg}`,
        { cause: err },
      );
    }
  }
}

/** Fisher-Yates shuffle into a new array. */
export function shuffled<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
