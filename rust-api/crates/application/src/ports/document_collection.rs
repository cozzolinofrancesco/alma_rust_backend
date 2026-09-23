use crate::error::ApplicationError;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredDocument {
    pub document_identifier: String,
    pub owning_account: Option<String>,
    pub document_body: serde_json::Value,
}

#[async_trait]
pub trait DocumentCollectionPort: Send + Sync {
    async fn insert_document(
        &self,
        collection_name: &str,
        document_to_insert: StoredDocument,
    ) -> Result<(), ApplicationError>;

    async fn fetch_document(
        &self,
        collection_name: &str,
        document_identifier: &str,
    ) -> Result<Option<StoredDocument>, ApplicationError>;

    async fn list_documents(
        &self,
        collection_name: &str,
    ) -> Result<Vec<StoredDocument>, ApplicationError>;

    async fn list_documents_owned_by(
        &self,
        collection_name: &str,
        owning_account: &str,
    ) -> Result<Vec<StoredDocument>, ApplicationError>;

    async fn replace_document(
        &self,
        collection_name: &str,
        document_to_replace: StoredDocument,
    ) -> Result<bool, ApplicationError>;

    async fn delete_document(
        &self,
        collection_name: &str,
        document_identifier: &str,
    ) -> Result<bool, ApplicationError>;

    async fn count_documents(&self, collection_name: &str) -> Result<usize, ApplicationError>;
}
