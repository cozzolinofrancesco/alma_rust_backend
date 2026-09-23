//! File-backed, JSON-persisted [`DocumentCollectionPort`] adapter.
//!
//! This mirrors the CRUD semantics of the hermetic
//! [`InMemoryDocumentCollectionStore`](crate::document_collection::InMemoryDocumentCollectionStore)
//! (its logic is the port-from reference for this unit) but persists the whole
//! store to a single JSON file so state survives process restarts — the
//! durability the plan requires for agents/runs/reports/corpora (plan Phase 1c).
//!
//! Design notes:
//! - **Single JSON file, whole-store snapshot.** The plan deliberately chose a
//!   file-backed JSON store over SQLite (no C build toolchain). Because usage is
//!   single-user/local and the corpus of documents is small, serializing the
//!   entire store on each mutation is simple and robust, and it sidesteps
//!   collection-name-to-filename sanitization entirely.
//! - **Load-on-boot.** [`FileBackedDocumentCollectionStore::load_from_directory`]
//!   reads the snapshot (if present) into an in-memory cache; all reads are then
//!   served from that cache and all writes update the cache and re-persist.
//! - **Atomic write.** Each persist writes to a sibling temp file and then
//!   `rename`s it over the target, so a crash mid-write can never leave a
//!   half-written (unparseable) store on disk.
//! - **Revision counter (plan C9).** A monotonically increasing `revision` is
//!   bumped on every mutation and persisted with the snapshot. The port trait
//!   carries no etag, so this counter is the store's "checkpoint safety" signal:
//!   callers coordinating concurrent `runs/advance` writes can observe it via
//!   [`FileBackedDocumentCollectionStore::current_revision`] to detect that the
//!   store changed underneath them.
//!
//! A `tokio::sync::Mutex` guards the state so the mutate-then-persist sequence is
//! held across the `.await` on the file write, keeping the in-memory cache and
//! the on-disk snapshot from interleaving out of order.

use alma_application::error::ApplicationError;
use alma_application::ports::document_collection::{DocumentCollectionPort, StoredDocument};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::sync::Mutex;

/// Name of the JSON snapshot file inside the configured data directory.
const STORE_SNAPSHOT_FILE_NAME: &str = "document_store.json";
/// Name of the sibling temp file used for the atomic write-then-rename.
const STORE_SNAPSHOT_TEMPORARY_FILE_NAME: &str = "document_store.json.tmp";

type CollectionContents = HashMap<String, StoredDocument>;

/// The in-memory cache mirrored to disk. Keyed first by collection name, then by
/// document identifier — identical shape to the in-memory adapter, plus the
/// durable revision counter (plan C9).
struct DurableStoreState {
    revision: u64,
    collections_indexed_by_name: HashMap<String, CollectionContents>,
}

/// Owned form used to deserialize the snapshot on boot. Fields default so an
/// older/partial snapshot still loads.
#[derive(Debug, Default, Deserialize)]
struct PersistedStoreSnapshot {
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    collections_indexed_by_name: HashMap<String, CollectionContents>,
}

/// Borrowing form used to serialize the snapshot without cloning the cache.
#[derive(Debug, Serialize)]
struct PersistedStoreSnapshotView<'borrow> {
    revision: u64,
    collections_indexed_by_name: &'borrow HashMap<String, CollectionContents>,
}

/// File-backed durable [`DocumentCollectionPort`] adapter.
pub struct FileBackedDocumentCollectionStore {
    store_snapshot_path: PathBuf,
    store_snapshot_temporary_path: PathBuf,
    state: Mutex<DurableStoreState>,
}

impl FileBackedDocumentCollectionStore {
    /// Load (or initialize) a durable store rooted at `data_directory`.
    ///
    /// The directory is created if missing. When a snapshot file already exists
    /// it is parsed into the in-memory cache (and its revision restored); a
    /// missing snapshot yields an empty store. A snapshot that exists but cannot
    /// be parsed is surfaced as an error rather than silently discarded, so a
    /// corrupt file never causes silent data loss.
    pub async fn load_from_directory(
        data_directory: impl Into<PathBuf>,
    ) -> Result<Self, ApplicationError> {
        let data_directory = data_directory.into();

        tokio::fs::create_dir_all(&data_directory)
            .await
            .map_err(|io_failure| {
                document_collection_failure(format!(
                    "could not create the durable data directory {}: {io_failure}",
                    data_directory.display()
                ))
            })?;

        let store_snapshot_path = data_directory.join(STORE_SNAPSHOT_FILE_NAME);
        let store_snapshot_temporary_path =
            data_directory.join(STORE_SNAPSHOT_TEMPORARY_FILE_NAME);

        let loaded_snapshot = match tokio::fs::read(&store_snapshot_path).await {
            Ok(snapshot_bytes) => serde_json::from_slice::<PersistedStoreSnapshot>(&snapshot_bytes)
                .map_err(|parse_failure| {
                    document_collection_failure(format!(
                        "the durable store snapshot at {} could not be parsed: {parse_failure}",
                        store_snapshot_path.display()
                    ))
                })?,
            Err(io_failure) if io_failure.kind() == std::io::ErrorKind::NotFound => {
                PersistedStoreSnapshot::default()
            }
            Err(io_failure) => {
                return Err(document_collection_failure(format!(
                    "the durable store snapshot at {} could not be read: {io_failure}",
                    store_snapshot_path.display()
                )));
            }
        };

        Ok(Self {
            store_snapshot_path,
            store_snapshot_temporary_path,
            state: Mutex::new(DurableStoreState {
                revision: loaded_snapshot.revision,
                collections_indexed_by_name: loaded_snapshot.collections_indexed_by_name,
            }),
        })
    }

    /// The current store-wide revision (plan C9). Increments on every successful
    /// mutation and is preserved across restarts.
    pub async fn current_revision(&self) -> u64 {
        self.state.lock().await.revision
    }

    /// Absolute path of the JSON snapshot backing this store.
    pub fn store_snapshot_path(&self) -> &Path {
        &self.store_snapshot_path
    }

    /// Serialize the given state and write it to disk atomically (temp file +
    /// rename). Called while the state mutex is held so writes never interleave.
    async fn persist_state(&self, state: &DurableStoreState) -> Result<(), ApplicationError> {
        let snapshot_view = PersistedStoreSnapshotView {
            revision: state.revision,
            collections_indexed_by_name: &state.collections_indexed_by_name,
        };
        let serialized_snapshot =
            serde_json::to_vec_pretty(&snapshot_view).map_err(|serialization_failure| {
                document_collection_failure(format!(
                    "the durable store snapshot could not be serialized: {serialization_failure}"
                ))
            })?;

        // Defensive: the data directory is created at boot, but re-create it in
        // case it was removed at runtime so the write does not fail spuriously.
        if let Some(parent_directory) = self.store_snapshot_path.parent() {
            tokio::fs::create_dir_all(parent_directory)
                .await
                .map_err(|io_failure| {
                    document_collection_failure(format!(
                        "could not create the durable data directory {}: {io_failure}",
                        parent_directory.display()
                    ))
                })?;
        }

        tokio::fs::write(&self.store_snapshot_temporary_path, &serialized_snapshot)
            .await
            .map_err(|io_failure| {
                document_collection_failure(format!(
                    "could not write the durable store temp snapshot {}: {io_failure}",
                    self.store_snapshot_temporary_path.display()
                ))
            })?;

        tokio::fs::rename(&self.store_snapshot_temporary_path, &self.store_snapshot_path)
            .await
            .map_err(|io_failure| {
                document_collection_failure(format!(
                    "could not atomically replace the durable store snapshot {}: {io_failure}",
                    self.store_snapshot_path.display()
                ))
            })?;

        Ok(())
    }
}

#[async_trait]
impl DocumentCollectionPort for FileBackedDocumentCollectionStore {
    async fn insert_document(
        &self,
        collection_name: &str,
        document_to_insert: StoredDocument,
    ) -> Result<(), ApplicationError> {
        let mut acquired_guard = self.state.lock().await;
        let collection_contents = acquired_guard
            .collections_indexed_by_name
            .entry(collection_name.to_string())
            .or_default();
        collection_contents.insert(
            document_to_insert.document_identifier.clone(),
            document_to_insert,
        );
        acquired_guard.revision += 1;
        self.persist_state(&acquired_guard).await?;
        Ok(())
    }

    async fn fetch_document(
        &self,
        collection_name: &str,
        document_identifier: &str,
    ) -> Result<Option<StoredDocument>, ApplicationError> {
        let acquired_guard = self.state.lock().await;
        let retrieved_document = acquired_guard
            .collections_indexed_by_name
            .get(collection_name)
            .and_then(|collection_contents| collection_contents.get(document_identifier))
            .cloned();
        Ok(retrieved_document)
    }

    async fn list_documents(
        &self,
        collection_name: &str,
    ) -> Result<Vec<StoredDocument>, ApplicationError> {
        let acquired_guard = self.state.lock().await;
        let listed_documents = acquired_guard
            .collections_indexed_by_name
            .get(collection_name)
            .map(|collection_contents| collection_contents.values().cloned().collect())
            .unwrap_or_default();
        Ok(listed_documents)
    }

    async fn list_documents_owned_by(
        &self,
        collection_name: &str,
        owning_account: &str,
    ) -> Result<Vec<StoredDocument>, ApplicationError> {
        let acquired_guard = self.state.lock().await;
        let filtered_documents = acquired_guard
            .collections_indexed_by_name
            .get(collection_name)
            .map(|collection_contents| {
                collection_contents
                    .values()
                    .filter(|candidate_document| {
                        candidate_document.owning_account.as_deref() == Some(owning_account)
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        Ok(filtered_documents)
    }

    async fn replace_document(
        &self,
        collection_name: &str,
        document_to_replace: StoredDocument,
    ) -> Result<bool, ApplicationError> {
        let mut acquired_guard = self.state.lock().await;
        let collection_contents = acquired_guard
            .collections_indexed_by_name
            .entry(collection_name.to_string())
            .or_default();
        let document_already_existed =
            collection_contents.contains_key(&document_to_replace.document_identifier);
        collection_contents.insert(
            document_to_replace.document_identifier.clone(),
            document_to_replace,
        );
        acquired_guard.revision += 1;
        self.persist_state(&acquired_guard).await?;
        Ok(document_already_existed)
    }

    async fn delete_document(
        &self,
        collection_name: &str,
        document_identifier: &str,
    ) -> Result<bool, ApplicationError> {
        let mut acquired_guard = self.state.lock().await;
        let removal_outcome = acquired_guard
            .collections_indexed_by_name
            .get_mut(collection_name)
            .map(|collection_contents| collection_contents.remove(document_identifier).is_some())
            .unwrap_or(false);
        // Only bump the revision and re-persist when the store actually changed,
        // so a no-op delete does not churn the snapshot or the revision counter.
        if removal_outcome {
            acquired_guard.revision += 1;
            self.persist_state(&acquired_guard).await?;
        }
        Ok(removal_outcome)
    }

    async fn count_documents(&self, collection_name: &str) -> Result<usize, ApplicationError> {
        let acquired_guard = self.state.lock().await;
        let counted = acquired_guard
            .collections_indexed_by_name
            .get(collection_name)
            .map(|collection_contents| collection_contents.len())
            .unwrap_or(0);
        Ok(counted)
    }
}

/// Build the port's failure variant with a human-readable description.
fn document_collection_failure(failure_description: String) -> ApplicationError {
    ApplicationError::DocumentCollectionFailure {
        failure_description,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn unique_temporary_directory() -> PathBuf {
        std::env::temp_dir().join(format!(
            "alma-durable-doc-store-{}",
            uuid::Uuid::new_v4()
        ))
    }

    fn sample_document(document_identifier: &str, owning_account: Option<&str>) -> StoredDocument {
        StoredDocument {
            document_identifier: document_identifier.to_string(),
            owning_account: owning_account.map(|account| account.to_string()),
            document_body: json!({ "identifier": document_identifier, "value": 7 }),
        }
    }

    #[tokio::test]
    async fn inserted_documents_can_be_fetched_and_counted() {
        let directory = unique_temporary_directory();
        let store = FileBackedDocumentCollectionStore::load_from_directory(&directory)
            .await
            .expect("the durable store should load from a fresh directory");

        store
            .insert_document("AGENT_NODES", sample_document("alpha", Some("user@example.com")))
            .await
            .expect("insert should succeed");

        let fetched = store
            .fetch_document("AGENT_NODES", "alpha")
            .await
            .expect("fetch should succeed")
            .expect("the inserted document should be present");
        assert_eq!(fetched.document_identifier, "alpha");
        assert_eq!(
            store.count_documents("AGENT_NODES").await.unwrap(),
            1,
            "the collection should report exactly one document"
        );
        assert!(
            store
                .fetch_document("AGENT_NODES", "missing")
                .await
                .unwrap()
                .is_none(),
            "a missing identifier should fetch as None"
        );

        let _ = std::fs::remove_dir_all(&directory);
    }

    #[tokio::test]
    async fn state_and_revision_survive_a_reload_from_the_same_directory() {
        let directory = unique_temporary_directory();

        let revision_before_reload = {
            let store = FileBackedDocumentCollectionStore::load_from_directory(&directory)
                .await
                .expect("first boot should load");
            store
                .insert_document("RUNS", sample_document("run-1", None))
                .await
                .unwrap();
            store
                .insert_document("RUNS", sample_document("run-2", None))
                .await
                .unwrap();
            store.current_revision().await
        };
        assert_eq!(revision_before_reload, 2);

        // Boot a brand-new store instance against the same directory: it must
        // rehydrate both documents and the revision counter from disk.
        let reloaded_store = FileBackedDocumentCollectionStore::load_from_directory(&directory)
            .await
            .expect("second boot should load the persisted snapshot");
        assert_eq!(reloaded_store.count_documents("RUNS").await.unwrap(), 2);
        assert!(reloaded_store
            .fetch_document("RUNS", "run-1")
            .await
            .unwrap()
            .is_some());
        assert_eq!(
            reloaded_store.current_revision().await,
            revision_before_reload,
            "the revision counter should be restored on reboot"
        );

        let _ = std::fs::remove_dir_all(&directory);
    }

    #[tokio::test]
    async fn revision_advances_on_mutations_but_not_on_no_op_delete() {
        let directory = unique_temporary_directory();
        let store = FileBackedDocumentCollectionStore::load_from_directory(&directory)
            .await
            .unwrap();
        assert_eq!(store.current_revision().await, 0);

        store
            .insert_document("REPORTS", sample_document("r-1", None))
            .await
            .unwrap();
        assert_eq!(store.current_revision().await, 1);

        let previously_existed = store
            .replace_document("REPORTS", sample_document("r-1", Some("owner")))
            .await
            .unwrap();
        assert!(previously_existed, "replace should report prior existence");
        assert_eq!(store.current_revision().await, 2);

        let removed = store.delete_document("REPORTS", "r-1").await.unwrap();
        assert!(removed, "delete of an existing document should report removal");
        assert_eq!(store.current_revision().await, 3);

        let removed_again = store.delete_document("REPORTS", "r-1").await.unwrap();
        assert!(!removed_again, "deleting a missing document reports false");
        assert_eq!(
            store.current_revision().await,
            3,
            "a no-op delete must not advance the revision counter"
        );

        let _ = std::fs::remove_dir_all(&directory);
    }

    #[tokio::test]
    async fn owner_scoped_listing_filters_by_account() {
        let directory = unique_temporary_directory();
        let store = FileBackedDocumentCollectionStore::load_from_directory(&directory)
            .await
            .unwrap();

        store
            .insert_document("RAG_CORPORA", sample_document("owned-1", Some("alice")))
            .await
            .unwrap();
        store
            .insert_document("RAG_CORPORA", sample_document("owned-2", Some("bob")))
            .await
            .unwrap();
        store
            .insert_document("RAG_CORPORA", sample_document("unowned", None))
            .await
            .unwrap();

        let alice_documents = store
            .list_documents_owned_by("RAG_CORPORA", "alice")
            .await
            .unwrap();
        assert_eq!(alice_documents.len(), 1);
        assert_eq!(alice_documents[0].document_identifier, "owned-1");

        assert_eq!(
            store.list_documents("RAG_CORPORA").await.unwrap().len(),
            3,
            "the unscoped listing should return every document"
        );

        let _ = std::fs::remove_dir_all(&directory);
    }

    #[tokio::test]
    async fn a_corrupt_snapshot_is_surfaced_as_an_error() {
        let directory = unique_temporary_directory();
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join(STORE_SNAPSHOT_FILE_NAME), b"{ not json").unwrap();

        let load_outcome =
            FileBackedDocumentCollectionStore::load_from_directory(&directory).await;
        assert!(
            load_outcome.is_err(),
            "a corrupt snapshot must fail loudly rather than silently reset the store"
        );

        let _ = std::fs::remove_dir_all(&directory);
    }
}
