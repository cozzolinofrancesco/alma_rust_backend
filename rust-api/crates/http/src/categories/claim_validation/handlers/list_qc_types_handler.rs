//! `GET /api/claim-validation/qc-types` — the built-in QC-type registry.
//!
//! Returns the static registry of validation types this build supports. With the
//! Google-Sheet-backed registry cut (needs OAuth), only the built-in
//! `document-validation` type ships — the claim-level workflow the
//! `validate_document_handler` implements.

use alma_application::ports::unit_of_work::UnitOfWork;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};

use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;

#[route(method = "GET", path = "/api/claim-validation/qc-types")]
pub async fn list_qc_types_handler<TransactionalUnitOfWork>(
    State(_application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    Ok(Json(json!({
        "qcTypes": [
            {
                "id": "document-validation",
                "label": "Document validation",
                "description": "Claim-level validation of statements against a supplied source document: extract atomic claims, locate evidence, compare, and report one of supported / partially_supported / contradicted / insufficient_evidence.",
                "outcomes": [
                    "supported",
                    "partially_supported",
                    "contradicted",
                    "insufficient_evidence",
                    "not_assessed"
                ]
            }
        ]
    })))
}
