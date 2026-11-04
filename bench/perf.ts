import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { buildGraph, nearestNode, routeCostSurface, type GraphEdge, type GraphNode } from "../src/graph.js";
import { ExposureField, type FieldCamera } from "../src/exposureField.js";
import { findCoolCorridor, type LatLng } from "../src/corridorSearch.js";
import { randomGrid } from "../fixtures/randomGraph.js";
import { LARGE_GRID_SEED, largeGridOptions } from "../fixtures/golden.js";
import { downtownLv } from "../fixtures/downtownLv.js";

// Runtime and memory for the larger scenarios, so a PR that touches the search,
// the field or graph assembly can show before/after numbers.
//
//   npm run bench:perf                 table, 15 timed runs per scenario
//   npm run bench:perf -- --runs 40    more runs, steadier medians
//   npm run bench:perf -- --json       machine-readable output
//   npm run bench:perf -- --only grid-200
//
// Each scenario runs in its own child process, so its peak RSS is its own.
// Numbers are machine-dependent: compare before/after on the same machine,
// never against someone else's table. Nothing here is checked in CI.
//
// Columns:
//   build ms   buildGraph + new ExposureField (median)
//   run ms     one routeCostSurface (or findCoolCorridor) call: median / min
//              (a route call includes pricing every edge against the field)
//   heap MB    heap retained by the built graph + field (after GC)
//   peak MB    peak resident set size of the whole child process, including
//              generating or loading the scenario's input data

interface PerfScenario {
  name: string;
  setup(): {
    nodes: number;
    edges: number;
    sensors: number;
    build(): unknown;
    run(built: unknown): void;
  };
}

function routeScenario(
  name: string,
  load: () => { nodes: GraphNode[]; edges: GraphEdge[]; cameras: FieldCamera[]; from: LatLng; to: LatLng; lambda: number },
): PerfScenario {
  return {
    name,
    setup() {
      const s = load();
      return {
        nodes: s.nodes.length,
        edges: s.edges.length,
        sensors: s.cameras.length,
        build: () => {
          const graph = buildGraph(s.nodes, s.edges);
          const field = new ExposureField(s.cameras);
          return {
            graph,
            field,
            start: nearestNode(graph, s.from.lat, s.from.lng)!,
            goal: nearestNode(graph, s.to.lat, s.to.lng)!,
          };
        },
        run: (built) => {
          const b = built as { graph: ReturnType<typeof buildGraph>; field: ExposureField; start: number; goal: number };
          if (!routeCostSurface(b.graph, b.field, b.start, b.goal, s.lambda)) throw new Error(`${name}: no route`);
        },
      };
    },
  };
}

function gridScenario(size: number): PerfScenario {
  return routeScenario(`grid-${size}`, () => {
    const g = randomGrid(LARGE_GRID_SEED, largeGridOptions(size));
    const a = g.at(0, 0);
    const b = g.at(size - 1, size - 1);
    return { ...g, from: a, to: b, lambda: 1500 };
  });
}

const SCENARIOS: PerfScenario[] = [
  routeScenario("downtown-lv", () => ({ ...downtownLv(), lambda: 2200 })),
  gridScenario(80),
  gridScenario(200),
  {
    name: "corridor-15km",
    setup() {
      const g = randomGrid(LARGE_GRID_SEED, { rows: 1, cols: 1, sensors: 1500, spacingM: 12_000 });
      const from = { lat: 36.0, lng: -115.0 };
      const to = { lat: 36.0 + 9000 / 111_320, lng: -115.0 + 12_000 / (111_320 * Math.cos((36 * Math.PI) / 180)) };
      return {
        nodes: 0,
        edges: 0,
        sensors: g.cameras.length,
        build: () => new ExposureField(g.cameras),
        run: (field) => {
          if (!findCoolCorridor(from, to, field as ExposureField, { metersPerRead: 1500 })) {
            throw new Error("corridor-15km: no corridor");
          }
        },
      };
    },
  },
];

interface PerfResult {
  name: string;
  nodes: number;
  edges: number;
  sensors: number;
  runs: number;
  buildMs: number;
  runMedianMs: number;
  runMinMs: number;
  heapMB: number;
  peakRssMB: number;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const gc = () => (globalThis as { gc?: () => void }).gc?.();
const r1 = (x: number) => Math.round(x * 10) / 10;

function measure(sc: PerfScenario, runs: number): PerfResult {
  const s = sc.setup();

  gc();
  const heap0 = process.memoryUsage().heapUsed;
  const buildTimes: number[] = [];
  let built: unknown;
  for (let i = 0; i < 5; i++) {
    built = undefined;
    const t0 = performance.now();
    built = s.build();
    buildTimes.push(performance.now() - t0);
  }
  gc();
  const heapMB = (process.memoryUsage().heapUsed - heap0) / 2 ** 20;

  s.run(built); // warm-up
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    s.run(built);
    times.push(performance.now() - t0);
  }
  return {
    name: sc.name,
    nodes: s.nodes,
    edges: s.edges,
    sensors: s.sensors,
    runs,
    buildMs: r1(median(buildTimes)),
    runMedianMs: r1(median(times)),
    runMinMs: r1(Math.min(...times)),
    heapMB: r1(heapMB),
    peakRssMB: r1(process.resourceUsage().maxRSS / 1024),
  };
}

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const runs = Number(flag("--runs") ?? 15);
if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");

const child = flag("--child");
if (child !== undefined) {
  const sc = SCENARIOS.find((s) => s.name === child);
  if (!sc) throw new Error(`unknown scenario ${child}`);
  process.stdout.write(JSON.stringify(measure(sc, runs)) + "\n");
} else {
  if (!(globalThis as { gc?: unknown }).gc) {
    console.warn("note: run via `npm run bench:perf` (needs --expose-gc) for meaningful heap numbers\n");
  }
  const only = flag("--only");
  const selected = only ? SCENARIOS.filter((s) => s.name === only) : SCENARIOS;
  if (!selected.length) throw new Error(`unknown scenario ${only}; have ${SCENARIOS.map((s) => s.name).join(", ")}`);

  const results: PerfResult[] = [];
  for (const sc of selected) {
    const out = spawnSync(
      process.execPath,
      [...process.execArgv, fileURLToPath(import.meta.url), "--child", sc.name, "--runs", String(runs)],
      { encoding: "utf8" },
    );
    if (out.status !== 0) {
      process.stderr.write(out.stderr);
      throw new Error(`${sc.name}: child exited with ${out.status}`);
    }
    results.push(JSON.parse(out.stdout.trim().split("\n").pop()!) as PerfResult);
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify({ node: process.version, platform: `${process.platform}-${process.arch}`, runs, results }, null, 2));
  } else {
    const pad = (v: unknown, w: number) => String(v).padStart(w);
    console.log(`node ${process.version} ${process.platform}-${process.arch}, ${runs} timed runs per scenario\n`);
    console.log(
      `${"scenario".padEnd(16)}${pad("nodes", 8)}${pad("edges", 8)}${pad("sensors", 9)}${pad("build ms", 10)}${pad("run ms (med/min)", 18)}${pad("heap MB", 9)}${pad("peak MB", 9)}`,
    );
    for (const r of results) {
      console.log(
        `${r.name.padEnd(16)}${pad(r.nodes, 8)}${pad(r.edges, 8)}${pad(r.sensors, 9)}${pad(r.buildMs, 10)}${pad(`${r.runMedianMs} / ${r.runMinMs}`, 18)}${pad(r.heapMB, 9)}${pad(r.peakRssMB, 9)}`,
      );
    }
  }
}
