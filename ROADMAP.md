# Roadmap

Each step follows strict red/green TDD: failing test first, then the
implementation, then refactor. A step isn't done until its tests pass and
everything before it stays green.

## Built

- **The grid gate.** OSTN15 found via `GEOCOW_GRID_DIR` → `./OSTN15_NTv2` →
  beside the executable; TP01 checked to 1 mm before any subcommand runs;
  exit `2` with instructions otherwise.
- **Transforms.** EPSG:4258 ↔ EPSG:27700 through explicit PROJ pipelines on
  the OS grid (forward and inverted), validated against all 40 OS reference
  points in both directions.
- **Geometry I/O.** WKT, GeoJSON (geometry, Feature, FeatureCollection),
  NDJSON, WKT-per-line, and WKB/EWKB (OGC, ISO, both byte orders,
  concatenated). All seven OGC Simple Feature types round-trip.
- **`geocow transform`**, **`geocow serve`** (web map + HTTP API, Docker
  image), **`geocow map`** (pipe to a browser).
- **The web map.** Forgiving paste, file drop, National Grid detection,
  data-driven extrusion and colour, simplestyle, share links, a live URL.

## Next

### Measurement operations

`geocow area | length | distance | centroid | bbox`, each with planar (via
27700) and geodesic (on the ellipsoid, Karney) variants. Replaces the
spherical approximations in the map's info panel with exact figures from the
API.

- Unit: a 1 km × 1 km square has 1,000,000 m² planar, and the matching
  geodesic value within tolerance.
- Unit: known geodesic distances match published values.
- Edge cases: empty geometry, points (zero area and length).

### Batch performance

The transform path currently resolves the grid and builds a PROJ pipeline per
geometry. Build it once per process (or per thread), transform coordinate
slices rather than points, and stream line-delimited input.

- Criterion benchmarks for single and batch transforms, parsing, and WKB
  decoding — baseline first, then optimise.
- Rayon for batch work, only where measured.
- Batch results must match sequential results exactly.

### CLI ergonomics

- File arguments and `--output` for `transform`; WKT-per-line / NDJSON
  streaming.
- `--format` to override auto-detection, `--pretty` for GeoJSON.
- `geocow info` — geometry type, vertex count, bbox, detected CRS.
- Shell completions (`clap_complete`).

### Distribution

- Publish a container image (GHCR) from CI.
- Release binaries for macOS and Linux.
- crates.io: the 14 MB grid exceeds the crate size limit, so this needs either
  a first-run download (with checksum) or a separate data crate.

## Later

- **Spatial operations:** buffer (planar), simplify (Douglas–Peucker,
  Visvalingam–Whyatt), convex hull, intersection / union / difference,
  validity checking.
- **Curved geometries:** CircularString, CompoundCurve, CurvePolygon —
  preserved through I/O, linearised for operations.
- **Property tests** (`proptest`) for geometric invariants, e.g. transform
  round-trips.
