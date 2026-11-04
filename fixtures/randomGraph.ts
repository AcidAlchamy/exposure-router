import type { GraphNode, GraphEdge } from "../src/graph.js";
import { metersBetween, type FieldCamera } from "../src/exposureField.js";
import { M_PER_DEG } from "./scenario.js";
import { createRng } from "./rng.js";

// Seeded random street grids, used by the golden large-map case, the
// performance bench and the property tests. Every value is derived from the
// seed, so the same (seed, options) pair yields byte-identical nodes, edges and
// sensors on every machine.
//
// Shape: a rows x cols lattice with jittered intersections, edges bent slightly
// off the straight line (so geometry is never degenerate and two routes almost
// never tie exactly), optional dropped edges, one-way edges, diagonals and a mix
// of road classes. Every sensor is synthetic.
//
// Edge lengths are the length of the edge's own geometry (the sum of great-
// circle segment lengths), so lengthM is never shorter than the straight line
// between its endpoints: the precondition the router's A* heuristic relies on.

export interface RandomGridOptions {
  rows: number;
  cols: number;
  /** Lattice spacing, metres. Default 100. */
  spacingM?: number;
  /** Max random offset of each intersection, metres. Default 20% of spacing. */
  jitterM?: number;
  /** Max sideways bend of an edge's midpoint, metres. Default 15% of spacing. */
  bendM?: number;
  /** Probability that a lattice edge is left out. Default 0. */
  dropEdge?: number;
  /** Probability that an edge is one-way (a→b). Default 0. */
  oneway?: number;
  /** Probability of a diagonal edge across each lattice cell. Default 0. */
  diagonals?: number;
  /** Road classes to draw from (undefined = no class). Default ["residential"]. */
  classes?: readonly (string | undefined)[];
  /** Number of synthetic sensors scattered over the area. Default 0. */
  sensors?: number;
  /** Fraction of sensors that have a facing and a cone. Default 0.5. */
  coneShare?: number;
  /** Anchor of the south-west corner. Default 36, -115 (abstract open desert). */
  lat0?: number;
  lng0?: number;
  /** First node id. Default 0; node id = idBase + r * cols + c. */
  idBase?: number;
}

export interface RandomGrid {
  nodes: GraphNode[];
  edges: GraphEdge[];
  cameras: FieldCamera[];
  /** Node at lattice row r, column c. */
  at(r: number, c: number): GraphNode;
}

/** Straight-line [lng, lat] pieces from a to b, about every stepM metres. */
function densifyLeg(a: [number, number], b: [number, number], stepM: number): [number, number][] {
  const len = metersBetween(a[0], a[1], b[0], b[1]);
  const n = Math.max(1, Math.ceil(len / stepM));
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    out.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
  }
  return out;
}

export function polylineLengthM(geom: [number, number][]): number {
  let len = 0;
  for (let i = 0; i < geom.length - 1; i++) {
    len += metersBetween(geom[i]![0], geom[i]![1], geom[i + 1]![0], geom[i + 1]![1]);
  }
  return len;
}

export function randomGrid(seed: number, opts: RandomGridOptions): RandomGrid {
  const rng = createRng(seed);
  const {
    rows,
    cols,
    spacingM = 100,
    dropEdge = 0,
    oneway = 0,
    diagonals = 0,
    classes = ["residential"],
    sensors = 0,
    coneShare = 0.5,
    lat0 = 36,
    lng0 = -115,
    idBase = 0,
  } = opts;
  const jitterM = opts.jitterM ?? spacingM * 0.2;
  const bendM = opts.bendM ?? spacingM * 0.15;
  const cos0 = Math.cos((lat0 * Math.PI) / 180);
  const toLat = (northM: number) => lat0 + northM / M_PER_DEG;
  const toLng = (eastM: number) => lng0 + eastM / (M_PER_DEG * cos0);

  const nodes: GraphNode[] = [];
  const pos: { e: number; n: number }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const e = c * spacingM + rng.float(-jitterM, jitterM);
      const n = r * spacingM + rng.float(-jitterM, jitterM);
      pos.push({ e, n });
      nodes.push({ id: idBase + r * cols + c, lat: toLat(n), lng: toLng(e) });
    }
  }
  const at = (r: number, c: number) => nodes[r * cols + c]!;

  const edges: GraphEdge[] = [];
  const link = (r1: number, c1: number, r2: number, c2: number) => {
    const i = r1 * cols + c1;
    const j = r2 * cols + c2;
    const pa = pos[i]!;
    const pb = pos[j]!;
    // Bend the midpoint sideways so the edge is a gentle dogleg, not a chord.
    const dx = pb.e - pa.e;
    const dy = pb.n - pa.n;
    const len = Math.hypot(dx, dy) || 1;
    const bend = rng.float(-bendM, bendM);
    const mid = { e: (pa.e + pb.e) / 2 - (dy / len) * bend, n: (pa.n + pb.n) / 2 + (dx / len) * bend };
    const a: [number, number] = [nodes[i]!.lng, nodes[i]!.lat];
    const m: [number, number] = [toLng(mid.e), toLat(mid.n)];
    const b: [number, number] = [nodes[j]!.lng, nodes[j]!.lat];
    const geom = [...densifyLeg(a, m, 20), ...densifyLeg(m, b, 20).slice(1)];
    const highway = rng.pick(classes);
    const edge: GraphEdge = {
      a: nodes[i]!.id,
      b: nodes[j]!.id,
      geom,
      lengthM: polylineLengthM(geom),
      oneway: rng.chance(oneway),
    };
    if (highway !== undefined) edge.highway = highway;
    edges.push(edge);
  };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (c + 1 < cols && !rng.chance(dropEdge)) link(r, c, r, c + 1);
      if (r + 1 < rows && !rng.chance(dropEdge)) link(r, c, r + 1, c);
      if (r + 1 < rows && c + 1 < cols && rng.chance(diagonals)) {
        if (rng.chance(0.5)) link(r, c, r + 1, c + 1);
        else link(r, c + 1, r + 1, c);
      }
    }
  }

  const cameras: FieldCamera[] = [];
  for (let k = 0; k < sensors; k++) {
    const e = rng.float(-spacingM, cols * spacingM);
    const n = rng.float(-spacingM, rows * spacingM);
    const cone = rng.chance(coneShare);
    cameras.push({
      latitude: toLat(n),
      longitude: toLng(e),
      directionDeg: cone ? rng.float(0, 360) : null,
      fovDeg: cone && rng.chance(0.7) ? rng.float(30, 120) : null,
      confidenceScore: rng.chance(0.2) ? null : rng.float(0.2, 1),
    });
  }

  return { nodes, edges, cameras, at };
}
