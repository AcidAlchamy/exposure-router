import {
  classWeight,
  edgeExposure,
  type BuiltGraph,
  type CostSurfaceResult,
} from "../../src/graph.js";
import type { ExposureField } from "../../src/exposureField.js";

// Independent checks on a routeCostSurface result, shared by the golden
// harness and the property tests. Nothing here calls the router: it re-derives
// what the router should have done from the graph and the field alone.

export interface RouteStep {
  /** Index into graph.edges. */
  edge: number;
  /** true when the edge was driven a→b. */
  forward: boolean;
}

/** Per-edge exposure (expected reads) for a graph under a field, computed once. */
export function edgeReadsFor(graph: BuiltGraph, field: ExposureField): Float64Array {
  const reads = new Float64Array(graph.edges.length);
  for (let i = 0; i < graph.edges.length; i++) reads[i] = edgeExposure(graph.edges[i]!, field);
  return reads;
}

/** The router's per-edge objective: length · driveWeight + λ · reads. */
export function stepCost(graph: BuiltGraph, reads: Float64Array, edge: number, lambda: number): number {
  const e = graph.edges[edge]!;
  return e.lengthM * classWeight(e.highway) + lambda * reads[edge]!;
}

const sameCoords = (a: [number, number][], b: [number, number][]) =>
  a.length === b.length && a.every((p, i) => p[0] === b[i]![0] && p[1] === b[i]![1]);

/**
 * Recover the edges a route drove, from its node path and its geometry, and
 * check every step is a legal move. Throws (with the reason) if:
 *  - a consecutive node pair is not joined by an edge traversable in that
 *    direction (one-way edges only a→b),
 *  - the geometry is not exactly the concatenation of the edges' geometries,
 *  - the path does not start at `start` or end at `goal`.
 * Among parallel edges with matching geometry, the cheapest one (first in
 * adjacency order on a tie) is taken — the same rule the router applies.
 */
export function routeSteps(
  graph: BuiltGraph,
  reads: Float64Array,
  result: CostSurfaceResult,
  start: number,
  goal: number,
  lambda: number,
): RouteStep[] {
  const { path, geometry } = result;
  if (path[0] !== start) throw new Error(`route starts at ${path[0]}, not at the start ${start}`);
  if (path[path.length - 1] !== goal) {
    throw new Error(`route ends at ${path[path.length - 1]}, not at the goal ${goal}`);
  }
  const steps: RouteStep[] = [];
  let offset = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const u = path[i]!;
    const v = path[i + 1]!;
    const candidates = (graph.adjacency.get(u) ?? []).filter((nb) => nb.to === v);
    if (!candidates.length) throw new Error(`illegal move ${u}→${v}: no edge traversable in that direction`);
    let best: { edge: number; forward: boolean; cost: number; take: number } | null = null;
    for (const nb of candidates) {
      const e = graph.edges[nb.edge]!;
      const oriented = nb.forward ? e.geom : [...e.geom].reverse();
      const chunk = offset === 0 ? oriented : oriented.slice(1);
      if (!sameCoords(chunk, geometry.slice(offset, offset + chunk.length))) continue;
      const cost = stepCost(graph, reads, nb.edge, lambda);
      if (!best || cost < best.cost) best = { edge: nb.edge, forward: nb.forward, cost, take: chunk.length };
    }
    if (!best) throw new Error(`step ${u}→${v}: route geometry does not follow any connecting edge`);
    steps.push({ edge: best.edge, forward: best.forward });
    offset += best.take;
  }
  if (offset !== geometry.length) {
    throw new Error(`route geometry has ${geometry.length} points but its edges account for ${offset}`);
  }
  return steps;
}

export interface RouteTotals {
  /** Σ lengthM. */
  distanceMeters: number;
  /** Σ per-edge reads. */
  reads: number;
  /** Σ lengthM · driveWeight. */
  weightedMeters: number;
  /** The objective the router minimises: weightedMeters + λ · reads. */
  cost: number;
}

export function routeTotals(
  graph: BuiltGraph,
  reads: Float64Array,
  steps: RouteStep[],
  lambda: number,
): RouteTotals {
  let distanceMeters = 0;
  let r = 0;
  let weightedMeters = 0;
  let cost = 0;
  for (const { edge } of steps) {
    const e = graph.edges[edge]!;
    distanceMeters += e.lengthM;
    r += reads[edge]!;
    weightedMeters += e.lengthM * classWeight(e.highway);
    cost += stepCost(graph, reads, edge, lambda);
  }
  return { distanceMeters, reads: r, weightedMeters, cost };
}

/** |a - b| within a relative tolerance (with an absolute floor for values near 0). */
export function close(a: number, b: number, rel = 1e-9, abs = 1e-9): boolean {
  if (a === b) return true;
  return Math.abs(a - b) <= Math.max(abs, rel * Math.max(Math.abs(a), Math.abs(b)));
}
