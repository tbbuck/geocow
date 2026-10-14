pub mod crs;
pub mod error;
pub mod geom;
pub mod io;
pub mod wkb;

#[cfg(feature = "serve")]
pub mod ingest;

#[cfg(feature = "serve")]
pub mod share;

#[cfg(feature = "serve")]
pub mod web;

#[cfg(feature = "map")]
pub mod launch;

/// gzip + base64url share payloads: written by `geocow map`, and by the
/// server when it stores a POSTed geometry for viewing.
#[cfg(any(feature = "serve", feature = "map"))]
pub mod sharelink;
