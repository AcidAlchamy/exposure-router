import {
  parallelStreet,
  flankedExit,
  saturatedDowntown,
  parkingLotTemptation,
} from "../fixtures/synthetic.js";
import { downtownLv, lambdaLadder } from "../fixtures/downtownLv.js";
import type { Scenario } from "../fixtures/scenario.js";

// The panel, in the order the bench prints it. Synthetic scenarios first
// (each one a preserved regression or founding case), then the real-geometry
// pair. Add a scenario here and `npm run bench -- --update` to extend the
// baseline — CONTRIBUTING.md explains the rules.

export function allScenarios(): Scenario[] {
  return [
    parallelStreet(),
    flankedExit(),
    saturatedDowntown(),
    parkingLotTemptation(),
    downtownLv(),
    lambdaLadder(),
  ];
}

/**
 * The λ ladder: the spread of λ values a real application tries, from the plain
 * shortest path up. Densified mid-range on purpose — see lambda-ladder's description
 * for the regression that motivates it.
 */
export const LAMBDA_LADDER = [0, 200, 400, 700, 1000, 1500, 2200, 3000, 4000, 6000, 9000, 14000];
