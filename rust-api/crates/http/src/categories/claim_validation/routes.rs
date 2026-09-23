use crate::categories::claim_validation::handlers::*;
use crate::state::ApplicationState;
use alma_application::ports::unit_of_work::UnitOfWork;
use axum::Router;
use axum::routing::{get, post};

/// Build the `claim-validation` router — the paper's Document Validation QC.
///
/// - `POST /api/claim-validation/validate` runs the extract → locate → compare
///   pipeline against an inline source document.
/// - `GET  /api/claim-validation/qc-types` returns the built-in QC-type registry.
pub fn build_claim_validation_router<TransactionalUnitOfWork>()
-> Router<ApplicationState<TransactionalUnitOfWork>>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    Router::new()
        .route(
            "/api/claim-validation/validate",
            post(validate_document_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/claim-validation/qc-types",
            get(list_qc_types_handler::<TransactionalUnitOfWork>),
        )
}
