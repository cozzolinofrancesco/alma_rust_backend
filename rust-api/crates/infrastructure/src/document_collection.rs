use alma_application::error::ApplicationError;
use alma_application::ports::document_collection::{DocumentCollectionPort, StoredDocument};
use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

type CollectionContents = HashMap<String, StoredDocument>;

pub struct InMemoryDocumentCollectionStore {
    collections_indexed_by_name: Arc<Mutex<HashMap<String, CollectionContents>>>,
}

impl InMemoryDocumentCollectionStore {
    pub fn construct_empty() -> Self {
        Self {
            collections_indexed_by_name: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl Default for InMemoryDocumentCollectionStore {
    fn default() -> Self {
        Self::construct_empty()
    }
}

#[async_trait]
impl DocumentCollectionPort for InMemoryDocumentCollectionStore {
    async fn insert_document(
        &self,
        collection_name: &str,
        document_to_insert: StoredDocument,
    ) -> Result<(), ApplicationError> {
        let mut acquired_guard = self
            .collections_indexed_by_name
            .lock()
            .expect("the in-memory document collection mutex was poisoned");
        let collection_contents = acquired_guard
            .entry(collection_name.to_string())
            .or_default();
        collection_contents.insert(
            document_to_insert.document_identifier.clone(),
            document_to_insert,
        );
        Ok(())
    }

    async fn fetch_document(
        &self,
        collection_name: &str,
        document_identifier: &str,
    ) -> Result<Option<StoredDocument>, ApplicationError> {
        let acquired_guard = self
            .collections_indexed_by_name
            .lock()
            .expect("the in-memory document collection mutex was poisoned");
        let retrieved_document = acquired_guard
            .get(collection_name)
            .and_then(|collection_contents| collection_contents.get(document_identifier))
            .cloned();
        Ok(retrieved_document)
    }

    async fn list_documents(
        &self,
        collection_name: &str,
    ) -> Result<Vec<StoredDocument>, ApplicationError> {
        let acquired_guard = self
            .collections_indexed_by_name
            .lock()
            .expect("the in-memory document collection mutex was poisoned");
        let listed_documents = acquired_guard
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
        let acquired_guard = self
            .collections_indexed_by_name
            .lock()
            .expect("the in-memory document collection mutex was poisoned");
        let filtered_documents = acquired_guard
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
        let mut acquired_guard = self
            .collections_indexed_by_name
            .lock()
            .expect("the in-memory document collection mutex was poisoned");
        let collection_contents = acquired_guard
            .entry(collection_name.to_string())
            .or_default();
        let document_already_existed =
            collection_contents.contains_key(&document_to_replace.document_identifier);
        collection_contents.insert(
            document_to_replace.document_identifier.clone(),
            document_to_replace,
        );
        Ok(document_already_existed)
    }

    async fn delete_document(
        &self,
        collection_name: &str,
        document_identifier: &str,
    ) -> Result<bool, ApplicationError> {
        let mut acquired_guard = self
            .collections_indexed_by_name
            .lock()
            .expect("the in-memory document collection mutex was poisoned");
        let removal_outcome = acquired_guard
            .get_mut(collection_name)
            .map(|collection_contents| collection_contents.remove(document_identifier).is_some())
            .unwrap_or(false);
        Ok(removal_outcome)
    }

    async fn count_documents(&self, collection_name: &str) -> Result<usize, ApplicationError> {
        let acquired_guard = self
            .collections_indexed_by_name
            .lock()
            .expect("the in-memory document collection mutex was poisoned");
        let counted = acquired_guard
            .get(collection_name)
            .map(|collection_contents| collection_contents.len())
            .unwrap_or(0);
        Ok(counted)
    }
}
