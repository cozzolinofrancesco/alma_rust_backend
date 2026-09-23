use crate::categories::agentnodes::build_agentnodes_router;
use crate::categories::ai::build_ai_router;
use crate::categories::ai_agents::build_ai_agents_router;
use crate::categories::auth::build_auth_router;
use crate::categories::claim_validation::build_claim_validation_router;
use crate::categories::ocr::build_ocr_router;
use crate::categories::projects_files::build_projects_files_router;
use crate::categories::rag::build_rag_router;
use crate::categories::templates_policy::build_templates_policy_router;
use crate::projects::build_projects_router;
use crate::state::ApplicationState;
use alma_application::ports::unit_of_work::UnitOfWork;
use axum::Router;

pub fn build_complete_router<TransactionalUnitOfWork>()
-> Router<ApplicationState<TransactionalUnitOfWork>>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    Router::new()
        .merge(build_projects_router::<TransactionalUnitOfWork>())
        .merge(build_projects_files_router::<TransactionalUnitOfWork>())
        .merge(build_auth_router::<TransactionalUnitOfWork>())
        .merge(build_ai_router::<TransactionalUnitOfWork>())
        .merge(build_ai_agents_router::<TransactionalUnitOfWork>())
        .merge(build_agentnodes_router::<TransactionalUnitOfWork>())
        .merge(build_ocr_router::<TransactionalUnitOfWork>())
        .merge(build_rag_router::<TransactionalUnitOfWork>())
        .merge(build_claim_validation_router::<TransactionalUnitOfWork>())
        .merge(build_templates_policy_router::<TransactionalUnitOfWork>())
}
