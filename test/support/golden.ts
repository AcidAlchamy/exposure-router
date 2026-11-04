import { readdirSync, readFileSync, existsSync } from "node:fs";
import { buildGraph, nearestNode, routeCostSurface, edgeExposure } from "../../src/graph.js";
import { ExposureField, scoreRouteExposureField } from "../../src/exposureField.js";
import { findCoolCorridor } from "../../src/corridorSearch.js";
import { goldenCases, type GoldenCase } from "../../fixtures/golden.js";
import { edgeReadsFor, routeSteps, routeTotals } from "./routeCheck.js";

// The golden-output harness: run every case in fixtures/golden.ts through the
// engine and turn the results into plain JSON. test/golden.test.ts compares
// that JSON with the committed test/golden/<case>.json files;
// `npm run golden:update` rewrites them.
//
// Comparison rule: node ids, edge indices, counts and labels must match
// exactly; floating-point values must match to a relative 1e-9 (absolute 1e-9
// near zero). That is far tighter than any real behaviour change and loose
// enough to survive a different summation order in a refactor.

export const GOLDEN_DIR = new URL("../golden/", import.meta.url);

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Non-finite numbers are not representable in JSON; record them as strings. */
const num = (x: number): number | string => (Number.isFinite(x) ? x : String(x));

export function runCase(c: GoldenCase): Json {
  switch (c.kind) {
    case "route": {
      const graph = buildGraph(c.nodes, c.edges);
      const field = new ExposureField(c.cameras);
      const reads = edgeReadsFor(graph, field);
      return {
        name: c.name,
        trips: c.trips.map((t) => {
          const r = routeCostSurface(graph, field, t.start, t.goal, t.lambda);
          if (!r) return { label: t.label, start: t.start, goal: t.goal, lambda: t.lambda, result: null };
          const steps = routeSteps(graph, reads, r, t.start, t.goal, t.lambda);
          const totals = routeTotals(graph, reads, steps, t.lambda);
          return {
            label: t.label,
            start: t.start,
            goal: t.goal,
            lambda: t.lambda,
            result: {
              path: r.path,
              edges: steps.map((s) => s.edge),
              distanceMeters: num(r.distanceMeters),
              reads: num(r.reads),
              cost: num(totals.cost),
              geometryPoints: r.geometry.length,
              geometryFirst: r.geometry[0] ?? null,
              geometryLast: r.geometry[r.geometry.length - 1] ?? null,
            },
          };
        }),
      };
    }
    case "snap": {
      const graph = buildGraph(c.nodes, []);
      return {
        name: c.name,
        points: c.points.map((p) => ({ label: p.label, node: nearestNode(graph, p.lat, p.lng) })),
      };
    }
    case "corridor": {
      const field = new ExposureField(c.cameras);
      return {
        name: c.name,
        trips: c.trips.map((t) => {
          const r = findCoolCorridor(t.from, t.to, field, { metersPerRead: t.metersPerRead });
          return {
            label: t.label,
            metersPerRead: t.metersPerRead,
            result: r && {
              waypoints: r.waypoints.map((w) => [w.lat, w.lng]),
              gridScore: num(r.gridScore),
              cellsExplored: r.cellsExplored,
            },
          };
        }),
      };
    }
    case "field": {
      const field = new ExposureField(c.cameras);
      return {
        name: c.name,
        points: c.points.map((p) => ({ label: p.label, heat: num(field.heatAt(p.lng, p.lat)) })),
        lines: c.lines.map((l) => {
          const s = scoreRouteExposureField({ geometry: { coordinates: l.coordinates } }, field);
          const asEdge = edgeExposure({ a: 0, b: 1, geom: l.coordinates, lengthM: 0, oneway: false }, field);
          return {
            label: l.label,
            score: num(s.score),
            peak: num(s.peak),
            exposedMeters: num(s.exposedMeters),
            edgeExposure: num(asEdge),
          };
        }),
      };
    }
  }
}

export function runAll(): Map<string, Json> {
  const out = new Map<string, Json>();
  for (const c of goldenCases()) {
    if (out.has(c.name)) throw new Error(`duplicate golden case name: ${c.name}`);
    out.set(c.name, runCase(c));
  }
  return out;
}

/** Stable, diff-friendly JSON: two-space indent, arrays of scalars on one line. */
export function formatGolden(value: Json): string {
  const fmt = (v: Json, indent: string): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    const inner = indent + "  ";
    if (Array.isArray(v)) {
      if (!v.length) return "[]";
      if (v.every((x) => x === null || typeof x !== "object")) return `[${v.map((x) => JSON.stringify(x)).join(", ")}]`;
      return `[\n${v.map((x) => inner + fmt(x, inner)).join(",\n")}\n${indent}]`;
    }
    const keys = Object.keys(v);
    if (!keys.length) return "{}";
    return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${fmt(v[k]!, inner)}`).join(",\n")}\n${indent}}`;
  };
  return fmt(value, "") + "\n";
}

export function goldenFile(name: string): URL {
  return new URL(`${name}.json`, GOLDEN_DIR);
}

export function readGolden(name: string): Json | undefined {
  const url = goldenFile(name);
  return existsSync(url) ? (JSON.parse(readFileSync(url, "utf8")) as Json) : undefined;
}

/** Names of the committed golden files (without .json). */
export function committedGoldenNames(): string[] {
  if (!existsSync(GOLDEN_DIR)) return [];
  return readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
}

const closeEnough = (a: number, b: number) =>
  a === b || Math.abs(a - b) <= Math.max(1e-9, 1e-9 * Math.max(Math.abs(a), Math.abs(b)));

/** Every difference between two golden values, as "path: expected → actual" lines. */
export function diffGolden(expected: Json | undefined, actual: Json, at = ""): string[] {
  const show = (v: Json | undefined) => {
    const s = JSON.stringify(v);
    return s === undefined ? "(missing)" : s.length > 120 ? `${s.slice(0, 117)}...` : s;
  };
  if (typeof expected === "number" && typeof actual === "number") {
    return closeEnough(expected, actual) ? [] : [`${at}: ${expected} → ${actual}`];
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const out: string[] = [];
    if (expected.length !== actual.length) out.push(`${at}.length: ${expected.length} → ${actual.length}`);
    const n = Math.min(expected.length, actual.length);
    for (let i = 0; i < n; i++) out.push(...diffGolden(expected[i], actual[i]!, `${at}[${i}]`));
    return out;
  }
  if (
    expected && actual && typeof expected === "object" && typeof actual === "object" &&
    !Array.isArray(expected) && !Array.isArray(actual)
  ) {
    const out: string[] = [];
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const k of keys) {
      const label = at ? `${at}.${k}` : k;
      if (!(k in actual)) out.push(`${label}: ${show(expected[k])} → (missing)`);
      else out.push(...diffGolden(expected[k], actual[k]!, label));
    }
    return out;
  }
  return JSON.stringify(expected) === JSON.stringify(actual) ? [] : [`${at}: ${show(expected)} → ${show(actual)}`];
}

/** Human-readable label for a diff path: replaces trips[3] with the trip's label. */
export function labelDiffs(value: Json, diffs: string[]): string[] {
  return diffs.map((d) => {
    const m = /^(trips|points|lines)\[(\d+)\](.*)$/.exec(d);
    if (!m || !value || typeof value !== "object" || Array.isArray(value)) return d;
    const list = value[m[1]!];
    const item = Array.isArray(list) ? list[Number(m[2])] : undefined;
    const label =
      item && typeof item === "object" && !Array.isArray(item) && typeof item.label === "string" ? item.label : null;
    return label ? `${m[1]}[${m[2]}] "${label}"${m[3]}` : d;
  });
}
