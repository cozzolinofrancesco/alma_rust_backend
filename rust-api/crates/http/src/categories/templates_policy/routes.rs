use crate::categories::templates_policy::handlers::*;
use crate::state::ApplicationState;
use alma_application::ports::unit_of_work::UnitOfWork;
use axum::Router;
use axum::routing::{get, post};

pub fn build_templates_policy_router<TransactionalUnitOfWork>()
-> Router<ApplicationState<TransactionalUnitOfWork>>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    Router::new()
        .route(
            "/api/templates/study-types",
            get(list_study_type_templates_handler::<TransactionalUnitOfWork>)
                .post(create_study_type_template_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/templates/drafting-templates",
            get(list_drafting_templates_handler::<TransactionalUnitOfWork>)
                .post(create_drafting_template_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/generate-policy-question",
            post(generate_policy_question_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/assess-policy-answer",
            post(assess_policy_answer_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/corrections",
            get(list_corrections_handler::<TransactionalUnitOfWork>)
                .post(create_correction_handler::<TransactionalUnitOfWork>),
        )
}
