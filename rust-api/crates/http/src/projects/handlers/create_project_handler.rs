use crate::dto::projects::{CreateProjectRequestBody, CreateProjectResponseBody};
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::cqrs::CommandDispatchBus;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_application::projects::commands::{CreateProjectCommand, CreateProjectCommandHandler};
use alma_domain::value_objects::ProjectId;
use alma_domain::value_objects::optics::project_name_string_prism;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use std::sync::Arc;
use uuid::Uuid;

#[route(method = "POST", path = "/api/projects")]
pub async fn create_project_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(request_body): Json<CreateProjectRequestBody>,
) -> Result<Json<CreateProjectResponseBody>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let freshly_generated_identifier = ProjectId::from_uuid(Uuid::new_v4());
    let parsed_project_name = project_name_string_prism()
        .preview(&request_body.project_name)
        .ok_or(HttpError::RequestBodyWasMalformed {
            explanation: String::from("the project name did not parse into a valid project name"),
        })?;
    let owning_account = authorized_request.authorized_principal().clone();

    let create_project_command = CreateProjectCommand {
        requested_identifier: freshly_generated_identifier,
        requested_name: parsed_project_name,
        requested_owner: owning_account,
    };
    let create_project_command_handler = CreateProjectCommandHandler::construct_with(Arc::clone(
        &application_state.transactional_unit_of_work,
    ));
    let created_project_identifier = CommandDispatchBus::dispatch_command(
        &create_project_command_handler,
        create_project_command,
    )
    .await?;

    Ok(Json(CreateProjectResponseBody {
        project_identifier: created_project_identifier.as_uuid().to_string(),
    }))
}
