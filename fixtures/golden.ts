import { buildGraph, nearestNode, type GraphNode, type GraphEdge } from "../src/graph.js";
import type { FieldCamera } from "../src/exposureField.js";
import type { LatLng } from "../src/corridorSearch.js";
import { M_PER_DEG, edgeBetween } from "./scenario.js";
import { saturatedDowntown } from "./synthetic.js";
import { downtownLv } from "./downtownLv.js";
import { randomGrid } from "./randomGraph.js";
import { createRng } from "./rng.js";

// The golden-output panel: fixed, deterministic inputs whose exact outputs are
// recorded in test/golden/*.json. test/golden.test.ts fails if any route, cost,
// snapped node, corridor or field value moves. Regenerate on purpose with
// `npm run golden:update` (see CONTRIBUTING.md).
//
// Everything here is synthetic and generated in code (the one exception,
// downtown-lv, reuses the committed OSM-derived road fixture with synthetic
// sensors). Trips name their start and goal by node id, so a route case does
// not depend on nearestNode; snapping has its own case.

export interface RouteTrip {
  label: string;
  start: number;
  goal: number;
  lambda: number;
}

export interface GoldenRouteCase {
  kind: "route";
  name: string;
  description: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  cameras: FieldCamera[];
  trips: RouteTrip[];
}

export interface GoldenSnapCase {
  kind: "snap";
  name: string;
  description: string;
  nodes: GraphNode[];
  points: (LatLng & { label: string })[];
}

export interface GoldenCorridorCase {
  kind: "corridor";
  name: string;
  description: string;
  cameras: FieldCamera[];
  trips: { label: string; from: LatLng; to: LatLng; metersPerRead: number }[];
}

export interface GoldenFieldCase {
  kind: "field";
  name: string;
  description: string;
  cameras: FieldCamera[];
  points: { label: string; lng: number; lat: number }[];
  lines: { label: string; coordinates: [number, number][] }[];
}

export type GoldenCase = GoldenRouteCase | GoldenSnapCase | GoldenCorridorCase | GoldenFieldCase;

// ---- geometry helpers --------------------------------------------------------

const LAT0 = 36.0;
const LNG0 = -115.0;

function placer(lat0 = LAT0, lng0 = LNG0) {
  const cos0 = Math.cos((lat0 * Math.PI) / 180);
  const node = (id: number, eastM: number, northM: number): GraphNode => ({
    id,
    lat: lat0 + northM / M_PER_DEG,
    lng: lng0 + eastM / (M_PER_DEG * cos0),
  });
  const cam = (
    eastM: number,
    northM: number,
    extra: Partial<FieldCamera> = {},
  ): FieldCamera => {
    const n = node(-1, eastM, northM);
    return {
      latitude: n.lat,
      longitude: n.lng,
      directionDeg: null,
      fovDeg: null,
      confidenceScore: 1,
      ...extra,
    };
  };
  return { node, cam };
}

interface Grid {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Node id at row r (north), column c (east). */
  id(r: number, c: number): number;
}

/** rows x cols two-way street grid, spacing metres apart. */
function grid(
  rows: number,
  cols: number,
  spacingM: number,
  opts: { highway?: string; idBase?: number; eastM?: number; northM?: number; lat0?: number } = {},
): Grid {
  const { highway = "residential", idBase = 0, eastM = 0, northM = 0 } = opts;
  const { node } = placer(opts.lat0);
  const nodes: GraphNode[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      nodes.push(node(idBase + r * cols + c, eastM + c * spacingM, northM + r * spacingM));
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
  return { nodes, edges, id: (r, c) => at(r, c).id };
}

// ---- route cases ---------------------------------------------------------------

function gridOpen(): GoldenRouteCase {
  const g = grid(6, 6, 100);
  return {
    kind: "route",
    name: "grid-open",
    description:
      "6x6 grid, 100 m blocks, no sensors. With no exposure, λ must not matter; the route is the " +
      "shortest by length (many near-equal Manhattan paths, so this also pins tie-breaking).",
    nodes: g.nodes,
    edges: g.edges,
    cameras: [],
    trips: [
      { label: "SW to NE, λ=0", start: g.id(0, 0), goal: g.id(5, 5), lambda: 0 },
      { label: "SW to NE, λ=1000", start: g.id(0, 0), goal: g.id(5, 5), lambda: 1000 },
      { label: "west to east along row 2, λ=0", start: g.id(2, 0), goal: g.id(2, 5), lambda: 0 },
      { label: "NW to row 0 col 3, λ=500", start: g.id(5, 0), goal: g.id(0, 3), lambda: 500 },
    ],
  };
}

function singleSensor(): GoldenRouteCase {
  const g = grid(7, 7, 100);
  const { cam } = placer();
  return {
    kind: "route",
    name: "single-sensor",
    description:
      "7x7 grid with one omnidirectional sensor 5 m off the centre intersection: the single " +
      "high-cost obstacle. As λ rises the west-east route must bow away from the centre.",
    nodes: g.nodes,
    edges: g.edges,
    cameras: [cam(305, 300)],
    trips: [0, 250, 1000, 5000].map((lambda) => ({
      label: `west to east through the centre row, λ=${lambda}`,
      start: g.id(3, 0),
      goal: g.id(3, 6),
      lambda,
    })).concat([{ label: "south to north, λ=1000", start: g.id(0, 3), goal: g.id(6, 3), lambda: 1000 }]),
  };
}

function coneSensor(): GoldenRouteCase {
  const g = grid(7, 7, 100);
  const { cam } = placer();
  return {
    kind: "route",
    name: "cone-sensor",
    description:
      "7x7 grid, one directional sensor at the centre facing east with a 60° cone and confidence " +
      "0.8. Pins the cone and blind-side factor: routes in front of the sensor cost more than " +
      "routes behind it.",
    nodes: g.nodes,
    edges: g.edges,
    cameras: [cam(300, 300, { directionDeg: 90, fovDeg: 60, confidenceScore: 0.8 })],
    trips: [
      { label: "west to east, λ=0", start: g.id(3, 0), goal: g.id(3, 6), lambda: 0 },
      { label: "west to east, λ=1000", start: g.id(3, 0), goal: g.id(3, 6), lambda: 1000 },
      { label: "south to north, λ=1000", start: g.id(0, 3), goal: g.id(6, 3), lambda: 1000 },
      { label: "west half only, λ=1000", start: g.id(0, 0), goal: g.id(6, 2), lambda: 1000 },
    ],
  };
}

function corridor(): GoldenRouteCase {
  // A 3-row ladder: rows 250 m apart, columns 200 m apart. Sensors line the
  // outer rows mid-block; the middle row is a cool corridor.
  const rows = 3;
  const cols = 12;
  const { node, cam } = placer();
  const nodes: GraphNode[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) nodes.push(node(r * cols + c, c * 200, r * 250));
  }
  const at = (r: number, c: number) => nodes[r * cols + c]!;
  const edges: GraphEdge[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (c + 1 < cols) edges.push(edgeBetween(at(r, c), at(r, c + 1), "residential"));
      if (r + 1 < rows) edges.push(edgeBetween(at(r, c), at(r + 1, c), "residential"));
    }
  }
  const cameras: FieldCamera[] = [];
  for (let c = 1; c <= 10; c++) {
    cameras.push(cam(c * 200 - 100, 6));
    cameras.push(cam(c * 200 - 100, 500 - 6));
  }
  return {
    kind: "route",
    name: "corridor",
    description:
      "A 3-row ladder whose outer streets are lined with sensors and whose middle street is a " +
      "cool corridor. At high λ the route must enter the corridor early and stay in it.",
    nodes,
    edges,
    cameras,
    trips: [
      { label: "row 0 west to row 2 east, λ=0", start: at(0, 0).id, goal: at(2, 11).id, lambda: 0 },
      { label: "row 0 west to row 2 east, λ=1000", start: at(0, 0).id, goal: at(2, 11).id, lambda: 1000 },
      { label: "row 0 west to row 2 east, λ=4000", start: at(0, 0).id, goal: at(2, 11).id, lambda: 4000 },
      { label: "row 0 west to row 0 east, λ=4000", start: at(0, 0).id, goal: at(0, 11).id, lambda: 4000 },
    ],
  };
}

function startEqualsGoal(): GoldenRouteCase {
  const g = grid(3, 3, 100);
  const { cam } = placer();
  return {
    kind: "route",
    name: "start-equals-goal",
    description:
      "Start and goal are the same node, including one that sits on a sensor. The route is the " +
      "single node: zero distance, zero reads, empty geometry.",
    nodes: g.nodes,
    edges: g.edges,
    cameras: [cam(100, 100)],
    trips: [
      { label: "centre to itself (on the sensor), λ=0", start: g.id(1, 1), goal: g.id(1, 1), lambda: 0 },
      { label: "centre to itself (on the sensor), λ=1000", start: g.id(1, 1), goal: g.id(1, 1), lambda: 1000 },
      { label: "corner to itself, λ=0", start: g.id(0, 0), goal: g.id(0, 0), lambda: 0 },
    ],
  };
}

function unreachable(): GoldenRouteCase {
  const { node } = placer();
  const a = grid(3, 3, 100);
  const b = grid(2, 2, 100, { idBase: 100, eastM: 1000 });
  const deadEnd = node(200, 300, 200);
  const nodes = [...a.nodes, ...b.nodes, deadEnd];
  const edges = [
    ...a.edges,
    ...b.edges,
    // One-way spur: reachable from the grid, no way back.
    edgeBetween(a.nodes[8]!, deadEnd, "residential", true),
  ];
  return {
    kind: "route",
    name: "unreachable",
    description:
      "Two disconnected components plus a one-way spur. Unreachable goals, one-way dead ends " +
      "and unknown node ids all return null; the reachable direction of the spur routes.",
    nodes,
    edges,
    cameras: [],
    trips: [
      { label: "goal in another component", start: a.id(0, 0), goal: b.id(0, 0), lambda: 0 },
      { label: "into the one-way spur (allowed)", start: a.id(0, 0), goal: 200, lambda: 0 },
      { label: "out of the one-way spur (against the one-way)", start: 200, goal: a.id(0, 0), lambda: 0 },
      { label: "unknown start id", start: 999, goal: a.id(0, 0), lambda: 0 },
      { label: "unknown goal id", start: a.id(0, 0), goal: 999, lambda: 0 },
    ],
  };
}

function ties(): GoldenRouteCase {
  const { node } = placer();
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // (1) Two identical parallel edges between the same pair of nodes.
  const s1 = node(1, 0, 0);
  const g1 = node(2, 200, 0);
  nodes.push(s1, g1);
  edges.push(edgeBetween(s1, g1, "residential"), edgeBetween(s1, g1, "residential"));

  // (2) A diamond whose two middle nodes share a position: an exact tie in
  //     length, exposure AND heuristic, so only insertion order can decide.
  const s2 = node(10, 0, 1000);
  const m2a = node(11, 100, 1100);
  const m2b = node(12, 100, 1100);
  const g2 = node(13, 200, 1000);
  nodes.push(s2, m2a, m2b, g2);
  edges.push(
    edgeBetween(s2, m2a, "residential"),
    edgeBetween(s2, m2b, "residential"),
    edgeBetween(m2a, g2, "residential"),
    edgeBetween(m2b, g2, "residential"),
  );

  // (3) A mirrored diamond: north and south branches of equal design length.
  const s3 = node(20, 0, 2000);
  const n3 = node(21, 100, 2100);
  const so3 = node(22, 100, 1900);
  const g3 = node(23, 200, 2000);
  nodes.push(s3, n3, so3, g3);
  edges.push(
    edgeBetween(s3, n3, "residential"),
    edgeBetween(s3, so3, "residential"),
    edgeBetween(n3, g3, "residential"),
    edgeBetween(so3, g3, "residential"),
  );

  return {
    kind: "route",
    name: "ties",
    description:
      "Equal-cost alternatives: identical parallel edges, a diamond with coincident middle nodes, " +
      "and a mirrored diamond. Pins which alternative the search returns, so a change to the heap " +
      "or to edge ordering that flips a tie shows up as a diff.",
    nodes,
    edges,
    cameras: [],
    trips: [
      { label: "parallel edges", start: 1, goal: 2, lambda: 0 },
      { label: "parallel edges, reversed", start: 2, goal: 1, lambda: 0 },
      { label: "coincident diamond", start: 10, goal: 13, lambda: 0 },
      { label: "coincident diamond, reversed", start: 13, goal: 10, lambda: 0 },
      { label: "mirrored diamond", start: 20, goal: 23, lambda: 0 },
      { label: "mirrored diamond, reversed", start: 23, goal: 20, lambda: 0 },
    ],
  };
}

function oneway(): GoldenRouteCase {
  const { node } = placer();
  const a = node(0, 0, 0);
  const b = node(1, 100, 0);
  const c = node(2, 200, 0);
  const shortcut: GraphEdge = {
    ...edgeBetween(a, c, "residential", true),
    lengthM: 150,
  };
  return {
    kind: "route",
    name: "oneway",
    description:
      "A one-way shortcut A→C (150 m) beside a two-way street A–B–C (200 m). The shortcut is " +
      "used from A to C and never from C to A.",
    nodes: [a, b, c],
    edges: [edgeBetween(a, b, "residential"), edgeBetween(b, c, "residential"), shortcut],
    cameras: [],
    trips: [
      { label: "A to C (with the one-way)", start: 0, goal: 2, lambda: 0 },
      { label: "C to A (against the one-way)", start: 2, goal: 0, lambda: 0 },
    ],
  };
}

function roadClass(): GoldenRouteCase {
  const { node } = placer();
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  // Component 1: 300 m service edge vs 500 m residential detour (×2.6 vs ×1.05).
  const a1 = node(0, 0, 0);
  const b1 = node(1, 300, 0);
  const r1a = node(2, 0, 100);
  const r1b = node(3, 300, 100);
  nodes.push(a1, b1, r1a, r1b);
  edges.push(
    edgeBetween(a1, b1, "service"),
    edgeBetween(a1, r1a, "residential"),
    edgeBetween(r1a, r1b, "residential"),
    edgeBetween(r1b, b1, "residential"),
  );
  // Component 2: 120 m service edge vs 500 m residential detour.
  const a2 = node(10, 0, 1000);
  const b2 = node(11, 120, 1000);
  const r2a = node(12, 0, 1190);
  const r2b = node(13, 120, 1190);
  nodes.push(a2, b2, r2a, r2b);
  edges.push(
    edgeBetween(a2, b2, "service"),
    edgeBetween(a2, r2a, "residential"),
    edgeBetween(r2a, r2b, "residential"),
    edgeBetween(r2b, b2, "residential"),
  );
  // Component 3: primary (×1) vs residential (×1.05) vs living_street (×1.25)
  // vs unclassified (×1.05) vs no class (×1) — three parallel branches.
  const a3 = node(20, 0, 2000);
  const b3 = node(21, 200, 2000);
  const p3 = node(22, 100, 2010);
  const q3 = node(23, 100, 1990);
  const l3 = node(24, 100, 2003);
  nodes.push(a3, b3, p3, q3, l3);
  edges.push(
    edgeBetween(a3, p3, "primary"),
    edgeBetween(p3, b3, "primary"),
    edgeBetween(a3, q3, "residential"),
    edgeBetween(q3, b3, "unclassified"),
    edgeBetween(a3, l3, "living_street"),
    edgeBetween(l3, b3),
  );
  return {
    kind: "route",
    name: "road-class",
    description:
      "Pins the drivability weights: a long service shortcut loses to a residential detour, a " +
      "short one wins, and near-equal branches are decided by class (primary ×1 < residential " +
      "×1.05 < living_street ×1.25).",
    nodes,
    edges,
    cameras: [],
    trips: [
      { label: "300 m service vs 500 m residential", start: 0, goal: 1, lambda: 0 },
      { label: "120 m service vs 500 m residential", start: 10, goal: 11, lambda: 0 },
      { label: "primary vs residential vs living_street", start: 20, goal: 21, lambda: 0 },
    ],
  };
}

function highLatitude(): GoldenRouteCase {
  const lat0 = 60;
  const g = grid(7, 7, 100, { lat0 });
  const { cam } = placer(lat0);
  return {
    kind: "route",
    name: "high-latitude",
    description:
      "The single-sensor idea at 60° N, with sensors 230 m due west and due east of the grid's " +
      "middle row. A degree of longitude is half as long here as at the equator, so this case " +
      "exercises the field's spatial index in the east-west direction.",
    nodes: g.nodes,
    edges: g.edges,
    cameras: [cam(-230, 300), cam(600 + 230, 300), cam(300, 300)],
    trips: [
      { label: "west to east, λ=0", start: g.id(3, 0), goal: g.id(3, 6), lambda: 0 },
      { label: "west to east, λ=1000", start: g.id(3, 0), goal: g.id(3, 6), lambda: 1000 },
      { label: "west to east, λ=3000", start: g.id(3, 0), goal: g.id(3, 6), lambda: 3000 },
      { label: "SW to NE, λ=2000", start: g.id(0, 0), goal: g.id(6, 6), lambda: 2000 },
    ],
  };
}

/** Options for the large seeded grid; the perf bench scales the same recipe up. */
export const LARGE_GRID_SEED = 20261104;
export function largeGridOptions(size: number) {
  return {
    rows: size,
    cols: size,
    spacingM: 100,
    dropEdge: 0.08,
    oneway: 0.1,
    diagonals: 0.05,
    classes: ["residential", "residential", "residential", "tertiary", "primary", "service", undefined],
    sensors: Math.round((size * size) / 60),
  } as const;
}

function largeGrid(): GoldenRouteCase {
  const size = 80;
  const g = randomGrid(LARGE_GRID_SEED, largeGridOptions(size));
  const last = size - 1;
  const mid = size >> 1;
  return {
    kind: "route",
    name: "large-grid",
    description:
      `Seeded random ${size}x${size} street grid (jittered, bent edges, 8% dropped, 10% one-way, ` +
      "mixed road classes) with seeded synthetic sensors. The larger-map correctness check; the " +
      "perf bench runs the same recipe at larger sizes.",
    nodes: g.nodes,
    edges: g.edges,
    cameras: g.cameras,
    trips: [
      { label: "SW to NE, λ=0", start: g.at(0, 0).id, goal: g.at(last, last).id, lambda: 0 },
      { label: "SW to NE, λ=1500", start: g.at(0, 0).id, goal: g.at(last, last).id, lambda: 1500 },
      { label: "west to east, λ=3000", start: g.at(mid, 0).id, goal: g.at(mid, last).id, lambda: 3000 },
      { label: "NW to SE, λ=800", start: g.at(last, 0).id, goal: g.at(0, last).id, lambda: 800 },
    ],
  };
}

function downtownLvRoutes(): GoldenRouteCase {
  const s = downtownLv();
  const graph = buildGraph(s.nodes, s.edges);
  const start = nearestNode(graph, s.from.lat, s.from.lng)!;
  const goal = nearestNode(graph, s.to.lat, s.to.lng)!;
  return {
    kind: "route",
    name: "downtown-lv",
    description:
      "The committed real-geometry road fixture (OSM-derived, synthetic sensors) at four points " +
      "of the λ ladder. Pins the exact path, not just the bench's summary metrics.",
    nodes: s.nodes,
    edges: s.edges,
    cameras: s.cameras,
    trips: [0, 700, 2200, 9000].map((lambda) => ({
      label: `fixture trip, λ=${lambda}`,
      start,
      goal,
      lambda,
    })),
  };
}

// ---- snapping, corridor and field cases -----------------------------------------

function snap(): GoldenSnapCase {
  const g = randomGrid(7, { rows: 10, cols: 10, spacingM: 100, jitterM: 30 });
  const rng = createRng(11);
  const cos0 = Math.cos((LAT0 * Math.PI) / 180);
  const points: GoldenSnapCase["points"] = [];
  for (let i = 0; i < 40; i++) {
    const e = rng.float(-50, 950);
    const n = rng.float(-50, 950);
    points.push({ label: `p${i}`, lat: LAT0 + n / M_PER_DEG, lng: LNG0 + e / (M_PER_DEG * cos0) });
  }
  points.push({ label: "2 km north of the grid", lat: LAT0 + 3000 / M_PER_DEG, lng: LNG0 });
  points.push({ label: "2 km east of the grid", lat: LAT0, lng: LNG0 + 3000 / (M_PER_DEG * cos0) });
  return {
    kind: "snap",
    name: "snap",
    description:
      "nearestNode on a jittered 10x10 grid at 36° N: 40 seeded points inside the grid and two far " +
      "outside it. Pins which node each point snaps to.",
    nodes: g.nodes,
    points,
  };
}

function corridorSearch(): GoldenCorridorCase {
  const s = saturatedDowntown();
  const { node } = placer();
  const far = node(-1, 40_000, 40_000);
  return {
    kind: "corridor",
    name: "corridor-search",
    description:
      "findCoolCorridor (the experimental grid search) over the saturated-downtown sensor walls " +
      "at three exchange rates, plus the two documented null cases: same cell, and a grid too " +
      "large to search.",
    cameras: s.cameras,
    trips: [
      ...[0, 1500, 5000].map((metersPerRead) => ({
        label: `west to east, metersPerRead=${metersPerRead}`,
        from: s.from,
        to: s.to,
        metersPerRead,
      })),
      { label: "from equals to", from: s.from, to: s.from, metersPerRead: 1500 },
      { label: "trip too large for the grid", from: s.from, to: { lat: far.lat, lng: far.lng }, metersPerRead: 1500 },
    ],
  };
}

function field(): GoldenFieldCase {
  const { cam, node } = placer();
  const hi = placer(60);
  const cameras: FieldCamera[] = [
    cam(0, 0), // omnidirectional, confidence 1
    cam(1000, 0, { directionDeg: 0, fovDeg: 60, confidenceScore: null }), // facing north
    cam(2000, 0, { confidenceScore: 0.2 }), // low confidence
    cam(3000, 0, { directionDeg: 90, fovDeg: null, confidenceScore: 0.9 }), // facing east, default cone
  ];
  const pt = (label: string, e: number, n: number) => {
    const p = node(-1, e, n);
    return { label, lng: p.lng, lat: p.lat };
  };
  const points = [
    pt("omni: on the sensor", 0, 0),
    pt("omni: 15 m north (core)", 0, 15),
    pt("omni: 30 m east (core edge)", 30, 0),
    pt("omni: 100 m south", 0, -100),
    pt("omni: 200 m west", -200, 0),
    pt("omni: 259 m north", 0, 259),
    pt("omni: 261 m north (out of range)", 0, 261),
    pt("omni: 230 m east", 230, 0),
    pt("omni: 245 m west", -245, 0),
    pt("cone: 100 m north (in cone)", 1000, 100),
    pt("cone: 100 m south (blind side)", 1000, -100),
    pt("cone: 100 m at 45° (taper)", 1000 + 70.71, 70.71),
    pt("cone: 100 m east (beside)", 1100, 0),
    pt("low confidence: 50 m north", 2000, 50),
    pt("default cone: 100 m east (in cone)", 3100, 0),
    pt("default cone: 100 m north (outside)", 3000, 100),
    pt("between two sensors", 500, 0),
  ];
  // One more omnidirectional sensor at 60° N, thousands of km from the others,
  // probed 230 m due east and due west.
  const hiPoint = hi.node(-1, 230, 0);
  cameras.push(hi.cam(0, 0));
  points.push({ label: "60° N: 230 m east of a sensor", lng: hiPoint.lng, lat: hiPoint.lat });
  points.push({ label: "60° N: 230 m west of a sensor", lng: hi.node(-1, -230, 0).lng, lat: hiPoint.lat });

  const line = (label: string, pts: [number, number][]) => ({
    label,
    coordinates: pts.map(([e, n]) => {
      const p = node(-1, e, n);
      return [p.lng, p.lat] as [number, number];
    }),
  });
  return {
    kind: "field",
    name: "field",
    description:
      "The exposure field itself: heat at fixed probe points around omnidirectional, directional " +
      "and low-confidence sensors (including 60° N), and scoreRouteExposureField / edgeExposure " +
      "along fixed lines.",
    cameras,
    points,
    lines: [
      line("straight past the omni sensor at 20 m", [[-500, 20], [500, 20]]),
      line("straight past the omni sensor, many vertices", Array.from({ length: 51 }, (_, i) => [-500 + i * 20, 20] as [number, number])),
      line("in front of then behind the cone sensor", [[900, 150], [1100, 150], [1100, -150], [900, -150]]),
      line("far from every sensor", [[-500, 2000], [3500, 2000]]),
      line("single point", [[0, 0]]),
    ],
  };
}

export function goldenCases(): GoldenCase[] {
  return [
    gridOpen(),
    singleSensor(),
    coneSensor(),
    corridor(),
    startEqualsGoal(),
    unreachable(),
    ties(),
    oneway(),
    roadClass(),
    highLatitude(),
    largeGrid(),
    downtownLvRoutes(),
    snap(),
    corridorSearch(),
    field(),
  ];
}
