import { ExposureField, metersBetween } from "./exposureField.js";

/** A WGS84 coordinate pair. */
export interface LatLng {
  lat: number;
  lng: number;
}

// Corridor search — our own pathfinding over the camera exposure field.
//
// The problem with asking a road router to "avoid these polygons" is that it
// only ever considers routes it already liked. It optimises time, we veto a few
// edges, it returns its next-favourite time-optimal route. It never goes looking
// for the quiet corridor two blocks over, because nothing in its cost function
// knows that corridor is quiet.
//
// So we do that search ourselves, on a grid, with no roads involved at all:
// Dijkstra from origin to destination over cells whose cost is
// distance + heat, which finds the genuinely coolest way across town. The
// result is not drivable — it cuts through blocks — so we simplify it to a
// handful of waypoints and hand those to the road router, which snaps them to
// real streets. We choose the corridor; it handles legality.

/**
 * Grid resolution. 80 m is roughly half a city block — fine enough to thread
 * between cameras on opposite corners, coarse enough that a 15 km trip stays
 * around 200x200 cells, which Dijkstra clears in well under a second.
 */
const CELL_M = 80;
/** How far outside the origin-destination box the corridor may bow. */
const PAD_M = 2500;
/** Hard ceiling on grid cells, so a very long trip degrades instead of stalling. */
const MAX_CELLS = 90_000;

export interface CorridorOptions {
  /**
   * Metres of extra travel we are willing to spend to remove one expected plate
   * read. This IS the avoidance dial — the entire "how hard should I try"
   * question reduces to this single exchange rate.
   */
  metersPerRead: number;
}

export interface CorridorResult {
  /** Intermediate waypoints (origin/destination excluded), coolest-path order. */
  waypoints: LatLng[];
  /** Exposure integral of the raw grid path, for logging/diagnosis. */
  gridScore: number;
  cellsExplored: number;
}

/**
 * Find the lowest-exposure corridor from `from` to `to` and return waypoints
 * that describe it. Returns null when the grid would be too large or no path
 * exists (the caller then just keeps its road-router candidates).
 */
export function findCoolCorridor(
  from: LatLng,
  to: LatLng,
  field: ExposureField,
  opts: CorridorOptions,
): CorridorResult | null {
  const latPad = PAD_M / 111_320;
  const midLat = (from.lat + to.lat) / 2;
  const lngPad = PAD_M / (111_320 * Math.max(0.2, Math.cos(midLat * (Math.PI / 180))));

  const minLat = Math.min(from.lat, to.lat) - latPad;
  const maxLat = Math.max(from.lat, to.lat) + latPad;
  const minLng = Math.min(from.lng, to.lng) - lngPad;
  const maxLng = Math.max(from.lng, to.lng) + lngPad;

  const cellLat = CELL_M / 111_320;
  const cellLng = CELL_M / (111_320 * Math.max(0.2, Math.cos(midLat * (Math.PI / 180))));

  const rows = Math.ceil((maxLat - minLat) / cellLat);
  const cols = Math.ceil((maxLng - minLng) / cellLng);
  if (rows < 3 || cols < 3 || rows * cols > MAX_CELLS) return null;

  const n = rows * cols;
  const cellLng2Lat = (r: number) => minLat + (r + 0.5) * cellLat;
  const cellLng2Lng = (c: number) => minLng + (c + 0.5) * cellLng;

  // Precompute heat per cell once — the field lookup is the expensive part and
  // each cell is visited by up to eight neighbours.
  const heat = new Float32Array(n);
  for (let r = 0; r < rows; r++) {
    const lat = cellLng2Lat(r);
    for (let c = 0; c < cols; c++) {
      heat[r * cols + c] = field.heatAt(cellLng2Lng(c), lat);
    }
  }

  const rc = (p: LatLng): number => {
    const r = Math.min(rows - 1, Math.max(0, Math.floor((p.lat - minLat) / cellLat)));
    const c = Math.min(cols - 1, Math.max(0, Math.floor((p.lng - minLng) / cellLng)));
    return r * cols + c;
  };

  const start = rc(from);
  const goal = rc(to);
  if (start === goal) return null;

  // Cost of stepping INTO a cell: the metres travelled, plus the heat there
  // priced at the caller's exchange rate. A cell with heat 1.0 costs as much as
  // walking `metersPerRead` extra metres, which is exactly the tradeoff we want
  // to express and the only knob the avoidance level needs to move.
  const dist = new Float32Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  dist[start] = 0;

  // Binary heap keyed on tentative distance.
  const heapIdx: number[] = [start];
  const heapKey: number[] = [0];
  const push = (idx: number, key: number) => {
    heapIdx.push(idx);
    heapKey.push(key);
    let i = heapIdx.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapKey[p]! <= heapKey[i]!) break;
      [heapIdx[p], heapIdx[i]] = [heapIdx[i]!, heapIdx[p]!];
      [heapKey[p], heapKey[i]] = [heapKey[i]!, heapKey[p]!];
      i = p;
    }
  };
  const pop = (): number => {
    const top = heapIdx[0]!;
    const li = heapIdx.pop()!;
    const lk = heapKey.pop()!;
    if (heapIdx.length) {
      heapIdx[0] = li;
      heapKey[0] = lk;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < heapIdx.length && heapKey[l]! < heapKey[s]!) s = l;
        if (r < heapIdx.length && heapKey[r]! < heapKey[s]!) s = r;
        if (s === i) break;
        [heapIdx[s], heapIdx[i]] = [heapIdx[i]!, heapIdx[s]!];
        [heapKey[s], heapKey[i]] = [heapKey[i]!, heapKey[s]!];
        i = s;
      }
    }
    return top;
  };

  const diagM = Math.SQRT2 * CELL_M;
  let explored = 0;

  while (heapIdx.length) {
    const cur = pop();
    if (done[cur]) continue;
    done[cur] = 1;
    explored++;
    if (cur === goal) break;

    const r = (cur / cols) | 0;
    const c = cur % cols;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const ni = nr * cols + nc;
        if (done[ni]) continue;
        const stepM = dr !== 0 && dc !== 0 ? diagM : CELL_M;
        const cost = stepM + heat[ni]! * opts.metersPerRead;
        const nd = dist[cur]! + cost;
        if (nd < dist[ni]!) {
          dist[ni] = nd;
          prev[ni] = cur;
          push(ni, nd);
        }
      }
    }
  }

  if (!done[goal] || prev[goal] === -1) return null;

  // Walk the path back, accumulating its exposure for diagnostics.
  const path: number[] = [];
  let gridScore = 0;
  for (let at = goal; at !== -1; at = prev[at]!) {
    path.push(at);
    gridScore += heat[at]!;
    if (at === start) break;
  }
  path.reverse();

  return {
    waypoints: simplifyToWaypoints(path, cols, cellLng2Lat, cellLng2Lng),
    gridScore,
    cellsExplored: explored,
  };
}

/**
 * Reduce a jagged grid path to a few waypoints.
 *
 * The road router is given these as via-points, and every extra one is another
 * hard constraint on a network it understands better than we do — too many and
 * we force absurd detours to touch cells that happen to sit mid-block. We keep
 * only the points where the corridor genuinely changes direction, capped at a
 * handful, and let the router choose everything between them.
 */
function simplifyToWaypoints(
  path: number[],
  cols: number,
  toLat: (r: number) => number,
  toLng: (c: number) => number,
): LatLng[] {
  if (path.length < 4) return [];

  const pts = path.map((i) => ({ lat: toLat((i / cols) | 0), lng: toLng(i % cols) }));

  // Douglas-Peucker on the corridor. Tolerance is deliberately tight: the
  // waypoints are the ONLY thing holding the road router to our corridor, and
  // between two consecutive ones it is free to do whatever its own cost function
  // prefers — which is get back on an arterial. Measured with a 250 m tolerance
  // and 4 waypoints over a 10 km trip, the realised route scored 109 expected
  // reads against the plain route's 66: the corridor was found correctly and
  // then discarded in the handoff.
  const keep = new Set<number>([0, pts.length - 1]);
  const stack: [number, number][] = [[0, pts.length - 1]];
  const TOL_M = 120;
  while (stack.length) {
    const [s, e] = stack.pop()!;
    if (e <= s + 1) continue;
    let best = -1;
    let bestD = TOL_M;
    for (let i = s + 1; i < e; i++) {
      const d = perpendicularM(pts[i]!, pts[s]!, pts[e]!);
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best !== -1) {
      keep.add(best);
      stack.push([s, best], [best, e]);
    }
  }

  let idx = [...keep].sort((a, b) => a - b).slice(1, -1); // drop endpoints
  if (!idx.length) {
    // A dead-straight corridor still needs anchors, or the router simply takes
    // its own favourite line between the two endpoints and our search was moot.
    const step = Math.floor(pts.length / 5);
    if (step > 0) idx = [step, step * 2, step * 3, step * 4].filter((i) => i < pts.length - 1);
    if (!idx.length) return [];
  }

  // Cap the count. Valhalla accepts many via-points; the real limit is that each
  // one is a hard constraint, so too many forces silly detours to touch a cell
  // that happens to sit mid-block. One roughly every 700-900 m keeps the route
  // on our corridor without over-constraining it.
  const MAX_WAYPOINTS = 10;
  if (idx.length <= MAX_WAYPOINTS) return idx.map((i) => pts[i]!);
  const out: LatLng[] = [];
  for (let k = 0; k < MAX_WAYPOINTS; k++) {
    out.push(pts[idx[Math.round((k * (idx.length - 1)) / (MAX_WAYPOINTS - 1))]!]!);
  }
  return out;
}

/** Perpendicular distance from p to the segment a-b, in metres. */
function perpendicularM(p: LatLng, a: LatLng, b: LatLng): number {
  const abLng = b.lng - a.lng;
  const abLat = b.lat - a.lat;
  const denom = abLng * abLng + abLat * abLat;
  if (denom === 0) return metersBetween(a.lng, a.lat, p.lng, p.lat);
  let t = ((p.lng - a.lng) * abLng + (p.lat - a.lat) * abLat) / denom;
  t = Math.max(0, Math.min(1, t));
  return metersBetween(a.lng + abLng * t, a.lat + abLat * t, p.lng, p.lat);
}
