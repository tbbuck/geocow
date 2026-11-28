//! On-disk temporary share store for the web tool.
//!
//! Holds at most [`CAPACITY`] recently-shared payloads, each at most the
//! store's `max_bytes` ([`DEFAULT_MAX_SHARE_BYTES`] unless `serve` is given
//! `--max-share-bytes` / `GEOCOW_MAX_SHARE_BYTES`), one file per payload.
//! Inserting past capacity deletes the oldest file, so the footprint is
//! hard-bounded at `CAPACITY * max_bytes` (plus uploads in flight) with no
//! cleanup job or database to maintain — that bound is the whole defence
//! against unbounded growth / abuse.
//!
//! Links are deliberately ephemeral: they vanish on server restart and once
//! `CAPACITY` newer links displace them. That is the intended contract, not a
//! limitation — the store exists only to keep share URLs short. Disk rather
//! than memory only so reads stream from a file instead of a heap copy.
//!
//! Safety rules the code below keeps:
//! - Ids are server-issued UUIDs, and a lookup must parse as one *and* be in
//!   the index before any path is built, so a request can't name a file.
//! - Files are written under a `.tmp` name and renamed into place, so a
//!   reader never sees half a payload.
//! - The index lock is never held across file I/O.
//! - Startup wipes only files named like shares, never recursing and never
//!   removing the directory, so a mis-set `GEOCOW_SHARE_DIR` loses nothing
//!   that isn't ours.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{self, DefaultBodyLimit, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Serialize;
use tower_http::services::ServeFile;
use uuid::Uuid;

use crate::error::GeocowError;

/// Most-recent shared payloads kept at once; the oldest is evicted past this.
pub const CAPACITY: usize = 10;

/// Default per-payload ceiling. The frontend stores a gzipped payload, so
/// 10 MB is a very large dataset; the body limit rejects anything bigger up
/// front.
pub const DEFAULT_MAX_SHARE_BYTES: usize = 10 * 1024 * 1024;

/// Suffix of a payload still being written.
const TMP_SUFFIX: &str = ".tmp";

/// Bounded, file-backed store of share payloads. Cheap to clone: clones share
/// one directory and index.
#[derive(Clone)]
pub struct ShareStore {
    inner: Arc<Inner>,
}

struct Inner {
    dir: PathBuf,
    /// Remove `dir` itself when the last clone goes: true only for a
    /// directory the store created for itself.
    owns_dir: bool,
    max_bytes: usize,
    /// Ids currently held, oldest at the front.
    ids: Mutex<VecDeque<Uuid>>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        if self.owns_dir
            && let Err(e) = std::fs::remove_dir_all(&self.dir)
        {
            tracing::warn!("could not remove share directory {:?}: {e}", self.dir);
        }
    }
}

impl ShareStore {
    /// Use `dir` (created if missing) for payloads, first deleting any shares
    /// a previous run left there. The directory itself is left in place.
    pub fn open(dir: impl Into<PathBuf>, max_bytes: usize) -> Result<Self, GeocowError> {
        let dir = dir.into();
        std::fs::create_dir_all(&dir)?;
        let wiped = wipe_shares(&dir)?;
        if wiped > 0 {
            tracing::info!("removed {wiped} share(s) left in {dir:?} by a previous run");
        }
        Ok(Self::with_dir(dir, false, max_bytes))
    }

    /// Use a fresh directory under the system temp dir, readable only by this
    /// user and removed when the last clone of the store is dropped.
    pub fn temporary(max_bytes: usize) -> Result<Self, GeocowError> {
        let dir = std::env::temp_dir().join(format!("geocow-shares-{}", Uuid::new_v4()));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        // `create`, not `create_dir_all`: never adopt a directory someone
        // else made first.
        builder.create(&dir)?;
        Ok(Self::with_dir(dir, true, max_bytes))
    }

    fn with_dir(dir: PathBuf, owns_dir: bool, max_bytes: usize) -> Self {
        Self {
            inner: Arc::new(Inner {
                dir,
                owns_dir,
                max_bytes,
                ids: Mutex::new(VecDeque::with_capacity(CAPACITY + 1)),
            }),
        }
    }

    /// Where the payloads live.
    pub fn dir(&self) -> &Path {
        &self.inner.dir
    }

    /// Per-payload ceiling. Every writer checks against this one value, so the
    /// browser's Share button and `/api/geometry` can't disagree.
    pub fn max_bytes(&self) -> usize {
        self.inner.max_bytes
    }

    /// Lock the index, recovering the guard if a previous holder panicked —
    /// a poisoned share store is not worth taking the process down for.
    fn lock(&self) -> MutexGuard<'_, VecDeque<Uuid>> {
        self.inner.ids.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn file(&self, id: Uuid) -> PathBuf {
        self.inner.dir.join(id.to_string())
    }

    /// Store `payload` under a fresh id, deleting the oldest payload if that
    /// takes the store past capacity. Returns the id. Public so
    /// `/api/geometry` can stash a POSTed geometry in the very same store the
    /// browser's Share button uses.
    pub async fn insert(&self, payload: Bytes) -> Result<String, GeocowError> {
        let id = Uuid::new_v4();
        let path = self.file(id);
        let tmp = self.inner.dir.join(format!("{id}{TMP_SUFFIX}"));

        let written = async {
            tokio::fs::write(&tmp, &payload).await?;
            tokio::fs::rename(&tmp, &path).await
        }
        .await;
        if let Err(e) = written {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(e.into());
        }

        let evicted = {
            let mut ids = self.lock();
            ids.push_back(id);
            if ids.len() > CAPACITY {
                ids.pop_front()
            } else {
                None
            }
        };
        if let Some(old) = evicted {
            // Already out of the index, so it can't be served; a failure here
            // only leaves a file for the next startup to wipe.
            if let Err(e) = tokio::fs::remove_file(self.file(old)).await
                && e.kind() != std::io::ErrorKind::NotFound
            {
                tracing::warn!("could not delete evicted share {old}: {e}");
            }
        }
        Ok(id.to_string())
    }

    /// The file for `id`, if `id` is a UUID this store issued and still holds.
    /// Nothing from the request reaches the path except a parsed UUID.
    fn path_of(&self, id: &str) -> Option<PathBuf> {
        let id = Uuid::try_parse(id).ok()?;
        self.lock().contains(&id).then(|| self.file(id))
    }
}

/// Delete regular files in `dir` named `<uuid>` or `<uuid>.tmp`; leave
/// everything else alone. Returns how many went.
fn wipe_shares(dir: &Path) -> Result<usize, GeocowError> {
    let mut removed = 0;
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        // `DirEntry::file_type` doesn't follow symlinks, so a link is skipped
        // rather than its target judged.
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let stem = name.strip_suffix(TMP_SUFFIX).unwrap_or(name);
        if Uuid::try_parse(stem).is_ok() {
            std::fs::remove_file(entry.path())?;
            removed += 1;
        }
    }
    Ok(removed)
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
    if body.len() > store.max_bytes() {
        return (StatusCode::PAYLOAD_TOO_LARGE, "payload too large").into_response();
    }
    match store.insert(body).await {
        Ok(id) => (StatusCode::OK, Json(ShareId { id })).into_response(),
        Err(e) => {
            tracing::error!("could not store a share: {e}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "could not store the share",
            )
                .into_response()
        }
    }
}

/// `GET /api/share/{id}` — stream a stored payload from disk, or 404 if it
/// never existed or has since been evicted.
async fn read_share(
    State(store): State<ShareStore>,
    extract::Path(id): extract::Path<String>,
    req: Request,
) -> Response {
    let Some(path) = store.path_of(&id) else {
        return (StatusCode::NOT_FOUND, "share not found or expired").into_response();
    };
    // Evicted between the lookup and the open: ServeFile answers 404 itself.
    match ServeFile::new(path).try_call(req).await {
        Ok(resp) => resp.map(Body::new),
        Err(e) => {
            tracing::error!("could not read share {id}: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// `POST /api/share`, split from the read route so the server can put it
/// under the upload concurrency limit. The store is passed in rather than
/// owned here, so `/api/geometry` writes into the same one.
pub fn share_upload_router(store: ShareStore) -> Router {
    Router::new()
        .route("/api/share", post(create_share))
        .layer(DefaultBodyLimit::max(store.max_bytes()))
        .with_state(store)
}

/// `GET /api/share/{id}`.
pub fn share_read_router(store: ShareStore) -> Router {
    Router::new()
        .route("/api/share/{id}", get(read_share))
        .with_state(store)
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::Path;

    fn temp_store() -> ShareStore {
        ShareStore::temporary(DEFAULT_MAX_SHARE_BYTES).unwrap()
    }

    fn files_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    async fn read(store: &ShareStore, id: &str) -> Option<Vec<u8>> {
        tokio::fs::read(store.path_of(id)?).await.ok()
    }

    /// A fresh, not-yet-existing directory under the system temp dir.
    fn scratch_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("geocow-{label}-{}", Uuid::new_v4()))
    }

    #[tokio::test]
    async fn insert_writes_to_disk_and_reads_back() {
        let store = temp_store();
        let a = store.insert(Bytes::from_static(b"alpha")).await.unwrap();
        let b = store.insert(Bytes::from_static(b"beta")).await.unwrap();
        assert_ne!(a, b);
        assert_eq!(read(&store, &a).await.as_deref(), Some(&b"alpha"[..]));
        assert_eq!(read(&store, &b).await.as_deref(), Some(&b"beta"[..]));
        // Only the final files: no temp files left behind.
        let mut expected = vec![a, b];
        expected.sort();
        assert_eq!(files_in(store.dir()), expected);
    }

    #[tokio::test]
    async fn eviction_deletes_the_oldest_file() {
        let store = temp_store();
        let mut ids = Vec::new();
        for i in 0..CAPACITY + 1 {
            ids.push(store.insert(Bytes::from(format!("p{i}"))).await.unwrap());
        }
        assert!(store.path_of(&ids[0]).is_none(), "oldest should be evicted");
        assert!(
            !store.dir().join(&ids[0]).exists(),
            "an evicted payload should be deleted from disk"
        );
        assert_eq!(files_in(store.dir()).len(), CAPACITY);
        assert_eq!(read(&store, &ids[1]).await.as_deref(), Some(&b"p1"[..]));
        assert_eq!(
            read(&store, &ids[CAPACITY]).await.as_deref(),
            Some(&b"p10"[..])
        );
    }

    #[test]
    fn only_ids_the_store_issued_resolve_to_a_path() {
        let store = temp_store();
        // A uuid-named file the store never issued must not be served.
        let stray = Uuid::new_v4().to_string();
        std::fs::write(store.dir().join(&stray), "x").unwrap();
        for id in [
            stray.as_str(),
            "../../etc/passwd",
            "..",
            "",
            "a/b",
            "not-a-uuid",
        ] {
            assert!(store.path_of(id).is_none(), "{id:?} must not resolve");
        }
    }

    #[test]
    fn opening_a_directory_wipes_old_shares_and_nothing_else() {
        let dir = scratch_dir("open");
        std::fs::create_dir_all(dir.join("subdir")).unwrap();
        let old = Uuid::new_v4().to_string();
        std::fs::write(dir.join(&old), "old").unwrap();
        std::fs::write(dir.join(format!("{old}.tmp")), "half-written").unwrap();
        std::fs::write(dir.join("notes.txt"), "not ours").unwrap();

        let store = ShareStore::open(&dir, DEFAULT_MAX_SHARE_BYTES).unwrap();
        assert_eq!(files_in(&dir), vec!["notes.txt", "subdir"]);
        assert!(store.path_of(&old).is_none());

        // An explicit directory belongs to the operator: it outlives the store.
        drop(store);
        assert!(dir.is_dir());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn opening_creates_a_missing_directory() {
        let dir = scratch_dir("create").join("nested");
        let store = ShareStore::open(&dir, DEFAULT_MAX_SHARE_BYTES).unwrap();
        assert!(dir.is_dir());
        drop(store);
        std::fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_temporary_store_removes_its_directory_with_the_last_clone() {
        let store = temp_store();
        let dir = store.dir().to_path_buf();
        let clone = store.clone();
        drop(store);
        assert!(dir.is_dir(), "a live clone keeps the directory");
        drop(clone);
        assert!(!dir.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_temporary_store_is_private_to_its_user() {
        use std::os::unix::fs::PermissionsExt;
        let store = temp_store();
        let mode = std::fs::metadata(store.dir()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }
}
