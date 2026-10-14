# geocow

Rust toolbox for ETRS89 <-> British National Grid work via OSTN15: one `geocow`
binary with `transform`, `serve` (web map + HTTP API) and `map` subcommands.
Performance is the primary non-functional requirement.

Guidance for AI coding agents and humans alike; CONTRIBUTING.md is the short
human version. `claude-scripts/` and `claude-sql/` are local-only (gitignored).

## Core Invariants

- Default I/O CRS: **EPSG:4258 (ETRS89)**. All input is assumed 4258 and all output is emitted in 4258 unless the user explicitly overrides.
- Planar CRS: **EPSG:27700 (OSGB National Grid)**. This is the only supported projected CRS.
- **Hard startup gate:** the binary MUST locate and validate the OSTN15 grid before doing anything. If it is missing or corrupt, print a clear error explaining how to obtain it and exit 2. No subcommand and no server start runs without this check passing. (OSGM15 — the vertical/geoid model — is not used: geocow is horizontal-only.)
- The OGC Simple Feature types are supported: Point, LineString, Polygon, MultiPoint, MultiLineString, MultiPolygon, GeometryCollection. Never silently drop or approximate one.
- No secrets or deployment specifics in the repo. Keys and tile hosts are runtime configuration (`GEOCOW_*` env vars, served to the browser via `/api/config`); there are no built-in defaults for them.

## Goals (not yet built — see ROADMAP.md)

- Curved types (CircularString, CompoundCurve, CurvePolygon) where the dependency chain allows.
- Planar and geodesic variants of every measurement operation (area, length, distance).

## OS Transform Grid Files

The `OSTN15_NTv2/` directory contains the Ordnance Survey OSTN15 NTv2 grid shift files for horizontal transformation between ETRS89 (GRS80) and OSGB36 (Airy 1830):

**Grid files:**
- `OSTN15_NTv2_OSGBtoETRS.gsb` — **committed** (~14 MB). The canonical OS/EPSG grid and the *only* one geocow uses: applied forward for OSGB36 -> ETRS89 and inverted for ETRS89 -> OSGB36. Committed so a clone builds and the Docker image can bake it in.
- `OSTN15_NTv2_ETRStoOSGB.gsb` — gitignored, obsolete, deliberately unused.
- `OSTN15_NTv2_*.asc` — gitignored ASCII equivalents (~38 MB each).

**Metadata and test data (committed):**
- `OSTN15_NTv2_ETRStoOSGB_Header.txt` / `..._OSGBtoETRS_Header.txt` — NTv2 header info
- `OSTN15_TestInput_ETRStoOSGB.txt` / `OSTN15_TestOutput_ETRStoOSGB.txt` — 40 OS-published reference points (TP01-TP40) for ETRS89 -> OSGB36 validation
- `OSTN15_TestInput_OSGBtoETRS.txt` / `OSTN15_TestOutput_OSGBtoETRS.txt` — same 40 points for OSGB36 -> ETRS89 validation

**Loading:** geocow builds explicit PROJ pipelines with `+grids=<absolute path>` rather than relying on PROJ's search path, so `PROJ_DATA`/`PROJ_LIB` are irrelevant. The grid directory is found via `GEOCOW_GRID_DIR`, then `./OSTN15_NTv2`, then `OSTN15_NTv2/` next to the executable (`crs::find_grid_dir`).

**Startup validation:** Must transform at least one OS reference point (e.g. TP01: ETRS89 49.9223, -6.2998 -> OSGB36 E 91492.146, N 11318.804) and assert the result is within tolerance (1mm). This proves the grid file is present, readable, and correct. All 40 test points are used in the test suite, at 10mm / 1e-7 deg — NTv2 interpolates in geographic space where OS interpolates in projected space, a ~8mm difference; still far tighter than a Helmert fallback's metres.

## Development Method

Strict red/green TDD:
1. Write a failing test that describes the desired behaviour.
2. Write the minimum code to make it pass.
3. Refactor while keeping tests green.

No code without a covering test. No test without a clear assertion.

## Architecture

Start flat, split into directories only when a file exceeds ~300 lines:

```
src/
  main.rs        CLI entry: clap, startup gate, subcommand dispatch
  lib.rs         library root
  error.rs       thiserror error enum
  crs.rs         CRS definitions, PROJ wrapper, grid validation
  geom.rs        geometry type wrappers
  io.rs          WKT / GeoJSON / NDJSON parsing and writing, CRS detection
  wkb.rs         WKB / EWKB reader (hand-rolled, no dependency)
  web.rs         axum API router, MapConfig + /api/config, `serve`   (feature: serve)
  ingest.rs      authenticated POST /api/geometry                    (feature: serve)
  share.rs       bounded in-memory share store                       (feature: serve)
  launch.rs      `map`: build the share URL, open a browser          (feature: map)
  sharelink.rs   gzip+base64url share-payload codec                  (features: serve, map)
tests/           integration tests (CLI + HTTP API)
web/             Vite + Lit + Tailwind frontend (its own yarn project)
OSTN15_NTv2/     OS grid (OSGBtoETRS.gsb committed) + 40-point test data + LICENCE.md
deploy/          generic reverse-proxy example and self-hosting notes
```

Features `serve` and `map` are both on by default; `--no-default-features`
builds a transform-only CLI with no async runtime. CI must keep that building.

No `ops.rs` or `benches/` yet — measurement operations and criterion benchmarks
are still unbuilt. Don't cite them as if they exist.

## Dependencies

In use today:

| Crate | Purpose |
|---|---|
| `clap` (derive) | CLI framework |
| `geo` | Geometry types + algorithms |
| `proj` | PROJ C library bindings for CRS transforms |
| `wkt` | WKT parse/write |
| `geojson` | GeoJSON parse/write |
| `thiserror` | Library error types |
| `anyhow` | CLI-level error handling |
| `axum`, `tokio`, `tower-http`, `serde`, `tracing`, `uuid` | Web server (feature: `serve`) |
| `flate2`, `base64` | Share-payload codec (features: `serve`, `map`) |
| `tower`, `http-body-util` | HTTP test harness (dev-dependencies) |

Not yet pulled in — add them when the work actually lands, not before:
`criterion` (benchmarks), `rayon` (parallel batch ops), `proptest` (property tests).

## Error Handling

- Library code: return `Result<T, GeocowError>` everywhere. `GeocowError` is a `thiserror` enum.
- Distinguish "the caller asked for something impossible" from "we failed": `UnsupportedCrs` vs `TransformError`, since the HTTP layer maps the first to 422 and the second to 500.
- CLI code: use `anyhow` for ergonomic propagation and display.
- No `unwrap()` or `expect()` in library code. Permitted only in tests.
- Grid files missing -> hard exit with instructions for the user.
- Invalid input geometry -> descriptive error echoing the problematic input.

## Performance Rules

- Avoid allocations in hot paths. Prefer iterators over collecting to Vec.
- Benchmark before and after any optimisation with criterion.
- Batch coordinate transforms should be the fast path (transform a slice of coordinates, not one at a time).
- Consider rayon for embarrassingly parallel batch work, but only where measured.

## Testing

- Unit tests inline in modules (`#[cfg(test)] mod tests`).
- Integration tests in `tests/`: `cli.rs` drives the binary, `server.rs` drives
  the axum router directly via `tower::ServiceExt::oneshot`.
- Frontend tests are vitest, colocated as `*.test.ts` under `web/src/`.
- Known-point CRS tests validated against OS-published transformation data.
- Round-trip tests for all I/O formats across all geometry types.
- Property tests (via `proptest`) for geometric invariants where valuable — not
  yet wired up.

## CLI Conventions

- One binary; new functionality is a subcommand (a verb), not a new binary.
- Reads from stdin when no file argument given.
- Writes to stdout by default.
- Input format auto-detected (WKT vs GeoJSON); there is no `--format` flag yet.
- `--from` / `--to` for CRS override (default both 4258, i.e. a pass-through —
  only the 4258 <-> 27700 pair actually transforms).
- `serve` / `map` options are flags with `GEOCOW_*` env fallbacks (clap `env =`).
- Exit code 0 on success, 1 on user error, 2 on system/grid error.

## CI

`.github/workflows/ci.yml`: `cargo fmt --check`, clippy with `-D warnings`,
`cargo test --all-features`, a `--no-default-features` build, and the web
build + vitest. Keep all of them green; run them locally before committing.
