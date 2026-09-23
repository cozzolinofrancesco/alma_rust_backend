use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::cqrs::QueryDispatchBus;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_application::projects::queries::{LoadProjectQuery, LoadProjectQueryHandler};
use alma_application::projects::read_model::ProjectView;
use alma_domain::value_objects::ProjectId;
use alma_macros::route;
use axum::Json;
use axum::extract::{Path, State};
use std::sync::Arc;

#[route(method = "GET", path = "/api/projects/:project_identifier")]
pub async fn load_project_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Path(raw_project_identifier): Path<String>,
) -> Result<Json<ProjectView>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let parsed_project_identifier =
        ProjectId::parse(&raw_project_identifier).map_err(|domain_parse_failure| {
            HttpError::RequestBodyWasMalformed {
                explanation: domain_parse_failure.to_string(),
            }
        })?;
    let requesting_principal = authorized_request.authorized_principal().clone();
    let load_project_query = LoadProjectQuery {
        target_identifier: parsed_project_identifier,
        requesting_principal,
    };
    let load_project_query_handler = LoadProjectQueryHandler::construct_with(Arc::clone(
        &application_state.transactional_unit_of_work,
    ));
    let optionally_projected_view =
        QueryDispatchBus::dispatch_query(&load_project_query_handler, load_project_query).await?;

    match optionally_projected_view {
        Some(projected_view) => Ok(Json(projected_view)),
        None => Err(HttpError::RequestedResourceWasNotFound {
            explanation: String::from(
                "no project exists under the supplied identifier for this principal",
            ),
        }),
    }
}
