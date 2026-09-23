pub mod ai;
pub mod document_collection;
pub mod durable_document_collection;
pub mod google_drive;
pub mod literature;
pub mod persistence;
pub mod rag_ingest;
pub mod retrieval;
pub mod storage;

pub use ai::{DeterministicEchoingAiAdapter, GeminiAiAdapter};
pub use document_collection::InMemoryDocumentCollectionStore;
pub use google_drive::{GoogleDriveClient, DEFAULT_GOOGLE_DRIVE_BASE_URL};
pub use durable_document_collection::FileBackedDocumentCollectionStore;
pub use literature::CannedLiteratureSourceAdapter;
pub use persistence::{
    InMemoryEventStoreState, InMemoryTransactionalProjectRepository, InMemoryUnitOfWork,
};
pub use rag_ingest::{
    CorpusIngestionError, GeminiCorpusIngestionAdapter, IngestedCorpus, IngestedCorpusFile,
};
pub use retrieval::{GeminiFileSearchRetrievalAdapter, LexicalRetrievalAdapter};
pub use storage::InMemoryBlobStorageAdapter;
