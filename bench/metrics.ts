import type { BuiltGraph } from "../src/graph.js";
import type { FieldCamera } from "../src/exposureField.js";

// Pure measurement helpers for the bench. The definitions here are the
// contract every PR is judged against, so they are written down precisely:
//
// A sensor's READ ZONE is a circle of `readRangeM` around it (default 50 m —
// field reports for pole-mounted ALPR units cluster around 23-75 m). A route
// CROSSES a read zone when its polyline passes within `readRangeM` of the
// sensor, UNLESS the sensor sits on the trip's own endpoint — within
// min(readRangeM, endpointExemptM) of origin or destination — and the route
// never approaches it meaningfully closer than the endpoint itself does
// (50 m tolerance). A trip that starts under a sensor cannot be routed away
// from it, and counting it would let unavoidable exposure drown the signal.

const M_PER_DEG = 111_320;

/** Min distance (metres) from a point to a [lng,lat] polyline. Planar-local. */
export function pointToPolylineM(lng: number, lat: number, coords: [number, number][]): number {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const px = lng * cosLat * M_PER_DEG;
  const py = lat * M_PER_DEG;
  let best = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const [aLng, aLat] = coords[i]!;
    const [bLng, bLat] = coords[i + 1]!;
    const ax = aLng * cosLat * M_PER_DEG;
    const ay = aLat * M_PER_DEG;
    const bx = bLng * cosLat * M_PER_DEG;
    const by = bLat * M_PER_DEG;
    const dx = bx - ax;
    const dy = by - ay;
    const denom = dx * dx + dy * dy;
    let t = denom === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / denom;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
    if (d < best) best = d;
  }
  return best;
}

function distM(aLng: number, aLat: number, bLng: number, bLat: number): number {
  const cosLat = Math.cos((aLat * Math.PI) / 180);
  return Math.hypot((bLng - aLng) * cosLat * M_PER_DEG, (bLat - aLat) * M_PER_DEG);
}

export interface CrossedZones {
  crossed: number;
  endpointExempt: number;
}

export function crossedReadZones(
  coords: [number, number][],
  cameras: FieldCamera[],
  readRangeM = 50,
  endpointExemptM = 120,
): CrossedZones {
  if (coords.length < 2) return { crossed: 0, endpointExempt: 0 };
  const [fromLng, fromLat] = coords[0]!;
  const [toLng, toLat] = coords[coords.length - 1]!;
  let crossed = 0;
  let endpointExempt = 0;
  for (const cam of cameras) {
    const d = pointToPolylineM(cam.longitude, cam.latitude, coords);
    if (d >= readRangeM) continue;
    const dEndpoint = Math.min(
      distM(cam.longitude, cam.latitude, fromLng, fromLat),
      distM(cam.longitude, cam.latitude, toLng, toLat),
    );
    if (dEndpoint < Math.min(readRangeM, endpointExemptM) && d >= dEndpoint - 50) {
      endpointExempt++;
      continue;
    }
    crossed++;
  }
  return { crossed, endpointExempt };
}

/**
 * Metres of the path travelled on edges matching a road-class predicate.
 * Recovers each step's edge from the adjacency list; where parallel edges
 * connect the same node pair the shortest is assumed (deterministic, and the
 * ambiguity is irrelevant at bench scale).
 */
export function pathMetersWhere(
  graph: BuiltGraph,
  path: number[],
  match: (highway?: string) => boolean,
): number {
  let sum = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const u = path[i]!;
    const v = path[i + 1]!;
    let bestLen: number | null = null;
    let bestHighway: string | undefined;
    for (const nb of graph.adjacency.get(u) ?? []) {
      if (nb.to !== v) continue;
      const e = graph.edges[nb.edge]!;
      if (bestLen === null || e.lengthM < bestLen) {
        bestLen = e.lengthM;
        bestHighway = e.highway;
      }
    }
    if (bestLen !== null && match(bestHighway)) sum += bestLen;
  }
  return sum;
}
