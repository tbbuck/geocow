//! Reading Well-Known Binary.
//!
//! Handles the three encodings that turn up in practice:
//!
//! - **OGC WKB** — `ST_AsBinary(geom)`, and what most libraries emit.
//! - **ISO WKB** (SQL/MM) — Z and M signalled by adding 1000/2000/3000 to
//!   the type code.
//! - **EWKB** — PostGIS's extension, with Z, M and an SRID flagged in the
//!   high bits of the type word. The SRID is worth having: it says outright
//!   what CRS the coordinates are in, so nothing has to be inferred.
//!
//! Both byte orders are accepted, per geometry — a collection may legally
//! mix them, so the order byte is read afresh at every nesting level.
//!
//! Z and M ordinates are read and discarded: geocow is horizontal-only, and
//! `geo-types` is XY. The geometry is otherwise preserved exactly.
//!
//! Written rather than pulled in: the format is small and fully specified,
//! and doing it here means the SRID and the error messages are ours.

use geo::{
    Coord, Geometry as GeoGeometry, GeometryCollection, LineString, MultiLineString, MultiPoint,
    MultiPolygon, Point, Polygon,
};

use crate::error::GeocowError;

/// Smallest possible WKB: order byte plus a 4-byte type code.
const MIN_WKB_LEN: usize = 5;

/// EWKB flags, packed into the high bits of the type word.
const EWKB_Z: u32 = 0x8000_0000;
const EWKB_M: u32 = 0x4000_0000;
const EWKB_SRID: u32 = 0x2000_0000;
const EWKB_TYPE_MASK: u32 = 0x0FFF_FFFF;

/// A guard against a corrupt length field. Every coordinate occupies at
/// least 16 bytes on the wire, so a count implying more than the buffer
/// holds is a lie — and `Vec::with_capacity` on it would take the process
/// down rather than return an error.
const MIN_BYTES_PER_COORD: usize = 16;

/// What a WKB payload turned out to contain.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedWkb {
    pub geometries: Vec<GeoGeometry<f64>>,
    /// SRID declared by EWKB, if it said. `0` (PostGIS for "unknown") is
    /// reported as `None`.
    pub srid: Option<u32>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Order {
    Big,
    Little,
}

/// True if `bytes` starts like WKB rather than text.
///
/// Unambiguous in practice: WKB opens with a byte order flag of 0 or 1,
/// while WKT, GeoJSON and NDJSON all open with a printable character.
pub fn looks_like_wkb(bytes: &[u8]) -> bool {
    matches!(bytes.first(), Some(0x00 | 0x01)) && bytes.len() >= MIN_WKB_LEN
}

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    fn remaining(&self) -> usize {
        self.bytes.len() - self.pos
    }

    fn take(&mut self, n: usize, what: &str) -> Result<&'a [u8], GeocowError> {
        if self.remaining() < n {
            return Err(GeocowError::WkbParse(format!(
                "truncated at byte {}: needed {n} more bytes for {what}, {} left",
                self.pos,
                self.remaining()
            )));
        }
        let slice = &self.bytes[self.pos..self.pos + n];
        self.pos += n;
        Ok(slice)
    }

    fn u8(&mut self, what: &str) -> Result<u8, GeocowError> {
        Ok(self.take(1, what)?[0])
    }

    fn u32(&mut self, order: Order, what: &str) -> Result<u32, GeocowError> {
        let b: [u8; 4] = self.take(4, what)?.try_into().expect("4 bytes");
        Ok(match order {
            Order::Little => u32::from_le_bytes(b),
            Order::Big => u32::from_be_bytes(b),
        })
    }

    fn f64(&mut self, order: Order, what: &str) -> Result<f64, GeocowError> {
        let b: [u8; 8] = self.take(8, what)?.try_into().expect("8 bytes");
        Ok(match order {
            Order::Little => f64::from_le_bytes(b),
            Order::Big => f64::from_be_bytes(b),
        })
    }

    /// Read one coordinate, discarding any Z/M ordinates that follow it.
    fn coord(&mut self, order: Order, dims: usize) -> Result<Coord<f64>, GeocowError> {
        let x = self.f64(order, "x")?;
        let y = self.f64(order, "y")?;
        for _ in 2..dims {
            self.f64(order, "z/m ordinate")?;
        }
        Ok(Coord { x, y })
    }

    /// Read a count, rejecting one too large for the bytes that remain.
    fn count(&mut self, order: Order, what: &str) -> Result<usize, GeocowError> {
        let n = self.u32(order, what)? as usize;
        if n.saturating_mul(MIN_BYTES_PER_COORD) > self.remaining() {
            return Err(GeocowError::WkbParse(format!(
                "implausible {what} count {n} at byte {}: only {} bytes remain",
                self.pos - 4,
                self.remaining()
            )));
        }
        Ok(n)
    }

    fn coords(&mut self, order: Order, dims: usize) -> Result<Vec<Coord<f64>>, GeocowError> {
        let n = self.count(order, "point")?;
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            out.push(self.coord(order, dims)?);
        }
        Ok(out)
    }
}

/// The type word, once its Z/M/SRID trimmings are stripped off.
struct Header {
    base_type: u32,
    dims: usize,
    srid: Option<u32>,
}

fn read_header(r: &mut Reader) -> Result<(Order, Header), GeocowError> {
    let order = match r.u8("byte order")? {
        0 => Order::Big,
        1 => Order::Little,
        other => {
            return Err(GeocowError::WkbParse(format!(
                "byte {}: expected a byte order of 0 or 1, found {other}",
                r.pos - 1
            )));
        }
    };

    let raw = r.u32(order, "geometry type")?;
    let has_srid = raw & EWKB_SRID != 0;
    let mut base = raw & EWKB_TYPE_MASK;

    // ISO puts the dimensionality in the thousands column; EWKB puts it in
    // the top bits. Either may be in play, so take both.
    let iso = base / 1000;
    base %= 1000;
    let z = raw & EWKB_Z != 0 || iso == 1 || iso == 3;
    let m = raw & EWKB_M != 0 || iso == 2 || iso == 3;

    let srid = if has_srid {
        // PostGIS writes 0 for "no SRID set"; that is not a CRS.
        Some(r.u32(order, "SRID")?).filter(|&s| s != 0)
    } else {
        None
    };

    Ok((
        order,
        Header {
            base_type: base,
            dims: 2 + usize::from(z) + usize::from(m),
            srid,
        },
    ))
}

/// Read one geometry, returning it with any SRID it declared.
fn read_geometry(r: &mut Reader) -> Result<(GeoGeometry<f64>, Option<u32>), GeocowError> {
    let (order, header) = read_header(r)?;
    let dims = header.dims;

    let geometry = match header.base_type {
        1 => {
            let c = r.coord(order, dims)?;
            // An empty point is NaN NaN by convention; geo-types has no way
            // to hold one, and silently producing Point(NaN) would poison
            // every bbox and transform downstream.
            if c.x.is_nan() && c.y.is_nan() {
                return Err(GeocowError::WkbParse(
                    "empty POINT (NaN coordinates) cannot be represented".into(),
                ));
            }
            GeoGeometry::Point(Point(c))
        }
        2 => GeoGeometry::LineString(LineString(r.coords(order, dims)?)),
        3 => {
            let rings = r.count(order, "ring")?;
            let mut parsed = Vec::with_capacity(rings);
            for _ in 0..rings {
                parsed.push(LineString(r.coords(order, dims)?));
            }
            let mut parsed = parsed.into_iter();
            let exterior = parsed.next().unwrap_or_else(|| LineString(Vec::new()));
            GeoGeometry::Polygon(Polygon::new(exterior, parsed.collect()))
        }
        // Every member of a multi-part geometry is a complete WKB geometry
        // of its own, order byte and type code included.
        4 => GeoGeometry::MultiPoint(MultiPoint(
            read_members(r, order)?
                .into_iter()
                .map(|g| match g {
                    GeoGeometry::Point(p) => Ok(p),
                    other => Err(member_error("MultiPoint", "Point", &other)),
                })
                .collect::<Result<Vec<_>, _>>()?,
        )),
        5 => GeoGeometry::MultiLineString(MultiLineString(
            read_members(r, order)?
                .into_iter()
                .map(|g| match g {
                    GeoGeometry::LineString(l) => Ok(l),
                    other => Err(member_error("MultiLineString", "LineString", &other)),
                })
                .collect::<Result<Vec<_>, _>>()?,
        )),
        6 => GeoGeometry::MultiPolygon(MultiPolygon(
            read_members(r, order)?
                .into_iter()
                .map(|g| match g {
                    GeoGeometry::Polygon(p) => Ok(p),
                    other => Err(member_error("MultiPolygon", "Polygon", &other)),
                })
                .collect::<Result<Vec<_>, _>>()?,
        )),
        7 => GeoGeometry::GeometryCollection(GeometryCollection(read_members(r, order)?)),
        other => {
            return Err(GeocowError::WkbParse(format!(
                "unsupported geometry type {other}. \
                 Curved types (CircularString, CompoundCurve, CurvePolygon) \
                 are not supported."
            )));
        }
    };

    Ok((geometry, header.srid))
}

fn member_error(parent: &str, expected: &str, found: &GeoGeometry<f64>) -> GeocowError {
    GeocowError::WkbParse(format!(
        "{parent} contains a {}, expected {expected}",
        type_name(found)
    ))
}

fn type_name(g: &GeoGeometry<f64>) -> &'static str {
    match g {
        GeoGeometry::Point(_) => "Point",
        GeoGeometry::Line(_) => "Line",
        GeoGeometry::LineString(_) => "LineString",
        GeoGeometry::Polygon(_) => "Polygon",
        GeoGeometry::MultiPoint(_) => "MultiPoint",
        GeoGeometry::MultiLineString(_) => "MultiLineString",
        GeoGeometry::MultiPolygon(_) => "MultiPolygon",
        GeoGeometry::GeometryCollection(_) => "GeometryCollection",
        GeoGeometry::Rect(_) => "Rect",
        GeoGeometry::Triangle(_) => "Triangle",
    }
}

/// Read the `n` sub-geometries of a multi-part geometry or collection.
fn read_members(r: &mut Reader, order: Order) -> Result<Vec<GeoGeometry<f64>>, GeocowError> {
    // A member is at least a header, so bound the count by that rather than
    // by coordinate size.
    let n = r.u32(order, "member count")? as usize;
    if n.saturating_mul(MIN_WKB_LEN) > r.remaining() {
        return Err(GeocowError::WkbParse(format!(
            "implausible member count {n}: only {} bytes remain",
            r.remaining()
        )));
    }
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        out.push(read_geometry(r)?.0);
    }
    Ok(out)
}

/// Parse a WKB payload: one geometry, or several concatenated back to back.
///
/// Concatenation falls out of the format being self-delimiting, and matches
/// what `psql -A -t -c 'select ST_AsBinary(geom) from …' > file.wkb` leaves
/// you with — the binary counterpart of WKT-per-line.
pub fn parse_all(bytes: &[u8]) -> Result<ParsedWkb, GeocowError> {
    if bytes.len() < MIN_WKB_LEN {
        return Err(GeocowError::WkbParse(format!(
            "too short to be WKB: {} bytes",
            bytes.len()
        )));
    }

    let mut r = Reader::new(bytes);
    let mut geometries = Vec::new();
    let mut srid: Option<u32> = None;

    while r.remaining() > 0 {
        let (geometry, this_srid) = read_geometry(&mut r)?;
        match (srid, this_srid) {
            (Some(a), Some(b)) if a != b => {
                return Err(GeocowError::WkbParse(format!(
                    "geometries declare different SRIDs ({a} and {b}); \
                     reproject them to one CRS first"
                )));
            }
            (None, Some(b)) => srid = Some(b),
            _ => {}
        }
        geometries.push(geometry);
    }

    if geometries.is_empty() {
        return Err(GeocowError::WkbParse("no geometries in payload".into()));
    }
    Ok(ParsedWkb { geometries, srid })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Decode a hex string into bytes — for anchoring tests to WKB written
    /// by something other than this file.
    fn hex(s: &str) -> Vec<u8> {
        let clean: String = s.chars().filter(|c| !c.is_whitespace()).collect();
        (0..clean.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&clean[i..i + 2], 16).unwrap())
            .collect()
    }

    fn only(bytes: &[u8]) -> GeoGeometry<f64> {
        let parsed = parse_all(bytes).expect("should parse");
        assert_eq!(parsed.geometries.len(), 1);
        parsed.geometries.into_iter().next().unwrap()
    }

    // ---------------------------------------------------------------
    // Anchored against externally-produced bytes
    // ---------------------------------------------------------------

    #[test]
    fn little_endian_point() {
        // 01 | type 1 | x=1.0 | y=2.0
        let g = only(&hex("0101000000 000000000000F03F 0000000000000040"));
        assert_eq!(g, GeoGeometry::Point(Point::new(1.0, 2.0)));
    }

    #[test]
    fn big_endian_point() {
        let g = only(&hex("00 00000001 3FF0000000000000 4000000000000000"));
        assert_eq!(g, GeoGeometry::Point(Point::new(1.0, 2.0)));
    }

    #[test]
    fn little_endian_linestring() {
        let g = only(&hex("0102000000 02000000 \
             0000000000000000 0000000000000000 \
             000000000000F03F 000000000000F03F"));
        assert_eq!(
            g,
            GeoGeometry::LineString(LineString::from(vec![(0.0, 0.0), (1.0, 1.0)]))
        );
    }

    #[test]
    fn ewkb_carries_its_srid() {
        // Type 0x20000001 (point + SRID flag), SRID 27700 = 0x6C34.
        let parsed = parse_all(&hex(
            "0101000020 346C0000 000000000000F03F 0000000000000040",
        ))
        .unwrap();
        assert_eq!(parsed.srid, Some(27700));
        assert_eq!(
            parsed.geometries[0],
            GeoGeometry::Point(Point::new(1.0, 2.0))
        );
    }

    #[test]
    fn srid_zero_means_unknown_not_a_crs() {
        let parsed = parse_all(&hex(
            "0101000020 00000000 000000000000F03F 0000000000000040",
        ))
        .unwrap();
        assert_eq!(parsed.srid, None);
    }

    // ---------------------------------------------------------------
    // Round trips, via a writer built only for the tests
    // ---------------------------------------------------------------

    /// Minimal little-endian WKB writer. Independent of the reader above,
    /// and anchored by the hex cases, so the two can't agree on a mistake
    /// about the byte layout.
    fn write(g: &GeoGeometry<f64>, out: &mut Vec<u8>) {
        let coord = |out: &mut Vec<u8>, c: &Coord<f64>| {
            out.extend_from_slice(&c.x.to_le_bytes());
            out.extend_from_slice(&c.y.to_le_bytes());
        };
        let coords = |out: &mut Vec<u8>, cs: &[Coord<f64>]| {
            out.extend_from_slice(&(cs.len() as u32).to_le_bytes());
            for c in cs {
                out.extend_from_slice(&c.x.to_le_bytes());
                out.extend_from_slice(&c.y.to_le_bytes());
            }
        };
        let header = |out: &mut Vec<u8>, t: u32| {
            out.push(1);
            out.extend_from_slice(&t.to_le_bytes());
        };

        match g {
            GeoGeometry::Point(p) => {
                header(out, 1);
                coord(out, &p.0);
            }
            GeoGeometry::LineString(l) => {
                header(out, 2);
                coords(out, &l.0);
            }
            GeoGeometry::Polygon(p) => {
                header(out, 3);
                let rings = 1 + p.interiors().len();
                out.extend_from_slice(&(rings as u32).to_le_bytes());
                coords(out, &p.exterior().0);
                for r in p.interiors() {
                    coords(out, &r.0);
                }
            }
            GeoGeometry::MultiPoint(m) => {
                header(out, 4);
                out.extend_from_slice(&(m.0.len() as u32).to_le_bytes());
                for p in &m.0 {
                    write(&GeoGeometry::Point(*p), out);
                }
            }
            GeoGeometry::MultiLineString(m) => {
                header(out, 5);
                out.extend_from_slice(&(m.0.len() as u32).to_le_bytes());
                for l in &m.0 {
                    write(&GeoGeometry::LineString(l.clone()), out);
                }
            }
            GeoGeometry::MultiPolygon(m) => {
                header(out, 6);
                out.extend_from_slice(&(m.0.len() as u32).to_le_bytes());
                for p in &m.0 {
                    write(&GeoGeometry::Polygon(p.clone()), out);
                }
            }
            GeoGeometry::GeometryCollection(c) => {
                header(out, 7);
                out.extend_from_slice(&(c.0.len() as u32).to_le_bytes());
                for member in &c.0 {
                    write(member, out);
                }
            }
            other => panic!("test writer doesn't cover {}", type_name(other)),
        }
    }

    fn to_wkb(g: &GeoGeometry<f64>) -> Vec<u8> {
        let mut out = Vec::new();
        write(g, &mut out);
        out
    }

    fn from_wkt(s: &str) -> GeoGeometry<f64> {
        crate::io::parse_wkt(s).unwrap().into()
    }

    #[test]
    fn writer_agrees_with_the_anchored_bytes() {
        // Guards the round-trip tests below: if the test writer drifted, the
        // reader and writer could agree with each other and be wrong.
        assert_eq!(
            to_wkb(&GeoGeometry::Point(Point::new(1.0, 2.0))),
            hex("0101000000 000000000000F03F 0000000000000040")
        );
    }

    #[test]
    fn round_trips_every_geometry_type() {
        let cases = [
            "POINT(-1.5 52.4)",
            "LINESTRING(0 0,1 1,2 2)",
            "POLYGON((0 0,4 0,4 4,0 4,0 0))",
            "POLYGON((0 0,10 0,10 10,0 10,0 0),(2 2,3 2,3 3,2 3,2 2))",
            "MULTIPOINT((1 2),(3 4))",
            "MULTILINESTRING((0 0,1 1),(2 2,3 3))",
            "MULTIPOLYGON(((0 0,1 0,1 1,0 1,0 0)),((5 5,6 5,6 6,5 6,5 5)))",
            "GEOMETRYCOLLECTION(POINT(1 2),LINESTRING(0 0,1 1))",
        ];
        for wkt in cases {
            let expected = from_wkt(wkt);
            let actual = only(&to_wkb(&expected));
            assert_eq!(actual, expected, "round trip failed for {wkt}");
        }
    }

    #[test]
    fn reads_national_grid_coordinates_intact() {
        let expected = from_wkt("POINT(434115.77580714034 278114.07152933464)");
        assert_eq!(only(&to_wkb(&expected)), expected);
    }

    // ---------------------------------------------------------------
    // Dimensionality
    // ---------------------------------------------------------------

    #[test]
    fn iso_z_ordinates_are_read_and_dropped() {
        // Type 1001 (0x3E9) = PointZ: x=1, y=2, and a z of 3 that is read
        // off the wire and discarded.
        let g = only(&hex("01 E9030000 \
             000000000000F03F 0000000000000040 0000000000000840"));
        assert_eq!(g, GeoGeometry::Point(Point::new(1.0, 2.0)));
    }

    #[test]
    fn iso_zm_ordinates_are_read_and_dropped() {
        // Type 3001 (0xBB9) = PointZM: four ordinates, two kept.
        let g = only(&hex("01 B90B0000 \
             000000000000F03F 0000000000000040 \
             0000000000000840 0000000000001040"));
        assert_eq!(g, GeoGeometry::Point(Point::new(1.0, 2.0)));
    }

    #[test]
    fn iso_m_ordinates_are_read_and_dropped() {
        // Type 2001 (0x7D1) = PointM: three ordinates, m discarded.
        let g = only(&hex("01 D1070000 \
             000000000000F03F 0000000000000040 0000000000000840"));
        assert_eq!(g, GeoGeometry::Point(Point::new(1.0, 2.0)));
    }

    #[test]
    fn ewkb_z_ordinates_are_read_and_dropped() {
        // Type 0x80000001 — PointZ in EWKB. x=1, y=2, z=3.
        let g = only(&hex(
            "0101000080 000000000000F03F 0000000000000040 0000000000000840",
        ));
        assert_eq!(g, GeoGeometry::Point(Point::new(1.0, 2.0)));
    }

    #[test]
    fn ewkb_zm_with_srid_reads_both_flags_and_the_srid() {
        // Type 0xE0000001 = Z | M | SRID, SRID 27700, then x,y,z,m.
        let parsed = parse_all(&hex("01010000E0 346C0000 \
             000000000000F03F 0000000000000040 \
             0000000000000840 0000000000001040"))
        .unwrap();
        assert_eq!(parsed.srid, Some(27700));
        assert_eq!(
            parsed.geometries[0],
            GeoGeometry::Point(Point::new(1.0, 2.0))
        );
    }

    // ---------------------------------------------------------------
    // Several geometries in one payload
    // ---------------------------------------------------------------

    #[test]
    fn reads_concatenated_geometries() {
        let a = from_wkt("POINT(1 2)");
        let b = from_wkt("POINT(3 4)");
        let mut bytes = to_wkb(&a);
        bytes.extend(to_wkb(&b));
        let parsed = parse_all(&bytes).unwrap();
        assert_eq!(parsed.geometries, vec![a, b]);
    }

    #[test]
    fn mixed_byte_orders_in_one_payload() {
        let mut bytes = hex("0101000000 000000000000F03F 0000000000000040");
        bytes.extend(hex("00 00000001 4008000000000000 4010000000000000"));
        let parsed = parse_all(&bytes).unwrap();
        assert_eq!(
            parsed.geometries,
            vec![
                GeoGeometry::Point(Point::new(1.0, 2.0)),
                GeoGeometry::Point(Point::new(3.0, 4.0)),
            ]
        );
    }

    #[test]
    fn conflicting_srids_are_rejected() {
        let mut bytes = hex("0101000020 346C0000 000000000000F03F 0000000000000040");
        bytes.extend(hex("0101000020 E6100000 000000000000F03F 0000000000000040"));
        let err = parse_all(&bytes).unwrap_err().to_string();
        assert!(err.contains("different SRIDs"), "got: {err}");
    }

    // ---------------------------------------------------------------
    // Detection and rejection
    // ---------------------------------------------------------------

    #[test]
    fn recognises_wkb_and_not_text() {
        assert!(looks_like_wkb(&hex(
            "0101000000 000000000000F03F 0000000000000040"
        )));
        assert!(looks_like_wkb(&hex(
            "00 00000001 3FF0000000000000 4000000000000000"
        )));
        assert!(!looks_like_wkb(b"POINT(1 2)"));
        assert!(!looks_like_wkb(b"{\"type\":\"Point\"}"));
        assert!(!looks_like_wkb(b"  POINT(1 2)"));
        assert!(!looks_like_wkb(b""));
        // Right first byte, too short to be anything.
        assert!(!looks_like_wkb(&[0x01, 0x01]));
    }

    #[test]
    fn rejects_a_bad_byte_order_flag() {
        let err = parse_all(&hex("07 01000000 000000000000F03F 0000000000000040"))
            .unwrap_err()
            .to_string();
        assert!(err.contains("byte order"), "got: {err}");
    }

    #[test]
    fn rejects_an_unsupported_geometry_type() {
        // Type 8 is CircularString.
        let err = parse_all(&hex("0108000000 00000000"))
            .unwrap_err()
            .to_string();
        assert!(err.contains("unsupported geometry type 8"), "got: {err}");
    }

    #[test]
    fn rejects_truncated_input() {
        // A point missing its y ordinate.
        let err = parse_all(&hex("0101000000 000000000000F03F"))
            .unwrap_err()
            .to_string();
        assert!(err.contains("truncated"), "got: {err}");
    }

    #[test]
    fn rejects_trailing_rubbish_after_a_valid_geometry() {
        let mut bytes = to_wkb(&from_wkt("POINT(1 2)"));
        bytes.extend_from_slice(&[0x01, 0x02]);
        assert!(parse_all(&bytes).is_err());
    }

    // A corrupt length field must not be believed: allocating for it is how
    // a malformed upload turns into an out-of-memory kill.
    #[test]
    fn rejects_an_implausible_coordinate_count() {
        let err = parse_all(&hex("0102000000 FFFFFFFF 0000000000000000"))
            .unwrap_err()
            .to_string();
        assert!(err.contains("implausible"), "got: {err}");
    }

    #[test]
    fn rejects_an_implausible_member_count() {
        let err = parse_all(&hex("0104000000 FFFFFFFF"))
            .unwrap_err()
            .to_string();
        assert!(err.contains("implausible"), "got: {err}");
    }

    #[test]
    fn rejects_an_empty_point() {
        // NaN NaN is the conventional encoding of POINT EMPTY.
        let err = parse_all(&hex("0101000000 000000000000F87F 000000000000F87F"))
            .unwrap_err()
            .to_string();
        assert!(err.contains("empty POINT"), "got: {err}");
    }

    #[test]
    fn rejects_a_multipoint_holding_the_wrong_type() {
        let mut bytes = hex("0104000000 01000000");
        bytes.extend(to_wkb(&from_wkt("LINESTRING(0 0,1 1)")));
        let err = parse_all(&bytes).unwrap_err().to_string();
        assert!(
            err.contains("MultiPoint contains a LineString"),
            "got: {err}"
        );
    }
}
