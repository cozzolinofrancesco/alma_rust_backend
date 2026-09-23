use crate::categories::agentnodes::handlers::*;
use crate::state::ApplicationState;
use alma_application::ports::unit_of_work::UnitOfWork;
use axum::Router;
use axum::routing::{get, post};

/// Build the portable `agentnodes` API router.
///
/// All operations are mounted under the reference base path `/api/v1/agentnodes`
/// (the base path the capability descriptor advertises and the reference
/// `app/api/v1/agentnodes/[[...segments]]` catch-all serves). The `#[route]`
/// attribute on each handler only emits a descriptor; the paths registered here
/// are authoritative.
///
/// Wired: the 272 / IB money-path (`runs/plan` -> `runs/advance` -> `steps/execute`
/// -> `documents/assemble` -> `exports/{format}`), `272/compile`, and the
/// `GET capabilities` descriptor. `272/prepare-source` and the agent-graph
/// `GET`/`PUT` endpoints are not wired here because their handlers are not part of
/// this build stage.
pub fn build_agentnodes_router<TransactionalUnitOfWork>()
-> Router<ApplicationState<TransactionalUnitOfWork>>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    Router::new()
        .route(
            "/api/v1/agentnodes/capabilities",
            get(capabilities_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/v1/agentnodes/steps/execute",
            post(execute_step_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/v1/agentnodes/runs/plan",
            post(plan_run_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/v1/agentnodes/runs/advance",
            post(advance_run_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/v1/agentnodes/272/compile",
            post(compile_272_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/v1/agentnodes/documents/assemble",
            post(assemble_document_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/v1/agentnodes/exports/:export_format",
            post(export_document_handler::<TransactionalUnitOfWork>),
        )
}
