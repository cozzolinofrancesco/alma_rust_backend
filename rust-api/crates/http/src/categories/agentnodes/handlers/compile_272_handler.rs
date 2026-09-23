//! `POST /api/v1/agentnodes/272/compile` — compile a 272 authoring request into a
//! portable execution bundle.
//!
//! Ports `compilePortableReport` from
//! `frontend_v3/app/lib/reportCreation/api.server.ts` under **equivalent-behavior**
//! parity. Given a 272 request (studies + section/meta steps + templates + sources),
//! it validates the request, resolves exactly one template source, computes per-step
//! source **bindings**, builds the report-creation agent, stamps the template snapshot
//! + hash onto the agent metadata, and returns the portable execution bundle. It does
//! **not** render markdown — that comes later via `runs/plan → advance → assemble →
//! export` (port plan correction C3: `272/compile` returns `{bundle, requiredSources}`,
//! a bundle, not a rendered report).
//!
//! ## Structure
//!
//! All of the compile logic (schema validation, template resolution, binding
//! computation, agent construction, snapshot stamping) is the pure
//! [`compile_portable_report`] core in `alma_domain::agentnodes::report_creation`.
//! This module is the thin axum wrapper: it enforces the shared auth perimeter (the
//! `HttpRequestInPipeline<RequestHasBeenAuthorized>` extractor), marshals the JSON
//! body into the core, and serializes the resulting [`CompiledReport`] — whose serde
//! `camelCase` shape is exactly `{ schemaVersion, bundle, requiredSources }` — back to
//! the response. The operation is pure (no I/O), so `State` is accepted only to keep
//! the handler shape uniform with the rest of the category and is otherwise unused.
//!
//! Every failure the reference throws (`TEMPLATES_REQUIRED`, `INVALID_TEMPLATES`,
//! `DUPLICATE_TEMPLATE`, `DUPLICATE_SOURCE`, `AMBIGUOUS_SOURCE_MODE`, `MISSING_SOURCE`,
//! `INVALID_SOURCE_BINDING`, `TEMPLATE_NOT_FOUND`, `UNBOUND_SOURCE`,
//! `GOOGLE_AUTH_REQUIRED`, the builder's `INVALID_REPORT` / `BIOMATERIAL_REQUIRED` /
//! `INVALID_BIOMATERIAL_SELECTION`, and `INVALID_REQUEST` for a malformed body) is
//! carried by [`AgentExecutionError`], which renders the portable
//! `{ error: { code, message, stage } }` envelope at the canonical status.

use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::agentnodes::error::AgentExecutionError;
use alma_domain::agentnodes::report_creation::compile::compile_portable_report;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::Value;

use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;

/// `POST /api/v1/agentnodes/272/compile`.
///
/// Delegates to the pure [`compile_portable_report`] core and returns its
/// `{ schemaVersion, bundle, requiredSources }` result. `State` is unused (the compile
/// path performs no I/O) but retained so every handler in the category shares one
/// signature.
#[route(method = "POST", path = "/api/v1/agentnodes/272/compile")]
pub async fn compile_272_handler<TransactionalUnitOfWork>(
    State(_application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, AgentExecutionError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let compiled_report = compile_portable_report(submitted_body)?;
    // `CompiledReport` serializes (camelCase) to exactly the reference body:
    // `{ schemaVersion, bundle, requiredSources }`. Serialization is infallible in
    // practice (the bundle is assembled from validated JSON values); a failure here is
    // an internal defect and surfaces as EXPORT_FAILED, mirroring the assemble unit.
    let response_payload = serde_json::to_value(&compiled_report).map_err(|error| {
        AgentExecutionError::export_failed(format!(
            "Failed to serialize the compiled report bundle: {error}"
        ))
    })?;
    Ok(Json(response_payload))
}
