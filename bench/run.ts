import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { buildGraph, nearestNode, routeCostSurface, type CostSurfaceResult } from "../src/graph.js";
import { ExposureField } from "../src/exposureField.js";
import { allScenarios, LAMBDA_LADDER } from "./scenarios.js";
import { crossedReadZones, pathMetersWhere } from "./metrics.js";
import type { Scenario } from "../fixtures/scenario.js";

// The measuring stick. Every scenario is routed at λ=0 (the shortest-path
// reference) and at its judged λ; the printed numbers ARE the review contract:
// a PR that changes routing behaviour must land with its baseline diff, and
// "feels better" is not evidence. See CONTRIBUTING.md.
//
//   npm run bench              print the table and diff against the baseline
//   npm run bench -- --check   same, but exit 1 on any drift (CI mode)
//   npm run bench -- --update  rewrite bench/baseline.json with today's numbers
//
// runtimeMs is printed for information and never compared — machines differ;
// geometry must not.

const BASELINE_URL = new URL("./baseline.json", import.meta.url);

type Metrics = Record<string, number | number[]>;

interface BenchResult {
  name: string;
  metrics: Metrics;
  runtimeMs: number;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10000) / 10000;

function route(scenario: Scenario, lambda: number): CostSurfaceResult {
  const graph = buildGraph(scenario.nodes, scenario.edges);
  const field = new ExposureField(scenario.cameras);
  const startId = nearestNode(graph, scenario.from.lat, scenario.from.lng);
  const goalId = nearestNode(graph, scenario.to.lat, scenario.to.lng);
  if (startId == null || goalId == null) throw new Error(`${scenario.name}: endpoints did not snap`);
  const r = routeCostSurface(graph, field, startId, goalId, lambda);
  if (!r) throw new Error(`${scenario.name}: no route at λ=${lambda}`);
  return r;
}

function runRoute(s: Scenario): BenchResult {
  const graph = buildGraph(s.nodes, s.edges);
  const field = new ExposureField(s.cameras);
  const startId = nearestNode(graph, s.from.lat, s.from.lng)!;
  const goalId = nearestNode(graph, s.to.lat, s.to.lng)!;

  const t0 = performance.now();
  const shortest = routeCostSurface(graph, field, startId, goalId, 0);
  const routed = s.lambda === 0 ? shortest : routeCostSurface(graph, field, startId, goalId, s.lambda);
  const runtimeMs = performance.now() - t0;
  if (!shortest || !routed) throw new Error(`${s.name}: did not route`);

  const zonesShortest = crossedReadZones(shortest.geometry, s.cameras);
  const zonesRouted = crossedReadZones(routed.geometry, s.cameras);

  return {
    name: s.name,
    runtimeMs,
    metrics: {
      distanceM: r1(routed.distanceMeters),
      addedM: r1(routed.distanceMeters - shortest.distanceMeters),
      addedPct: r1(((routed.distanceMeters - shortest.distanceMeters) / shortest.distanceMeters) * 100),
      crossedShortest: zonesShortest.crossed,
      crossedRouted: zonesRouted.crossed,
      endpointExempt: zonesRouted.endpointExempt,
      readsShortest: r4(shortest.reads),
      readsRouted: r4(routed.reads),
      serviceM: r1(pathMetersWhere(graph, routed.path, (hw) => hw === "service")),
    },
  };
}

function runLadder(s: Scenario): BenchResult {
  const t0 = performance.now();
  const seen = new Set<string>();
  const distances: number[] = [];
  for (const lambda of LAMBDA_LADDER) {
    const r = route(s, lambda);
    const sig = `${r.geometry.length}:${Math.round(r.distanceMeters)}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    distances.push(r1(r.distanceMeters));
  }
  const runtimeMs = performance.now() - t0;
  const sorted = [...distances].sort((a, b) => a - b);
  let maxGapRatio = 1;
  for (let i = 0; i < sorted.length - 1; i++) {
    maxGapRatio = Math.max(maxGapRatio, sorted[i + 1]! / sorted[i]!);
  }
  return {
    name: s.name,
    runtimeMs,
    metrics: {
      candidateCount: distances.length,
      candidates: sorted,
      maxGapRatio: r2(maxGapRatio),
    },
  };
}

// ---- baseline comparison ----------------------------------------------------

interface Drift {
  scenario: string;
  metric: string;
  baseline: number | number[] | undefined;
  now: number | number[];
}

const TOLERANCE: Record<string, number> = {
  distanceM: 1,
  addedM: 1,
  addedPct: 0.1,
  readsShortest: 0.005,
  readsRouted: 0.005,
  serviceM: 1,
  maxGapRatio: 0.02,
  candidates: 1, // per element, metres
};

function differs(metric: string, a: number | number[] | undefined, b: number | number[]): boolean {
  const tol = TOLERANCE[metric] ?? 0; // counts compare exactly
  if (a === undefined) return true;
  if (Array.isArray(b)) {
    if (!Array.isArray(a) || a.length !== b.length) return true;
    return b.some((v, i) => Math.abs(v - (a as number[])[i]!) > tol);
  }
  if (Array.isArray(a)) return true;
  return Math.abs(b - a) > tol;
}

function compare(results: BenchResult[], baseline: Record<string, Metrics>): Drift[] {
  const drifts: Drift[] = [];
  for (const r of results) {
    const base = baseline[r.name];
    for (const [metric, now] of Object.entries(r.metrics)) {
      if (differs(metric, base?.[metric], now)) {
        drifts.push({ scenario: r.name, metric, baseline: base?.[metric], now });
      }
    }
  }
  return drifts;
}

// ---- main -------------------------------------------------------------------

const mode = process.argv.includes("--update")
  ? "update"
  : process.argv.includes("--check")
    ? "check"
    : "print";

const results: BenchResult[] = [];
for (const s of allScenarios()) {
  results.push(s.kind === "ladder" ? runLadder(s) : runRoute(s));
}

const pad = (v: unknown, w: number) => String(v).padStart(w);
console.log(
  `${"scenario".padEnd(24)}${pad("dist m", 9)}${pad("+m", 8)}${pad("+%", 7)}${pad("zones", 9)}${pad("reads", 17)}${pad("svc m", 8)}${pad("ms", 7)}`,
);
for (const r of results) {
  const m = r.metrics;
  if ("candidates" in m) {
    console.log(
      `${r.name.padEnd(24)}λ-ladder: ${m.candidateCount} candidates ${JSON.stringify(m.candidates)} maxGapRatio=${m.maxGapRatio}  ${r.runtimeMs.toFixed(0)}ms`,
    );
    continue;
  }
  console.log(
    `${r.name.padEnd(24)}${pad(m.distanceM, 9)}${pad(m.addedM, 8)}${pad(m.addedPct, 7)}${pad(`${m.crossedShortest}→${m.crossedRouted}`, 9)}${pad(`${m.readsShortest}→${m.readsRouted}`, 17)}${pad(m.serviceM, 8)}${pad(r.runtimeMs.toFixed(0), 7)}`,
  );
}

if (mode === "update") {
  const out: Record<string, Metrics> = {};
  for (const r of results) out[r.name] = r.metrics;
  writeFileSync(BASELINE_URL, JSON.stringify({ _note: "Regenerate with: npm run bench -- --update. runtimeMs is never recorded.", scenarios: out }, null, 2) + "\n");
  console.log(`\nbaseline written: ${results.length} scenarios`);
} else if (!existsSync(BASELINE_URL)) {
  console.log("\nno baseline.json — run `npm run bench -- --update` to create it");
  if (mode === "check") process.exitCode = 1;
} else {
  const baseline = (JSON.parse(readFileSync(BASELINE_URL, "utf8")) as { scenarios: Record<string, Metrics> })
    .scenarios;
  const drifts = compare(results, baseline);
  const missing = Object.keys(baseline).filter((k) => !results.some((r) => r.name === k));
  if (!drifts.length && !missing.length) {
    console.log(`\nbaseline: OK — ${results.length} scenarios within tolerance`);
  } else {
    console.log("\nbaseline: BEHAVIOUR CHANGED");
    for (const d of drifts) {
      console.log(`  ${d.scenario}.${d.metric}: ${JSON.stringify(d.baseline)} → ${JSON.stringify(d.now)}`);
    }
    for (const name of missing) console.log(`  ${name}: in baseline but not in the panel`);
    console.log("  If intended, include this diff in your PR and refresh with: npm run bench -- --update");
    if (mode === "check") process.exitCode = 1;
  }
}
