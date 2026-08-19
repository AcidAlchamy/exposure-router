import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pointToPolylineM, crossedReadZones } from "../bench/metrics.js";
import type { FieldCamera } from "../src/exposureField.js";

// The bench metrics are the review contract, so they get their own tests: if
// the measuring stick bends, every number in baseline.json is fiction.

const cam = (lng: number, lat: number): FieldCamera => ({
  latitude: lat,
  longitude: lng,
  directionDeg: null,
  fovDeg: null,
  confidenceScore: 1,
});

const M_PER_DEG = 111_320;
const lat0 = 36.0;
// A 1 km straight east-west polyline at lat0.
const mDeg = (m: number) => m / (M_PER_DEG * Math.cos((lat0 * Math.PI) / 180));
const line: [number, number][] = [
  [-115.0, lat0],
  [-115.0 + mDeg(500), lat0],
  [-115.0 + mDeg(1000), lat0],
];

describe("bench metrics", () => {
  test("pointToPolylineM: perpendicular distance to a segment interior", () => {
    const d = pointToPolylineM(-115.0 + mDeg(250), lat0 + 100 / M_PER_DEG, line);
    assert.ok(Math.abs(d - 100) < 1, `expected ~100 m, got ${d}`);
  });

  test("pointToPolylineM: clamps to segment endpoints", () => {
    const d = pointToPolylineM(-115.0 - mDeg(300), lat0, line);
    assert.ok(Math.abs(d - 300) < 1, `expected ~300 m, got ${d}`);
  });

  test("crossedReadZones: counts a sensor the route passes within range", () => {
    const { crossed } = crossedReadZones(line, [cam(-115.0 + mDeg(500), lat0 + 30 / M_PER_DEG)]);
    assert.equal(crossed, 1);
  });

  test("crossedReadZones: ignores a sensor out of range", () => {
    const { crossed } = crossedReadZones(line, [cam(-115.0 + mDeg(500), lat0 + 80 / M_PER_DEG)]);
    assert.equal(crossed, 0);
  });

  test("crossedReadZones: a sensor on the origin is endpoint-exempt, not crossed", () => {
    const { crossed, endpointExempt } = crossedReadZones(line, [cam(-115.0, lat0 + 20 / M_PER_DEG)]);
    assert.equal(crossed, 0);
    assert.equal(endpointExempt, 1);
  });

  test("crossedReadZones: endpoint sensor still counts when the route dives back at it", () => {
    // Sensor 100 m from the origin (inside the exemption radius is min(50,120)=50,
    // so 100 m is NOT exempt) and 30 m off the line mid-route.
    const c = cam(-115.0 + mDeg(500), lat0 + 30 / M_PER_DEG);
    const shortLine: [number, number][] = [
      [-115.0 + mDeg(495), lat0],
      [-115.0 + mDeg(505), lat0],
    ];
    const { crossed } = crossedReadZones(shortLine, [c]);
    // The sensor is ~30 m from the line but only ~30 m from the origin too —
    // within min(readRange, exempt)=50 — and the route never gets meaningfully
    // closer than the endpoint distance, so it is exempt.
    assert.equal(crossed, 0);
  });
});
