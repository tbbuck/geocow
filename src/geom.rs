use geo::{
    Geometry as GeoGeometry, GeometryCollection, LineString, MultiLineString, MultiPoint,
    MultiPolygon, Point, Polygon,
};

/// Geocow's geometry wrapper around geo_types.
///
/// We use geo_types as the canonical in-memory representation and
/// convert to/from WKT and GeoJSON at the I/O boundary.
#[derive(Debug, Clone, PartialEq)]
pub enum Geometry {
    Point(Point),
    LineString(LineString),
    Polygon(Polygon),
    MultiPoint(MultiPoint),
    MultiLineString(MultiLineString),
    MultiPolygon(MultiPolygon),
    GeometryCollection(GeometryCollection),
}

impl From<Geometry> for GeoGeometry {
    fn from(g: Geometry) -> Self {
        match g {
            Geometry::Point(p) => GeoGeometry::Point(p),
            Geometry::LineString(l) => GeoGeometry::LineString(l),
            Geometry::Polygon(p) => GeoGeometry::Polygon(p),
            Geometry::MultiPoint(m) => GeoGeometry::MultiPoint(m),
            Geometry::MultiLineString(m) => GeoGeometry::MultiLineString(m),
            Geometry::MultiPolygon(m) => GeoGeometry::MultiPolygon(m),
            Geometry::GeometryCollection(g) => GeoGeometry::GeometryCollection(g),
        }
    }
}

impl TryFrom<GeoGeometry> for Geometry {
    type Error = crate::error::GeocowError;

    fn try_from(g: GeoGeometry) -> Result<Self, Self::Error> {
        match g {
            GeoGeometry::Point(p) => Ok(Geometry::Point(p)),
            GeoGeometry::LineString(l) => Ok(Geometry::LineString(l)),
            GeoGeometry::Polygon(p) => Ok(Geometry::Polygon(p)),
            GeoGeometry::MultiPoint(m) => Ok(Geometry::MultiPoint(m)),
            GeoGeometry::MultiLineString(m) => Ok(Geometry::MultiLineString(m)),
            GeoGeometry::MultiPolygon(m) => Ok(Geometry::MultiPolygon(m)),
            GeoGeometry::GeometryCollection(g) => Ok(Geometry::GeometryCollection(g)),
            _ => Err(crate::error::GeocowError::UnsupportedGeometry(format!(
                "{:?}",
                g
            ))),
        }
    }
}
