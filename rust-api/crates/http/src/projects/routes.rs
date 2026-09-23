use crate::projects::handlers::{
    create_project_handler, list_projects_handler, load_project_handler, rename_project_handler,
};
use crate::state::ApplicationState;
use alma_application::ports::unit_of_work::UnitOfWork;
use axum::Router;
use axum::routing::{get, post};

pub fn build_projects_router<TransactionalUnitOfWork>()
-> Router<ApplicationState<TransactionalUnitOfWork>>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    Router::new()
        .route(
            "/api/projects",
            post(create_project_handler::<TransactionalUnitOfWork>)
                .get(list_projects_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/projects/:project_identifier",
            get(load_project_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/projects/:project_identifier/rename",
            post(rename_project_handler::<TransactionalUnitOfWork>),
        )
}
