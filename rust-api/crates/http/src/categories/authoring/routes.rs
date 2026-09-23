use crate::categories::authoring::handlers::{
    export_docx_handler, get_canvas_272_sidecar_handler, put_canvas_272_sidecar_handler,
};
use crate::state::ApplicationState;
use alma_application::ports::unit_of_work::UnitOfWork;
use axum::Router;
use axum::routing::{get, post};

/// Build the `authoring` category router (canvas-272 export + sidecar).
///
/// Routes:
/// - `POST /api/export/docx` — render a `StructuredDoc` to a downloadable `.docx`.
/// - `GET`/`PUT /api/canvas-272/sidecar/:agent_identifier` — per-agent sidecar.
pub fn build_authoring_router<TransactionalUnitOfWork>()
-> Router<ApplicationState<TransactionalUnitOfWork>>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    Router::new()
        .route(
            "/api/export/docx",
            post(export_docx_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/canvas-272/sidecar/:agent_identifier",
            get(get_canvas_272_sidecar_handler::<TransactionalUnitOfWork>)
                .put(put_canvas_272_sidecar_handler::<TransactionalUnitOfWork>),
        )
}
