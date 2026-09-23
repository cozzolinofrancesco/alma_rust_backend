use crate::categories::ocr::handlers::*;
use crate::state::ApplicationState;
use alma_application::ports::unit_of_work::UnitOfWork;
use axum::Router;
use axum::routing::{get, post};

pub fn build_ocr_router<TransactionalUnitOfWork>()
-> Router<ApplicationState<TransactionalUnitOfWork>>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    Router::new()
        .route(
            "/api/ocr",
            post(create_ocr_job_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/ocr-retry",
            post(retry_ocr_job_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/ocr-stream",
            get(describe_ocr_stream_handler::<TransactionalUnitOfWork>)
                .post(create_ocr_stream_job_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/preprocessing-stream",
            get(describe_preprocessing_stream_handler::<TransactionalUnitOfWork>)
                .post(run_preprocessing_stream_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/cleanup-tmp",
            get(describe_cleanup_temporary_files_handler::<TransactionalUnitOfWork>)
                .post(run_cleanup_temporary_files_handler::<TransactionalUnitOfWork>),
        )
}
