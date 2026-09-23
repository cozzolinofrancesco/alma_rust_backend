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
        let mut acquired_guard = self
            .stored_blobs_indexed_by_reference
            .lock()
            .expect("the in-memory storage mutex was poisoned");
        acquired_guard.insert(generated_reference.clone(), blob_to_persist.raw_bytes);
        Ok(StorageObjectIdentifier {
            opaque_reference: generated_reference,
        })
    }

    async fn fetch_blob(
        &self,
        object_identifier: &StorageObjectIdentifier,
    ) -> Result<Vec<u8>, ApplicationError> {
        let acquired_guard = self
            .stored_blobs_indexed_by_reference
            .lock()
            .expect("the in-memory storage mutex was poisoned");
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
