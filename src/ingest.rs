//! `POST /api/geometry` — push geometry at a running geocow and get back a URL
//! that displays it.
//!
//! This is the machine-facing counterpart to pasting into the web app: pipe a
//! query result straight from a local shell to production and open the link.
//!
//! ```text
//! curl -sS https://maps.example.com/api/geometry \
//!   -H "x-api-key: $GEOCOW_API_KEY" \
//!   --data-binary @boundary.wkt
//! {"url":"https://maps.example.com/#s=…","id":"…","features":1,"from":27700,"to":4258,"transformed":true}
//! ```
//!
//! The body can be WKT, GeoJSON, NDJSON, WKT-per-line, or raw WKB bytes —
//! whichever the caller already has. Which one it is is read from the body
//! itself, so there is no flag or content type to get right.
//!
//! The CRS rules are deliberately identical to the frontend's: coordinates
//! outside lon/lat bounds are taken to be EPSG:27700 and reprojected through
//! OSTN15 to ETRS89 before storage, so a POST and a paste of the same text
//! produce the same map. EWKB, which states its SRID, is believed over any
//! inference; `?from=` overrides both.
//!
//! Auth is a single shared key — enough to keep the open internet from filling
//! the share store, not a user system. There is no built-in key: until
//! `GEOCOW_API_KEY` is set the endpoint answers 503 to everyone.

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use serde::{Deserialize, Serialize};

use crate::error::GeocowError;
use crate::io;
use crate::share::{MAX_SHARE_BYTES, ShareStore};
use crate::sharelink;
use crate::wkb;

/// Ingest configuration, resolved once at router construction so a request
/// never reads the environment (and tests can inject their own).
#[derive(Clone, Debug)]
pub struct IngestConfig {
    /// Shared secret for `/api/geometry`. `None` disables the endpoint: it
    /// guards writes to a public-by-design store, and an unconfigured server
    /// must not accept them from anyone.
    pub api_key: Option<String>,
    /// Origin to put in returned URLs. `None` means "whatever host the
    /// request arrived on", which is almost always what you want: POST to
    /// localhost and you get a localhost link, POST to a public host and you
    /// get a link on it. Set it only when the public origin differs from the
    /// `Host` the server sees.
    pub public_url: Option<String>,
}

impl IngestConfig {
    /// Read `GEOCOW_API_KEY` and `GEOCOW_PUBLIC_URL`; empty counts as unset.
    pub fn from_env() -> Self {
        let var = |name| std::env::var(name).ok().filter(|s: &String| !s.is_empty());
        Self {
            api_key: var("GEOCOW_API_KEY"),
            public_url: var("GEOCOW_PUBLIC_URL"),
        }
    }
}

/// Work out the origin to hand back, so the link points at the instance that
/// actually holds the payload. A reverse proxy should forward `Host` and
/// `X-Forwarded-Proto` (see deploy/nginx.conf.example). `None` when there is
/// neither a configured origin nor a `Host` header to derive one from.
fn request_origin(headers: &HeaderMap, config: &IngestConfig) -> Option<String> {
    if let Some(url) = &config.public_url {
        return Some(url.clone());
    }
    let host = headers.get("host").and_then(|v| v.to_str().ok())?;
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        // A proxy chain can leave a comma-separated list; the first wins.
        .and_then(|v| v.split(',').next())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("http");
    Some(format!("{scheme}://{host}"))
}

/// Router state: the config plus the share store the URL will point into.
#[derive(Clone)]
pub struct IngestState {
    pub config: IngestConfig,
    pub store: ShareStore,
}

/// Query string: `?from=27700&to=4258`.
#[derive(Debug, Deserialize)]
pub struct IngestQuery {
    /// Source CRS. Omit to auto-detect (lon/lat vs National Grid).
    pub from: Option<u32>,
    /// Target CRS. Only 4258 is useful — it's what the map renders.
    pub to: Option<u32>,
}

/// Success body for `POST /api/geometry`.
#[derive(Debug, Serialize)]
pub struct IngestResponse {
    /// Full URL that displays the geometry. This is the point of the endpoint.
    pub url: String,
    pub id: String,
    pub features: usize,
    pub from: u32,
    pub to: u32,
    /// Whether the geometry was reprojected on the way in.
    pub transformed: bool,
    /// How `from` was arrived at: `"requested"` when `?from=` said so,
    /// `"declared"` when EWKB carried an SRID, `"detected"` when it was read
    /// off the coordinates. Worth surfacing — it's the one decision here the
    /// caller didn't necessarily make explicitly.
    pub source_crs: &'static str,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: String,
}

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (
        status,
        Json(ErrorBody {
            error: message.into(),
        }),
    )
        .into_response()
}

fn geocow_error(err: GeocowError) -> Response {
    use GeocowError::*;
    let status = match err {
        WktParse(_)
        | GeoJsonParse(_)
        | WkbParse(_)
        | InvalidGeometry(_)
        | UnsupportedGeometry(_)
        | UnsupportedCrs(_) => StatusCode::UNPROCESSABLE_ENTITY,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    error(status, err.to_string())
}

/// Compare two secrets without leaking their common prefix through timing.
/// Length is not secret (it shows in the comparison cost either way).
fn secret_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes()
        .zip(b.bytes())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

/// Pull the presented key out of `x-api-key`, or an `Authorization: Bearer`
/// header for clients that only speak OAuth-shaped auth.
fn presented_key(headers: &HeaderMap) -> Option<String> {
    if let Some(v) = headers.get("x-api-key").and_then(|v| v.to_str().ok()) {
        return Some(v.trim().to_string());
    }
    let auth = headers.get("authorization")?.to_str().ok()?;
    auth.strip_prefix("Bearer ")
        .or_else(|| auth.strip_prefix("bearer "))
        .map(|v| v.trim().to_string())
}

fn authorised(headers: &HeaderMap, api_key: &str) -> bool {
    presented_key(headers).is_some_and(|k| secret_eq(&k, api_key))
}

async fn ingest_handler(
    State(state): State<IngestState>,
    Query(q): Query<IngestQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(api_key) = state.config.api_key.as_deref() else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "ingest is disabled on this server: set GEOCOW_API_KEY to enable it",
        );
    };
    if !authorised(&headers, api_key) {
        return error(
            StatusCode::UNAUTHORIZED,
            "missing or invalid API key — send it as `x-api-key`",
        );
    }

    // Settle where the link will point before doing any work, so a request
    // that can't be answered fails fast and stores nothing.
    let Some(origin) = request_origin(&headers, &state.config) else {
        return error(
            StatusCode::BAD_REQUEST,
            "no Host header to build the returned URL from (or set GEOCOW_PUBLIC_URL)",
        );
    };

    if body.is_empty() {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "empty body");
    }

    // Text input is echoed back verbatim when nothing needs reprojecting, so
    // WKT stays WKT in the paste box. WKB has no text form to keep.
    let mut original_text: Option<String> = None;

    // Binary or text? WKB opens with a byte order flag of 0 or 1, which no
    // text format can, so the body speaks for itself and there's no header
    // or flag for the caller to remember.

    let (fc, declared_srid) = if wkb::looks_like_wkb(&body) {
        match wkb::parse_all(&body) {
            Ok(parsed) => (
                io::geometries_to_feature_collection(parsed.geometries),
                parsed.srid,
            ),
            Err(e) => return geocow_error(e),
        }
    } else {
        let input = match std::str::from_utf8(&body) {
            Ok(s) => s.trim(),
            Err(_) => {
                return error(
                    StatusCode::BAD_REQUEST,
                    "body is neither UTF-8 text nor WKB (WKB must start with a \
                     byte order flag of 0x00 or 0x01 — send it with curl's \
                     --data-binary, not -d)",
                );
            }
        };
        if input.is_empty() {
            return error(StatusCode::UNPROCESSABLE_ENTITY, "empty body");
        }
        // The same three shapes the file-drop endpoint accepts: one
        // document, NDJSON, or WKT-per-line.
        match io::parse_lines_to_feature_collection(input) {
            Ok(fc) => {
                original_text = Some(input.to_string());
                (fc, None)
            }
            Err(e) => return geocow_error(e),
        }
    };

    let to = q.to.unwrap_or(4258);
    // Three ways to know the source CRS, best first. EWKB states it outright,
    // so nothing has to be inferred. Otherwise go by where the coordinates
    // are: National Grid eastings and northings look nothing like degrees
    // over the British Isles. Outside both boxes, fall back to the looser
    // "is it even a lon/lat?" test rather than refusing the request.
    let detected = declared_srid.or_else(|| io::detect_crs(&fc));
    let from = q
        .from
        .unwrap_or_else(|| detected.unwrap_or(if io::looks_projected(&fc) { 27700 } else { to }));
    let transformed = from != to;

    // Store what the map should render, so the link doesn't depend on the
    // frontend repeating the same guess.
    let (fc, text) = if transformed {
        let projected = match io::transform_feature_collection(fc, from, to) {
            Ok(fc) => fc,
            Err(e) => return geocow_error(e),
        };
        let text = match serde_json::to_string(&projected) {
            Ok(t) => t,
            Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        };
        (projected, text)
    } else if let Some(text) = original_text {
        // Nothing to reproject: keep the caller's own text, so WKT stays WKT
        // in the paste box rather than coming back as GeoJSON.
        (fc, text)
    } else {
        // WKB in lon/lat already. There's no text to preserve, so serialise
        // the geometry as GeoJSON for the map to pick up.
        let text = match serde_json::to_string(&fc) {
            Ok(t) => t,
            Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        };
        (fc, text)
    };

    let payload = match sharelink::encode_share_payload(&text) {
        Ok(p) => p,
        Err(e) => return geocow_error(e),
    };
    if payload.len() > MAX_SHARE_BYTES {
        return error(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!(
                "geometry is too large to share ({} bytes compressed, limit {MAX_SHARE_BYTES})",
                payload.len()
            ),
        );
    }

    let id = state.store.insert(Bytes::from(payload));
    let url = sharelink::share_id_url(&origin, &id);

    Json(IngestResponse {
        url,
        id,
        features: fc.features.len(),
        from,
        to,
        transformed,
        source_crs: match (q.from.is_some(), declared_srid.is_some()) {
            (true, _) => "requested",
            // EWKB said so itself, rather than it being read off the numbers.
            (false, true) => "declared",
            (false, false) => "detected",
        },
    })
    .into_response()
}

/// Router for the ingest endpoint. Shares the caller's [`ShareStore`] so the
/// URL it returns resolves through the ordinary `/api/share/{id}` path.
pub fn ingest_router(config: IngestConfig, store: ShareStore) -> Router {
    Router::new()
        .route("/api/geometry", post(ingest_handler))
        // The body is raw geometry, which is routinely megabytes.
        .layer(DefaultBodyLimit::max(crate::web::MAX_UPLOAD_BYTES))
        .with_state(IngestState { config, store })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_eq_matches_only_identical_keys() {
        assert!(secret_eq("abc", "abc"));
        assert!(!secret_eq("abc", "abd"));
        assert!(!secret_eq("abc", "abcd"));
        assert!(!secret_eq("", "a"));
        assert!(secret_eq("", ""));
    }

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                v.parse().unwrap(),
            );
        }
        h
    }

    #[test]
    fn reads_the_key_from_either_header() {
        assert_eq!(
            presented_key(&headers(&[("x-api-key", "k1")])).as_deref(),
            Some("k1")
        );
        assert_eq!(
            presented_key(&headers(&[("authorization", "Bearer k2")])).as_deref(),
            Some("k2")
        );
        assert_eq!(presented_key(&headers(&[])), None);
        // A non-bearer Authorization scheme isn't a key.
        assert_eq!(
            presented_key(&headers(&[("authorization", "Basic abc")])),
            None
        );
    }

    #[test]
    fn only_the_configured_key_authorises() {
        assert!(authorised(&headers(&[("x-api-key", "k1")]), "k1"));
        assert!(!authorised(&headers(&[("x-api-key", "nope")]), "k1"));
        assert!(!authorised(&headers(&[]), "k1"));
    }

    fn origin_config(public_url: Option<&str>) -> IngestConfig {
        IngestConfig {
            api_key: Some("k".into()),
            public_url: public_url.map(str::to_string),
        }
    }

    #[test]
    fn origin_follows_the_request_host_by_default() {
        let c = origin_config(None);
        assert_eq!(
            request_origin(&headers(&[("host", "127.0.0.1:8787")]), &c).as_deref(),
            Some("http://127.0.0.1:8787")
        );
        assert_eq!(
            request_origin(
                &headers(&[("host", "maps.example.com"), ("x-forwarded-proto", "https")]),
                &c
            )
            .as_deref(),
            Some("https://maps.example.com")
        );
    }

    #[test]
    fn origin_takes_the_first_proto_in_a_proxy_chain() {
        let c = origin_config(None);
        assert_eq!(
            request_origin(
                &headers(&[
                    ("host", "maps.example.com"),
                    ("x-forwarded-proto", "https, http")
                ]),
                &c
            )
            .as_deref(),
            Some("https://maps.example.com")
        );
    }

    #[test]
    fn an_explicit_public_url_overrides_the_request() {
        let c = origin_config(Some("https://maps.example"));
        assert_eq!(
            request_origin(&headers(&[("host", "127.0.0.1:8787")]), &c).as_deref(),
            Some("https://maps.example")
        );
    }

    #[test]
    fn there_is_no_origin_without_a_host_header_or_public_url() {
        assert_eq!(request_origin(&headers(&[]), &origin_config(None)), None);
    }
}
