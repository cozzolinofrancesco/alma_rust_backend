use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::cqrs::QueryDispatchBus;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_application::projects::queries::{
    ListProjectsOwnedByQuery, ListProjectsOwnedByQueryHandler,
};
use alma_application::projects::read_model::ProjectView;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use std::sync::Arc;

#[route(method = "GET", path = "/api/projects")]
pub async fn list_projects_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> Result<Json<Vec<ProjectView>>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let owning_account = authorized_request.authorized_principal().clone();
    let list_projects_query = ListProjectsOwnedByQuery { owning_account };
    let list_projects_query_handler = ListProjectsOwnedByQueryHandler::construct_with(Arc::clone(
        &application_state.transactional_unit_of_work,
    ));
    let projected_views =
        QueryDispatchBus::dispatch_query(&list_projects_query_handler, list_projects_query).await?;

    Ok(Json(projected_views))
}
