import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  GOLDEN_DIR,
  committedGoldenNames,
  diffGolden,
  formatGolden,
  goldenFile,
  labelDiffs,
  readGolden,
  runAll,
} from "./golden.js";

// Regenerate the golden outputs in test/golden/ from the engine as it is now.
//
//   npm run golden:update
//
// Only do this on purpose: when a change to routing output is intended and
// explained in the PR. The script prints every value that moved, so the diff
// can be pasted into the PR description; `git diff test/golden` shows the same.

const results = runAll();
mkdirSync(GOLDEN_DIR, { recursive: true });

let changedCases = 0;
for (const [name, value] of results) {
  const before = readGolden(name);
  const diffs = labelDiffs(value, diffGolden(before, value));
  if (before === undefined) {
    console.log(`${name}: new`);
    changedCases++;
  } else if (diffs.length) {
    console.log(`${name}: ${diffs.length} value(s) changed`);
    for (const d of diffs) console.log(`  ${d}`);
    changedCases++;
  }
  writeFileSync(goldenFile(name), formatGolden(value));
}
for (const name of committedGoldenNames()) {
  if (!results.has(name)) {
    rmSync(goldenFile(name));
    console.log(`${name}: removed (no longer a case in fixtures/golden.ts)`);
    changedCases++;
  }
}
console.log(
  changedCases
    ? `\ngolden outputs written: ${results.size} cases, ${changedCases} changed`
    : `\ngolden outputs unchanged: ${results.size} cases`,
);
