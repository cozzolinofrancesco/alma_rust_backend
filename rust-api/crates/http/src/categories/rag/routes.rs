use crate::categories::rag::handlers::*;
use crate::state::ApplicationState;
use alma_application::ports::unit_of_work::UnitOfWork;
use axum::Router;
use axum::routing::{get, post};

pub fn build_rag_router<TransactionalUnitOfWork>()
-> Router<ApplicationState<TransactionalUnitOfWork>>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    Router::new()
        .route(
            "/api/rag/corpora",
            get(list_rag_corpora_handler::<TransactionalUnitOfWork>)
                .post(store_rag_corpus_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/rag/corpora/summaries",
            post(summarize_rag_corpora_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/rag/corpora/:corpus_identifier",
            axum::routing::delete(delete_rag_corpus_handler::<TransactionalUnitOfWork>)
                .patch(update_rag_corpus_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/rag/jobs",
            get(list_rag_jobs_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/rag/jobs/start-file",
            post(start_rag_file_job_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/rag/jobs/:job_identifier",
            get(fetch_rag_job_handler::<TransactionalUnitOfWork>)
                .delete(delete_rag_job_handler::<TransactionalUnitOfWork>)
                .patch(update_rag_job_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/rag/jobs/:job_identifier/files",
            get(list_rag_job_files_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/rag/jobs/:job_identifier/restart",
            post(restart_rag_job_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/rag/ingest",
            post(ingest_corpus_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/rag/query",
            post(query_rag_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/rag/qc",
            post(rag_qc_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/rag/drive/search",
            get(search_rag_drive_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/rag/drive/folder/:folder_identifier",
            get(browse_rag_drive_folder_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/rag/drive/download/:file_identifier",
            get(download_rag_drive_file_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/rag-knowledge/list",
            get(list_rag_knowledge_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/rag-knowledge/check-duplicate",
            post(check_rag_knowledge_duplicate_handler::<TransactionalUnitOfWork>),
        )
}
