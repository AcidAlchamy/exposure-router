import { ExposureField, metersBetween } from "./exposureField.js";

/**
 * Distance multiplier by road class. 1.0 = take it at face value.
 *
 * These are DRIVABILITY weights, not camera weights — they answer "would a
 * driver actually use this?", which the raw graph cannot express. Service roads
 * (parking aisles, alleys, drive-throughs) stay usable, because sometimes the
 * genuinely quiet path IS the back of a lot — but at 2.6x they never win on
 * convenience alone.
 */
function classWeight(hw?: string): number {
  switch (hw) {
    case "service":
      return 2.6;
    case "living_street":
      return 1.25;
    case "residential":
    case "unclassified":
      return 1.05;
    default:
      return 1;
  }
}

// The cost-surface router's core: a road graph and an A* that minimises
// distance + λ·exposure, where exposure is the camera "temperature" integrated
// along each road segment.
//
// This model replaced exclusion polygons. A circle is a wall — it blocks every road through its disc, including the one
// that passes safely at 80 m, which is why the old router kept butting into a
// camera when a slightly-longer-but-cleaner road existed. Here a road near a
// camera simply COSTS more; the optimiser flows around heat like water downhill
// and naturally prefers the parallel street one block over when it's cheaper
// overall. λ (metresPerRead) is the avoidance dial: how many extra metres of
// driving one expected plate-read is worth.
//
// Pure and dependency-free (only the ExposureField, itself pure) so it runs
// under node:test with no DB and no network — the same discipline as
// proximityMath.ts.

export interface GraphNode {
  id: number;
  lat: number;
  lng: number;
}

export interface GraphEdge {
  /** Endpoint node ids. */
  a: number;
  b: number;
  /** Densified geometry [lng, lat] from a to b, for exposure integration + output. */
  geom: [number, number][];
  lengthM: number;
  /** OSM highway class — drives the drivability weight (see CLASS_WEIGHT). */
  highway?: string;
  /** false = two-way; when true the edge is only traversable a→b. */
  oneway: boolean;
}

export interface BuiltGraph {
  nodes: Map<number, GraphNode>;
  /** adjacency[nodeId] = list of {to, edgeIndex, forward} */
  adjacency: Map<number, { to: number; edge: number; forward: boolean }[]>;
  edges: GraphEdge[];
}

/** Assemble adjacency from raw nodes + edges. */
export function buildGraph(nodes: GraphNode[], edges: GraphEdge[]): BuiltGraph {
  const nodeMap = new Map<number, GraphNode>();
  for (const n of nodes) nodeMap.set(n.id, n);
  const adjacency = new Map<number, { to: number; edge: number; forward: boolean }[]>();
  const add = (from: number, to: number, edge: number, forward: boolean) => {
    let list = adjacency.get(from);
    if (!list) adjacency.set(from, (list = []));
    list.push({ to, edge, forward });
  };
  edges.forEach((e, i) => {
    add(e.a, e.b, i, true);
    if (!e.oneway) add(e.b, e.a, i, false);
  });
  return { nodes: nodeMap, adjacency, edges };
}

/** Sampling step for integrating the exposure field along an edge. */
const SAMPLE_M = 20;
const CORE_M = 30; // matches exposureField: crossing a core zone once ≈ 1 read

/**
 * Expected plate-reads accumulated by driving one edge — the integral of the
 * camera heat field along its geometry, in the same "reads" unit the rest of
 * the app scores in. Sampled by distance (not by vertex) so uneven vertex
 * spacing doesn't bias the estimate.
 */
export function edgeExposure(edge: GraphEdge, field: ExposureField): number {
  const co = edge.geom;
  if (co.length < 2) return 0;
  let integral = 0;
  let carry = 0;
  for (let i = 0; i < co.length - 1; i++) {
    const [aLng, aLat] = co[i]!;
    const [bLng, bLat] = co[i + 1]!;
    const segLen = metersBetween(aLng, aLat, bLng, bLat);
    if (segLen === 0) continue;
    let t = carry;
    while (t < segLen) {
      const f = t / segLen;
      integral += field.heatAt(aLng + (bLng - aLng) * f, aLat + (bLat - aLat) * f) * SAMPLE_M;
      t += SAMPLE_M;
    }
    carry = t - segLen;
  }
  return integral / (CORE_M * 2);
}

export interface CostSurfaceResult {
  /** [lng, lat] polyline of the chosen path. */
  geometry: [number, number][];
  distanceMeters: number;
  /** Expected plate-reads along the path (the field integral). */
  reads: number;
  /** Node ids visited, for maneuver reconstruction. */
  path: number[];
}

/**
 * A* from the node nearest `from` to the node nearest `to`, minimising
 *   distance + metresPerRead · exposure.
 *
 * The heuristic is straight-line distance to the goal, which is admissible for
 * the distance term; exposure only ADDS cost, so distance-only stays a valid
 * lower bound and A* remains optimal. Returns null if the goal is unreachable.
 */
export function routeCostSurface(
  graph: BuiltGraph,
  field: ExposureField,
  startId: number,
  goalId: number,
  metresPerRead: number,
): CostSurfaceResult | null {
  const goal = graph.nodes.get(goalId);
  if (!goal || !graph.nodes.has(startId)) return null;

  // Precompute exposure per edge once (each edge is relaxed from both ends).
  const edgeReads = new Float64Array(graph.edges.length);
  for (let i = 0; i < graph.edges.length; i++) edgeReads[i] = edgeExposure(graph.edges[i]!, field);

  const gScore = new Map<number, number>([[startId, 0]]);
  const cameFrom = new Map<number, { node: number; edge: number; forward: boolean }>();
  const closed = new Set<number>();

  const h = (id: number) => {
    const n = graph.nodes.get(id)!;
    return metersBetween(n.lng, n.lat, goal.lng, goal.lat);
  };

  // Binary heap of {id, f}.
  const heapId: number[] = [startId];
  const heapF: number[] = [h(startId)];
  const push = (id: number, f: number) => {
    heapId.push(id);
    heapF.push(f);
    let i = heapId.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapF[p]! <= heapF[i]!) break;
      [heapF[p], heapF[i]] = [heapF[i]!, heapF[p]!];
      [heapId[p], heapId[i]] = [heapId[i]!, heapId[p]!];
      i = p;
    }
  };
  const pop = (): number => {
    const top = heapId[0]!;
    const li = heapId.pop()!;
    const lf = heapF.pop()!;
    if (heapId.length) {
      heapId[0] = li;
      heapF[0] = lf;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < heapId.length && heapF[l]! < heapF[s]!) s = l;
        if (r < heapId.length && heapF[r]! < heapF[s]!) s = r;
        if (s === i) break;
        [heapF[s], heapF[i]] = [heapF[i]!, heapF[s]!];
        [heapId[s], heapId[i]] = [heapId[i]!, heapId[s]!];
        i = s;
      }
    }
    return top;
  };

  while (heapId.length) {
    const cur = pop();
    if (cur === goalId) break;
    if (closed.has(cur)) continue;
    closed.add(cur);
    const curG = gScore.get(cur)!;
    for (const nb of graph.adjacency.get(cur) ?? []) {
      if (closed.has(nb.to)) continue;
      const edge = graph.edges[nb.edge]!;
      // Multiply distance by a drivability weight BEFORE adding exposure.
      // Without this the router treats a supermarket parking aisle exactly like
      // a street — measured on a commercial start point, it produced a 1199 m
      // "route" against Valhalla's 2008 m by cutting through lots. Service
      // roads and alleys are slow, frequently private, and often not through-
      // routes; they should be usable but never preferred.
      const stepCost =
        edge.lengthM * classWeight(edge.highway) + metresPerRead * edgeReads[nb.edge]!;
      const tentative = curG + stepCost;
      if (tentative < (gScore.get(nb.to) ?? Infinity)) {
        gScore.set(nb.to, tentative);
        cameFrom.set(nb.to, { node: cur, edge: nb.edge, forward: nb.forward });
        push(nb.to, tentative + h(nb.to));
      }
    }
  }

  if (!gScore.has(goalId)) return null;

  // Reconstruct the path geometry + totals.
  const nodePath: number[] = [goalId];
  const geometry: [number, number][] = [];
  let distanceMeters = 0;
  let reads = 0;
  let at = goalId;
  const segs: { edge: number; forward: boolean }[] = [];
  while (at !== startId) {
    const step = cameFrom.get(at);
    if (!step) break;
    segs.push({ edge: step.edge, forward: step.forward });
    nodePath.push(step.node);
    at = step.node;
  }
  segs.reverse();
  nodePath.reverse();
  for (const { edge, forward } of segs) {
    const e = graph.edges[edge]!;
    const g = forward ? e.geom : [...e.geom].reverse();
    // Avoid duplicating the shared vertex between consecutive edges.
    geometry.push(...(geometry.length ? g.slice(1) : g));
    distanceMeters += e.lengthM;
    reads += edgeReads[edge]!;
  }
  return { geometry, distanceMeters, reads, path: nodePath };
}

/** Nearest graph node to a point (linear scan; the per-trip subgraph is small). */
export function nearestNode(graph: BuiltGraph, lat: number, lng: number): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  for (const n of graph.nodes.values()) {
    const d = (n.lat - lat) ** 2 + (n.lng - lng) ** 2;
    if (d < bestD) {
      bestD = d;
      best = n.id;
    }
  }
  return best;
}
