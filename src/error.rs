use thiserror::Error;

#[derive(Debug, Error)]
pub enum GeocowError {
    #[error("OSTN15 grid files not found or invalid: {0}")]
    GridNotFound(String),

    #[error("CRS transformation failed: {0}")]
    TransformError(String),

    /// A CRS pair geocow doesn't do. Distinct from [`Self::TransformError`]
    /// because it is the caller asking for the impossible, not the transform
    /// going wrong — the difference between a 422 and a 500.
    #[error("unsupported CRS: {0}")]
    UnsupportedCrs(String),

    #[error("invalid input geometry: {0}")]
    InvalidGeometry(String),

    #[error("failed to parse WKT: {0}")]
    WktParse(String),

    #[error("failed to parse GeoJSON: {0}")]
    GeoJsonParse(String),

    #[error("failed to parse WKB: {0}")]
    WkbParse(String),

    #[error("unsupported geometry type: {0}")]
    UnsupportedGeometry(String),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}
