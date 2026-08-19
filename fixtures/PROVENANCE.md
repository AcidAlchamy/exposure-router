# Fixture provenance

## Sensors are synthetic, everywhere, without exception

No fixture in this directory contains a real sensor location. Every
`FieldCamera` used by the bench is generated in code (`synthetic.ts`, or
`downtownLv.ts` at runtime) and positioned to exercise a specific routing
behaviour. This repository carries no camera dataset, and adding one would be a
policy violation, not just a large diff. See the README's "The data model cannot
hold a person".

## `downtown-lv.json` — real road geometry, no sensors

This is the one fixture with real-world geometry: a road subgraph covering a
bounded area of downtown Las Vegas, used so the bench has one scenario over a
messy real network (2,586 nodes, 3,441 edges, 1,803 of them service roads) and
not only clean synthetic grids.

- **Source:** derived from OpenStreetMap data.
- **Copyright:** © OpenStreetMap contributors.
- **Licence:** [Open Database License (ODbL) v1.0](https://opendatacommons.org/licenses/odbl/1-0/).
  Geometry produced from OSM data is a Derivative Database under the ODbL.
- **What it contains:** road edges only — endpoints, densified geometry, length,
  `oneway`, and OSM `highway` class. Node ids are **synthetic sequential
  integers**, not OSM ids; the original ids are not preserved in this file.
- **What it does not contain:** any sensor, camera, plate, vehicle, person, or
  timestamp. The scenario stands synthetic sensors on this graph at runtime; the
  file on disk is pure road network.

The bounding box is recorded in the file's `bbox` field. If you regenerate or
extend this fixture from OSM, keep this file ODbL-attributed and keep it
sensor-free.
