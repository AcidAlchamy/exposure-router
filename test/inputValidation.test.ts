import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, edgeExposure, nearestNode, routeCostSurface, type GraphEdge, type GraphNode } from "../src/graph.js";
import { ExposureField, scoreRouteExposureField, type FieldCamera } from "../src/exposureField.js";
import { M_PER_DEG, edgeBetween } from "../fixtures/scenario.js";

// Bad input must produce a clear error — never a hang, a crash with an
// unrelated message, or a route that looks valid but is not. Each test notes
// what the engine did with that input before it was validated.
//
// Two "no route" cases are deliberately NOT errors: an unknown start/goal id
// and an empty graph return null, the documented and typed "no route" result.

const LAT0 = 36;
const COS0 = Math.cos((LAT0 * Math.PI) / 180);
const at = (id: number, eastM: number, northM: number): GraphNode => ({
  id,
  lat: LAT0 + northM / M_PER_DEG,
  lng: -115 + eastM / (M_PER_DEG * COS0),
});

/** 3x3 grid, 100 m blocks, ids r*3+c; a sensor on the centre node. */
function grid3() {
  const nodes: GraphNode[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) nodes.push(at(r * 3 + c, c * 100, r * 100));
  const edges: GraphEdge[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (c < 2) edges.push(edgeBetween(nodes[r * 3 + c]!, nodes[r * 3 + c + 1]!, "residential"));
      if (r < 2) edges.push(edgeBetween(nodes[r * 3 + c]!, nodes[(r + 1) * 3 + c]!, "residential"));
    }
  }
  const camera: FieldCamera = {
    latitude: nodes[4]!.lat,
    longitude: nodes[4]!.lng,
    directionDeg: null,
    fovDeg: null,
    confidenceScore: 1,
  };
  return { nodes, edges, camera, field: new ExposureField([camera]) };
}

describe("routeCostSurface input validation", () => {
  const { nodes, edges, field } = grid3();
  const graph = buildGraph(nodes, edges);

  for (const lambda of [NaN, Infinity, -Infinity, -1000, -1e-9]) {
    test(`metresPerRead = ${lambda} is rejected`, () => {
      // Before: NaN and Infinity returned null ("unreachable") on a connected
      // graph (Infinity · 0 reads = NaN); a negative λ made edge costs negative
      // and returned an exposure-seeking route the search cannot vouch for.
      assert.throws(() => routeCostSurface(graph, field, 0, 8, lambda), {
        name: "RangeError",
        message: /metresPerRead must be a finite number >= 0/,
      });
    });
  }

  test("an edge with a NaN length is rejected", () => {
    // Before: the edge silently never relaxed, so 0→2 detoured 0-3-4-5-2.
    const bad = edges.map((e, i) => (i === 0 ? { ...e, lengthM: NaN } : e));
    assert.throws(() => routeCostSurface(buildGraph(nodes, bad), field, 0, 2, 0), {
      name: "RangeError",
      message: /edge 0 .*lengthM NaN/,
    });
  });

  test("an edge with a negative length is rejected", () => {
    // Before: a negative edge cost, which A* cannot handle; the route was
    // whatever the search happened to settle first.
    const bad = edges.map((e, i) => (i === 0 ? { ...e, lengthM: -500 } : e));
    assert.throws(() => routeCostSurface(buildGraph(nodes, bad), field, 0, 8, 0), {
      name: "RangeError",
      message: /edge 0 .*lengthM -500/,
    });
  });

  test("an edge of infinite length is accepted and never driven", () => {
    // Not an error: +Infinity is a consistent "impassable" cost.
    const closed = edges.map((e, i) => (i === 0 ? { ...e, lengthM: Infinity } : e));
    const r = routeCostSurface(buildGraph(nodes, closed), field, 0, 1, 0);
    assert.ok(r);
    assert.notDeepEqual(r.path, [0, 1]);
  });

  test("an edge to a node missing from the node list is a clear error, not a TypeError", () => {
    // Before: "Cannot read properties of undefined (reading 'lng')".
    const dangling = [...edges, edgeBetween(nodes[0]!, at(77, -100, 0), "residential")];
    assert.throws(() => routeCostSurface(buildGraph(nodes, dangling), field, 0, 8, 0), {
      name: "Error",
      message: /node 77, which is not in the graph/,
    });
  });

  test("a goal with a non-finite position is rejected", () => {
    // Before: every heuristic value was NaN, which breaks the heap's ordering;
    // the search returned a route without any optimality guarantee.
    const bad = nodes.map((n) => (n.id === 8 ? { ...n, lat: NaN } : n));
    assert.throws(() => routeCostSurface(buildGraph(bad, edges), field, 0, 8, 0), {
      name: "RangeError",
      message: /node 8 has a non-finite position/,
    });
  });

  test("a node with a non-finite position reached by the search is rejected", () => {
    const bad = nodes.map((n) => (n.id === 4 ? { ...n, lng: Infinity } : n));
    assert.throws(() => routeCostSurface(buildGraph(bad, edges), field, 0, 8, 0), {
      name: "RangeError",
      message: /node 4 has a non-finite position/,
    });
  });

  test("unknown ids and an empty graph return null (the documented 'no route')", () => {
    assert.equal(routeCostSurface(graph, field, 999, 8, 0), null);
    assert.equal(routeCostSurface(graph, field, 0, 999, 0), null);
    assert.equal(routeCostSurface(buildGraph([], []), field, 0, 1, 0), null);
  });
});

describe("nearestNode input handling", () => {
  test("an empty graph or a non-finite point gives null, never an arbitrary node", () => {
    const { nodes, edges } = grid3();
    const graph = buildGraph(nodes, edges);
    assert.equal(nearestNode(buildGraph([], []), LAT0, -115), null);
    assert.equal(nearestNode(graph, NaN, -115), null);
    assert.equal(nearestNode(graph, LAT0, Infinity), null);
  });
});

describe("exposure input validation", () => {
  const { nodes, edges, camera } = grid3();

  for (const [field, value] of [
    ["latitude", NaN],
    ["longitude", Infinity],
    ["confidenceScore", NaN],
    ["directionDeg", NaN],
    ["fovDeg", -Infinity],
  ] as const) {
    test(`a sensor with ${field} = ${value} is rejected`, () => {
      // Before: a NaN position put the sensor in a bucket no lookup visits, so
      // it was silently ignored; a NaN confidence made its heat NaN, which
      // poisoned every edge in range (0→8 at λ=1000 returned null); a NaN
      // facing or cone width silently behaved as omnidirectional.
      assert.throws(() => new ExposureField([camera, { ...camera, [field]: value }]), {
        name: "RangeError",
        message: new RegExp(`camera 1 has a non-finite ${field}`),
      });
    });
  }

  test("null facing, cone width and confidence are accepted", () => {
    const f = new ExposureField([{ ...camera, directionDeg: null, fovDeg: null, confidenceScore: null }]);
    assert.ok(f.heatAt(camera.longitude, camera.latitude) > 0);
  });

  test("an edge whose geometry has a non-finite coordinate is rejected", () => {
    // Before: a NaN segment length skipped the sampling loop and the NaN carry
    // skipped every later segment, so the edge scored 0 reads even when it ran
    // straight through a sensor.
    const field = new ExposureField([camera]);
    const bad: GraphEdge = { ...edges[3]!, geom: edges[3]!.geom.map(([lng, lat], i) => [i === 2 ? NaN : lng, lat]) };
    assert.throws(() => edgeExposure(bad, field), { name: "RangeError", message: /non-finite coordinate/ });
    const badEdges = edges.map((e, i) => (i === 3 ? bad : e));
    assert.throws(() => routeCostSurface(buildGraph(nodes, badEdges), field, 0, 8, 0), {
      name: "RangeError",
      message: /non-finite coordinate/,
    });
  });

  test("a route line with a non-finite coordinate is rejected", () => {
    // Before: score, peak and exposedMeters all came back 0.
    const field = new ExposureField([camera]);
    const line = { geometry: { coordinates: [[camera.longitude, camera.latitude - 0.001], [NaN, camera.latitude + 0.001]] as [number, number][] } };
    assert.throws(() => scoreRouteExposureField(line, field), { name: "RangeError", message: /non-finite coordinate/ });
  });
});
