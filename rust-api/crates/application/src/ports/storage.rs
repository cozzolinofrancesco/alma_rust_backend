use crate::error::ApplicationError;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StorageObjectIdentifier {
    pub opaque_reference: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorageBlob {
    pub containing_folder: String,
    pub declared_name: String,
    pub raw_bytes: Vec<u8>,
}

#[async_trait]
pub trait StoragePort: Send + Sync {
    async fn persist_blob(
        &self,
        blob_to_persist: StorageBlob,
    ) -> Result<StorageObjectIdentifier, ApplicationError>;

    async fn fetch_blob(
        &self,
        object_identifier: &StorageObjectIdentifier,
    ) -> Result<Vec<u8>, ApplicationError>;
}
