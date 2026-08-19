import { readFileSync } from "node:fs";
import { buildGraph, nearestNode, routeCostSurface, type GraphEdge, type GraphNode } from "../src/graph.js";
import { ExposureField, metersBetween, type FieldCamera } from "../src/exposureField.js";
import type { Scenario } from "./scenario.js";

// The one real-geometry fixture: a downtown Las Vegas road subgraph exported
// from OpenStreetMap-derived data (see downtown-lv.json's attribution field).
// 2,586 nodes / 3,441 edges — 1,803 of them service roads, which makes this
// real graph a drivability test as well as a routing one.
//
// EVERY SENSOR HERE IS SYNTHETIC. Positions are generated below, along the
// unweighted shortest path of the fixture trip, precisely so the scenario
// exercises avoidance. They are not real camera locations and must never be —
// this repository carries no sensor dataset, by policy (see README).

interface FixtureFile {
  name: string;
  attribution: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const FROM = { lat: 36.16187, lng: -115.14999 };
const TO = { lat: 36.1705, lng: -115.1356 };

let cached: { nodes: GraphNode[]; edges: GraphEdge[]; cameras: FieldCamera[] } | null = null;

/** Bearing a→b in degrees clockwise from north. */
function bearing(aLng: number, aLat: number, bLng: number, bLat: number): number {
  const toRad = Math.PI / 180;
  const y = Math.sin((bLng - aLng) * toRad) * Math.cos(bLat * toRad);
  const x =
    Math.cos(aLat * toRad) * Math.sin(bLat * toRad) -
    Math.sin(aLat * toRad) * Math.cos(bLat * toRad) * Math.cos((bLng - aLng) * toRad);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Point offset from (lng,lat) by metres along a bearing. */
function offsetM(lng: number, lat: number, bearingDeg: number, m: number): { lng: number; lat: number } {
  const rad = (bearingDeg * Math.PI) / 180;
  const dLat = (m * Math.cos(rad)) / 111_320;
  const dLng = (m * Math.sin(rad)) / (111_320 * Math.cos((lat * Math.PI) / 180));
  return { lng: lng + dLng, lat: lat + dLat };
}

function load(): { nodes: GraphNode[]; edges: GraphEdge[]; cameras: FieldCamera[] } {
  if (cached) return cached;
  const file = JSON.parse(
    readFileSync(new URL("./downtown-lv.json", import.meta.url), "utf8"),
  ) as FixtureFile;

  // Synthesise the sensors: route the trip with exposure off (an empty field),
  // then stand five sensors along that shortest path — 8 m off the roadway,
  // facing back down the direction of travel with a 60° cone — plus five more
  // on the busiest intersections for background texture. Deterministic: same
  // fixture in, same sensors out.
  const graph = buildGraph(file.nodes, file.edges);
  const startId = nearestNode(graph, FROM.lat, FROM.lng)!;
  const goalId = nearestNode(graph, TO.lat, TO.lng)!;
  const shortest = routeCostSurface(graph, new ExposureField([]), startId, goalId, 0);
  if (!shortest) throw new Error("downtown-lv fixture: shortest path did not route");

  const geom = shortest.geometry;
  const total = shortest.distanceMeters;
  const cameras: FieldCamera[] = [];
  const confidences = [1, 1, 0.6, 1, 1];
  [0.15, 0.35, 0.5, 0.65, 0.85].forEach((frac, i) => {
    // Walk the geometry to the point `frac` of the way along, by distance.
    let want = total * frac;
    for (let j = 0; j < geom.length - 1; j++) {
      const [aLng, aLat] = geom[j]!;
      const [bLng, bLat] = geom[j + 1]!;
      const seg = metersBetween(aLng, aLat, bLng, bLat);
      if (want > seg) {
        want -= seg;
        continue;
      }
      const f = seg === 0 ? 0 : want / seg;
      const lng = aLng + (bLng - aLng) * f;
      const lat = aLat + (bLat - aLat) * f;
      const travel = bearing(aLng, aLat, bLng, bLat);
      const pos = offsetM(lng, lat, travel + 90, 8);
      cameras.push({
        latitude: pos.lat,
        longitude: pos.lng,
        directionDeg: (travel + 180) % 360, // looking back up the road
        fovDeg: 60,
        confidenceScore: confidences[i]!,
      });
      break;
    }
  });

  // Background sensors on the five best-connected intersections, skipping any
  // within 150 m of an already-placed sensor or 120 m of an endpoint.
  const byDegree = [...graph.adjacency.entries()]
    .map(([id, adj]) => ({ id, degree: adj.length }))
    .sort((a, b) => b.degree - a.degree || a.id - b.id);
  for (const { id } of byDegree) {
    if (cameras.length >= 10) break;
    const n = graph.nodes.get(id)!;
    const nearExisting = cameras.some(
      (c) => metersBetween(c.longitude, c.latitude, n.lng, n.lat) < 150,
    );
    const nearEndpoint =
      metersBetween(FROM.lng, FROM.lat, n.lng, n.lat) < 120 ||
      metersBetween(TO.lng, TO.lat, n.lng, n.lat) < 120;
    if (nearExisting || nearEndpoint) continue;
    cameras.push({
      latitude: n.lat,
      longitude: n.lng,
      directionDeg: null,
      fovDeg: null,
      confidenceScore: 1,
    });
  }

  cached = { nodes: file.nodes, edges: file.edges, cameras };
  return cached;
}

/** The headline scenario: a real downtown grid, synthetic sensors, judged λ. */
export function downtownLv(): Scenario {
  const { nodes, edges, cameras } = load();
  return {
    name: "downtown-lv",
    description:
      "Real downtown Las Vegas road geometry (OSM-derived), five synthetic cone sensors stood " +
      "along the unweighted shortest path plus five background sensors. The judged route must " +
      "shed most expected reads at proportionate added distance.",
    nodes,
    edges,
    cameras,
    from: FROM,
    to: TO,
    lambda: 2200,
    kind: "route",
  };
}

/**
 * The λ-ladder guard on the same graph: routes the trip at every λ the ladder
 * holds and reports the candidate distance spread. Exists because of a real
 * regression: a sparse ladder once produced candidates at 1199/1277/1335 m and
 * then nothing until 8972 m — the moderate detour a driver would actually take
 * was never generated. The bench records the spread so a re-thinned ladder
 * shows up as a diff.
 */
export function lambdaLadder(): Scenario {
  const { nodes, edges, cameras } = load();
  return {
    name: "lambda-ladder",
    description:
      "Candidate spread across the full λ ladder on the downtown-lv graph. Guards ladder density: " +
      "moderate detours must exist between the shortest and the coolest candidates.",
    nodes,
    edges,
    cameras,
    from: FROM,
    to: TO,
    lambda: 0,
    kind: "ladder",
  };
}
