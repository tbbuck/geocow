//! In-memory temporary share store for the web tool.
//!
//! Holds at most [`CAPACITY`] recently-shared payloads, each at most
//! [`MAX_SHARE_BYTES`]. Inserting past capacity evicts the oldest entry, so the
//! footprint is hard-bounded at `CAPACITY * MAX_SHARE_BYTES` with no
//! persistence, cleanup job, or database to maintain — that bound is the whole
//! defence against unbounded growth / abuse.
//!
//! Links are deliberately ephemeral: they vanish on server restart and once
//! `CAPACITY` newer links displace them. That is the intended contract, not a
//! limitation — the store exists only to keep share URLs short.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Serialize;
use uuid::Uuid;

/// Most-recent shared payloads kept at once; the oldest is evicted past this.
pub const CAPACITY: usize = 10;

/// Per-payload ceiling. The frontend stores a gzipped payload, so 10 MB is a
/// very large dataset; the raised body limit rejects anything bigger up front.
pub const MAX_SHARE_BYTES: usize = 10 * 1024 * 1024;

/// Thread-safe bounded ring buffer of `(id, payload)`, newest at the back.
#[derive(Clone, Default)]
pub struct ShareStore {
    inner: Arc<Mutex<VecDeque<(String, Bytes)>>>,
}

impl ShareStore {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(VecDeque::with_capacity(CAPACITY))),
        }
    }

    /// Lock the buffer, recovering the guard if a previous holder panicked —
    /// a poisoned share store is not worth taking the process down for.
    fn lock(&self) -> MutexGuard<'_, VecDeque<(String, Bytes)>> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Store `payload` under a fresh id, evicting the oldest if at capacity.
    /// Returns the id. Public so `/api/geometry` can stash a POSTed geometry
    /// in the very same store the browser's Share button uses.
    pub fn insert(&self, payload: Bytes) -> String {
        let id = Uuid::new_v4().to_string();
        let mut q = self.lock();
        if q.len() >= CAPACITY {
            q.pop_front();
        }
        q.push_back((id.clone(), payload));
        id
    }

    /// Fetch a payload by id, if it hasn't been evicted.
    fn get(&self, id: &str) -> Option<Bytes> {
        self.lock()
            .iter()
            .find(|(k, _)| k == id)
            .map(|(_, v)| v.clone())
    }
}

/// Response body for `POST /api/share`.
#[derive(Serialize)]
struct ShareId {
    id: String,
}

/// `POST /api/share` — stash an opaque payload, return its lookup id. The body
/// is the (already-compressed) share blob itself, not a JSON envelope.
async fn create_share(State(store): State<ShareStore>, body: Bytes) -> Response {
    if body.is_empty() {
        return (StatusCode::UNPROCESSABLE_ENTITY, "empty payload").into_response();
    }
    // The body limit below already rejects oversize requests; this is a belt to
    // that braces in case the layer is ever reconfigured.
    if body.len() > MAX_SHARE_BYTES {
        return (StatusCode::PAYLOAD_TOO_LARGE, "payload too large").into_response();
    }
    let id = store.insert(body);
    (StatusCode::OK, Json(ShareId { id })).into_response()
}

/// `GET /api/share/{id}` — return a stored payload, or 404 if it never existed
/// or has since been evicted.
async fn read_share(State(store): State<ShareStore>, Path(id): Path<String>) -> Response {
    match store.get(&id) {
        Some(bytes) => (StatusCode::OK, bytes).into_response(),
        None => (StatusCode::NOT_FOUND, "share not found or expired").into_response(),
    }
}

/// Router for the temporary-share endpoints. The store is passed in rather
/// than owned here, so `/api/geometry` writes into the same one these routes
/// read from.
pub fn share_router(store: ShareStore) -> Router {
    Router::new()
        .route("/api/share", post(create_share))
        .route("/api/share/{id}", get(read_share))
        .layer(DefaultBodyLimit::max(MAX_SHARE_BYTES))
        .with_state(store)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_returns_distinct_ids_and_get_roundtrips() {
        let store = ShareStore::new();
        let a = store.insert(Bytes::from_static(b"alpha"));
        let b = store.insert(Bytes::from_static(b"beta"));
        assert_ne!(a, b);
        assert_eq!(store.get(&a).as_deref(), Some(&b"alpha"[..]));
        assert_eq!(store.get(&b).as_deref(), Some(&b"beta"[..]));
        assert!(store.get("nope").is_none());
    }

    #[test]
    fn insert_past_capacity_evicts_oldest() {
        let store = ShareStore::new();
        let ids: Vec<String> = (0..CAPACITY + 1)
            .map(|i| store.insert(Bytes::from(format!("p{i}"))))
            .collect();
        // The first insert has been pushed out; everything after it survives.
        assert!(store.get(&ids[0]).is_none(), "oldest should be evicted");
        assert_eq!(store.get(&ids[1]).as_deref(), Some(&b"p1"[..]));
        assert_eq!(store.get(&ids[CAPACITY]).as_deref(), Some(&b"p10"[..]));
    }
}
