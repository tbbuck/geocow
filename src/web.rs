//! HTTP API and web server for `geocow serve`.
//!
//! This module is compiled only with the `serve` feature. It exposes the
//! API router (`api_router`) so it can be exercised directly in tests via
//! `tower::ServiceExt::oneshot`; [`serve`] wraps it with static-file serving.

use std::net::SocketAddr;
use std::path::PathBuf;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Query},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};

use crate::io;

/// Body-size ceiling for the geometry endpoints. axum defaults to 2 MiB,
/// which a real dataset blows past instantly; drops carry the whole payload in
/// one request, so allow generously (a 22 MB NDJSON is routine).
pub const MAX_UPLOAD_BYTES: usize = 256 * 1024 * 1024;

/// Request body for `POST /api/parse`.
#[derive(Debug, Deserialize)]
pub struct ParseRequest {
    /// Raw pasted text: WKT, GeoJSON, or a bare GeoJSON geometry.
    pub input: String,
}

/// Successful response for `POST /api/parse`.
#[derive(Debug, Serialize)]
pub struct ParseResponse {
    /// Detected input format: `"wkt"` or `"geojson"`.
    pub format: String,
    /// Normalised GeoJSON FeatureCollection, ready for the map.
    pub geojson: geojson::FeatureCollection,
}

/// Error response body.
#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

/// Map a `GeocowError` to an HTTP status. Parse failures are user errors
/// (422); anything else is a server fault (500).
fn error_response(err: crate::error::GeocowError) -> Response {
    use crate::error::GeocowError::*;
    let status = match err {
        WktParse(_)
        | GeoJsonParse(_)
        | WkbParse(_)
        | InvalidGeometry(_)
        | UnsupportedGeometry(_)
        | UnsupportedCrs(_) => StatusCode::UNPROCESSABLE_ENTITY,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (
        status,
        Json(ErrorResponse {
            error: err.to_string(),
        }),
    )
        .into_response()
}

async fn parse_handler(Json(req): Json<ParseRequest>) -> Response {
    let input = req.input.trim();
    if input.is_empty() {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(ErrorResponse {
                error: "empty input".into(),
            }),
        )
            .into_response();
    }

    let format = match io::detect_format(input) {
        io::Format::Wkt => "wkt",
        io::Format::GeoJson => "geojson",
    };

    match io::parse_to_feature_collection(input) {
        Ok(fc) => Json(ParseResponse {
            format: format.to_string(),
            geojson: fc,
        })
        .into_response(),
        Err(e) => error_response(e),
    }
}

/// Request body for `POST /api/transform`.
#[derive(Debug, Deserialize)]
pub struct TransformRequest {
    pub input: String,
    /// Source CRS EPSG code (default 27700, OSGB National Grid).
    pub from: Option<u32>,
    /// Target CRS EPSG code (default 4258, ETRS89).
    pub to: Option<u32>,
}

/// Successful response for `POST /api/transform`.
#[derive(Debug, Serialize)]
pub struct TransformResponse {
    pub format: String,
    pub from: u32,
    pub to: u32,
    /// Transformed geometry as a FeatureCollection (target CRS), for the map.
    pub geojson: geojson::FeatureCollection,
    /// Transformed geometry re-serialised in the input's format, for the box.
    pub text: String,
}

/// Re-serialise a transformed FeatureCollection back into the input format so
/// the textbox can be repopulated with the reprojected geometry.
fn fc_to_text(fc: &geojson::FeatureCollection, format: io::Format) -> String {
    match format {
        io::Format::Wkt => {
            use geo::Geometry as GeoGeometry;
            use wkt::ToWkt;
            match fc.features.first().and_then(|f| f.geometry.clone()) {
                Some(g) => match GeoGeometry::<f64>::try_from(g) {
                    Ok(geo) => geo.wkt_string(),
                    Err(_) => String::new(),
                },
                None => String::new(),
            }
        }
        io::Format::GeoJson => {
            if fc.features.len() == 1 {
                fc.features[0]
                    .geometry
                    .as_ref()
                    .map(|g| g.to_string())
                    .unwrap_or_default()
            } else {
                serde_json::to_string(fc).unwrap_or_default()
            }
        }
    }
}

async fn transform_handler(Json(req): Json<TransformRequest>) -> Response {
    let input = req.input.trim();
    if input.is_empty() {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(ErrorResponse {
                error: "empty input".into(),
            }),
        )
            .into_response();
    }

    let from = req.from.unwrap_or(27700);
    let to = req.to.unwrap_or(4258);
    let format = match io::detect_format(input) {
        io::Format::Wkt => "wkt",
        io::Format::GeoJson => "geojson",
    };

    let fc = match io::parse_to_feature_collection(input) {
        Ok(fc) => fc,
        Err(e) => return error_response(e),
    };
    let transformed = match io::transform_feature_collection(fc, from, to) {
        Ok(fc) => fc,
        Err(e) => return error_response(e),
    };
    let text = fc_to_text(&transformed, io::detect_format(input));

    Json(TransformResponse {
        format: format.to_string(),
        from,
        to,
        geojson: transformed,
        text,
    })
    .into_response()
}

/// Format label for a raw upload, based on its first meaningful character.
fn format_label(input: &str) -> &'static str {
    match io::detect_format(input) {
        io::Format::Wkt => "wkt",
        io::Format::GeoJson => "geojson",
    }
}

/// `POST /api/parse-file` — parse a raw uploaded body (WKT-per-line, NDJSON,
/// or a single GeoJSON document) into a FeatureCollection.
///
/// Unlike `/api/parse`, the body is the geometry itself, not a JSON envelope:
/// no `{"input": "..."}` wrapping (which would double a 22 MB payload and force
/// escaping every quote). Body limit is [`MAX_UPLOAD_BYTES`].
/// The frontend only routes WKT here — GeoJSON/NDJSON it parses locally — but
/// this endpoint accepts all three so nothing depends on the client guessing.
async fn parse_file_handler(body: String) -> Response {
    let input = body.trim();
    if input.is_empty() {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(ErrorResponse {
                error: "empty input".into(),
            }),
        )
            .into_response();
    }

    match io::parse_lines_to_feature_collection(input) {
        Ok(fc) => Json(ParseResponse {
            format: format_label(input).to_string(),
            geojson: fc,
        })
        .into_response(),
        Err(e) => error_response(e),
    }
}

/// Query string for `POST /api/transform-file` (`?from=27700&to=4258`).
#[derive(Debug, Deserialize)]
pub struct TransformFileQuery {
    pub from: Option<u32>,
    pub to: Option<u32>,
}

/// Successful response for `POST /api/transform-file`. No re-serialised `text`
/// (the paste box isn't repopulated for large drops) — just the map data.
#[derive(Debug, Serialize)]
pub struct TransformFileResponse {
    pub from: u32,
    pub to: u32,
    pub geojson: geojson::FeatureCollection,
}

/// `POST /api/transform-file` — reproject a raw uploaded body between CRSs.
/// Same raw-body, raised-limit contract as [`parse_file_handler`]; used when a
/// dropped file's coordinates fall outside lon/lat bounds (assumed EPSG:27700).
async fn transform_file_handler(Query(q): Query<TransformFileQuery>, body: String) -> Response {
    let input = body.trim();
    if input.is_empty() {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(ErrorResponse {
                error: "empty input".into(),
            }),
        )
            .into_response();
    }

    let from = q.from.unwrap_or(27700);
    let to = q.to.unwrap_or(4258);

    let fc = match io::parse_lines_to_feature_collection(input) {
        Ok(fc) => fc,
        Err(e) => return error_response(e),
    };
    match io::transform_feature_collection(fc, from, to) {
        Ok(geojson) => Json(TransformFileResponse { from, to, geojson }).into_response(),
        Err(e) => error_response(e),
    }
}

async fn health_handler() -> &'static str {
    "ok"
}

/// Basemap settings handed to the frontend at runtime, so the bundle and the
/// Docker image carry no keys and one build serves any deployment.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapConfig {
    /// MapTiler API key. Without one the frontend falls back to keyless
    /// OpenFreeMap styles and has no satellite basemap.
    pub maptiler_key: Option<String>,
    /// XYZ template for a high-resolution aerial imagery overlay, e.g.
    /// `https://tiles.example.com/{z}/{x}/{y}.jpg`. Shown in satellite mode.
    pub aerial_tile_url: Option<String>,
    /// Attribution text for the aerial overlay.
    pub aerial_attribution: Option<String>,
}

impl MapConfig {
    /// Read `GEOCOW_MAPTILER_KEY`, `GEOCOW_AERIAL_TILE_URL` and
    /// `GEOCOW_AERIAL_ATTRIBUTION`; empty counts as unset.
    pub fn from_env() -> Self {
        let var = |name| std::env::var(name).ok().filter(|s: &String| !s.is_empty());
        Self {
            maptiler_key: var("GEOCOW_MAPTILER_KEY"),
            aerial_tile_url: var("GEOCOW_AERIAL_TILE_URL"),
            aerial_attribution: var("GEOCOW_AERIAL_ATTRIBUTION"),
        }
    }
}

/// Build the API router (no static-file serving), taking its settings from
/// the environment. See [`api_router_with`] for the injectable form.
pub fn api_router() -> Router {
    api_router_with(
        crate::ingest::IngestConfig::from_env(),
        MapConfig::from_env(),
    )
}

/// Build the API router with explicit settings — the ingest key, the public
/// origin baked into returned URLs, and the basemap config served at
/// `/api/config`. Tests use this to avoid depending on (or racing on) process
/// environment.
pub fn api_router_with(ingest: crate::ingest::IngestConfig, map: MapConfig) -> Router {
    // Every route that takes geometry gets the raised limit: the raw-body
    // upload routes carry whole datasets, and a single pasted geometry
    // (a big MultiPolygon, one FeatureCollection) goes through the JSON
    // paste routes and is just as large.
    let geometry = Router::new()
        .route("/api/parse", post(parse_handler))
        .route("/api/transform", post(transform_handler))
        .route("/api/parse-file", post(parse_file_handler))
        .route("/api/transform-file", post(transform_file_handler))
        .layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES));

    // One store, two writers: the browser's Share button and POST
    // /api/geometry both put payloads where GET /api/share/{id} can find them.
    let store = crate::share::ShareStore::new();

    Router::new()
        .route("/api/health", get(health_handler))
        .route("/api/config", get(move || async move { Json(map) }))
        .merge(geometry)
        .merge(crate::ingest::ingest_router(ingest, store.clone()))
        .merge(crate::share::share_router(store))
}

/// Log filter used when `RUST_LOG` is unset. `tower_http` is at debug because
/// that's where `TraceLayer::new_for_http` logs each request and its status.
pub const DEFAULT_LOG_FILTER: &str = "geocow=info,tower_http=debug";

/// Serve the API and the built frontend in `web_dir` on `addr` until Ctrl-C
/// or SIGTERM. Settings come from the environment (see [`MapConfig`] and
/// [`crate::ingest::IngestConfig`]). The caller is responsible for the grid
/// gate and for installing a tracing subscriber.
pub async fn serve(addr: SocketAddr, web_dir: PathBuf) -> Result<(), crate::error::GeocowError> {
    use tower_http::services::{ServeDir, ServeFile};
    use tower_http::trace::TraceLayer;

    let ingest = crate::ingest::IngestConfig::from_env();
    if ingest.api_key.is_none() {
        tracing::warn!("GEOCOW_API_KEY is unset: POST /api/geometry is disabled");
    }
    let map = MapConfig::from_env();
    if map.maptiler_key.is_none() {
        tracing::info!("GEOCOW_MAPTILER_KEY is unset: the map uses keyless OpenFreeMap styles");
    }

    let index = web_dir.join("index.html");
    if !index.is_file() {
        // Legitimate in development, where Vite serves the frontend and
        // proxies /api here.
        tracing::info!(
            "no {index:?}: serving the API only (build the frontend with `yarn --cwd web build`)"
        );
    }

    // Serve the SPA: unknown paths fall back to index.html so client-side
    // routing / hash state survives a hard refresh.
    let static_files = ServeDir::new(&web_dir).not_found_service(ServeFile::new(index));
    let app = api_router_with(ingest, map)
        .fallback_service(static_files)
        .layer(TraceLayer::new_for_http());

    // Install the SIGTERM handler (what `docker stop` sends) before binding,
    // so a failure to install it stops startup rather than leaving a server
    // that can only be killed.
    #[cfg(unix)]
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let shutdown = async move {
        #[cfg(unix)]
        let terminate = sigterm.recv();
        #[cfg(not(unix))]
        let terminate = std::future::pending::<Option<()>>();
        tokio::select! {
            r = tokio::signal::ctrl_c() => {
                if let Err(e) = r {
                    tracing::error!("Ctrl-C handler failed, shutting down: {e}");
                }
            }
            _ = terminate => {}
        }
        tracing::info!("shutting down");
    };

    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("geocow listening on http://{addr} (serving {web_dir:?})");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing::Level;

    fn with_default_filter(check: impl FnOnce()) {
        let subscriber = tracing_subscriber::fmt()
            .with_env_filter(tracing_subscriber::EnvFilter::new(DEFAULT_LOG_FILTER))
            .with_test_writer()
            .finish();
        tracing::subscriber::with_default(subscriber, check);
    }

    #[test]
    fn default_filter_shows_the_library_info_logs() {
        with_default_filter(|| assert!(tracing::enabled!(target: "geocow::web", Level::INFO)));
    }

    #[test]
    fn default_filter_shows_per_request_trace_logs() {
        // TraceLayer::new_for_http logs requests and responses at DEBUG.
        with_default_filter(|| {
            assert!(tracing::enabled!(target: "tower_http::trace::on_response", Level::DEBUG))
        });
    }
}
