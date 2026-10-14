use std::convert::TryInto;

use geo::Geometry as GeoGeometry;
use geojson::GeoJson;
use wkt::TryFromWkt;

use crate::error::GeocowError;
use crate::geom::Geometry;

/// Supported input formats.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Wkt,
    GeoJson,
}

/// Auto-detect whether `input` is GeoJSON or WKT.
/// If the trimmed input starts with `{` or `[`, it's GeoJSON; otherwise WKT.
pub fn detect_format(input: &str) -> Format {
    let trimmed = input.trim_start();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        Format::GeoJson
    } else {
        Format::Wkt
    }
}

/// Parse a WKT string into a Geometry.
pub fn parse_wkt(input: &str) -> Result<Geometry, GeocowError> {
    let geo_geom: GeoGeometry =
        GeoGeometry::try_from_wkt_str(input).map_err(|e| GeocowError::WktParse(e.to_string()))?;
    geo_geom.try_into()
}

/// Serialize a Geometry to WKT.
pub fn to_wkt(geom: &Geometry) -> String {
    use wkt::ToWkt;
    let geo_geom: GeoGeometry = geom.clone().into();
    geo_geom.wkt_string()
}

/// Parse a GeoJSON string into a Geometry.
///
/// Accepts bare Geometry objects, Features (extracts the geometry),
/// and FeatureCollections (extracts the first geometry).
pub fn parse_geojson(input: &str) -> Result<Geometry, GeocowError> {
    let gj: GeoJson = input
        .parse::<GeoJson>()
        .map_err(|e| GeocowError::GeoJsonParse(e.to_string()))?;

    let geojson_geom = match gj {
        GeoJson::Geometry(g) => g,
        GeoJson::Feature(f) => f
            .geometry
            .ok_or_else(|| GeocowError::GeoJsonParse("Feature has no geometry".into()))?,
        GeoJson::FeatureCollection(fc) => fc
            .features
            .into_iter()
            .next()
            .ok_or_else(|| GeocowError::GeoJsonParse("FeatureCollection is empty".into()))?
            .geometry
            .ok_or_else(|| GeocowError::GeoJsonParse("Feature has no geometry".into()))?,
    };

    let geo_geom: GeoGeometry = geojson_geom
        .try_into()
        .map_err(|e: geojson::Error| GeocowError::GeoJsonParse(e.to_string()))?;
    geo_geom.try_into()
}

/// Serialize a Geometry to GeoJSON (bare geometry object).
pub fn to_geojson(geom: &Geometry) -> String {
    let geo_geom: GeoGeometry = geom.clone().into();
    let gj_geom = geojson::Geometry::from(&geo_geom);
    gj_geom.to_string()
}

/// Parse input by auto-detecting format.
pub fn parse_auto(input: &str) -> Result<Geometry, GeocowError> {
    match detect_format(input) {
        Format::Wkt => parse_wkt(input),
        Format::GeoJson => parse_geojson(input),
    }
}

/// Wrap a bare GeoJSON geometry in a property-less Feature.
fn wrap_geometry(geometry: geojson::Geometry) -> geojson::Feature {
    geojson::Feature {
        bbox: None,
        geometry: Some(geometry),
        id: None,
        properties: None,
        foreign_members: None,
    }
}

/// Flatten a parsed GeoJSON document into its constituent features: a
/// FeatureCollection yields its features, a Feature yields itself, and a
/// bare geometry is wrapped in one property-less Feature.
fn geojson_to_features(gj: GeoJson) -> Vec<geojson::Feature> {
    match gj {
        GeoJson::FeatureCollection(fc) => fc.features,
        GeoJson::Feature(f) => vec![f],
        GeoJson::Geometry(g) => vec![wrap_geometry(g)],
    }
}

/// Parse a single WKT geometry into a property-less GeoJSON Feature.
fn wkt_line_to_feature(line: &str) -> Result<geojson::Feature, GeocowError> {
    let geom = parse_wkt(line)?;
    let geo_geom: GeoGeometry = geom.into();
    Ok(wrap_geometry(geojson::Geometry::from(&geo_geom)))
}

/// Parse input into a normalised GeoJSON `FeatureCollection` for display.
///
/// Unlike [`parse_auto`], this preserves *every* feature and its
/// properties — what a map needs — rather than collapsing to a single
/// geometry. WKT is parsed via [`parse_wkt`] and wrapped in one
/// property-less Feature; GeoJSON input (bare geometry, Feature, or
/// FeatureCollection) is normalised to a FeatureCollection intact.
pub fn parse_to_feature_collection(input: &str) -> Result<geojson::FeatureCollection, GeocowError> {
    use geojson::FeatureCollection;

    match detect_format(input) {
        Format::Wkt => Ok(FeatureCollection {
            bbox: None,
            features: vec![wkt_line_to_feature(input)?],
            foreign_members: None,
        }),
        Format::GeoJson => {
            let gj: GeoJson = input
                .parse::<GeoJson>()
                .map_err(|e| GeocowError::GeoJsonParse(e.to_string()))?;
            Ok(FeatureCollection {
                bbox: None,
                features: geojson_to_features(gj),
                foreign_members: None,
            })
        }
    }
}

/// Attach a 1-based line number and a snippet of the offending line to a
/// parse error, so a bad line in a large upload is easy to locate.
fn annotate_line_error(err: GeocowError, line_no: usize, line: &str) -> GeocowError {
    let snippet: String = line.chars().take(80).collect();
    let tail = if line.chars().count() > 80 { "…" } else { "" };
    let context = format!("line {line_no}: {{msg}} — in `{snippet}{tail}`");
    match err {
        GeocowError::WktParse(m) => GeocowError::WktParse(context.replace("{msg}", &m)),
        GeocowError::GeoJsonParse(m) => GeocowError::GeoJsonParse(context.replace("{msg}", &m)),
        other => other,
    }
}

/// Parse possibly line-delimited input into a normalised `FeatureCollection`.
///
/// Handles the three formats a file drop can carry, auto-detected from
/// content (never the filename, which lies — e.g. NDJSON saved as `.geojson`):
///
/// 1. A single GeoJSON document (Geometry, Feature, or FeatureCollection).
/// 2. Newline-delimited GeoJSON (NDJSON): one GeoJSON value per line.
/// 3. WKT-per-line: one WKT geometry per line.
///
/// The whole-document fast path is tried first; only when that fails does it
/// fall back to line-by-line parsing, so a valid (possibly pretty-printed)
/// GeoJSON blob is never mistaken for NDJSON.
pub fn parse_lines_to_feature_collection(
    input: &str,
) -> Result<geojson::FeatureCollection, GeocowError> {
    use geojson::FeatureCollection;

    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(GeocowError::GeoJsonParse("empty input".into()));
    }

    // Fast path: the entire payload is a single GeoJSON document.
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        if let Ok(gj) = trimmed.parse::<GeoJson>() {
            return Ok(FeatureCollection {
                bbox: None,
                features: geojson_to_features(gj),
                foreign_members: None,
            });
        }
        // Not a single valid document — fall through to line-by-line (NDJSON).
    }

    // Line-delimited: each non-empty line is its own GeoJSON value or WKT.
    let mut features = Vec::new();
    for (i, raw) in input.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let parsed = if line.starts_with('{') || line.starts_with('[') {
            line.parse::<GeoJson>()
                .map_err(|e| GeocowError::GeoJsonParse(e.to_string()))
                .map(geojson_to_features)
        } else {
            wkt_line_to_feature(line).map(|f| vec![f])
        };
        features.extend(parsed.map_err(|e| annotate_line_error(e, i + 1, line))?);
    }

    if features.is_empty() {
        return Err(GeocowError::GeoJsonParse(
            "no geometries found in input".into(),
        ));
    }

    Ok(FeatureCollection {
        bbox: None,
        features,
        foreign_members: None,
    })
}

/// Transform every geometry in a `FeatureCollection` between CRSs, preserving
/// feature properties. Used by the web `/api/transform` endpoint to reproject
/// pasted EPSG:27700 data to the default ETRS89 (4258).
pub fn transform_feature_collection(
    fc: geojson::FeatureCollection,
    from: u32,
    to: u32,
) -> Result<geojson::FeatureCollection, GeocowError> {
    let features = fc
        .features
        .into_iter()
        .map(|mut f| {
            if let Some(g) = f.geometry.take() {
                let geo_geom: GeoGeometry = g
                    .try_into()
                    .map_err(|e: geojson::Error| GeocowError::GeoJsonParse(e.to_string()))?;
                let geom: Geometry = geo_geom.try_into()?;
                let transformed = crate::crs::transform(&geom, from, to)?;
                let out_geo: GeoGeometry = transformed.into();
                f.geometry = Some(geojson::Geometry::from(&out_geo));
            }
            Ok(f)
        })
        .collect::<Result<Vec<_>, GeocowError>>()?;

    Ok(geojson::FeatureCollection {
        bbox: None,
        features,
        foreign_members: fc.foreign_members,
    })
}

/// Wrap parsed geometries in a property-less `FeatureCollection`. WKB
/// carries geometry only — there are no attributes to preserve.
pub fn geometries_to_feature_collection(
    geometries: Vec<GeoGeometry>,
) -> geojson::FeatureCollection {
    geojson::FeatureCollection {
        bbox: None,
        features: geometries
            .iter()
            .map(|g| wrap_geometry(geojson::Geometry::from(g)))
            .collect(),
        foreign_members: None,
    }
}

/// Fold every coordinate in a GeoJSON position tree into `bounds`
/// (`[west, south, east, north]`). Positions nest arbitrarily deep — a
/// MultiPolygon is a Vec<Vec<Vec<Position>>> — so recurse rather than
/// match each geometry type.
fn extend_bounds(value: &geojson::Value, bounds: &mut Option<[f64; 4]>) {
    use geojson::Value::*;

    let mut add = |p: &geojson::Position| {
        if p.len() < 2 {
            return;
        }
        let (x, y) = (p[0], p[1]);
        *bounds = Some(match *bounds {
            None => [x, y, x, y],
            Some([w, s, e, n]) => [w.min(x), s.min(y), e.max(x), n.max(y)],
        });
    };

    match value {
        Point(p) => add(p),
        MultiPoint(ps) | LineString(ps) => ps.iter().for_each(add),
        MultiLineString(lss) | Polygon(lss) => lss.iter().flatten().for_each(add),
        MultiPolygon(ps) => ps.iter().flatten().flatten().for_each(add),
        GeometryCollection(gs) => {
            for g in gs {
                extend_bounds(&g.value, bounds);
            }
        }
    }
}

/// Bounding box of a whole `FeatureCollection` as `[west, south, east, north]`,
/// or `None` if it holds no coordinates.
pub fn feature_collection_bounds(fc: &geojson::FeatureCollection) -> Option<[f64; 4]> {
    let mut bounds = None;
    for f in &fc.features {
        if let Some(g) = &f.geometry {
            extend_bounds(&g.value, &mut bounds);
        }
    }
    bounds
}

/// True when the coordinates fall outside lon/lat bounds, i.e. they are
/// projected. EPSG:27700 is the only projected CRS geocow supports, so callers
/// read this as "assume National Grid". Mirrors the same rule in the frontend
/// (`geo.ts: isProjected`) so a paste and a POST behave identically.
pub fn looks_projected(fc: &geojson::FeatureCollection) -> bool {
    match feature_collection_bounds(fc) {
        Some([w, s, e, n]) => {
            !(-180.0..=180.0).contains(&w)
                || !(-180.0..=180.0).contains(&e)
                || !(-90.0..=90.0).contains(&s)
                || !(-90.0..=90.0).contains(&n)
        }
        None => false,
    }
}

/// Generous geographic bounding box for the British Isles in ETRS89/WGS84
/// degrees: west of the Outer Hebrides to east of Lowestoft, the Channel
/// Islands up to Shetland.
const GEOGRAPHIC_GB: [f64; 4] = [-11.0, 48.0, 3.0, 62.0];

/// Valid extent of the OSGB National Grid in metres. The grid is defined over
/// a 700 x 1300 km square; OSTN15 itself only covers the land area, but the
/// numbers can legitimately be anywhere in here.
const PROJECTED_GB: [f64; 4] = [0.0, 0.0, 700_000.0, 1_300_000.0];

fn within(bounds: [f64; 4], envelope: [f64; 4]) -> bool {
    let [w, s, e, n] = bounds;
    let [min_x, min_y, max_x, max_y] = envelope;
    w >= min_x && e <= max_x && s >= min_y && n <= max_y
}

/// Work out which CRS a collection's coordinates are in, for callers that
/// would otherwise have to be told.
///
/// The two candidates barely overlap in practice: degrees over the British
/// Isles are single- or double-digit, while National Grid coordinates run to
/// six or seven. The only numbers satisfying both are within a couple of
/// metres of the grid's false origin, which is in the sea south-west of the
/// Isles of Scilly — so the ambiguous case is not real data.
///
/// Returns `None` when the coordinates fit neither box (a different CRS, or
/// data from outside GB), leaving the caller to decide rather than guessing.
pub fn detect_crs(fc: &geojson::FeatureCollection) -> Option<u32> {
    let bounds = feature_collection_bounds(fc)?;
    // Check the projected box first: an easting/northing pair that also fell
    // inside the geographic box would have to be within metres of (0, 0).
    if within(bounds, PROJECTED_GB) && !within(bounds, GEOGRAPHIC_GB) {
        return Some(27700);
    }
    if within(bounds, GEOGRAPHIC_GB) {
        return Some(4258);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------------------------------------------------------------
    // Phase 2a — WKT
    // ---------------------------------------------------------------

    #[test]
    fn parse_wkt_point_coordinates() {
        let geom = parse_wkt("POINT (1.5 2.5)").unwrap();
        match geom {
            Geometry::Point(p) => {
                assert_eq!(p.x(), 1.5);
                assert_eq!(p.y(), 2.5);
            }
            other => panic!("expected Point, got {:?}", other),
        }
    }

    #[test]
    fn roundtrip_wkt_point() {
        let input = "POINT(1 2)";
        let geom = parse_wkt(input).unwrap();
        let wkt_out = to_wkt(&geom);
        let geom2 = parse_wkt(&wkt_out).unwrap();
        assert_eq!(geom, geom2);
    }

    #[test]
    fn roundtrip_wkt_linestring() {
        let input = "LINESTRING(0 0,1 1,2 0)";
        let geom = parse_wkt(input).unwrap();
        let wkt_out = to_wkt(&geom);
        let geom2 = parse_wkt(&wkt_out).unwrap();
        assert_eq!(geom, geom2);
    }

    #[test]
    fn roundtrip_wkt_polygon() {
        let input = "POLYGON((0 0,4 0,4 4,0 4,0 0),(1 1,2 1,2 2,1 2,1 1))";
        let geom = parse_wkt(input).unwrap();
        let wkt_out = to_wkt(&geom);
        let geom2 = parse_wkt(&wkt_out).unwrap();
        assert_eq!(geom, geom2);
    }

    #[test]
    fn roundtrip_wkt_multipoint() {
        let input = "MULTIPOINT((0 0),(1 1),(2 2))";
        let geom = parse_wkt(input).unwrap();
        let wkt_out = to_wkt(&geom);
        let geom2 = parse_wkt(&wkt_out).unwrap();
        assert_eq!(geom, geom2);
    }

    #[test]
    fn roundtrip_wkt_multilinestring() {
        let input = "MULTILINESTRING((0 0,1 1),(2 2,3 3))";
        let geom = parse_wkt(input).unwrap();
        let wkt_out = to_wkt(&geom);
        let geom2 = parse_wkt(&wkt_out).unwrap();
        assert_eq!(geom, geom2);
    }

    #[test]
    fn roundtrip_wkt_multipolygon() {
        let input = "MULTIPOLYGON(((0 0,1 0,1 1,0 1,0 0)),((2 2,3 2,3 3,2 3,2 2)))";
        let geom = parse_wkt(input).unwrap();
        let wkt_out = to_wkt(&geom);
        let geom2 = parse_wkt(&wkt_out).unwrap();
        assert_eq!(geom, geom2);
    }

    #[test]
    fn roundtrip_wkt_geometrycollection() {
        let input = "GEOMETRYCOLLECTION(POINT(1 2),LINESTRING(0 0,1 1))";
        let geom = parse_wkt(input).unwrap();
        let wkt_out = to_wkt(&geom);
        let geom2 = parse_wkt(&wkt_out).unwrap();
        assert_eq!(geom, geom2);
    }

    #[test]
    fn parse_malformed_wkt_returns_error() {
        let err = parse_wkt("NOT_A_GEOMETRY(1 2 3)").unwrap_err();
        assert!(
            matches!(err, GeocowError::WktParse(_)),
            "expected WktParse, got: {err}"
        );
    }

    #[test]
    fn parse_empty_wkt_returns_error() {
        let err = parse_wkt("").unwrap_err();
        assert!(matches!(err, GeocowError::WktParse(_)));
    }

    #[test]
    fn parse_wkt_unclosed_parens_returns_error() {
        let err = parse_wkt("POLYGON((0 0,1 0,1 1,0 1,0 0)").unwrap_err();
        assert!(matches!(err, GeocowError::WktParse(_)));
    }

    #[test]
    fn parse_wkt_point_z_preserves_coordinates() {
        // The wkt + geo-types pipeline drops Z, but we verify the 2D
        // coordinates survive. Z support requires coord extensions.
        let geom = parse_wkt("POINT Z (1 2 3)").unwrap();
        match geom {
            Geometry::Point(p) => {
                assert_eq!(p.x(), 1.0);
                assert_eq!(p.y(), 2.0);
            }
            other => panic!("expected Point, got {:?}", other),
        }
    }

    // ---------------------------------------------------------------
    // Phase 2b — GeoJSON
    // ---------------------------------------------------------------

    #[test]
    fn roundtrip_geojson_point() {
        let input = r#"{"type":"Point","coordinates":[1.0,2.0]}"#;
        let geom = parse_geojson(input).unwrap();
        let json_out = to_geojson(&geom);
        let geom2 = parse_geojson(&json_out).unwrap();
        assert_eq!(geom, geom2);
    }

    #[test]
    fn roundtrip_geojson_linestring() {
        let input = r#"{"type":"LineString","coordinates":[[0,0],[1,1],[2,0]]}"#;
        let geom = parse_geojson(input).unwrap();
        let json_out = to_geojson(&geom);
        let geom2 = parse_geojson(&json_out).unwrap();
        assert_eq!(geom, geom2);
    }

    #[test]
    fn roundtrip_geojson_polygon() {
        let input = r#"{"type":"Polygon","coordinates":[[[0,0],[4,0],[4,4],[0,4],[0,0]],[[1,1],[2,1],[2,2],[1,2],[1,1]]]}"#;
        let geom = parse_geojson(input).unwrap();
        let json_out = to_geojson(&geom);
        let geom2 = parse_geojson(&json_out).unwrap();
        assert_eq!(geom, geom2);
    }

    #[test]
    fn roundtrip_geojson_multipoint() {
        let input = r#"{"type":"MultiPoint","coordinates":[[0,0],[1,1],[2,2]]}"#;
        let geom = parse_geojson(input).unwrap();
        let json_out = to_geojson(&geom);
        let geom2 = parse_geojson(&json_out).unwrap();
        assert_eq!(geom, geom2);
    }

    #[test]
    fn roundtrip_geojson_multilinestring() {
        let input = r#"{"type":"MultiLineString","coordinates":[[[0,0],[1,1]],[[2,2],[3,3]]]}"#;
        let geom = parse_geojson(input).unwrap();
        let json_out = to_geojson(&geom);
        let geom2 = parse_geojson(&json_out).unwrap();
        assert_eq!(geom, geom2);
    }

    #[test]
    fn roundtrip_geojson_multipolygon() {
        let input = r#"{"type":"MultiPolygon","coordinates":[[[[0,0],[1,0],[1,1],[0,1],[0,0]]],[[[2,2],[3,2],[3,3],[2,3],[2,2]]]]}"#;
        let geom = parse_geojson(input).unwrap();
        let json_out = to_geojson(&geom);
        let geom2 = parse_geojson(&json_out).unwrap();
        assert_eq!(geom, geom2);
    }

    #[test]
    fn roundtrip_geojson_geometrycollection() {
        let input = r#"{"type":"GeometryCollection","geometries":[{"type":"Point","coordinates":[1,2]},{"type":"LineString","coordinates":[[0,0],[1,1]]}]}"#;
        let geom = parse_geojson(input).unwrap();
        let json_out = to_geojson(&geom);
        let geom2 = parse_geojson(&json_out).unwrap();
        assert_eq!(geom, geom2);
    }

    #[test]
    fn parse_geojson_feature_extracts_geometry() {
        let input = r#"{"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]},"properties":{"name":"test"}}"#;
        let geom = parse_geojson(input).unwrap();
        match geom {
            Geometry::Point(p) => {
                assert_eq!(p.x(), 1.0);
                assert_eq!(p.y(), 2.0);
            }
            other => panic!("expected Point, got {:?}", other),
        }
    }

    #[test]
    fn parse_geojson_featurecollection_extracts_first_geometry() {
        let input = r#"{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[5,6]},"properties":{}}]}"#;
        let geom = parse_geojson(input).unwrap();
        match geom {
            Geometry::Point(p) => {
                assert_eq!(p.x(), 5.0);
                assert_eq!(p.y(), 6.0);
            }
            other => panic!("expected Point, got {:?}", other),
        }
    }

    #[test]
    fn parse_malformed_geojson_returns_error() {
        let err = parse_geojson("{not valid json}").unwrap_err();
        assert!(
            matches!(err, GeocowError::GeoJsonParse(_)),
            "expected GeoJsonParse, got: {err}"
        );
    }

    #[test]
    fn parse_geojson_empty_featurecollection_returns_error() {
        let input = r#"{"type":"FeatureCollection","features":[]}"#;
        let err = parse_geojson(input).unwrap_err();
        assert!(matches!(err, GeocowError::GeoJsonParse(_)));
    }

    // ---------------------------------------------------------------
    // Auto-detection
    // ---------------------------------------------------------------

    #[test]
    fn detect_format_geojson_object() {
        assert_eq!(detect_format(r#"{"type":"Point"}"#), Format::GeoJson);
    }

    #[test]
    fn detect_format_geojson_array() {
        assert_eq!(detect_format(r#"[{"type":"Point"}]"#), Format::GeoJson);
    }

    #[test]
    fn detect_format_wkt() {
        assert_eq!(detect_format("POINT(1 2)"), Format::Wkt);
    }

    #[test]
    fn detect_format_wkt_with_leading_whitespace() {
        assert_eq!(detect_format("  POLYGON((0 0,1 0,1 1,0 0))"), Format::Wkt);
    }

    #[test]
    fn detect_format_geojson_with_leading_whitespace() {
        assert_eq!(
            detect_format(r#"  {"type":"Point","coordinates":[1,2]}"#),
            Format::GeoJson
        );
    }

    #[test]
    fn parse_auto_wkt() {
        let geom = parse_auto("POINT(3 4)").unwrap();
        match geom {
            Geometry::Point(p) => {
                assert_eq!(p.x(), 3.0);
                assert_eq!(p.y(), 4.0);
            }
            other => panic!("expected Point, got {:?}", other),
        }
    }

    #[test]
    fn parse_auto_geojson() {
        let geom = parse_auto(r#"{"type":"Point","coordinates":[3,4]}"#).unwrap();
        match geom {
            Geometry::Point(p) => {
                assert_eq!(p.x(), 3.0);
                assert_eq!(p.y(), 4.0);
            }
            other => panic!("expected Point, got {:?}", other),
        }
    }

    // ---------------------------------------------------------------
    // FeatureCollection normalisation (web)
    // ---------------------------------------------------------------

    #[test]
    fn fc_from_wkt_wraps_single_feature() {
        let fc = parse_to_feature_collection("POINT(1 2)").unwrap();
        assert_eq!(fc.features.len(), 1);
        let geom = fc.features[0].geometry.as_ref().unwrap();
        assert!(matches!(geom.value, geojson::Value::Point(_)));
    }

    #[test]
    fn fc_from_bare_geometry_wraps_single_feature() {
        let fc = parse_to_feature_collection(
            r#"{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}"#,
        )
        .unwrap();
        assert_eq!(fc.features.len(), 1);
        assert!(matches!(
            fc.features[0].geometry.as_ref().unwrap().value,
            geojson::Value::Polygon(_)
        ));
    }

    #[test]
    fn fc_from_feature_preserves_properties() {
        let fc = parse_to_feature_collection(
            r#"{"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]},"properties":{"name":"cow"}}"#,
        )
        .unwrap();
        assert_eq!(fc.features.len(), 1);
        let props = fc.features[0].properties.as_ref().unwrap();
        assert_eq!(props.get("name").unwrap(), "cow");
    }

    #[test]
    fn fc_from_featurecollection_keeps_all_features_and_properties() {
        let fc = parse_to_feature_collection(
            r#"{"type":"FeatureCollection","features":[
                {"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]},"properties":{"id":1}},
                {"type":"Feature","geometry":{"type":"Point","coordinates":[3,4]},"properties":{"id":2}}
            ]}"#,
        )
        .unwrap();
        assert_eq!(fc.features.len(), 2);
        assert_eq!(
            fc.features[1]
                .properties
                .as_ref()
                .unwrap()
                .get("id")
                .unwrap(),
            2
        );
    }

    #[test]
    fn fc_from_malformed_wkt_errors() {
        let err = parse_to_feature_collection("NONSENSE(1 2)").unwrap_err();
        assert!(matches!(err, GeocowError::WktParse(_)));
    }

    #[test]
    fn fc_from_malformed_geojson_errors() {
        let err = parse_to_feature_collection("{not json}").unwrap_err();
        assert!(matches!(err, GeocowError::GeoJsonParse(_)));
    }

    // ---------------------------------------------------------------
    // FeatureCollection transform (web v2)
    // ---------------------------------------------------------------

    #[test]
    fn transform_fc_known_point_27700_to_4258() {
        // TP01 in OSGB36 E/N -> ETRS89 lon/lat.
        let fc =
            parse_to_feature_collection(r#"{"type":"Point","coordinates":[91492.146,11318.804]}"#)
                .unwrap();
        let out = transform_feature_collection(fc, 27700, 4258).unwrap();
        match &out.features[0].geometry.as_ref().unwrap().value {
            geojson::Value::Point(c) => {
                assert!((c[0] - (-6.29977752)).abs() < 1e-6, "lon: {}", c[0]);
                assert!((c[1] - 49.92226394).abs() < 1e-6, "lat: {}", c[1]);
            }
            other => panic!("expected Point, got {other:?}"),
        }
    }

    #[test]
    fn transform_fc_preserves_properties() {
        let fc = parse_to_feature_collection(
            r#"{"type":"Feature","geometry":{"type":"Point","coordinates":[91492.146,11318.804]},"properties":{"name":"TP01"}}"#,
        )
        .unwrap();
        let out = transform_feature_collection(fc, 27700, 4258).unwrap();
        assert_eq!(
            out.features[0]
                .properties
                .as_ref()
                .unwrap()
                .get("name")
                .unwrap(),
            "TP01"
        );
    }

    // ---------------------------------------------------------------
    // Line-delimited parsing (file uploads: NDJSON / WKT-per-line)
    // ---------------------------------------------------------------

    #[test]
    fn lines_single_featurecollection_still_works() {
        let fc = parse_lines_to_feature_collection(
            r#"{"type":"FeatureCollection","features":[
                {"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]},"properties":{"id":1}}
            ]}"#,
        )
        .unwrap();
        assert_eq!(fc.features.len(), 1);
        assert_eq!(
            fc.features[0]
                .properties
                .as_ref()
                .unwrap()
                .get("id")
                .unwrap(),
            1
        );
    }

    #[test]
    fn lines_ndjson_feature_per_line() {
        // Each line is a complete GeoJSON Feature — the shape of the big
        // hh-results example (a `.geojson` file that is really NDJSON).
        let input = concat!(
            r#"{"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]},"properties":{"id":1}}"#,
            "\n",
            r#"{"type":"Feature","geometry":{"type":"Point","coordinates":[3,4]},"properties":{"id":2}}"#,
            "\n",
            r#"{"type":"Feature","geometry":{"type":"Point","coordinates":[5,6]},"properties":{"id":3}}"#,
        );
        let fc = parse_lines_to_feature_collection(input).unwrap();
        assert_eq!(fc.features.len(), 3);
        assert_eq!(
            fc.features[2]
                .properties
                .as_ref()
                .unwrap()
                .get("id")
                .unwrap(),
            3
        );
    }

    #[test]
    fn lines_ndjson_tolerates_blank_lines_and_crlf() {
        let input = "\r\n{\"type\":\"Point\",\"coordinates\":[1,2]}\r\n\r\n{\"type\":\"Point\",\"coordinates\":[3,4]}\r\n";
        let fc = parse_lines_to_feature_collection(input).unwrap();
        assert_eq!(fc.features.len(), 2);
    }

    #[test]
    fn lines_wkt_per_line() {
        let input = "POINT(1 2)\nLINESTRING(0 0,1 1)\nPOLYGON((0 0,1 0,1 1,0 1,0 0))";
        let fc = parse_lines_to_feature_collection(input).unwrap();
        assert_eq!(fc.features.len(), 3);
        assert!(matches!(
            fc.features[2].geometry.as_ref().unwrap().value,
            geojson::Value::Polygon(_)
        ));
    }

    #[test]
    fn lines_ndjson_bare_geometries() {
        let input = "{\"type\":\"Point\",\"coordinates\":[1,2]}\n{\"type\":\"Point\",\"coordinates\":[3,4]}";
        let fc = parse_lines_to_feature_collection(input).unwrap();
        assert_eq!(fc.features.len(), 2);
    }

    #[test]
    fn lines_wkt_bad_line_reports_line_number() {
        let input = "POINT(1 2)\nWIBBLE(9 9)\nPOINT(3 4)";
        let err = parse_lines_to_feature_collection(input).unwrap_err();
        let msg = err.to_string();
        assert!(matches!(err, GeocowError::WktParse(_)), "got: {msg}");
        assert!(msg.contains("line 2"), "expected line number, got: {msg}");
        assert!(msg.contains("WIBBLE"), "expected snippet, got: {msg}");
    }

    #[test]
    fn lines_empty_input_errors() {
        let err = parse_lines_to_feature_collection("   \n  \n").unwrap_err();
        assert!(matches!(err, GeocowError::GeoJsonParse(_)));
    }

    // ---------------------------------------------------------------
    // Bounds / projected-coordinate detection
    // ---------------------------------------------------------------

    #[test]
    fn bounds_of_a_single_point() {
        let fc = parse_to_feature_collection("POINT(-1.5 52.4)").unwrap();
        assert_eq!(
            feature_collection_bounds(&fc),
            Some([-1.5, 52.4, -1.5, 52.4])
        );
    }

    #[test]
    fn bounds_span_every_feature_and_nesting_level() {
        let fc = parse_lines_to_feature_collection(
            "POINT(-1.5 52.4)\nPOLYGON((0 0,3 0,3 4,0 4,0 0))\nMULTIPOINT((9 9),(-2 -3))",
        )
        .unwrap();
        assert_eq!(
            feature_collection_bounds(&fc),
            Some([-2.0, -3.0, 9.0, 52.4])
        );
    }

    #[test]
    fn bounds_of_an_empty_collection_is_none() {
        let fc = geojson::FeatureCollection {
            bbox: None,
            features: vec![],
            foreign_members: None,
        };
        assert_eq!(feature_collection_bounds(&fc), None);
    }

    #[test]
    fn lon_lat_coordinates_are_not_projected() {
        let fc = parse_to_feature_collection("POLYGON((-1.5 52.4,-1.4 52.4,-1.4 52.5,-1.5 52.4))")
            .unwrap();
        assert!(!looks_projected(&fc));
    }

    #[test]
    fn national_grid_coordinates_are_projected() {
        // TP01 in OSGB36 eastings/northings — far outside lon/lat range.
        let fc = parse_to_feature_collection("POINT(91492.146 11318.804)").unwrap();
        assert!(looks_projected(&fc));
    }

    // A National Grid easting can legitimately land inside lon/lat range near
    // the south-west origin, so detection is a heuristic — but a *northing*
    // that small would be off the coast of Cornwall, which is why the check
    // looks at both axes.
    #[test]
    fn small_eastings_with_large_northings_are_projected() {
        let fc = parse_to_feature_collection("POINT(100.0 11318.804)").unwrap();
        assert!(looks_projected(&fc));
    }

    // ---------------------------------------------------------------
    // CRS detection
    // ---------------------------------------------------------------

    fn detect(wkt: &str) -> Option<u32> {
        detect_crs(&parse_lines_to_feature_collection(wkt).unwrap())
    }

    #[test]
    fn detects_lon_lat_as_etrs89() {
        assert_eq!(detect("POINT(-1.5 52.4)"), Some(4258));
        assert_eq!(detect("POINT(-6.2998 49.9223)"), Some(4258)); // Scilly
        assert_eq!(detect("POINT(-1.3 60.15)"), Some(4258)); // Shetland
        assert_eq!(detect("POINT(1.75 52.48)"), Some(4258)); // Lowestoft
    }

    #[test]
    fn detects_national_grid_as_osgb() {
        assert_eq!(detect("POINT(91492.146 11318.804)"), Some(27700)); // TP01
        assert_eq!(detect("POINT(434115.776 278114.072)"), Some(27700));
        assert_eq!(detect("POINT(465000.0 1215000.0)"), Some(27700)); // Shetland
    }

    // The case the plain lon/lat-range check gets wrong: an easting small
    // enough to look like a longitude. The northing settles it.
    #[test]
    fn detects_small_eastings_as_national_grid() {
        assert_eq!(detect("POINT(100.0 11318.804)"), Some(27700));
        assert_eq!(detect("POINT(2.5 500000.0)"), Some(27700));
    }

    #[test]
    fn detection_spans_every_feature_not_just_the_first() {
        // The first point alone is ambiguous; the second is unmistakably grid.
        assert_eq!(
            detect("POINT(1.0 2.0)\nPOINT(434115.776 278114.072)"),
            Some(27700)
        );
    }

    #[test]
    fn declines_to_guess_outside_gb() {
        assert_eq!(detect("POINT(-74.006 40.7128)"), None); // New York
        assert_eq!(detect("POINT(2000000.0 4000000.0)"), None); // some other grid
    }

    // The two boxes overlap only where x is 0-3 and y is 48-62. Read as
    // degrees that's the Channel — real places. Read as a grid reference it
    // is a few metres from the false origin, which is open sea 80 km
    // south-west of the Isles of Scilly. Degrees win.
    #[test]
    fn the_overlap_is_read_as_degrees() {
        assert_eq!(detect("POINT(1.0 50.0)"), Some(4258));
        assert_eq!(detect("POINT(0.1 51.5)"), Some(4258)); // London
    }

    // Outside that overlap there's no contest: a latitude of 1 is nowhere
    // near GB, so two small numbers are a grid reference near the origin.
    #[test]
    fn small_numbers_below_gb_latitudes_are_grid_references() {
        assert_eq!(detect("POINT(1.0 1.0)"), Some(27700));
    }
}
