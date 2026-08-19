// exposure-router — a cost-surface router that models exposure to fixed
// roadside sensors.
//
// The package is three pure modules and nothing else. It takes a road graph
// (GraphNode[] + GraphEdge[]) and a set of sensors (FieldCamera[]) from the
// caller and returns routes; where the graph and the sensor records come from
// is deliberately the caller's problem. No I/O, no database, no network.

export {
  buildGraph,
  routeCostSurface,
  nearestNode,
  edgeExposure,
} from "./graph.js";
export type { GraphNode, GraphEdge, BuiltGraph, CostSurfaceResult } from "./graph.js";

export {
  ExposureField,
  cameraHeatAt,
  scoreRouteExposureField,
  metersBetween,
  INFLUENCE_RADIUS_M,
} from "./exposureField.js";
export type { FieldCamera, RouteLine, RouteExposure } from "./exposureField.js";

export { findCoolCorridor } from "./corridorSearch.js";
export type { LatLng, CorridorOptions, CorridorResult } from "./corridorSearch.js";
