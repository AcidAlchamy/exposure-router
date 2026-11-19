// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { cameraHeatAt, ExposureField, type FieldCamera } from "../src/exposureField.js";
import { buildGraph, nearestNode, routeCostSurface } from "../src/graph.js";
import { poleGap } from "../fixtures/synthetic.js";

const M = 111_320;
const base: FieldCamera = { latitude: 36, longitude: -115, directionDeg: null, fovDeg: null, confidenceScore: 1 };
/** A point `m` metres from the sensor at bearing 0 (north), 90 (east), 180 or 270. */
const off = (m: number, bearing: number): [number, number] => {
  const r = (bearing * Math.PI) / 180;
  return [-115 + (Math.sin(r) * m) / (M * Math.cos((36 * Math.PI) / 180)), 36 + (Math.cos(r) * m) / M];
};

test("heads: each head's cone is full heat; between them is blind side", () => {
  const pole: FieldCamera = { ...base, heads: [{ directionDeg: 0, fovDeg: null }, { directionDeg: 180, fovDeg: null }] };
  const omni = cameraHeatAt(base, ...off(60, 0));
  assert.equal(cameraHeatAt(pole, ...off(60, 0)), omni, "north head sees north");
  assert.equal(cameraHeatAt(pole, ...off(60, 180)), omni, "south head sees south");
  const east = cameraHeatAt(pole, ...off(60, 90));
  assert.ok(Math.abs(east - omni * 0.25) < 1e-12, `east is blind side for both heads (got ${east})`);
});

test("heads: one head is exactly the single facing; none falls back to it", () => {
  const facing: FieldCamera = { ...base, directionDeg: 90, fovDeg: 40 };
  const oneHead: FieldCamera = { ...base, heads: [{ directionDeg: 90, fovDeg: 40 }] };
  for (const b of [0, 45, 90, 135, 200, 300]) {
    assert.equal(cameraHeatAt(oneHead, ...off(80, b)), cameraHeatAt(facing, ...off(80, b)));
    assert.equal(cameraHeatAt({ ...facing, heads: [] }, ...off(80, b)), cameraHeatAt(facing, ...off(80, b)));
    assert.equal(cameraHeatAt({ ...facing, heads: null }, ...off(80, b)), cameraHeatAt(facing, ...off(80, b)));
  }
});

test("pole-gap: priced by its heads the route takes the pole's blind side; as a full circle it would go in front of the lens", () => {
  const s = poleGap();
  const graph = buildGraph(s.nodes, s.edges);
  const start = nearestNode(graph, s.from.lat, s.from.lng)!;
  const goal = nearestNode(graph, s.to.lat, s.to.lng)!;
  const northOf = (geometry: [number, number][]) => geometry.some(([, lat]) => lat > s.from.lat);

  const withHeads = routeCostSurface(graph, new ExposureField(s.cameras), start, goal, s.lambda)!;
  assert.ok(northOf(withHeads.geometry), "north street, past the pole's blind side");

  const asCircle = s.cameras.map((c) => ({ ...c, heads: null }));
  const old = routeCostSurface(graph, new ExposureField(asCircle), start, goal, s.lambda)!;
  assert.ok(!northOf(old.geometry), "the old model sends the trip in front of the lens");

  const shortest = routeCostSurface(graph, new ExposureField(s.cameras), start, goal, 0)!;
  assert.ok(!northOf(shortest.geometry), "λ=0 takes the shorter south street");
});
