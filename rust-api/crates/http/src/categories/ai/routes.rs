use crate::categories::ai::handlers::*;
use crate::state::ApplicationState;
use alma_application::ports::unit_of_work::UnitOfWork;
use axum::Router;
use axum::routing::{get, post};

pub fn build_ai_router<TransactionalUnitOfWork>()
-> Router<ApplicationState<TransactionalUnitOfWork>>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    Router::new()
        .route(
            "/api/ai",
            get(describe_artificial_intelligence_service_handler::<TransactionalUnitOfWork>).post(
                generate_artificial_intelligence_completion_handler::<TransactionalUnitOfWork>,
            ),
        )
        .route(
            "/api/gemini",
            post(generate_gemini_completion_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/multimodalgemini",
            post(generate_multimodal_gemini_completion_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/image-analysis",
            get(describe_image_analysis_service_handler::<TransactionalUnitOfWork>)
                .post(analyze_image_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/latex-to-json-ai",
            get(describe_latex_to_json_service_handler::<TransactionalUnitOfWork>)
                .post(convert_latex_to_json_handler::<TransactionalUnitOfWork>),
        )
}
