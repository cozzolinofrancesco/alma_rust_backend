use crate::categories::ai_agents::handlers::*;
use crate::state::ApplicationState;
use alma_application::ports::unit_of_work::UnitOfWork;
use axum::Router;
use axum::routing::post;

pub fn build_ai_agents_router<TransactionalUnitOfWork>()
-> Router<ApplicationState<TransactionalUnitOfWork>>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    Router::new()
        .route(
            "/api/ai-agents/export",
            post(export_ai_agent_configuration_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/ai-agents/generate",
            post(generate_ai_agent_structure_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/ai-agents/plan",
            post(plan_ai_agent_workflow_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/ai-agents/refine",
            post(refine_ai_agent_configuration_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/ai-agents/report-creation",
            post(create_ai_agent_report_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/ai-agents/share",
            post(share_ai_agent_configuration_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/ai-agents/verify-bibliography",
            post(verify_ai_agent_bibliography_handler::<TransactionalUnitOfWork>),
        )
}
