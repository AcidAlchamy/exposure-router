import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { findCoolCorridor, type LatLng } from "../src/corridorSearch.js";
import { ExposureField, metersBetween, type FieldCamera } from "../src/exposureField.js";
import { M_PER_DEG } from "../fixtures/scenario.js";
import type { Rng } from "../fixtures/rng.js";
import { forAll } from "./support/property.js";

// Seeded property tests for findCoolCorridor, the experimental grid search.
// It has no road graph to check against, so these pin its contract: it is
// deterministic, it terminates, what it returns is well-formed and inside the
// area it searched, and a higher exchange rate never buys a hotter corridor.

const PAD_M = 2500; // corridorSearch.ts: how far the grid extends past the trip's box

function at(lat0: number, lng0: number, eastM: number, northM: number): LatLng {
  return { lat: lat0 + northM / M_PER_DEG, lng: lng0 + eastM / (M_PER_DEG * Math.cos((lat0 * Math.PI) / 180)) };
}

function trip(rng: Rng) {
  const lat0 = rng.pick([36, -33.9, 51.5, 0]);
  const from = at(lat0, -115, rng.float(0, 500), rng.float(0, 500));
  const to = at(lat0, -115, rng.float(500, 6000), rng.float(-3000, 3000));
  const cameras: FieldCamera[] = Array.from({ length: rng.int(0, 60) }, () => {
    const p = at(lat0, -115, rng.float(-500, 6500), rng.float(-3500, 3500));
    return {
      latitude: p.lat,
      longitude: p.lng,
      directionDeg: rng.chance(0.5) ? rng.float(0, 360) : null,
      fovDeg: null,
      confidenceScore: rng.float(0.2, 1),
    };
  });
  return { from, to, field: new ExposureField(cameras), metersPerRead: rng.pick([0, 500, 1500, 5000]) };
}

describe("findCoolCorridor properties", () => {
  test("the same input always gives the same corridor", () => {
    forAll("corridor determinism", 30, (rng) => {
      const t = trip(rng);
      const a = findCoolCorridor(t.from, t.to, t.field, { metersPerRead: t.metersPerRead });
      const b = findCoolCorridor(t.from, t.to, t.field, { metersPerRead: t.metersPerRead });
      assert.deepEqual(b, a);
    });
  });

  test("waypoints are few, finite, and inside the searched area", () => {
    forAll("corridor shape", 60, (rng) => {
      const t = trip(rng);
      const r = findCoolCorridor(t.from, t.to, t.field, { metersPerRead: t.metersPerRead });
      assert.ok(r, "a corridor exists on an open grid");
      assert.ok(r.waypoints.length <= 10, `${r.waypoints.length} waypoints`);
      assert.ok(Number.isFinite(r.gridScore) && r.gridScore >= 0, `gridScore ${r.gridScore}`);
      assert.ok(r.cellsExplored >= 1);
      const minLat = Math.min(t.from.lat, t.to.lat);
      const maxLat = Math.max(t.from.lat, t.to.lat);
      const padLat = (PAD_M + 100) / M_PER_DEG;
      for (const w of r.waypoints) {
        assert.ok(Number.isFinite(w.lat) && Number.isFinite(w.lng));
        assert.ok(w.lat >= minLat - padLat && w.lat <= maxLat + padLat, `waypoint ${w.lat} outside the grid`);
        // No waypoint is further from both endpoints than the whole padded box allows.
        const dFrom = metersBetween(t.from.lng, t.from.lat, w.lng, w.lat);
        const span = metersBetween(t.from.lng, t.from.lat, t.to.lng, t.to.lat);
        assert.ok(dFrom <= span + 2 * PAD_M * Math.SQRT2 + 200, `waypoint ${dFrom} m from the origin`);
      }
    });
  });

  test("a higher metersPerRead never yields a hotter corridor", () => {
    // The search minimises distance + metersPerRead · heat, so (as for the
    // router and λ) the heat it accepts can only fall as the rate rises.
    // gridScore is that heat summed over the corridor's cells.
    forAll("corridor monotonicity", 25, (rng) => {
      const t = trip(rng);
      let prev = Infinity;
      for (const metersPerRead of [0, 200, 1000, 3000, 10000]) {
        const r = findCoolCorridor(t.from, t.to, t.field, { metersPerRead });
        assert.ok(r);
        assert.ok(r.gridScore <= prev + 1e-4, `gridScore rose from ${prev} to ${r.gridScore} at ${metersPerRead}`);
        prev = r.gridScore;
      }
    });
  });

  test("a trip that starts and ends in the same cell returns null", () => {
    forAll("corridor same cell", 30, (rng) => {
      const t = trip(rng);
      assert.equal(findCoolCorridor(t.from, t.from, t.field, { metersPerRead: t.metersPerRead }), null);
    });
  });
});
