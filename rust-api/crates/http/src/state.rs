use alma_application::ports::ai::ArtificialIntelligencePort;
use alma_application::ports::document_collection::DocumentCollectionPort;
use alma_application::ports::google_drive::GoogleDriveObjectPort;
use alma_application::ports::literature::LiteraturePort;
use alma_application::ports::retrieval::RetrievalPort;
use alma_application::ports::storage::StoragePort;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_infrastructure::rag_ingest::GeminiCorpusIngestionAdapter;
use std::sync::Arc;

pub struct ApplicationState<TransactionalUnitOfWork>
where
    TransactionalUnitOfWork: UnitOfWork,
{
    pub storage_adapter: Arc<dyn StoragePort>,
    pub artificial_intelligence_adapter: Arc<dyn ArtificialIntelligencePort>,
    pub literature_adapter: Arc<dyn LiteraturePort>,
    pub retrieval_adapter: Arc<dyn RetrievalPort>,
    pub document_collection: Arc<dyn DocumentCollectionPort>,
    pub transactional_unit_of_work: Arc<TransactionalUnitOfWork>,
    /// Real Gemini File Search corpus ingestion. `None` in the hermetic no-key
    /// build (ingestion needs a real `GEMINI_API_KEY`); the `/api/rag/ingest`
    /// handler returns a clear error when it is absent.
    pub corpus_ingestion_adapter: Option<Arc<GeminiCorpusIngestionAdapter>>,
    /// Per-user Google Drive access. Authenticates with the caller's OAuth token
    /// (`Authorization: Bearer …`), so it is always wired (no server credential).
    pub google_drive_adapter: Arc<dyn GoogleDriveObjectPort>,
}

impl<TransactionalUnitOfWork> ApplicationState<TransactionalUnitOfWork>
where
    TransactionalUnitOfWork: UnitOfWork,
{
    pub fn assemble_from_adapters(
        storage_adapter: Arc<dyn StoragePort>,
        artificial_intelligence_adapter: Arc<dyn ArtificialIntelligencePort>,
        literature_adapter: Arc<dyn LiteraturePort>,
        retrieval_adapter: Arc<dyn RetrievalPort>,
        document_collection: Arc<dyn DocumentCollectionPort>,
        transactional_unit_of_work: Arc<TransactionalUnitOfWork>,
        corpus_ingestion_adapter: Option<Arc<GeminiCorpusIngestionAdapter>>,
        google_drive_adapter: Arc<dyn GoogleDriveObjectPort>,
    ) -> Self {
        Self {
            storage_adapter,
            artificial_intelligence_adapter,
            literature_adapter,
            retrieval_adapter,
            document_collection,
            transactional_unit_of_work,
            corpus_ingestion_adapter,
            google_drive_adapter,
        }
    }
}

impl<TransactionalUnitOfWork> Clone for ApplicationState<TransactionalUnitOfWork>
where
    TransactionalUnitOfWork: UnitOfWork,
{
    fn clone(&self) -> Self {
        Self {
            storage_adapter: Arc::clone(&self.storage_adapter),
            artificial_intelligence_adapter: Arc::clone(&self.artificial_intelligence_adapter),
            literature_adapter: Arc::clone(&self.literature_adapter),
            retrieval_adapter: Arc::clone(&self.retrieval_adapter),
            document_collection: Arc::clone(&self.document_collection),
            transactional_unit_of_work: Arc::clone(&self.transactional_unit_of_work),
            corpus_ingestion_adapter: self.corpus_ingestion_adapter.clone(),
            google_drive_adapter: Arc::clone(&self.google_drive_adapter),
        }
    }
}
