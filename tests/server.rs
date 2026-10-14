//! Integration tests for the geocow HTTP API.
//!
//! Run with: `cargo test --test server`

#![cfg(feature = "serve")]

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt; // for `oneshot`

/// POST `{"input": input}` to a JSON paste route.
async fn post_json(uri: &str, input: &str) -> (StatusCode, Value) {
    let app = geocow::web::api_router();
    let body = serde_json::json!({ "input": input }).to_string();
    let req = Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body))
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    // An over-limit rejection returns a plain-text body, not JSON.
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, json)
}

async fn post_parse(input: &str) -> (StatusCode, Value) {
    post_json("/api/parse", input).await
}

/// A single GeoJSON MultiPoint of `n` points, offset from `(x0, y0)`.
fn big_multipoint(n: usize, x0: f64, y0: f64) -> String {
    let coords: Vec<String> = (0..n)
        .map(|i| {
            format!(
                "[{},{}]",
                x0 + (i % 1000) as f64 * 0.001,
                y0 + (i / 1000) as f64 * 0.001
            )
        })
        .collect();
    format!(
        r#"{{"type":"MultiPoint","coordinates":[{}]}}"#,
        coords.join(",")
    )
}

#[tokio::test]
async fn health_returns_ok() {
    let app = geocow::web::api_router();
    let req = Request::builder()
        .uri("/api/health")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(&bytes[..], b"ok");
}

async fn get_config(map: geocow::web::MapConfig) -> Value {
    let app = geocow::web::api_router_with(
        geocow::ingest::IngestConfig {
            api_key: None,
            public_url: None,
        },
        map,
    );
    let req = Request::builder()
        .uri("/api/config")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn config_reports_the_map_settings() {
    // The frontend reads its tile keys at runtime, so one build (or Docker
    // image) serves any deployment without baking a key into the bundle.
    let json = get_config(geocow::web::MapConfig {
        maptiler_key: Some("mt-key".into()),
        aerial_tile_url: Some("https://tiles.example.com/{z}/{y}/{x}.jpg".into()),
        aerial_attribution: Some("Imagery © Example".into()),
    })
    .await;
    assert_eq!(
        json,
        serde_json::json!({
            "maptilerKey": "mt-key",
            "aerialTileUrl": "https://tiles.example.com/{z}/{y}/{x}.jpg",
            "aerialAttribution": "Imagery © Example",
        })
    );
}

#[tokio::test]
async fn config_reports_nulls_when_nothing_is_configured() {
    let json = get_config(geocow::web::MapConfig::default()).await;
    assert_eq!(
        json,
        serde_json::json!({
            "maptilerKey": null,
            "aerialTileUrl": null,
            "aerialAttribution": null,
        })
    );
}

#[tokio::test]
async fn parse_wkt_polygon_returns_feature_collection() {
    let (status, json) = post_parse("POLYGON((0 0,1 0,1 1,0 1,0 0))").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["format"], "wkt");
    assert_eq!(json["geojson"]["type"], "FeatureCollection");
    let feats = json["geojson"]["features"].as_array().unwrap();
    assert_eq!(feats.len(), 1);
    assert_eq!(feats[0]["geometry"]["type"], "Polygon");
}

#[tokio::test]
async fn parse_bare_geometry_is_normalised() {
    let (status, json) = post_parse(r#"{"type":"Point","coordinates":[-1.5,52.4]}"#).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["format"], "geojson");
    let feats = json["geojson"]["features"].as_array().unwrap();
    assert_eq!(feats.len(), 1);
    assert_eq!(feats[0]["geometry"]["type"], "Point");
}

#[tokio::test]
async fn parse_feature_collection_preserves_properties() {
    let input = r#"{"type":"FeatureCollection","features":[
        {"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]},"properties":{"name":"a"}},
        {"type":"Feature","geometry":{"type":"Point","coordinates":[3,4]},"properties":{"name":"b"}}
    ]}"#;
    let (status, json) = post_parse(input).await;
    assert_eq!(status, StatusCode::OK);
    let feats = json["geojson"]["features"].as_array().unwrap();
    assert_eq!(feats.len(), 2);
    assert_eq!(feats[1]["properties"]["name"], "b");
}

#[tokio::test]
async fn parse_malformed_input_returns_422() {
    let (status, json) = post_parse("WIBBLE(1 2)").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(json["error"].is_string());
}

#[tokio::test]
async fn parse_empty_input_returns_422() {
    let (status, _json) = post_parse("   ").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn parse_accepts_body_over_the_default_2mib_limit() {
    // A single pasted geometry goes through /api/parse, not /api/parse-file,
    // so the JSON route needs the raised limit too. The envelope escapes
    // every quote, so the wire body is bigger still.
    let n = 150_000;
    let input = big_multipoint(n, -1.5, 52.0);
    assert!(
        input.len() > 2 * 1024 * 1024,
        "test input too small: {}",
        input.len()
    );
    let (status, json) = post_parse(&input).await;
    assert_eq!(status, StatusCode::OK, "large body rejected: {json:?}");
    let coords = json["geojson"]["features"][0]["geometry"]["coordinates"]
        .as_array()
        .unwrap();
    assert_eq!(coords.len(), n);
}

async fn post_transform(input: &str) -> (StatusCode, Value) {
    post_json("/api/transform", input).await
}

#[tokio::test]
async fn transform_accepts_body_over_the_default_2mib_limit() {
    let n = 150_000;
    let input = big_multipoint(n, 400_000.0, 300_000.0);
    assert!(
        input.len() > 2 * 1024 * 1024,
        "test input too small: {}",
        input.len()
    );
    let (status, json) = post_transform(&input).await;
    assert_eq!(status, StatusCode::OK, "large body rejected: {json:?}");
    let coords = json["geojson"]["features"][0]["geometry"]["coordinates"]
        .as_array()
        .unwrap();
    assert_eq!(coords.len(), n);
}

#[tokio::test]
async fn transform_27700_point_to_4258() {
    // TP01 easting/northing -> ETRS89 lon/lat.
    let (status, json) =
        post_transform(r#"{"type":"Point","coordinates":[91492.146,11318.804]}"#).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["from"], 27700);
    assert_eq!(json["to"], 4258);
    let coords = json["geojson"]["features"][0]["geometry"]["coordinates"]
        .as_array()
        .unwrap();
    let lng = coords[0].as_f64().unwrap();
    let lat = coords[1].as_f64().unwrap();
    assert!((lng - (-6.29977752)).abs() < 1e-6, "lng: {lng}");
    assert!((lat - 49.92226394).abs() < 1e-6, "lat: {lat}");
    // The textbox payload is reprojected geometry in the same (geojson) format.
    assert!(json["text"].as_str().unwrap().contains("-6.29977"));
}

// ---------------------------------------------------------------------------
// Raw-body file-upload endpoints
// ---------------------------------------------------------------------------

/// POST a raw text body (no JSON envelope) to a file-upload route.
async fn post_raw(uri: &str, body: String) -> (StatusCode, Value) {
    let app = geocow::web::api_router();
    let req = Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "text/plain")
        .body(Body::from(body))
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    // Some paths (e.g. an over-limit rejection) return a non-JSON body.
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, json)
}

#[tokio::test]
async fn parse_file_ndjson_feature_per_line() {
    let body = [
        r#"{"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]},"properties":{"id":1}}"#,
        r#"{"type":"Feature","geometry":{"type":"Point","coordinates":[3,4]},"properties":{"id":2}}"#,
    ]
    .join("\n");
    let (status, json) = post_raw("/api/parse-file", body).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["format"], "geojson");
    let feats = json["geojson"]["features"].as_array().unwrap();
    assert_eq!(feats.len(), 2);
    assert_eq!(feats[1]["properties"]["id"], 2);
}

#[tokio::test]
async fn parse_file_wkt_per_line() {
    let body = "POINT(1 2)\nLINESTRING(0 0,1 1)\nPOLYGON((0 0,1 0,1 1,0 1,0 0))".to_string();
    let (status, json) = post_raw("/api/parse-file", body).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["format"], "wkt");
    let feats = json["geojson"]["features"].as_array().unwrap();
    assert_eq!(feats.len(), 3);
    assert_eq!(feats[2]["geometry"]["type"], "Polygon");
}

#[tokio::test]
async fn parse_file_single_featurecollection() {
    let body = r#"{"type":"FeatureCollection","features":[
        {"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]},"properties":{}}
    ]}"#
    .to_string();
    let (status, json) = post_raw("/api/parse-file", body).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["geojson"]["features"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn parse_file_bad_line_reports_line_number() {
    let body = "POINT(1 2)\nWIBBLE(9 9)".to_string();
    let (status, json) = post_raw("/api/parse-file", body).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(json["error"].as_str().unwrap().contains("line 2"));
}

#[tokio::test]
async fn parse_file_accepts_body_over_the_default_2mib_limit() {
    // A body larger than axum's 2 MiB default must be accepted — proving the
    // raised limit is wired. ~6 MiB of NDJSON points.
    let mut body = String::with_capacity(7 * 1024 * 1024);
    let n = 90_000;
    for i in 0..n {
        body.push_str(&format!(
            "{{\"type\":\"Point\",\"coordinates\":[{},{}]}}\n",
            (i % 100) as f64 * 0.01,
            50.0 + (i % 50) as f64 * 0.01,
        ));
    }
    assert!(
        body.len() > 2 * 1024 * 1024,
        "test body too small: {}",
        body.len()
    );
    let (status, json) = post_raw("/api/parse-file", body).await;
    assert_eq!(status, StatusCode::OK, "large body rejected: {json:?}");
    assert_eq!(json["geojson"]["features"].as_array().unwrap().len(), n);
}

#[tokio::test]
async fn transform_file_reprojects_ndjson() {
    // Two TP-style OSGB points, NDJSON, reprojected 27700 -> 4258 by default.
    let body = [
        r#"{"type":"Point","coordinates":[91492.146,11318.804]}"#,
        r#"{"type":"Point","coordinates":[91492.146,11318.804]}"#,
    ]
    .join("\n");
    let (status, json) = post_raw("/api/transform-file", body).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["from"], 27700);
    assert_eq!(json["to"], 4258);
    let coords = json["geojson"]["features"][0]["geometry"]["coordinates"]
        .as_array()
        .unwrap();
    assert!((coords[0].as_f64().unwrap() - (-6.29977752)).abs() < 1e-6);
    assert!((coords[1].as_f64().unwrap() - 49.92226394).abs() < 1e-6);
}

#[tokio::test]
async fn transform_file_honours_query_params() {
    // from==to is an identity transform; proves the query string is read.
    let body = r#"{"type":"Point","coordinates":[-1.5,52.4]}"#.to_string();
    let (status, json) = post_raw("/api/transform-file?from=4258&to=4258", body).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["from"], 4258);
    assert_eq!(json["to"], 4258);
    let coords = json["geojson"]["features"][0]["geometry"]["coordinates"]
        .as_array()
        .unwrap();
    assert!((coords[0].as_f64().unwrap() - (-1.5)).abs() < 1e-9);
}

#[tokio::test]
async fn parse_file_empty_body_returns_422() {
    let (status, _json) = post_raw("/api/parse-file", "   \n".to_string()).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

// ---------------------------------------------------------------------------
// Temporary share store (POST /api/share, GET /api/share/{id})
// ---------------------------------------------------------------------------

/// POST a raw payload to `/api/share` on the given router, returning its id.
async fn post_share(app: &Router, payload: &str) -> String {
    let req = Request::builder()
        .method("POST")
        .uri("/api/share")
        .header("content-type", "text/plain")
        .body(Body::from(payload.to_owned()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json: Value = serde_json::from_slice(&bytes).unwrap();
    json["id"].as_str().unwrap().to_string()
}

/// GET `/api/share/{id}`, returning the status and raw body bytes.
async fn get_share(app: &Router, id: &str) -> (StatusCode, Vec<u8>) {
    let req = Request::builder()
        .uri(format!("/api/share/{id}"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (status, bytes.to_vec())
}

#[tokio::test]
async fn share_roundtrips_the_payload() {
    let app = geocow::web::api_router();
    let payload = "gzipped-share-blob-\u{1f42e}"; // opaque bytes, incl. non-ascii
    let id = post_share(&app, payload).await;
    let (status, body) = get_share(&app, &id).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, payload.as_bytes());
}

#[tokio::test]
async fn share_unknown_id_returns_404() {
    let app = geocow::web::api_router();
    let (status, _) = get_share(&app, "00000000-0000-0000-0000-000000000000").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn share_empty_body_returns_422() {
    let app = geocow::web::api_router();
    let req = Request::builder()
        .method("POST")
        .uri("/api/share")
        .header("content-type", "text/plain")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn share_evicts_oldest_past_capacity() {
    // Capacity is 10; the 11th share must push the first out.
    let app = geocow::web::api_router();
    let mut ids = Vec::new();
    for i in 0..11 {
        ids.push(post_share(&app, &format!("payload-{i}")).await);
    }
    let (first, _) = get_share(&app, &ids[0]).await;
    assert_eq!(
        first,
        StatusCode::NOT_FOUND,
        "oldest share should be evicted"
    );
    let (newest, body) = get_share(&app, &ids[10]).await;
    assert_eq!(newest, StatusCode::OK);
    assert_eq!(body, b"payload-10");
}

// ---------------------------------------------------------------------------
// Geometry ingest (POST /api/geometry)
// ---------------------------------------------------------------------------

const TEST_KEY: &str = "test-key-!@#";
const TEST_ORIGIN: &str = "https://geocow.example";

/// A router whose ingest settings are fixed, so these tests never depend on
/// the environment.
fn ingest_app() -> Router {
    geocow::web::api_router_with(
        geocow::ingest::IngestConfig {
            api_key: Some(TEST_KEY.into()),
            public_url: Some(TEST_ORIGIN.into()),
        },
        geocow::web::MapConfig::default(),
    )
}

/// A router that derives the returned origin from the request, as production
/// does.
fn host_derived_app() -> Router {
    geocow::web::api_router_with(
        geocow::ingest::IngestConfig {
            api_key: Some(TEST_KEY.into()),
            public_url: None,
        },
        geocow::web::MapConfig::default(),
    )
}

/// A router with no API key configured: ingest must refuse everyone.
fn keyless_app() -> Router {
    geocow::web::api_router_with(
        geocow::ingest::IngestConfig {
            api_key: None,
            public_url: Some(TEST_ORIGIN.into()),
        },
        geocow::web::MapConfig::default(),
    )
}

/// POST a body to `/api/geometry`, returning the status and parsed JSON.
/// `auth` is the full header pair to send, or None for an anonymous request.
async fn post_geometry(
    app: &Router,
    query: &str,
    auth: Option<(&str, &str)>,
    body: &str,
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method("POST")
        .uri(format!("/api/geometry{query}"))
        .header("content-type", "text/plain");
    if let Some((name, value)) = auth {
        req = req.header(name, value);
    }
    let resp = app
        .clone()
        .oneshot(req.body(Body::from(body.to_owned())).unwrap())
        .await
        .unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json: Value = serde_json::from_slice(&bytes).unwrap();
    (status, json)
}

/// The happy path: POST with the right key, returning the JSON body.
async fn ingest(app: &Router, query: &str, body: &str) -> Value {
    let (status, json) = post_geometry(app, query, Some(("x-api-key", TEST_KEY)), body).await;
    assert_eq!(status, StatusCode::OK, "ingest failed: {json}");
    json
}

/// Follow a returned id through the share store and unpack the payload,
/// exactly as the browser does on opening the link.
async fn stored_text(app: &Router, id: &str) -> String {
    let (status, body) = get_share(app, id).await;
    assert_eq!(status, StatusCode::OK, "share {id} should exist");
    let payload = String::from_utf8(body).unwrap();
    geocow::sharelink::decode_share_payload(&payload).unwrap()
}

#[tokio::test]
async fn geometry_without_a_key_is_rejected() {
    let (status, json) = post_geometry(&ingest_app(), "", None, "POINT(-1.5 52.4)").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(json["error"].is_string());
}

#[tokio::test]
async fn geometry_is_disabled_when_no_key_is_configured() {
    // Fail closed: there is no built-in key, so an unconfigured server must
    // not accept writes from anyone — whatever they present.
    for auth in [None, Some(("x-api-key", "")), Some(("x-api-key", TEST_KEY))] {
        let (status, json) = post_geometry(&keyless_app(), "", auth, "POINT(-1.5 52.4)").await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(
            json["error"].as_str().unwrap().contains("GEOCOW_API_KEY"),
            "error should say how to enable ingest: {json}"
        );
    }
}

#[tokio::test]
async fn geometry_without_an_origin_to_link_to_is_a_bad_request() {
    // No GEOCOW_PUBLIC_URL and no Host header: there is nothing honest to
    // put in the returned URL, so refuse rather than invent an origin.
    let (status, json) = post_geometry(
        &host_derived_app(),
        "",
        Some(("x-api-key", TEST_KEY)),
        "POINT(-1.5 52.4)",
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(json["error"].as_str().unwrap().contains("Host"), "{json}");
}

#[tokio::test]
async fn geometry_with_a_wrong_key_is_rejected() {
    let (status, _) = post_geometry(
        &ingest_app(),
        "",
        Some(("x-api-key", "not-the-key")),
        "POINT(-1.5 52.4)",
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn geometry_accepts_a_bearer_token() {
    let (status, _) = post_geometry(
        &ingest_app(),
        "",
        Some(("authorization", &format!("Bearer {TEST_KEY}"))),
        "POINT(-1.5 52.4)",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn geometry_returns_a_url_on_the_configured_origin() {
    let json = ingest(&ingest_app(), "", "POINT(-1.5 52.4)").await;
    let url = json["url"].as_str().unwrap();
    let id = json["id"].as_str().unwrap();
    assert_eq!(url, format!("{TEST_ORIGIN}/#s={id}"));
    assert_eq!(json["features"], 1);
}

#[tokio::test]
async fn geometry_url_follows_the_host_it_was_posted_to() {
    // The payload lives on the instance that received the POST, so the link
    // has to point back at that instance — not at a baked-in origin.
    let app = host_derived_app();
    let req = Request::builder()
        .method("POST")
        .uri("/api/geometry")
        .header("x-api-key", TEST_KEY)
        .header("host", "localhost:8787")
        .body(Body::from("POINT(-1.5 52.4)"))
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json: Value = serde_json::from_slice(&bytes).unwrap();
    let url = json["url"].as_str().unwrap();
    assert!(
        url.starts_with("http://localhost:8787/#s="),
        "url was {url}"
    );
}

#[tokio::test]
async fn geometry_url_honours_forwarded_https() {
    let app = host_derived_app();
    let req = Request::builder()
        .method("POST")
        .uri("/api/geometry")
        .header("x-api-key", TEST_KEY)
        .header("host", "maps.example.com")
        .header("x-forwarded-proto", "https")
        .body(Body::from("POINT(-1.5 52.4)"))
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json: Value = serde_json::from_slice(&bytes).unwrap();
    let url = json["url"].as_str().unwrap();
    assert!(
        url.starts_with("https://maps.example.com/#s="),
        "url was {url}"
    );
}

#[tokio::test]
async fn geometry_is_retrievable_through_the_share_store() {
    let app = ingest_app();
    let json = ingest(&app, "", "POINT(-1.5 52.4)").await;
    let text = stored_text(&app, json["id"].as_str().unwrap()).await;
    // Unprojected input is stored verbatim, so WKT stays WKT in the box.
    assert_eq!(text, "POINT(-1.5 52.4)");
    assert_eq!(json["transformed"], false);
    assert_eq!(json["from"], 4258);
    assert_eq!(json["to"], 4258);
}

#[tokio::test]
async fn geometry_reprojects_national_grid_input() {
    let app = ingest_app();
    // TP01's National Grid coordinates; ETRS89 is ~49.92 N, 6.30 W.
    let json = ingest(&app, "", "POINT(91492.146 11318.804)").await;
    assert_eq!(json["from"], 27700);
    assert_eq!(json["to"], 4258);
    assert_eq!(json["transformed"], true);

    let text = stored_text(&app, json["id"].as_str().unwrap()).await;
    let fc: Value = serde_json::from_str(&text).unwrap();
    let coords = &fc["features"][0]["geometry"]["coordinates"];
    let (lon, lat) = (coords[0].as_f64().unwrap(), coords[1].as_f64().unwrap());
    assert!((lon - -6.29977752).abs() < 1e-6, "lon was {lon}");
    assert!((lat - 49.92226394).abs() < 1e-6, "lat was {lat}");
}

#[tokio::test]
async fn geometry_honours_an_explicit_source_crs() {
    // These coordinates look like lon/lat, so only an explicit ?from can make
    // the server treat them as National Grid.
    let app = ingest_app();
    let json = ingest(&app, "?from=27700", "POINT(1 2)").await;
    assert_eq!(json["from"], 27700);
    assert_eq!(json["transformed"], true);
    assert_eq!(json["source_crs"], "requested");
}

#[tokio::test]
async fn geometry_detects_the_source_crs_from_the_coordinates() {
    let app = ingest_app();

    let grid = ingest(&app, "", "POINT(434115.776 278114.072)").await;
    assert_eq!(grid["from"], 27700);
    assert_eq!(grid["source_crs"], "detected");

    let degrees = ingest(&app, "", "POINT(-1.5 52.4)").await;
    assert_eq!(degrees["from"], 4258);
    assert_eq!(degrees["transformed"], false);

    // An easting small enough to pass for a longitude, which the plain
    // lon/lat-range check would misread. The northing gives it away.
    let low = ingest(&app, "", "POINT(2.5 500000.0)").await;
    assert_eq!(low["from"], 27700);
    assert_eq!(low["transformed"], true);
}

#[tokio::test]
async fn geometry_accepts_wkt_per_line_and_ndjson() {
    let app = ingest_app();
    let wkt = ingest(
        &app,
        "",
        "POINT(-1.5 52.4)\nPOINT(-1.4 52.5)\nPOINT(-1.3 52.6)",
    )
    .await;
    assert_eq!(wkt["features"], 3);

    let nd = ingest(
        &app,
        "",
        "{\"type\":\"Point\",\"coordinates\":[-1.5,52.4]}\n{\"type\":\"Point\",\"coordinates\":[-1.4,52.5]}",
    )
    .await;
    assert_eq!(nd["features"], 2);
}

#[tokio::test]
async fn geometry_preserves_feature_properties() {
    let app = ingest_app();
    let input = r#"{"type":"FeatureCollection","features":[
        {"type":"Feature","geometry":{"type":"Point","coordinates":[91492.146,11318.804]},"properties":{"name":"TP01"}}
    ]}"#;
    let json = ingest(&app, "", input).await;
    assert_eq!(json["transformed"], true);
    let text = stored_text(&app, json["id"].as_str().unwrap()).await;
    let fc: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(fc["features"][0]["properties"]["name"], "TP01");
}

// ---------------------------------------------------------------------------
// WKB ingest — raw bytes, as curl's --data-binary sends them
// ---------------------------------------------------------------------------

/// Decode hex into the bytes a client would actually put on the wire.
fn wkb(hex: &str) -> Vec<u8> {
    let clean: String = hex.chars().filter(|c| !c.is_whitespace()).collect();
    (0..clean.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&clean[i..i + 2], 16).unwrap())
        .collect()
}

/// POST raw bytes with the right key, returning the parsed JSON body.
async fn post_bytes(app: &Router, query: &str, body: Vec<u8>) -> (StatusCode, Value) {
    let req = Request::builder()
        .method("POST")
        .uri(format!("/api/geometry{query}"))
        .header("x-api-key", TEST_KEY)
        .header("content-type", "application/octet-stream")
        .body(Body::from(body))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn geometry_accepts_raw_wkb() {
    let app = ingest_app();
    // POINT(-1.5 52.4), little-endian OGC WKB.
    let (status, json) = post_bytes(
        &app,
        "",
        wkb("0101000000 000000000000F8BF 3333333333334A40"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{json}");
    assert_eq!(json["features"], 1);
    assert_eq!(json["from"], 4258);
    assert_eq!(json["source_crs"], "detected");

    let text = stored_text(&app, json["id"].as_str().unwrap()).await;
    let fc: Value = serde_json::from_str(&text).unwrap();
    let coords = &fc["features"][0]["geometry"]["coordinates"];
    assert_eq!(coords[0].as_f64().unwrap(), -1.5);
    assert_eq!(coords[1].as_f64().unwrap(), 52.4);
}

#[tokio::test]
async fn geometry_accepts_big_endian_wkb() {
    let app = ingest_app();
    let (status, json) = post_bytes(
        &app,
        "",
        wkb("00 00000001 BFF8000000000000 404A333333333333"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{json}");
    assert_eq!(json["features"], 1);
}

// EWKB states its own SRID, which beats reading the CRS off the coordinates.
#[tokio::test]
async fn geometry_uses_the_srid_ewkb_declares() {
    let app = ingest_app();
    // SRID=27700 (0x6C34); POINT(434115.77580714034 278114.07152933464),
    // which is POINT(-1.5 52.4) in ETRS89 put through OSTN15.
    let (status, json) = post_bytes(
        &app,
        "",
        wkb("0101000020 346C0000 DF2F6D1A0F7F1A41 64FC3E4988F91041"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{json}");
    assert_eq!(json["from"], 27700);
    assert_eq!(json["to"], 4258);
    assert_eq!(json["transformed"], true);
    assert_eq!(json["source_crs"], "declared");

    // Reprojected through OSTN15 to somewhere in the Midlands.
    let text = stored_text(&app, json["id"].as_str().unwrap()).await;
    let fc: Value = serde_json::from_str(&text).unwrap();
    let coords = &fc["features"][0]["geometry"]["coordinates"];
    let (lon, lat) = (coords[0].as_f64().unwrap(), coords[1].as_f64().unwrap());
    assert!((lon - -1.5).abs() < 0.001, "lon was {lon}");
    assert!((lat - 52.4).abs() < 0.001, "lat was {lat}");
}

// An SRID geocow can't transform must say so rather than quietly plot the
// numbers as if they were ETRS89.
#[tokio::test]
async fn geometry_rejects_an_srid_it_cannot_transform() {
    let app = ingest_app();
    // SRID=4326 (0x10E6), POINT(1 2).
    let (status, json) = post_bytes(
        &app,
        "",
        wkb("0101000020 E6100000 000000000000F03F 0000000000000040"),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(
        json["error"].as_str().unwrap().contains("4326"),
        "error should name the CRS: {json}"
    );
}

#[tokio::test]
async fn geometry_accepts_concatenated_wkb() {
    let app = ingest_app();
    // POINT(-1.5 52.4) then POINT(-1.4 52.5), back to back.
    let mut body = wkb("0101000000 000000000000F8BF 3333333333334A40");
    body.extend(wkb("0101000000 666666666666F6BF 0000000000404A40"));
    let (status, json) = post_bytes(&app, "", body).await;
    assert_eq!(status, StatusCode::OK, "{json}");
    assert_eq!(json["features"], 2);
}

#[tokio::test]
async fn geometry_accepts_a_wkb_polygon() {
    let app = ingest_app();
    // POLYGON((0 0,1 0,1 1,0 1,0 0)) — one ring, five points.
    let (status, json) = post_bytes(
        &app,
        "",
        wkb("0103000000 01000000 05000000 \
             0000000000000000 0000000000000000 \
             000000000000F03F 0000000000000000 \
             000000000000F03F 000000000000F03F \
             0000000000000000 000000000000F03F \
             0000000000000000 0000000000000000"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{json}");
    let text = stored_text(&app, json["id"].as_str().unwrap()).await;
    assert!(text.contains("Polygon"), "got: {text}");
}

#[tokio::test]
async fn geometry_rejects_malformed_wkb() {
    let app = ingest_app();
    // A point whose y ordinate was cut off.
    let (status, json) = post_bytes(&app, "", wkb("0101000000 000000000000F8BF")).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(
        json["error"].as_str().unwrap().contains("WKB"),
        "error should say it was reading WKB: {json}"
    );
}

// Bytes that are neither WKB nor text shouldn't come back as a UTF-8
// complaint with no hint about what to do.
#[tokio::test]
async fn geometry_explains_an_unrecognisable_binary_body() {
    let app = ingest_app();
    let (status, json) = post_bytes(&app, "", vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        json["error"].as_str().unwrap().contains("--data-binary"),
        "error should hint at how to send WKB: {json}"
    );
}

#[tokio::test]
async fn geometry_rejects_malformed_input() {
    let (status, json) = post_geometry(
        &ingest_app(),
        "",
        Some(("x-api-key", TEST_KEY)),
        "WIBBLE(1 2)",
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(json["error"].is_string());
}

#[tokio::test]
async fn geometry_rejects_an_empty_body() {
    let (status, _) =
        post_geometry(&ingest_app(), "", Some(("x-api-key", TEST_KEY)), "   \n ").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn share_rejects_payload_over_the_limit() {
    // One byte past the 10 MB ceiling must be rejected by the body limit.
    let app = geocow::web::api_router();
    let big = vec![b'a'; 10 * 1024 * 1024 + 1];
    let req = Request::builder()
        .method("POST")
        .uri("/api/share")
        .header("content-type", "text/plain")
        .body(Body::from(big))
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
}
