import type { GraphNode, GraphEdge } from "../src/graph.js";
import type { FieldCamera } from "../src/exposureField.js";
import type { LatLng } from "../src/corridorSearch.js";

// A benchmark scenario: a road graph, a set of SYNTHETIC sensors, one trip,
// and the λ (metres of extra driving per expected read avoided) the scenario
// is judged at. The bench also routes every scenario at λ=0 as the shortest-
// path reference, so "added distance" is always measured against something.

export interface Scenario {
  name: string;
  /** What the scenario exists to prove, in one or two sentences. */
  description: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  cameras: FieldCamera[];
  from: LatLng;
  to: LatLng;
  /** The λ this scenario is judged at (λ=0 is always run as the reference). */
  lambda: number;
  /**
   * "route": standard single-trip metrics.
   * "ladder": run the whole λ ladder and report the candidate spread — guards
   * against the historical cliff where no moderate detour was ever generated.
   */
  kind: "route" | "ladder";
}

export const M_PER_DEG = 111_320;

/** Straight line from a to b densified every ~20 m, as edge geometry. */
export function densify(
  aLng: number,
  aLat: number,
  bLng: number,
  bLat: number,
  stepM = 20,
): [number, number][] {
  const dLatM = (bLat - aLat) * M_PER_DEG;
  const dLngM = (bLng - aLng) * M_PER_DEG * Math.cos((aLat * Math.PI) / 180);
  const n = Math.max(2, Math.ceil(Math.hypot(dLatM, dLngM) / stepM));
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    out.push([aLng + ((bLng - aLng) * i) / n, aLat + ((bLat - aLat) * i) / n]);
  }
  return out;
}

/** Edge between two nodes with straight densified geometry. */
export function edgeBetween(
  a: GraphNode,
  b: GraphNode,
  highway?: string,
  oneway = false,
): GraphEdge {
  const dLat = (b.lat - a.lat) * M_PER_DEG;
  const dLng = (b.lng - a.lng) * M_PER_DEG * Math.cos((a.lat * Math.PI) / 180);
  return {
    a: a.id,
    b: b.id,
    geom: densify(a.lng, a.lat, b.lng, b.lat),
    lengthM: Math.hypot(dLat, dLng),
    oneway,
    highway,
  };
}
