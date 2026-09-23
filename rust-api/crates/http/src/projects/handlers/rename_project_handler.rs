use crate::dto::projects::{RenameProjectRequestBody, RenameProjectResponseBody};
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::cqrs::CommandDispatchBus;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_application::projects::commands::{RenameProjectCommand, RenameProjectCommandHandler};
use alma_domain::value_objects::ProjectId;
use alma_domain::value_objects::optics::project_name_string_prism;
use alma_macros::route;
use axum::Json;
use axum::extract::{Path, State};
use std::sync::Arc;

#[route(method = "POST", path = "/api/projects/:project_identifier/rename")]
pub async fn rename_project_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Path(raw_project_identifier): Path<String>,
    Json(request_body): Json<RenameProjectRequestBody>,
) -> Result<Json<RenameProjectResponseBody>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let parsed_project_identifier =
        ProjectId::parse(&raw_project_identifier).map_err(|domain_parse_failure| {
            HttpError::RequestBodyWasMalformed {
                explanation: domain_parse_failure.to_string(),
            }
        })?;
    let parsed_replacement_name = project_name_string_prism()
        .preview(&request_body.replacement_name)
        .ok_or(HttpError::RequestBodyWasMalformed {
            explanation: String::from(
                "the replacement name did not parse into a valid project name",
            ),
        })?;
    let requesting_principal = authorized_request.authorized_principal().clone();
    let rename_project_command = RenameProjectCommand {
        target_identifier: parsed_project_identifier,
        replacement_name: parsed_replacement_name,
        requesting_principal,
    };
    let rename_project_command_handler = RenameProjectCommandHandler::construct_with(Arc::clone(
        &application_state.transactional_unit_of_work,
    ));
    CommandDispatchBus::dispatch_command(&rename_project_command_handler, rename_project_command)
        .await?;

    Ok(Json(RenameProjectResponseBody {
        project_identifier: parsed_project_identifier.as_uuid().to_string(),
        acknowledgement: String::from("the project was renamed"),
    }))
}
