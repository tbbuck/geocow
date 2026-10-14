use crate::error::GeocowError;
use crate::geom::Geometry;
use geo::{
    Coord, Geometry as GeoGeometry, GeometryCollection, LineString, MultiLineString, MultiPoint,
    MultiPolygon, Point, Polygon,
};
use proj::Proj;
use std::path::{Path, PathBuf};

/// EPSG:4258 — ETRS89 geographic, default I/O CRS.
pub const EPSG_4258: &str = "EPSG:4258";

/// EPSG:27700 — OSGB36 / British National Grid, the only supported projected CRS.
pub const EPSG_27700: &str = "EPSG:27700";

/// Tolerance for grid validation: 1mm in projected coordinates.
const TOLERANCE_M: f64 = 0.001;

/// The single OSTN15 NTv2 grid geocow uses. The `OSGBtoETRS` file is the
/// canonical OS/EPSG grid and is applied in BOTH directions — forward for
/// OSGB36->ETRS89, inverted for ETRS89->OSGB36. The separately-named
/// `ETRStoOSGB.gsb` is obsolete and deliberately not used.
///
/// The pipelines below reference it as `+grids=<path>`, never `+grids=@<path>`.
/// PROJ treats an `@`-prefixed grid as optional and silently falls back to a
/// Helmert approximation when it is missing — transforms that look fine and
/// are metres out. Failing loudly is the whole point of the startup gate;
/// don't make this grid optional.
const GRID: &str = "OSTN15_NTv2_OSGBtoETRS.gsb";

/// Locate the directory containing the OSTN15 NTv2 .gsb grid files.
///
/// Search order: `GEOCOW_GRID_DIR` env var, `OSTN15_NTv2/` relative to CWD,
/// `OSTN15_NTv2/` relative to the executable.
pub fn find_grid_dir() -> Result<PathBuf, GeocowError> {
    if let Ok(dir) = std::env::var("GEOCOW_GRID_DIR") {
        let path = PathBuf::from(&dir);
        if has_grid_files(&path) {
            return Ok(path);
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        let path = cwd.join("OSTN15_NTv2");
        if has_grid_files(&path) {
            return Ok(path);
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let path = parent.join("OSTN15_NTv2");
            if has_grid_files(&path) {
                return Ok(path);
            }
        }
    }

    Err(GeocowError::GridNotFound(
        "OSTN15 NTv2 grid shift file not found. \
         Place OSTN15_NTv2_OSGBtoETRS.gsb \
         in the OSTN15_NTv2/ directory or set GEOCOW_GRID_DIR."
            .to_string(),
    ))
}

fn has_grid_files(dir: &Path) -> bool {
    dir.join(GRID).exists()
}

/// Create a PROJ pipeline for ETRS89 (lon/lat deg) -> OSGB36 (easting/northing m).
/// Applies the OSGBtoETRS grid *inverted* (ETRS->OSGB is the inverse of the
/// grid's native OSGB->ETRS direction), then projects to the National Grid.
pub fn make_etrs_to_osgb(grid_dir: &Path) -> Result<Proj, GeocowError> {
    let grid = grid_dir.join(GRID);
    let pipeline = format!(
        "+proj=pipeline \
         +step +proj=unitconvert +xy_in=deg +xy_out=rad \
         +step +inv +proj=hgridshift +grids={} \
         +step +proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 \
         +x_0=400000 +y_0=-100000 +ellps=airy",
        grid.display()
    );
    Proj::new(&pipeline).map_err(|e| {
        GeocowError::GridNotFound(format!("failed to create ETRS89 -> OSGB36 pipeline: {e}"))
    })
}

/// Create a PROJ pipeline for OSGB36 (easting/northing m) -> ETRS89 (lon/lat deg).
/// Uses the OSGBtoETRS grid in its native forward direction.
pub fn make_osgb_to_etrs(grid_dir: &Path) -> Result<Proj, GeocowError> {
    let grid = grid_dir.join(GRID);
    let pipeline = format!(
        "+proj=pipeline \
         +step +inv +proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 \
         +x_0=400000 +y_0=-100000 +ellps=airy \
         +step +proj=hgridshift +grids={} \
         +step +proj=unitconvert +xy_in=rad +xy_out=deg",
        grid.display()
    );
    Proj::new(&pipeline).map_err(|e| {
        GeocowError::GridNotFound(format!("failed to create OSGB36 -> ETRS89 pipeline: {e}"))
    })
}

/// Validate that the OSTN15 grid file is present and produces correct results.
///
/// Locates the .gsb grid, builds the ETRS89 -> OSGB36 pipeline from it,
/// transforms OS reference point TP01, and checks within 1mm tolerance.
pub fn validate_grid() -> Result<(), GeocowError> {
    let grid_dir = find_grid_dir()?;

    let tp01_lon = -6.29977752014_f64;
    let tp01_lat = 49.92226393730_f64;
    let tp01_easting = 91492.146_f64;
    let tp01_northing = 11318.804_f64;

    let proj = make_etrs_to_osgb(&grid_dir)?;

    let (easting, northing) = proj.convert((tp01_lon, tp01_lat)).map_err(|e| {
        GeocowError::GridNotFound(format!("OSTN15 transformation failed for TP01: {e}"))
    })?;

    if (easting - tp01_easting).abs() > TOLERANCE_M
        || (northing - tp01_northing).abs() > TOLERANCE_M
    {
        return Err(GeocowError::GridNotFound(format!(
            "OSTN15 validation failed: TP01 expected ({tp01_easting}, {tp01_northing}), \
             got ({easting:.3}, {northing:.3})"
        )));
    }

    Ok(())
}

/// Create a PROJ pipeline for the given SRID pair.
fn make_proj(from_srid: u32, to_srid: u32, grid_dir: &Path) -> Result<Proj, GeocowError> {
    match (from_srid, to_srid) {
        (4258, 27700) => make_etrs_to_osgb(grid_dir),
        (27700, 4258) => make_osgb_to_etrs(grid_dir),
        // EPSG:4326 turns up constantly — it is what most data declares —
        // and over GB it differs from ETRS89 by well under a metre. geocow
        // still won't quietly treat one as the other: say so, and let the
        // caller decide whether that difference matters to them.
        (4326, _) | (_, 4326) => Err(GeocowError::UnsupportedCrs(format!(
            "EPSG:{from_srid} -> EPSG:{to_srid}. geocow works in EPSG:4258 \
             (ETRS89) and EPSG:27700 (OSGB36). WGS84 (4326) and ETRS89 differ \
             by under a metre over Great Britain — if that is acceptable, \
             say so explicitly with ?from=4258."
        ))),
        _ => Err(GeocowError::UnsupportedCrs(format!(
            "EPSG:{from_srid} -> EPSG:{to_srid}. \
             Only EPSG:4258 (ETRS89) and EPSG:27700 (OSGB36) are supported."
        ))),
    }
}

/// Transform coordinates in a mutable slice using a PROJ pipeline.
fn transform_coords(proj: &Proj, coords: &mut [Coord<f64>]) -> Result<(), GeocowError> {
    for c in coords.iter_mut() {
        let (x, y) = proj
            .convert((c.x, c.y))
            .map_err(|e| GeocowError::TransformError(e.to_string()))?;
        c.x = x;
        c.y = y;
    }
    Ok(())
}

/// Transform a LineString's coordinates using a PROJ pipeline.
fn transform_linestring(proj: &Proj, ls: &LineString) -> Result<LineString, GeocowError> {
    let mut result = ls.clone();
    transform_coords(proj, &mut result.0)?;
    Ok(result)
}

/// Transform a geometry using an already-created PROJ pipeline.
fn transform_geometry(geom: &Geometry, proj: &Proj) -> Result<Geometry, GeocowError> {
    match geom {
        Geometry::Point(p) => {
            let (x, y) = proj
                .convert((p.x(), p.y()))
                .map_err(|e| GeocowError::TransformError(e.to_string()))?;
            Ok(Geometry::Point(Point::new(x, y)))
        }
        Geometry::LineString(ls) => Ok(Geometry::LineString(transform_linestring(proj, ls)?)),
        Geometry::Polygon(poly) => {
            let exterior = transform_linestring(proj, poly.exterior())?;
            let interiors = poly
                .interiors()
                .iter()
                .map(|ring| transform_linestring(proj, ring))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Geometry::Polygon(Polygon::new(exterior, interiors)))
        }
        Geometry::MultiPoint(mp) => {
            let points = mp
                .iter()
                .map(|p| {
                    let (x, y) = proj
                        .convert((p.x(), p.y()))
                        .map_err(|e| GeocowError::TransformError(e.to_string()))?;
                    Ok(Point::new(x, y))
                })
                .collect::<Result<Vec<_>, GeocowError>>()?;
            Ok(Geometry::MultiPoint(MultiPoint::new(points)))
        }
        Geometry::MultiLineString(mls) => {
            let lines = mls
                .iter()
                .map(|ls| transform_linestring(proj, ls))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Geometry::MultiLineString(MultiLineString::new(lines)))
        }
        Geometry::MultiPolygon(mpoly) => {
            let polys = mpoly
                .iter()
                .map(|poly| {
                    let exterior = transform_linestring(proj, poly.exterior())?;
                    let interiors = poly
                        .interiors()
                        .iter()
                        .map(|ring| transform_linestring(proj, ring))
                        .collect::<Result<Vec<_>, _>>()?;
                    Ok(Polygon::new(exterior, interiors))
                })
                .collect::<Result<Vec<_>, GeocowError>>()?;
            Ok(Geometry::MultiPolygon(MultiPolygon::new(polys)))
        }
        Geometry::GeometryCollection(gc) => {
            let members = gc
                .iter()
                .map(|g| {
                    let our_geom: Geometry = g.clone().try_into()?;
                    let transformed = transform_geometry(&our_geom, proj)?;
                    Ok(GeoGeometry::from(transformed))
                })
                .collect::<Result<Vec<_>, GeocowError>>()?;
            Ok(Geometry::GeometryCollection(GeometryCollection(members)))
        }
    }
}

/// Transform a geometry from one CRS to another.
///
/// Only EPSG:4258 (ETRS89) and EPSG:27700 (OSGB36) are supported.
/// Returns the geometry unchanged if `from_srid == to_srid`.
pub fn transform(geom: &Geometry, from_srid: u32, to_srid: u32) -> Result<Geometry, GeocowError> {
    if from_srid == to_srid {
        return Ok(geom.clone());
    }
    let grid_dir = find_grid_dir()?;
    let proj = make_proj(from_srid, to_srid, &grid_dir)?;
    transform_geometry(geom, &proj)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    // NTv2 bilinear interpolation in geographic space differs from the OS native
    // OSTN15 model (bilinear in projected space) by up to ~8mm. The suite tolerance
    // is set to 10mm — tight enough to prove the grid is loaded (Helmert fallback
    // would be off by metres) while allowing for interpolation-method differences.
    const SUITE_TOLERANCE_M: f64 = 0.01;
    /// Geographic equivalent: ~11mm latitude, tighter for longitude at GB latitudes.
    const SUITE_TOLERANCE_DEG: f64 = 1e-7;

    struct EtrsPoint {
        id: String,
        lat: f64,
        lon: f64,
    }

    struct OsgbPoint {
        id: String,
        easting: f64,
        northing: f64,
    }

    fn test_data_dir() -> String {
        format!("{}/OSTN15_NTv2", env!("CARGO_MANIFEST_DIR"))
    }

    fn grid_dir() -> PathBuf {
        PathBuf::from(test_data_dir())
    }

    fn parse_etrs_points(path: &Path) -> Vec<EtrsPoint> {
        let content = std::fs::read_to_string(path).unwrap();
        content
            .lines()
            .skip(1)
            .filter(|l| !l.is_empty())
            .map(|line| {
                let parts: Vec<&str> = line.split(',').collect();
                EtrsPoint {
                    id: parts[0].to_string(),
                    lat: parts[1].parse().unwrap(),
                    lon: parts[2].parse().unwrap(),
                }
            })
            .collect()
    }

    fn parse_osgb_points(path: &Path) -> Vec<OsgbPoint> {
        let content = std::fs::read_to_string(path).unwrap();
        content
            .lines()
            .skip(1)
            .filter(|l| !l.is_empty())
            .map(|line| {
                let parts: Vec<&str> = line.split(',').collect();
                OsgbPoint {
                    id: parts[0].to_string(),
                    easting: parts[1].parse().unwrap(),
                    northing: parts[2].parse().unwrap(),
                }
            })
            .collect()
    }

    #[test]
    fn validate_grid_succeeds_with_ostn15() {
        validate_grid().expect("grid validation should succeed with OSTN15 .gsb files present");
    }

    #[test]
    fn all_40_points_etrs_to_osgb() {
        let dir = test_data_dir();
        let inputs =
            parse_etrs_points(Path::new(&format!("{dir}/OSTN15_TestInput_ETRStoOSGB.txt")));
        let expected = parse_osgb_points(Path::new(&format!(
            "{dir}/OSTN15_TestOutput_ETRStoOSGB.txt"
        )));

        assert_eq!(inputs.len(), 40, "expected 40 test input points");
        assert_eq!(expected.len(), 40, "expected 40 test output points");

        let proj = make_etrs_to_osgb(&grid_dir()).expect("should create ETRS89 -> OSGB36 pipeline");

        let mut failures = Vec::new();
        for (input, exp) in inputs.iter().zip(expected.iter()) {
            assert_eq!(input.id, exp.id, "test point IDs must match");
            let (e, n) = proj
                .convert((input.lon, input.lat))
                .unwrap_or_else(|err| panic!("{}: transform failed: {err}", input.id));

            let de = (e - exp.easting).abs();
            let dn = (n - exp.northing).abs();
            if de > SUITE_TOLERANCE_M || dn > SUITE_TOLERANCE_M {
                failures.push(format!(
                    "{}: expected ({}, {}), got ({e:.3}, {n:.3}), delta=({de:.4}, {dn:.4})",
                    input.id, exp.easting, exp.northing
                ));
            }
        }

        assert!(
            failures.is_empty(),
            "ETRS->OSGB failures:\n{}",
            failures.join("\n")
        );
    }

    #[test]
    fn all_40_points_osgb_to_etrs() {
        let dir = test_data_dir();
        let inputs =
            parse_osgb_points(Path::new(&format!("{dir}/OSTN15_TestInput_OSGBtoETRS.txt")));
        let expected = parse_etrs_points(Path::new(&format!(
            "{dir}/OSTN15_TestOutput_OSGBtoETRS.txt"
        )));

        assert_eq!(inputs.len(), 40, "expected 40 test input points");
        assert_eq!(expected.len(), 40, "expected 40 test output points");

        let proj = make_osgb_to_etrs(&grid_dir()).expect("should create OSGB36 -> ETRS89 pipeline");

        let mut failures = Vec::new();
        for (input, exp) in inputs.iter().zip(expected.iter()) {
            assert_eq!(input.id, exp.id, "test point IDs must match");
            let (lon, lat) = proj
                .convert((input.easting, input.northing))
                .unwrap_or_else(|err| panic!("{}: transform failed: {err}", input.id));

            let dlat = (lat - exp.lat).abs();
            let dlon = (lon - exp.lon).abs();
            if dlat > SUITE_TOLERANCE_DEG || dlon > SUITE_TOLERANCE_DEG {
                failures.push(format!(
                    "{}: expected ({}, {}), got ({lat:.11}, {lon:.11}), \
                     delta=({dlat:.11}, {dlon:.11})",
                    input.id, exp.lat, exp.lon
                ));
            }
        }

        assert!(
            failures.is_empty(),
            "OSGB->ETRS failures:\n{}",
            failures.join("\n")
        );
    }

    // ---------------------------------------------------------------
    // Phase 3a — Transform function
    // ---------------------------------------------------------------

    #[test]
    fn transform_known_point_4258_to_27700() {
        // TP01: ETRS89 (lon/lat deg) -> OSGB36 (easting/northing m)
        let geom = Geometry::Point(Point::new(-6.29977752014, 49.92226393730));
        let result = transform(&geom, 4258, 27700).unwrap();
        match result {
            Geometry::Point(p) => {
                assert!(
                    (p.x() - 91492.146).abs() < TOLERANCE_M,
                    "easting: expected 91492.146, got {}",
                    p.x()
                );
                assert!(
                    (p.y() - 11318.804).abs() < TOLERANCE_M,
                    "northing: expected 11318.804, got {}",
                    p.y()
                );
            }
            other => panic!("expected Point, got {:?}", other),
        }
    }

    #[test]
    fn transform_roundtrip_4258_27700_4258() {
        let original = Geometry::Point(Point::new(-1.54, 53.79));
        let projected = transform(&original, 4258, 27700).unwrap();
        let back = transform(&projected, 27700, 4258).unwrap();
        match (&original, &back) {
            (Geometry::Point(orig), Geometry::Point(rt)) => {
                assert!(
                    (orig.x() - rt.x()).abs() < 1e-6,
                    "lon: {} vs {}",
                    orig.x(),
                    rt.x()
                );
                assert!(
                    (orig.y() - rt.y()).abs() < 1e-6,
                    "lat: {} vs {}",
                    orig.y(),
                    rt.y()
                );
            }
            _ => panic!("expected Points"),
        }
    }

    #[test]
    fn transform_linestring_all_coords() {
        let coords: Vec<(f64, f64)> = vec![
            (-6.29977752014, 49.92226393730),
            (-1.54, 53.79),
            (-0.12, 51.51),
        ];

        // Transform individually for reference
        let proj = make_etrs_to_osgb(&grid_dir()).unwrap();
        let expected: Vec<(f64, f64)> = coords.iter().map(|&c| proj.convert(c).unwrap()).collect();

        let ls = LineString::from(coords);
        let result = transform(&Geometry::LineString(ls), 4258, 27700).unwrap();
        match result {
            Geometry::LineString(ls) => {
                assert_eq!(ls.0.len(), 3);
                for (i, (c, &(ex, ey))) in ls.0.iter().zip(expected.iter()).enumerate() {
                    assert!((c.x - ex).abs() < 1e-6, "coord {i} x: {} vs {ex}", c.x);
                    assert!((c.y - ey).abs() < 1e-6, "coord {i} y: {} vs {ey}", c.y);
                }
            }
            other => panic!("expected LineString, got {:?}", other),
        }
    }

    #[test]
    fn transform_polygon_exterior_and_holes() {
        let ext = vec![
            (-6.3, 49.92),
            (-6.29, 49.92),
            (-6.29, 49.93),
            (-6.3, 49.93),
            (-6.3, 49.92),
        ];
        let hole = vec![
            (-6.298, 49.922),
            (-6.292, 49.922),
            (-6.292, 49.928),
            (-6.298, 49.928),
            (-6.298, 49.922),
        ];

        let proj = make_etrs_to_osgb(&grid_dir()).unwrap();
        let exp_ext: Vec<(f64, f64)> = ext.iter().map(|&c| proj.convert(c).unwrap()).collect();
        let exp_hole: Vec<(f64, f64)> = hole.iter().map(|&c| proj.convert(c).unwrap()).collect();

        let poly = Polygon::new(LineString::from(ext), vec![LineString::from(hole)]);
        let result = transform(&Geometry::Polygon(poly), 4258, 27700).unwrap();
        match result {
            Geometry::Polygon(p) => {
                assert_eq!(p.exterior().0.len(), 5);
                for (i, (c, &(ex, ey))) in p.exterior().0.iter().zip(exp_ext.iter()).enumerate() {
                    assert!((c.x - ex).abs() < 1e-6, "ext {i} x");
                    assert!((c.y - ey).abs() < 1e-6, "ext {i} y");
                }
                assert_eq!(p.interiors().len(), 1);
                assert_eq!(p.interiors()[0].0.len(), 5);
                for (i, (c, &(ex, ey))) in
                    p.interiors()[0].0.iter().zip(exp_hole.iter()).enumerate()
                {
                    assert!((c.x - ex).abs() < 1e-6, "hole {i} x");
                    assert!((c.y - ey).abs() < 1e-6, "hole {i} y");
                }
            }
            other => panic!("expected Polygon, got {:?}", other),
        }
    }

    #[test]
    fn transform_geometrycollection_recursive() {
        let proj = make_etrs_to_osgb(&grid_dir()).unwrap();
        let (exp_e, exp_n) = proj.convert((-6.29977752014, 49.92226393730)).unwrap();
        let ls_coords: Vec<(f64, f64)> = vec![(-1.54, 53.79), (-0.12, 51.51)];
        let exp_ls: Vec<(f64, f64)> = ls_coords
            .iter()
            .map(|&c| proj.convert(c).unwrap())
            .collect();

        let gc = GeometryCollection(vec![
            GeoGeometry::Point(Point::new(-6.29977752014, 49.92226393730)),
            GeoGeometry::LineString(LineString::from(ls_coords)),
        ]);
        let result = transform(&Geometry::GeometryCollection(gc), 4258, 27700).unwrap();
        match result {
            Geometry::GeometryCollection(gc) => {
                assert_eq!(gc.0.len(), 2);
                match &gc[0] {
                    GeoGeometry::Point(p) => {
                        assert!((p.x() - exp_e).abs() < 1e-6);
                        assert!((p.y() - exp_n).abs() < 1e-6);
                    }
                    other => panic!("expected Point, got {:?}", other),
                }
                match &gc[1] {
                    GeoGeometry::LineString(ls) => {
                        for (i, (c, &(ex, ey))) in ls.0.iter().zip(exp_ls.iter()).enumerate() {
                            assert!((c.x - ex).abs() < 1e-6, "ls {i} x");
                            assert!((c.y - ey).abs() < 1e-6, "ls {i} y");
                        }
                    }
                    other => panic!("expected LineString, got {:?}", other),
                }
            }
            other => panic!("expected GeometryCollection, got {:?}", other),
        }
    }

    #[test]
    fn transform_unsupported_crs_returns_error() {
        let geom = Geometry::Point(Point::new(9.0, 48.0));
        let err = transform(&geom, 4258, 32632).unwrap_err();
        match err {
            GeocowError::UnsupportedCrs(msg) => {
                assert!(msg.contains("32632"), "should mention SRID: {msg}");
            }
            other => panic!("expected UnsupportedCrs, got: {other}"),
        }
    }

    // 4326 is what most data declares, so the refusal needs to explain
    // itself rather than just listing what is supported.
    #[test]
    fn transform_from_wgs84_explains_the_difference() {
        let geom = Geometry::Point(Point::new(-1.5, 52.4));
        let err = transform(&geom, 4326, 27700).unwrap_err();
        let msg = err.to_string();
        assert!(matches!(err, GeocowError::UnsupportedCrs(_)), "got: {msg}");
        assert!(msg.contains("4326"), "should name the CRS: {msg}");
        assert!(msg.contains("?from=4258"), "should say what to do: {msg}");
    }
}
