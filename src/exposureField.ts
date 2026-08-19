// The camera exposure field — the "temperature" the router steers by.
//
// Everything before this treated cameras as binary walls: a route either entered
// an exclusion polygon or it did not. That is why avoidance kept producing
// "another arterial" — camera proximity never entered a cost function at all, so
// there was no gradient to descend. Moving 5 m further from a camera was worth
// exactly nothing until you crossed the wall, at which point it was worth
// everything.
//
// Here a camera instead radiates a continuous cost that falls off with distance
// and spikes inside its field of view. Any point in the world has a temperature;
// any route has an integral of it. That single number — expected plate reads,
// roughly — is what we minimise, and it is comparable across routes of different
// lengths, road classes and shapes.

export interface FieldCamera {
  latitude: number;
  longitude: number;
  /** Facing bearing, degrees cw from north. null = omnidirectional. */
  directionDeg: number | null;
  /** Cone width in degrees. null = use DEFAULT_FOV_DEG when a facing is known. */
  fovDeg: number | null;
  /** 0..1 — how much we trust this camera exists. Scales its heat. */
  confidenceScore: number | null;
}

/** Beyond this a camera contributes nothing. Keeps the grid sum O(local). */
export const INFLUENCE_RADIUS_M = 260;
/** Where the kernel is at full strength — inside this you are certainly read. */
const CORE_M = 30;
/** Assumed cone width when a facing is known but the width is not. */
const DEFAULT_FOV_DEG = 60;
/**
 * Heat multiplier for being on a directional camera's blind side.
 *
 * Not zero: OSM facing data is frequently wrong or describes only one of several
 * heads on the same pole, so treating the back of a camera as perfectly safe
 * would be overconfident in exactly the way this app must not be. Being behind a
 * camera is genuinely better, not free.
 */
const BLIND_SIDE_FACTOR = 0.25;

const R = 6371000;
const toRad = Math.PI / 180;

export function metersBetween(
  aLng: number,
  aLat: number,
  bLng: number,
  bLat: number,
): number {
  const dLat = (bLat - aLat) * toRad;
  const dLng = (bLng - aLng) * toRad;
  const la1 = aLat * toRad;
  const la2 = bLat * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Bearing from a to b, degrees 0-359 cw from north. */
function bearingDeg(aLng: number, aLat: number, bLng: number, bLat: number): number {
  const la1 = aLat * toRad;
  const la2 = bLat * toRad;
  const dLng = (bLng - aLng) * toRad;
  const y = Math.sin(dLng) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Heat from one camera at one point, in "expected reads" units (1.0 = certainly
 * read, 0 = out of range).
 *
 * Distance falls off smoothly rather than as a step: flat at 1.0 inside the core
 * read zone, then a smooth shoulder out to INFLUENCE_RADIUS_M. The shoulder is
 * what gives the search something to descend — without it, "a bit further away"
 * is worth nothing until a threshold flips.
 */
export function cameraHeatAt(cam: FieldCamera, lng: number, lat: number): number {
  const d = metersBetween(cam.longitude, cam.latitude, lng, lat);
  if (d >= INFLUENCE_RADIUS_M) return 0;

  let heat: number;
  if (d <= CORE_M) {
    heat = 1;
  } else {
    // Smoothstep from 1 at CORE_M to 0 at INFLUENCE_RADIUS_M.
    const t = (d - CORE_M) / (INFLUENCE_RADIUS_M - CORE_M);
    heat = 1 - t * t * (3 - 2 * t);
  }

  if (cam.directionDeg != null) {
    const half = (cam.fovDeg ?? DEFAULT_FOV_DEG) / 2;
    const off = angleDiff(bearingDeg(cam.longitude, cam.latitude, lng, lat), cam.directionDeg);
    if (off > half) {
      // Outside the cone. Taper rather than cliff — a plate at the very edge of
      // the FOV is not meaningfully safer than one just inside it.
      const taper = Math.max(0, 1 - (off - half) / 45);
      heat *= BLIND_SIDE_FACTOR + (1 - BLIND_SIDE_FACTOR) * taper;
    }
  }

  // A camera we are unsure exists should bend a route, not dominate it.
  const conf = cam.confidenceScore == null ? 0.5 : Math.max(0, Math.min(1, cam.confidenceScore));
  return heat * (0.35 + 0.65 * conf);
}

/**
 * A spatial hash over cameras so a point lookup touches only nearby ones.
 *
 * Scoring a route samples it every ~20 m and a corridor search probes tens of
 * thousands of grid cells; both against every camera in the metro would be
 * O(samples x cameras) and far too slow inside a request. Bucketing by a cell
 * the size of the influence radius makes each probe touch a handful.
 */
export class ExposureField {
  private readonly buckets = new Map<string, FieldCamera[]>();
  private readonly cellDeg: number;

  constructor(readonly cameras: FieldCamera[]) {
    // Degrees of latitude per influence radius; longitude is narrower but using
    // the latitude figure everywhere only makes buckets slightly generous.
    this.cellDeg = INFLUENCE_RADIUS_M / 111_320;
    for (const c of cameras) {
      const k = this.key(c.longitude, c.latitude);
      const arr = this.buckets.get(k);
      if (arr) arr.push(c);
      else this.buckets.set(k, [c]);
    }
  }

  private key(lng: number, lat: number): string {
    return `${Math.floor(lat / this.cellDeg)}:${Math.floor(lng / this.cellDeg)}`;
  }

  /** Total heat at a point — the sum over every camera that can see it. */
  heatAt(lng: number, lat: number): number {
    const ci = Math.floor(lat / this.cellDeg);
    const cj = Math.floor(lng / this.cellDeg);
    let total = 0;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const arr = this.buckets.get(`${ci + di}:${cj + dj}`);
        if (!arr) continue;
        for (const cam of arr) total += cameraHeatAt(cam, lng, lat);
      }
    }
    return total;
  }
}

/** Sampling step along a route when integrating exposure. */
const SAMPLE_M = 20;

/**
 * The one shape scoring needs from a route: a GeoJSON-style LineString's
 * [lng, lat] coordinates. Structurally satisfied by any richer route object,
 * so callers can pass their own route type without adapting it.
 */
export interface RouteLine {
  geometry: { coordinates: [number, number][] };
}

export interface RouteExposure {
  /**
   * The integral of heat along the route, in camera-metres, normalised to
   * "expected reads" by dividing out the core zone width. This is the number to
   * minimise and it is comparable between routes of different length.
   */
  score: number;
  /** Peak heat encountered anywhere on the route. */
  peak: number;
  /** Metres travelled with any camera heat at all. */
  exposedMeters: number;
}

/**
 * Integrate the exposure field along a route.
 *
 * Deliberately samples by DISTANCE, not by vertex. Route geometries have wildly
 * uneven vertex spacing — dense through turns, sparse on a straight highway — so
 * a per-vertex sum silently weights twisty sections far more heavily and would
 * make a curvy backroad look worse than a straight arterial past six cameras.
 */
export function scoreRouteExposureField(route: RouteLine, field: ExposureField): RouteExposure {
  const co = route.geometry.coordinates;
  if (co.length < 2) return { score: 0, peak: 0, exposedMeters: 0 };

  let score = 0;
  let peak = 0;
  let exposedMeters = 0;
  let carry = 0;

  for (let i = 0; i < co.length - 1; i++) {
    const [aLng, aLat] = co[i]!;
    const [bLng, bLat] = co[i + 1]!;
    const segLen = metersBetween(aLng, aLat, bLng, bLat);
    if (segLen === 0) continue;

    // Walk this segment in SAMPLE_M steps, carrying the remainder across
    // segment boundaries so sampling stays uniform along the whole line.
    let t = carry;
    while (t < segLen) {
      const f = t / segLen;
      const lng = aLng + (bLng - aLng) * f;
      const lat = aLat + (bLat - aLat) * f;
      const h = field.heatAt(lng, lat);
      if (h > 0) {
        score += h * SAMPLE_M;
        exposedMeters += SAMPLE_M;
        if (h > peak) peak = h;
      }
      t += SAMPLE_M;
    }
    carry = t - segLen;
  }

  // camera-metres -> "expected reads": crossing a camera's core zone once is 1.
  return { score: score / (CORE_M * 2), peak, exposedMeters };
}
