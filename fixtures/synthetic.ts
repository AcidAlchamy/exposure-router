import type { GraphNode, GraphEdge } from "../src/graph.js";
import type { FieldCamera } from "../src/exposureField.js";
import { M_PER_DEG, edgeBetween, type Scenario } from "./scenario.js";

// Synthetic scenario geometry. These grids are ABSTRACT — the coordinates are
// an arbitrary anchor in open desert, the streets do not exist, and every
// sensor in every scenario is invented. Three of the four scenarios are
// reconstructions of real cases the engine got wrong once (see each
// description); they are rebuilt synthetically so the repository never carries
// a real location.

const LAT0 = 36.0;
const LNG0 = -115.0;
const COS0 = Math.cos((LAT0 * Math.PI) / 180);

/** Node at (metres east, metres north) of the anchor. */
function nodeAt(id: number, eastM: number, northM: number): GraphNode {
  return {
    id,
    lat: LAT0 + northM / M_PER_DEG,
    lng: LNG0 + eastM / (M_PER_DEG * COS0),
  };
}

/** Omnidirectional sensor at (metres east, metres north) of the anchor. */
function camAt(eastM: number, northM: number, confidence = 1): FieldCamera {
  const n = nodeAt(-1, eastM, northM);
  return {
    latitude: n.lat,
    longitude: n.lng,
    directionDeg: null,
    fovDeg: null,
    confidenceScore: confidence,
  };
}

interface Grid {
  nodes: GraphNode[];
  edges: GraphEdge[];
  at(r: number, c: number): GraphNode;
}

/** rows x cols street grid, spacing metres apart, all edges two-way. */
function grid(
  rows: number,
  cols: number,
  spacingM: number,
  highway: string,
  originEastM = 0,
  originNorthM = 0,
  idBase = 0,
): Grid {
  const nodes: GraphNode[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      nodes.push(nodeAt(idBase + r * cols + c, originEastM + c * spacingM, originNorthM + r * spacingM));
    }
  }
  const at = (r: number, c: number) => nodes[r * cols + c]!;
  const edges: GraphEdge[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (c + 1 < cols) edges.push(edgeBetween(at(r, c), at(r, c + 1), highway));
      if (r + 1 < rows) edges.push(edgeBetween(at(r, c), at(r + 1, c), highway));
    }
  }
  return { nodes, edges, at };
}

/**
 * clean-parallel-street — the founding case: a straight street with one sensor
 * mid-block, and a parallel street one block over. With exposure priced at
 * λ=0 the router drives straight past the sensor; at the judged λ it must
 * take the parallel street. Exclusion-circle routing could never express this,
 * which is why this engine exists.
 */
export function parallelStreet(): Scenario {
  const g = grid(5, 6, 120, "residential");
  return {
    name: "parallel-street",
    description:
      "Straight street with one mid-block sensor; a clean parallel street one block over. " +
      "Judged λ must move the route off the sensor street; λ=0 must not.",
    nodes: g.nodes,
    edges: g.edges,
    // Mid-block between (2,2) and (2,3), 8 m off the roadway.
    cameras: [camAt(2 * 120 + 60, 2 * 120 + 8)],
    from: { lat: g.at(2, 0).lat, lng: g.at(2, 0).lng },
    to: { lat: g.at(2, 5).lat, lng: g.at(2, 5).lng },
    lambda: 1000,
    kind: "route",
  };
}

/**
 * flanked-exit — the honest failure case, reconstructed synthetically from a
 * real measured trip (the original sits at a private address and is not in
 * this repository). Every street out of the neighbourhood passes two sensors;
 * the only clean-ish alternative is a ~9 km perimeter that itself passes one.
 * The engine's job here is NOT to find a zero-exposure route — none exists —
 * it is to report the exposure honestly instead of pretending. Expected at the
 * judged λ: both sensors crossed, tiny added distance.
 */
export function flankedExit(): Scenario {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let id = 0;
  const mk = (eastM: number, northM: number) => {
    const n = nodeAt(id++, eastM, northM);
    nodes.push(n);
    return n;
  };

  const O = mk(0, 0); // origin, inside the neighbourhood
  const X1 = mk(300, 0); // gate street — sensor A mid-block
  const X2 = mk(500, 0); // collector — sensor B mid-block
  edges.push(edgeBetween(O, X1, "residential"));
  edges.push(edgeBetween(X1, X2, "residential"));

  // Small grid east of the collector, destination at its far corner.
  const g = grid(3, 4, 200, "residential", 500, -200, id);
  id += g.nodes.length;
  nodes.push(...g.nodes);
  edges.push(...g.edges);
  edges.push(edgeBetween(X2, g.at(1, 0), "residential"));
  const D = g.at(1, 3); // ~1.1 km east of the origin

  // Perimeter escape: west out of the neighbourhood, then a long tertiary arc
  // north and east, rejoining near the destination. ~9 km in total, with one
  // sensor on the final arterial approach — even the long way is watched.
  const arc: GraphNode[] = [O];
  const arcPts: [number, number][] = [
    [-400, 0],
    [-400, 1800],
    [1500, 2600],
    [3400, 1800],
    [3400, 200],
    [1400, -400],
  ];
  for (const [e, n] of arcPts) arc.push(mk(e, n));
  for (let i = 0; i < arc.length - 1; i++) edges.push(edgeBetween(arc[i]!, arc[i + 1]!, "tertiary"));
  edges.push(edgeBetween(arc[arc.length - 1]!, D, "tertiary"));

  return {
    name: "flanked-exit",
    description:
      "Every exit passes two sensors; the ~9 km perimeter alternative passes one. " +
      "No clean route exists — the engine must keep the short route at sane λ and report 2 crossings honestly.",
    nodes,
    edges,
    cameras: [
      camAt(150, 8), // sensor A: gate street mid-block
      camAt(400, -8), // sensor B: collector mid-block
      camAt(2400, -100), // sensor C: on the perimeter's arterial approach
    ],
    from: { lat: O.lat, lng: O.lng },
    to: { lat: D.lat, lng: D.lng },
    lambda: 2200,
    kind: "route",
  };
}

/**
 * saturated-downtown — three north-south sensor walls stand between origin and
 * destination, each with a single one-block gap, and the gaps do not line up.
 * The straight street crosses all three walls; the only clean line is a slalom
 * that threads all three gaps. Exclusion-circle routing structurally cannot
 * find this (each wall is a wall); the gradient can. If the field's shoulder
 * or the search regresses, the slalom disappears and this row shouts.
 */
export function saturatedDowntown(): Scenario {
  // 200 m blocks: wide enough that a wall's neighbours (±200 m) leave a gap
  // genuinely cooler than the wall itself — with 100 m blocks the whole grid
  // is one heat bath (every point < 260 m of several sensors) and threading
  // saves nothing, which is itself a finding the field's numbers make obvious.
  const g = grid(10, 10, 200, "residential");
  const cams: FieldCamera[] = [];
  const gapRow: Record<number, number> = { 2: 7, 5: 4, 8: 6 }; // col -> gap row
  for (const c of [2, 5, 8]) {
    for (let r = 0; r < 10; r++) {
      if (r === gapRow[c]) continue;
      cams.push(camAt(c * 200 + 4, r * 200)); // on the vertical street itself
    }
  }
  return {
    name: "saturated-downtown",
    description:
      "Three sensor walls with misaligned one-block gaps between a west and an east endpoint. " +
      "The judged route must thread the slalom (crossings 3→0) at the λ-priced added distance.",
    nodes: g.nodes,
    edges: g.edges,
    cameras: cams,
    from: { lat: g.at(5, 0).lat, lng: g.at(5, 0).lng },
    to: { lat: g.at(5, 9).lat, lng: g.at(5, 9).lng },
    lambda: 1500,
    kind: "route",
  };
}

/**
 * parking-lot-temptation — reconstruction of a real regression (measured at a
 * private address, rebuilt abstractly here): around the origin the graph held
 * 285 service edges against 4 residential ones, and with no road-class term
 * the router "won" by cutting through parking aisles — 1199 m of lot against
 * Valhalla's 2008 m of street. The drivability weight (service ×2.6) is what
 * keeps aisles usable but never preferable. Expected: the 2 km residential
 * path wins over the 1.2 km aisle chain, and metres-on-service is 0.
 */
export function parkingLotTemptation(): Scenario {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let id = 0;
  const mk = (eastM: number, northM: number) => {
    const n = nodeAt(id++, eastM, northM);
    nodes.push(n);
    return n;
  };

  const A = mk(0, 0);
  const B = mk(1200, 0);

  // The legal way around the block: 400 m up, 1200 m across, 400 m down.
  const R1 = mk(0, 400);
  const R2 = mk(1200, 400);
  edges.push(edgeBetween(A, R1, "residential"));
  edges.push(edgeBetween(R1, R2, "residential"));
  edges.push(edgeBetween(R2, B, "residential"));

  // The temptation: a straight chain of parking aisles, 1200 m point to point.
  let prev = A;
  for (let i = 1; i <= 7; i++) {
    const s = mk(i * 150, i % 2 === 0 ? 20 : -20); // slight jog, like real aisles
    edges.push(edgeBetween(prev, s, "service"));
    prev = s;
  }
  edges.push(edgeBetween(prev, B, "service"));

  return {
    name: "parking-lot-temptation",
    description:
      "A 1.2 km chain of parking aisles against a 2 km residential path, no sensors. " +
      "The drivability weight must keep the route on streets: distance ≈ 2 km, service metres = 0.",
    nodes,
    edges,
    cameras: [],
    from: { lat: A.lat, lng: A.lng },
    to: { lat: B.lat, lng: B.lng },
    lambda: 0,
    kind: "route",
  };
}
