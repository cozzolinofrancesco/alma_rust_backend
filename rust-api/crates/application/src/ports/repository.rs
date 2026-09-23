use crate::error::ApplicationError;
use alma_domain::projects::{Project, ProjectEvent};
use alma_domain::value_objects::{Email, ProjectId};
use async_trait::async_trait;

#[async_trait]
pub trait ProjectRepository: Send {
    async fn load_recorded_events(
        &mut self,
        project_identifier: ProjectId,
    ) -> Result<Vec<ProjectEvent>, ApplicationError>;

    async fn append_recorded_events(
        &mut self,
        project_identifier: ProjectId,
        newly_authored_events: Vec<ProjectEvent>,
    ) -> Result<(), ApplicationError>;

    async fn list_snapshots_owned_by(
        &mut self,
        owning_account: Email,
    ) -> Result<Vec<Project>, ApplicationError>;
}
