import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, classWeight, nearestNode, routeCostSurface, type BuiltGraph, type GraphEdge, type GraphNode } from "../src/graph.js";
import { ExposureField, metersBetween, type FieldCamera } from "../src/exposureField.js";
import { randomGrid } from "../fixtures/randomGraph.js";
import type { Rng } from "../fixtures/rng.js";
import { close, edgeReadsFor, routeSteps, routeTotals, stepCost } from "./support/routeCheck.js";
import { forAll, shuffled } from "./support/property.js";

// Seeded property tests for routeCostSurface. Every map is generated from a
// seed (see test/support/property.ts to replay or widen a run). Two oracles are
// independent of the router: an exhaustive search over every simple path on
// small maps, and a plain O(V²) Dijkstra on medium ones. Both price edges with
// the same objective the router documents: length · driveWeight + λ · reads.
//
// Maps are generated with edge lengths no shorter than the straight line
// between their endpoints — the documented precondition for the A* heuristic.

const CLASSES = ["residential", "unclassified", "living_street", "service", "primary", "tertiary", undefined] as const;
const LATITUDES = [36, -33.9, 0.5, 51.5, 60] as const;

interface MapData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  cameras: FieldCamera[];
}

/** 2-3 x 2-4 lattice with diagonals, one-ways, dropped edges and parallel edges. */
function smallMap(rng: Rng, opts: { oneway?: number } = {}): MapData {
  const g = randomGrid(rng.int(0, 2 ** 31), {
    rows: rng.int(2, 3),
    cols: rng.int(2, 4),
    dropEdge: 0.15,
    oneway: opts.oneway ?? 0.25,
    diagonals: 0.3,
    classes: CLASSES,
    sensors: rng.int(0, 4),
    lat0: rng.pick(LATITUDES),
  });
  const edges = [...g.edges];
  // A parallel edge or two: same geometry, longer or equal length, another class.
  for (let k = rng.int(0, 2); k > 0 && g.edges.length; k--) {
    const e = rng.pick(g.edges);
    edges.push({ ...e, lengthM: e.lengthM * rng.float(1, 1.5), highway: rng.pick(CLASSES) });
  }
  return { nodes: g.nodes, edges, cameras: g.cameras };
}

function mediumMap(rng: Rng, opts: { oneway?: number } = {}): MapData {
  const g = randomGrid(rng.int(0, 2 ** 31), {
    rows: rng.int(5, 14),
    cols: rng.int(5, 14),
    dropEdge: 0.1,
    oneway: opts.oneway ?? 0.15,
    diagonals: 0.1,
    classes: CLASSES,
    sensors: rng.int(3, 40),
    lat0: rng.pick(LATITUDES),
  });
  return { nodes: g.nodes, edges: g.edges, cameras: g.cameras };
}

const pickLambda = (rng: Rng) => rng.pick([0, 0, 100, 500, 1000, 2200, 5000, 20000, rng.float(0, 10000)]);

/** Cheapest cost over every simple path (exhaustive DFS); Infinity when none. */
function bruteForceCost(graph: BuiltGraph, reads: Float64Array, start: number, goal: number, lambda: number): number {
  if (start === goal) return 0;
  let best = Infinity;
  const onPath = new Set<number>([start]);
  const dfs = (u: number, cost: number) => {
    for (const nb of graph.adjacency.get(u) ?? []) {
      if (onPath.has(nb.to)) continue;
      const c = cost + stepCost(graph, reads, nb.edge, lambda);
      if (nb.to === goal) {
        if (c < best) best = c;
        continue;
      }
      onPath.add(nb.to);
      dfs(nb.to, c);
      onPath.delete(nb.to);
    }
  };
  dfs(start, 0);
  return best;
}

/** Plain O(V²) Dijkstra over the same objective; Infinity when unreachable. */
function dijkstraCost(graph: BuiltGraph, reads: Float64Array, start: number, goal: number, lambda: number): number {
  const dist = new Map<number, number>();
  for (const id of graph.nodes.keys()) dist.set(id, Infinity);
  dist.set(start, 0);
  const done = new Set<number>();
  for (;;) {
    let u: number | null = null;
    let du = Infinity;
    for (const [id, d] of dist) if (!done.has(id) && d < du) [u, du] = [id, d];
    if (u === null) return Infinity;
    if (u === goal) return du;
    done.add(u);
    for (const nb of graph.adjacency.get(u) ?? []) {
      const nd = du + stepCost(graph, reads, nb.edge, lambda);
      if (nd < dist.get(nb.to)!) dist.set(nb.to, nd);
    }
  }
}

/** Route a trip and return everything a property needs, with legality checked. */
function solve(map: MapData, start: number, goal: number, lambda: number) {
  const graph = buildGraph(map.nodes, map.edges);
  const field = new ExposureField(map.cameras);
  const reads = edgeReadsFor(graph, field);
  const result = routeCostSurface(graph, field, start, goal, lambda);
  if (!result) return { graph, reads, result: null, steps: null, totals: null };
  const steps = routeSteps(graph, reads, result, start, goal, lambda);
  return { graph, reads, result, steps, totals: routeTotals(graph, reads, steps, lambda) };
}

function pickTrip(rng: Rng, map: MapData) {
  const start = rng.pick(map.nodes).id;
  let goal = rng.pick(map.nodes).id;
  if (map.nodes.length > 1) while (goal === start) goal = rng.pick(map.nodes).id;
  return { start, goal };
}

/** A trip that is known to route, or null if the map has none after a few tries. */
function routableTrip(rng: Rng, map: MapData, lambda: number) {
  for (let k = 0; k < 10; k++) {
    const t = pickTrip(rng, map);
    const s = solve(map, t.start, t.goal, lambda);
    if (s.result && s.steps!.length > 0) return { ...t, ...s, result: s.result, steps: s.steps!, totals: s.totals! };
  }
  return null;
}

describe("routeCostSurface properties", () => {
  test("a route starts at the start, ends at the goal, and every step is a legal move", () => {
    forAll("legal route", 200, (rng) => {
      const map = rng.chance(0.5) ? smallMap(rng) : mediumMap(rng);
      const { start, goal } = pickTrip(rng, map);
      // routeSteps throws on a wrong endpoint, a missing or wrong-way edge, or
      // geometry that is not exactly the concatenation of the edges driven.
      const { result, graph } = solve(map, start, goal, pickLambda(rng));
      if (!result || result.path.length < 2) return;
      const s = graph.nodes.get(start)!;
      const g = graph.nodes.get(goal)!;
      assert.deepEqual(result.geometry[0], [s.lng, s.lat], "geometry starts at the start node");
      assert.deepEqual(result.geometry[result.geometry.length - 1], [g.lng, g.lat], "geometry ends at the goal node");
      assert.equal(new Set(result.path).size, result.path.length, "path never revisits a node");
    });
  });

  test("reported distance and reads equal the sums over the route's edges", () => {
    forAll("reported totals", 200, (rng) => {
      const map = rng.chance(0.5) ? smallMap(rng) : mediumMap(rng);
      const { start, goal } = pickTrip(rng, map);
      const { result, totals } = solve(map, start, goal, pickLambda(rng));
      if (!result) return;
      assert.ok(close(result.distanceMeters, totals!.distanceMeters), `distance ${result.distanceMeters} vs Σ ${totals!.distanceMeters}`);
      assert.ok(close(result.reads, totals!.reads), `reads ${result.reads} vs Σ ${totals!.reads}`);
    });
  });

  test("never more expensive than the cheapest path an exhaustive search finds (small maps)", () => {
    forAll("brute-force optimality", 400, (rng) => {
      const map = smallMap(rng);
      const lambda = pickLambda(rng);
      const { start, goal } = pickTrip(rng, map);
      const { graph, reads, result, totals } = solve(map, start, goal, lambda);
      const best = bruteForceCost(graph, reads, start, goal, lambda);
      if (best === Infinity) {
        assert.equal(result, null, "router found a route where none exists");
        return;
      }
      assert.ok(result, `router returned null but a path of cost ${best} exists`);
      assert.ok(close(totals!.cost, best), `router cost ${totals!.cost} vs exhaustive best ${best} at λ=${lambda}`);
    });
  });

  test("matches an independent Dijkstra on medium maps", () => {
    forAll("dijkstra optimality", 120, (rng) => {
      const map = mediumMap(rng);
      const lambda = pickLambda(rng);
      const { start, goal } = pickTrip(rng, map);
      const { graph, reads, result, totals } = solve(map, start, goal, lambda);
      const best = dijkstraCost(graph, reads, start, goal, lambda);
      if (best === Infinity) {
        assert.equal(result, null, "router found a route Dijkstra says is unreachable");
        return;
      }
      assert.ok(result, `router returned null; Dijkstra found cost ${best}`);
      assert.ok(close(totals!.cost, best), `router cost ${totals!.cost} vs Dijkstra ${best} at λ=${lambda}`);
    });
  });

  test("raising the cost of edges away from the route never changes the route", () => {
    forAll("off-route increase", 150, (rng) => {
      const map = rng.chance(0.5) ? smallMap(rng) : mediumMap(rng);
      const lambda = pickLambda(rng);
      const before = routableTrip(rng, map, lambda);
      if (!before) return;
      const used = new Set(before.steps.map((s) => s.edge));
      const edges = map.edges.map((e, i) =>
        !used.has(i) && rng.chance(0.4) ? { ...e, lengthM: e.lengthM * rng.float(1.05, 3) } : e,
      );
      const after = solve({ ...map, edges }, before.start, before.goal, lambda);
      assert.ok(after.result, "route disappeared");
      assert.deepEqual(after.result.path, before.result.path, "path changed");
      assert.deepEqual(after.steps, before.steps, "edges changed");
      assert.ok(close(after.totals!.cost, before.totals.cost), `cost ${before.totals.cost} → ${after.totals!.cost}`);
    });
  });

  test("raising the cost of an edge on the route never lowers the total, and raises it by at most that much", () => {
    forAll("on-route increase", 150, (rng) => {
      const map = rng.chance(0.5) ? smallMap(rng) : mediumMap(rng);
      const lambda = pickLambda(rng);
      const before = routableTrip(rng, map, lambda);
      if (!before) return;
      const step = rng.pick(before.steps);
      const extraM = rng.float(1, 800);
      const edges = map.edges.map((e, i) => (i === step.edge ? { ...e, lengthM: e.lengthM + extraM } : e));
      const after = solve({ ...map, edges }, before.start, before.goal, lambda);
      assert.ok(after.result, "route disappeared");
      // The old route, now longer by extraM on one edge, is still available.
      const maxRise = extraM * classWeight(map.edges[step.edge]!.highway);
      assert.ok(after.totals!.cost >= before.totals.cost - 1e-9 * before.totals.cost, `cost fell: ${before.totals.cost} → ${after.totals!.cost}`);
      assert.ok(after.totals!.cost <= before.totals.cost + maxRise + 1e-6, `cost rose by more than the increase`);
    });
  });

  test("adding a sensor never lowers the optimal cost", () => {
    forAll("added sensor", 150, (rng) => {
      const map = rng.chance(0.5) ? smallMap(rng) : mediumMap(rng);
      const lambda = rng.pick([100, 1000, 5000]);
      const before = routableTrip(rng, map, lambda);
      if (!before) return;
      // Put the new sensor somewhere along the current route, so it matters.
      const [lng, lat] = rng.pick(before.result.geometry);
      const cam: FieldCamera = {
        latitude: lat + rng.float(-0.001, 0.001),
        longitude: lng + rng.float(-0.001, 0.001),
        directionDeg: rng.chance(0.5) ? rng.float(0, 360) : null,
        fovDeg: null,
        confidenceScore: rng.float(0, 1),
      };
      const after = solve({ ...map, cameras: [...map.cameras, cam] }, before.start, before.goal, lambda);
      assert.ok(after.result, "route disappeared");
      assert.ok(after.totals!.cost >= before.totals.cost - 1e-9 * before.totals.cost, `cost fell: ${before.totals.cost} → ${after.totals!.cost}`);
    });
  });

  test("a higher λ never yields more reads or a shorter weighted length", () => {
    forAll("λ monotonicity", 150, (rng) => {
      const map = rng.chance(0.5) ? smallMap(rng) : mediumMap(rng);
      const { start, goal } = pickTrip(rng, map);
      const lambdas = [0, ...Array.from({ length: 4 }, () => rng.float(0, 10000))].sort((a, b) => a - b);
      let prev: { lambda: number; reads: number; weighted: number } | null = null;
      for (const lambda of lambdas) {
        const s = solve(map, start, goal, lambda);
        if (!s.result) return; // unreachable at every λ
        const cur = { lambda, reads: s.totals!.reads, weighted: s.totals!.weightedMeters };
        if (prev) {
          assert.ok(cur.reads <= prev.reads + 1e-6, `reads rose from ${prev.reads} (λ=${prev.lambda}) to ${cur.reads} (λ=${lambda})`);
          assert.ok(cur.weighted >= prev.weighted - 1e-6, `weighted length fell from ${prev.weighted} to ${cur.weighted}`);
        }
        prev = cur;
      }
    });
  });

  test("the same input always gives the same output", () => {
    forAll("determinism", 100, (rng) => {
      const map = rng.chance(0.5) ? smallMap(rng) : mediumMap(rng);
      const lambda = pickLambda(rng);
      const { start, goal } = pickTrip(rng, map);
      const graph = buildGraph(map.nodes, map.edges);
      const field = new ExposureField(map.cameras);
      const first = routeCostSurface(graph, field, start, goal, lambda);
      const again = routeCostSurface(graph, field, start, goal, lambda);
      const clone = structuredClone(map);
      const rebuilt = routeCostSurface(buildGraph(clone.nodes, clone.edges), new ExposureField(clone.cameras), start, goal, lambda);
      assert.deepEqual(again, first, "second call on the same graph differs");
      assert.deepEqual(rebuilt, first, "call on a rebuilt copy of the input differs");
    });
  });

  test("on a map with no one-way streets, a trip costs the same in both directions", () => {
    forAll("reversal symmetry", 150, (rng) => {
      const map = rng.chance(0.5) ? smallMap(rng, { oneway: 0 }) : mediumMap(rng, { oneway: 0 });
      const lambda = pickLambda(rng);
      const { start, goal } = pickTrip(rng, map);
      const there = solve(map, start, goal, lambda);
      const back = solve(map, goal, start, lambda);
      assert.equal(there.result === null, back.result === null, "reachable in one direction only");
      if (there.result) assert.ok(close(there.totals!.cost, back.totals!.cost), `${there.totals!.cost} vs ${back.totals!.cost}`);
    });
  });

  test("the optimal cost does not depend on the order of the node and edge lists", () => {
    forAll("input order", 100, (rng) => {
      const map = rng.chance(0.5) ? smallMap(rng) : mediumMap(rng);
      const lambda = pickLambda(rng);
      const { start, goal } = pickTrip(rng, map);
      const a = solve(map, start, goal, lambda);
      const b = solve({ ...map, nodes: shuffled(rng, map.nodes), edges: shuffled(rng, map.edges) }, start, goal, lambda);
      assert.equal(a.result === null, b.result === null);
      if (a.result) assert.ok(close(a.totals!.cost, b.totals!.cost), `${a.totals!.cost} vs ${b.totals!.cost}`);
    });
  });

  test("an edge of infinite length is never driven (it is impassable)", () => {
    forAll("infinite length", 100, (rng) => {
      const map = rng.chance(0.5) ? smallMap(rng) : mediumMap(rng);
      const lambda = pickLambda(rng);
      const before = routableTrip(rng, map, lambda);
      if (!before) return;
      const blocked = rng.pick(before.steps).edge;
      const edges = map.edges.map((e, i) => (i === blocked ? { ...e, lengthM: Infinity } : e));
      const after = solve({ ...map, edges }, before.start, before.goal, lambda);
      const best = dijkstraCost(after.graph, after.reads, before.start, before.goal, lambda);
      if (best === Infinity) {
        assert.equal(after.result, null);
        return;
      }
      assert.ok(after.result, "route disappeared although an alternative exists");
      assert.ok(!after.steps!.some((s) => s.edge === blocked), "drove the infinite edge");
      assert.ok(close(after.totals!.cost, best));
    });
  });

  test("start equal to goal returns the single-node route", () => {
    forAll("start equals goal", 100, (rng) => {
      const map = rng.chance(0.5) ? smallMap(rng) : mediumMap(rng);
      const id = rng.pick(map.nodes).id;
      const r = routeCostSurface(buildGraph(map.nodes, map.edges), new ExposureField(map.cameras), id, id, pickLambda(rng));
      assert.deepEqual(r, { geometry: [], distanceMeters: 0, reads: 0, path: [id] });
    });
  });
});

describe("nearestNode properties", () => {
  test("returns one of the graph's nodes, and null only for an empty graph", () => {
    forAll("snap membership", 200, (rng) => {
      const map = rng.chance(0.2) ? { nodes: [], edges: [], cameras: [] } : mediumMap(rng);
      const graph = buildGraph(map.nodes, map.edges);
      const anchor = map.nodes.length ? rng.pick(map.nodes) : { lat: 36, lng: -115 };
      const id = nearestNode(graph, anchor.lat + rng.float(-0.02, 0.02), anchor.lng + rng.float(-0.02, 0.02));
      if (!map.nodes.length) assert.equal(id, null);
      else assert.ok(id !== null && graph.nodes.has(id), `snapped to ${id}`);
    });
  });

  test("a point exactly on a node snaps to a node at that position", () => {
    forAll("snap exact", 200, (rng) => {
      const map = mediumMap(rng);
      const graph = buildGraph(map.nodes, map.edges);
      const n = rng.pick(map.nodes);
      const id = nearestNode(graph, n.lat, n.lng)!;
      const got = graph.nodes.get(id)!;
      assert.equal(metersBetween(got.lng, got.lat, n.lng, n.lat), 0);
    });
  });
});
