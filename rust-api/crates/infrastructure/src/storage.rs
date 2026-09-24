use alma_application::error::ApplicationError;
use alma_application::ports::storage::{StorageBlob, StorageObjectIdentifier, StoragePort};
use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

pub struct InMemoryBlobStorageAdapter {
    stored_blobs_indexed_by_reference: Arc<Mutex<HashMap<String, Vec<u8>>>>,
}

impl InMemoryBlobStorageAdapter {
    pub fn construct_empty() -> Self {
        Self {
            stored_blobs_indexed_by_reference: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl Default for InMemoryBlobStorageAdapter {
    fn default() -> Self {
        Self::construct_empty()
    }
}

#[async_trait]
impl StoragePort for InMemoryBlobStorageAdapter {
    async fn persist_blob(
        &self,
        blob_to_persist: StorageBlob,
    ) -> Result<StorageObjectIdentifier, ApplicationError> {
        let generated_reference = format!(
            "{}/{}/{}",
            blob_to_persist.containing_folder,
            blob_to_persist.declared_name,
            Uuid::new_v4()
        );
        // RUST-DOS-002(b): recover from a poisoned lock (a prior panic while
        // holding it) instead of propagating a persistent 500 to every later
        // request — the retained bytes remain safe to read/overwrite.
        let mut acquired_guard = self
            .stored_blobs_indexed_by_reference
            .lock()
            .unwrap_or_else(|poisoned_guard| poisoned_guard.into_inner());
        acquired_guard.insert(generated_reference.clone(), blob_to_persist.raw_bytes);
        Ok(StorageObjectIdentifier {
            opaque_reference: generated_reference,
        })
    }

    async fn fetch_blob(
        &self,
        object_identifier: &StorageObjectIdentifier,
    ) -> Result<Vec<u8>, ApplicationError> {
        // RUST-DOS-002(b): poison-tolerant access (see persist_blob).
        let acquired_guard = self
            .stored_blobs_indexed_by_reference
            .lock()
            .unwrap_or_else(|poisoned_guard| poisoned_guard.into_inner());
        match acquired_guard.get(&object_identifier.opaque_reference) {
            Some(retrieved_bytes) => Ok(retrieved_bytes.clone()),
            None => Err(ApplicationError::StorageAdapterFailure {
                failure_description: format!(
                    "no blob was stored under the reference {}",
                    object_identifier.opaque_reference
                ),
            }),
        }
    }
}
