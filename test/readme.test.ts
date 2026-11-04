import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The README's quick start must run exactly as printed, and print exactly the
// output the README shows. The block between the quick-start markers is run
// against this checkout's src/ (in place of the installed package).

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("README quick start runs and prints the output the README shows", async () => {
  const block = /<!-- quick-start:begin[^>]*-->\s*```js\n([\s\S]*?)```\s*<!-- quick-start:end -->([\s\S]*?)```\n([\s\S]*?)```/.exec(readme);
  assert.ok(block, "quick-start markers, the js block and the output block must be present in README.md");
  const [, code, , expectedOutput] = block;

  const indexUrl = pathToFileURL(new URL("../src/index.ts", import.meta.url).pathname).href;
  assert.match(code!, /from "exposure-router"/);
  const runnable = code!.replace(/from "exposure-router"/g, `from ${JSON.stringify(indexUrl)}`);

  const dir = mkdtempSync(join(tmpdir(), "exposure-router-readme-"));
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    const file = join(dir, "quick-start.mjs");
    writeFileSync(file, runnable);
    await import(pathToFileURL(file).href);
  } finally {
    console.log = log;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(lines, expectedOutput!.trim().split("\n"));
});
