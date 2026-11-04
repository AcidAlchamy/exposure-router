import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { edgeExposure } from "../src/graph.js";
import {
  ExposureField,
  cameraHeatAt,
  metersBetween,
  scoreRouteExposureField,
  INFLUENCE_RADIUS_M,
  type FieldCamera,
} from "../src/exposureField.js";
import { M_PER_DEG } from "../fixtures/scenario.js";
import type { Rng } from "../fixtures/rng.js";
import { close } from "./support/routeCheck.js";
import { forAll } from "./support/property.js";

// Seeded property tests for the exposure field: the heat kernel, the spatial
// index behind ExposureField, and the two integrals built on it
// (scoreRouteExposureField for a route, edgeExposure for a graph edge).

const LATITUDES = [0, 36, -33.9, 51.5, 60, -70] as const;

/** Point `m` metres from (lat, lng) along bearing `deg` (local flat approximation). */
function offset(lat: number, lng: number, deg: number, m: number): { lat: number; lng: number } {
  const rad = (deg * Math.PI) / 180;
  return {
    lat: lat + (m * Math.cos(rad)) / M_PER_DEG,
    lng: lng + (m * Math.sin(rad)) / (M_PER_DEG * Math.cos((lat * Math.PI) / 180)),
  };
}

/**
 * Point `m` metres from (lat, lng) along the great circle that leaves at
 * bearing `deg` — the same sphere metersBetween uses, so the bearing seen from
 * the start point is the same for every m.
 */
function destination(lat: number, lng: number, deg: number, m: number): { lat: number; lng: number } {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const d = m / R;
  const b = deg * toRad;
  const la1 = lat * toRad;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
  const lo2 = lng * toRad + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { lat: la2 / toRad, lng: lo2 / toRad };
}

function randomCamera(rng: Rng, lat: number, lng: number, spreadM: number): FieldCamera {
  const p = offset(lat, lng, rng.float(0, 360), rng.float(0, spreadM));
  return {
    latitude: p.lat,
    longitude: p.lng,
    directionDeg: rng.chance(0.5) ? rng.float(0, 360) : null,
    fovDeg: rng.chance(0.5) ? rng.float(10, 180) : null,
    confidenceScore: rng.chance(0.2) ? null : rng.float(0, 1),
  };
}

describe("exposure field properties", () => {
  test("one sensor's heat is within [0, 1] and zero at or beyond the influence radius", () => {
    forAll("heat range", 2000, (rng) => {
      const lat0 = rng.pick(LATITUDES);
      const cam = randomCamera(rng, lat0, -115, 0);
      const p = offset(lat0, -115, rng.float(0, 360), rng.float(0, 400));
      const h = cameraHeatAt(cam, p.lng, p.lat);
      assert.ok(h >= 0 && h <= 1, `heat ${h} outside [0, 1]`);
      if (metersBetween(cam.longitude, cam.latitude, p.lng, p.lat) >= INFLUENCE_RADIUS_M) assert.equal(h, 0);
    });
  });

  test("heat never rises as you move straight away from a sensor", () => {
    forAll("radial falloff", 500, (rng) => {
      const lat0 = rng.pick(LATITUDES);
      const cam = randomCamera(rng, lat0, -115, 0);
      const bearing = rng.float(0, 360);
      let prev = Infinity;
      for (let m = 1; m <= 280; m += 7) {
        const p = destination(cam.latitude, cam.longitude, bearing, m);
        const h = cameraHeatAt(cam, p.lng, p.lat);
        assert.ok(h <= prev + 1e-7, `heat rose from ${prev} to ${h} at ${m} m`);
        prev = h;
      }
    });
  });

  test("more confidence never means less heat, and outside the cone is never hotter than inside", () => {
    forAll("confidence and cone", 1000, (rng) => {
      const lat0 = rng.pick(LATITUDES);
      const cam = randomCamera(rng, lat0, -115, 0);
      const p = offset(lat0, -115, rng.float(0, 360), rng.float(0, 300));
      const lo = rng.float(0, 1);
      const hi = rng.float(lo, 1);
      assert.ok(
        cameraHeatAt({ ...cam, confidenceScore: lo }, p.lng, p.lat) <= cameraHeatAt({ ...cam, confidenceScore: hi }, p.lng, p.lat) + 1e-15,
      );
      // The same sensor with no facing (omnidirectional) bounds the directional one.
      assert.ok(cameraHeatAt(cam, p.lng, p.lat) <= cameraHeatAt({ ...cam, directionDeg: null }, p.lng, p.lat) + 1e-15);
    });
  });

  test("adding a sensor never lowers the heat anywhere", () => {
    forAll("added sensor heat", 300, (rng) => {
      const lat0 = rng.pick(LATITUDES);
      const cams = Array.from({ length: rng.int(0, 20) }, () => randomCamera(rng, lat0, -115, 800));
      const extra = randomCamera(rng, lat0, -115, 800);
      const a = new ExposureField(cams);
      const b = new ExposureField([...cams, extra]);
      for (let k = 0; k < 20; k++) {
        const p = offset(lat0, -115, rng.float(0, 360), rng.float(0, 900));
        const ha = a.heatAt(p.lng, p.lat);
        assert.ok(ha >= 0, `negative heat ${ha}`);
        assert.ok(b.heatAt(p.lng, p.lat) >= ha - 1e-12);
      }
    });
  });

  test("a route's score does not depend on how many vertices describe the same line", () => {
    // The documented reason scoring samples by distance, not by vertex.
    forAll("vertex density", 300, (rng) => {
      const lat0 = rng.pick(LATITUDES);
      const cams = Array.from({ length: rng.int(1, 6) }, () => randomCamera(rng, lat0, -115, 400));
      const field = new ExposureField(cams);
      const a = offset(lat0, -115, rng.float(0, 360), rng.float(0, 300));
      const b = offset(a.lat, a.lng, rng.float(0, 360), rng.float(50, 800));
      const sparse: [number, number][] = [[a.lng, a.lat], [b.lng, b.lat]];
      const n = rng.int(2, 40);
      const dense: [number, number][] = Array.from({ length: n + 1 }, (_, i) => [
        a.lng + ((b.lng - a.lng) * i) / n,
        a.lat + ((b.lat - a.lat) * i) / n,
      ]);
      const s1 = scoreRouteExposureField({ geometry: { coordinates: sparse } }, field);
      const s2 = scoreRouteExposureField({ geometry: { coordinates: dense } }, field);
      // Segment lengths are great-circle while interpolation is linear in
      // lng/lat, so sample positions drift by millimetres; allow for that.
      assert.ok(close(s1.score, s2.score, 1e-3, 1e-5), `score ${s1.score} vs ${s2.score} with ${n} segments`);
    });
  });

  test("an edge's exposure equals the score of its geometry as a route", () => {
    forAll("edge vs route score", 300, (rng) => {
      const lat0 = rng.pick(LATITUDES);
      const field = new ExposureField(Array.from({ length: rng.int(0, 8) }, () => randomCamera(rng, lat0, -115, 500)));
      const geom: [number, number][] = [];
      let p = offset(lat0, -115, rng.float(0, 360), rng.float(0, 300));
      for (let k = rng.int(1, 8); k >= 0; k--) {
        geom.push([p.lng, p.lat]);
        p = offset(p.lat, p.lng, rng.float(0, 360), rng.float(0, 150));
      }
      const e = edgeExposure({ a: 0, b: 1, geom, lengthM: 0, oneway: false }, field);
      const s = scoreRouteExposureField({ geometry: { coordinates: geom } }, field);
      assert.ok(close(e, s.score), `edgeExposure ${e} vs score ${s.score}`);
      assert.ok(s.score >= 0 && s.peak >= 0 && s.exposedMeters >= 0);
    });
  });

  test(
    "splitting an edge in two does not change its total exposure",
    {
      todo:
        "known model issue, not fixed here: edgeExposure restarts its 20 m sampling at the " +
        "start of every edge and counts each sample as a full 20 m, so edges shorter than 20 m " +
        "are over-counted (a 200 m road split into 40 edges scores 4x). See the PR findings.",
    },
    () => {
      forAll("edge splitting", 200, (rng) => {
        const lat0 = rng.pick(LATITUDES);
        const field = new ExposureField(Array.from({ length: rng.int(1, 6) }, () => randomCamera(rng, lat0, -115, 300)));
        const a = offset(lat0, -115, rng.float(0, 360), rng.float(0, 200));
        const b = offset(a.lat, a.lng, rng.float(0, 360), rng.float(20, 400));
        const f = rng.float(0.05, 0.95);
        const mid: [number, number] = [a.lng + (b.lng - a.lng) * f, a.lat + (b.lat - a.lat) * f];
        const whole = edgeExposure({ a: 0, b: 1, geom: [[a.lng, a.lat], [b.lng, b.lat]], lengthM: 0, oneway: false }, field);
        const parts =
          edgeExposure({ a: 0, b: 1, geom: [[a.lng, a.lat], mid], lengthM: 0, oneway: false }, field) +
          edgeExposure({ a: 1, b: 2, geom: [mid, [b.lng, b.lat]], lengthM: 0, oneway: false }, field);
        assert.ok(close(whole, parts, 0.02, 1e-3), `whole ${whole} vs split ${parts}`);
      });
    },
  );
});
