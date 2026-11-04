import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { goldenCases } from "../fixtures/golden.js";
import { committedGoldenNames, diffGolden, labelDiffs, readGolden, runCase } from "./support/golden.js";

// Golden outputs: every route, cost, snapped node, corridor and field value
// produced by the cases in fixtures/golden.ts must match the committed
// test/golden/<case>.json. A failure here means routing output changed.
//
// If the change is intended: run `npm run golden:update`, commit the updated
// JSON, and explain in the PR which outputs moved and why. If it is not
// intended, it is a regression.

const HINT =
  "Routing output changed. If intended, run `npm run golden:update`, commit test/golden/, " +
  "and explain the change in the PR (see CONTRIBUTING.md).";

describe("golden outputs", () => {
  const cases = goldenCases();

  for (const c of cases) {
    test(c.name, () => {
      const expected = readGolden(c.name);
      assert.ok(expected !== undefined, `test/golden/${c.name}.json is missing. ${HINT}`);
      const actual = runCase(c);
      const diffs = labelDiffs(actual, diffGolden(expected, actual));
      if (diffs.length) {
        const shown = diffs.slice(0, 25).join("\n  ");
        const more = diffs.length > 25 ? `\n  ... and ${diffs.length - 25} more` : "";
        assert.fail(`${c.name}: ${diffs.length} value(s) differ from the golden file:\n  ${shown}${more}\n${HINT}`);
      }
    });
  }

  test("no stale golden files", () => {
    const names = new Set(cases.map((c) => c.name));
    const stale = committedGoldenNames().filter((n) => !names.has(n));
    assert.deepEqual(stale, [], `golden files with no matching case: ${stale.join(", ")}. ${HINT}`);
  });
});
