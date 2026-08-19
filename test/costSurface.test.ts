import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildGraph,
  routeCostSurface,
  nearestNode,
  edgeExposure,
  type GraphNode,
  type GraphEdge,
} from "../src/graph.js";
import { ExposureField, type FieldCamera } from "../src/exposureField.js";

// The cost-surface router prices exposure into the route: it decides how much a
// route's contact with a sensor's field of view is worth trading distance for.
// Its one load-bearing property is that a slightly longer CLEAN road must beat a
// short HOT one once exposure is priced in (λ>0) — the exact thing exclusion
// circles could not express. Prove it on a synthetic two-corridor graph, in
// metres, with one sensor.

function densify(aLng: number, aLat: number, bLng: number, bLat: number, n = 8): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) out.push([aLng + ((bLng - aLng) * i) / n, aLat + ((bLat - aLat) * i) / n]);
  return out;
}

const M_PER_DEG = 111_320;
function edge(a: GraphNode, b: GraphNode): GraphEdge {
  const dLat = (b.lat - a.lat) * M_PER_DEG;
  const dLng = (b.lng - a.lng) * M_PER_DEG * Math.cos((a.lat * Math.PI) / 180);
  return {
    a: a.id,
    b: b.id,
    geom: densify(a.lng, a.lat, b.lng, b.lat),
    lengthM: Math.hypot(dLat, dLng),
    oneway: false,
  };
}

describe("cost-surface router", () => {
  // A north-bound trip with two parallel corridors:
  //   west corridor: nodes 1→2→3 (straight, but a camera sits on node 2)
  //   east corridor: nodes 1→4→3 (a 320 m dogleg — clear of the camera field)
  const lat0 = 36.06;
  const lng0 = -115.1;
  const dNorth = 300 / M_PER_DEG;
  const dEast = 320 / (M_PER_DEG * Math.cos((lat0 * Math.PI) / 180));

  const n1: GraphNode = { id: 1, lat: lat0, lng: lng0 }; // start (south)
  const n3: GraphNode = { id: 3, lat: lat0 + 2 * dNorth, lng: lng0 }; // goal (north)
  const n2: GraphNode = { id: 2, lat: lat0 + dNorth, lng: lng0 }; // west mid (camera here)
  // East corridor as a RECTANGULAR jog so the whole detour stays >=300 m clear
  // of the camera (a diagonal shortcut dips within the field's 260 m reach).
  const e1: GraphNode = { id: 4, lat: lat0, lng: lng0 + dEast }; // SE corner
  const e2: GraphNode = { id: 5, lat: lat0 + 2 * dNorth, lng: lng0 + dEast }; // NE corner

  const graph = buildGraph(
    [n1, n2, n3, e1, e2],
    [edge(n1, n2), edge(n2, n3), edge(n1, e1), edge(e1, e2), edge(e2, n3)],
  );

  const camera: FieldCamera = {
    latitude: n2.lat,
    longitude: n2.lng,
    directionDeg: null,
    fovDeg: null,
    confidenceScore: 1,
  };
  const field = new ExposureField([camera]);

  test("the west corridor is genuinely hot, the east corridor is clean", () => {
    const west = edgeExposure(edge(n1, n2), field) + edgeExposure(edge(n2, n3), field);
    const east =
      edgeExposure(edge(n1, e1), field) +
      edgeExposure(edge(e1, e2), field) +
      edgeExposure(edge(e2, n3), field);
    assert.ok(west > 0.4, `west corridor should be hot, got ${west}`);
    assert.ok(east < 0.05, `east corridor should be clean, got ${east}`);
  });

  test("λ=0 (avoidance off) takes the shortest road — through the camera", () => {
    const r = routeCostSurface(graph, field, 1, 3, 0);
    assert.ok(r, "route should exist");
    assert.deepEqual(r!.path, [1, 2, 3]);
  });

  test("λ>0 (avoidance on) takes the slightly longer CLEAN road", () => {
    const r = routeCostSurface(graph, field, 1, 3, 500);
    assert.ok(r, "route should exist");
    assert.deepEqual(r!.path, [1, 4, 5, 3], "should detour east around the camera");
    assert.ok(r!.reads < 0.05, `chosen route should be clean, got ${r!.reads} reads`);
  });

  test("higher λ never yields a hotter route than lower λ (monotonic)", () => {
    const lo = routeCostSurface(graph, field, 1, 3, 100)!;
    const hi = routeCostSurface(graph, field, 1, 3, 5000)!;
    assert.ok(hi.reads <= lo.reads + 1e-9, `hi reads ${hi.reads} > lo reads ${lo.reads}`);
  });

  test("nearestNode snaps a coordinate to the closest graph node", () => {
    assert.equal(nearestNode(graph, e1.lat + 0.00001, e1.lng), 4);
  });

  test("unreachable goal returns null", () => {
    const isolated = buildGraph([n1, n2, { id: 9, lat: 40, lng: -120 }], [edge(n1, n2)]);
    assert.equal(routeCostSurface(isolated, field, 1, 9, 0), null);
  });
});
