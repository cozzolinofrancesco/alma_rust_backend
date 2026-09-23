use crate::error::DomainError;
use crate::optics::Lens;
use crate::projects::events::ProjectEvent;
use crate::value_objects::{Email, ProjectId, ProjectName};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Revision {
    monotonic_counter: u64,
}

impl Revision {
    pub fn initial() -> Self {
        Self {
            monotonic_counter: 1,
        }
    }

    pub fn advance(self) -> Self {
        Self {
            monotonic_counter: self.monotonic_counter + 1,
        }
    }

    pub fn value(self) -> u64 {
        self.monotonic_counter
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProjectLifecycleStatus {
    Active,
    Archived,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Project {
    project_identifier: ProjectId,
    current_name: ProjectName,
    current_owner: Email,
    lifecycle_status: ProjectLifecycleStatus,
    aggregate_revision: Revision,
}

impl Project {
    pub fn author_creation_event(
        project_identifier: ProjectId,
        assigned_name: ProjectName,
        owning_account: Email,
    ) -> ProjectEvent {
        ProjectEvent::ProjectWasCreated {
            project_identifier,
            assigned_name,
            owning_account,
        }
    }

    pub fn author_rename_event(
        &self,
        replacement_name: ProjectName,
    ) -> Result<ProjectEvent, DomainError> {
        self.reject_when_archived()?;
        Ok(ProjectEvent::ProjectWasRenamed { replacement_name })
    }

    pub fn author_ownership_transfer_event(
        &self,
        replacement_owner: Email,
    ) -> Result<ProjectEvent, DomainError> {
        self.reject_when_archived()?;
        Ok(ProjectEvent::ProjectOwnershipWasTransferred { replacement_owner })
    }

    pub fn author_archive_event(&self) -> Result<ProjectEvent, DomainError> {
        self.reject_when_archived()?;
        Ok(ProjectEvent::ProjectWasArchived)
    }

    fn reject_when_archived(&self) -> Result<(), DomainError> {
        match crate::projects::lifecycle_access::project_is_active_access().preview(self) {
            Some(()) => Ok(()),
            None => Err(DomainError::ProjectAlreadyArchived),
        }
    }

    pub fn apply_event(
        current_state: Option<Project>,
        event_under_application: &ProjectEvent,
    ) -> Option<Project> {
        match (current_state, event_under_application) {
            (
                None,
                ProjectEvent::ProjectWasCreated {
                    project_identifier,
                    assigned_name,
                    owning_account,
                },
            ) => Some(Project {
                project_identifier: *project_identifier,
                current_name: assigned_name.clone(),
                current_owner: owning_account.clone(),
                lifecycle_status: ProjectLifecycleStatus::Active,
                aggregate_revision: Revision::initial(),
            }),
            (Some(existing_state), ProjectEvent::ProjectWasRenamed { replacement_name }) => {
                Some(Project {
                    current_name: replacement_name.clone(),
                    aggregate_revision: existing_state.aggregate_revision.advance(),
                    ..existing_state
                })
            }
            (
                Some(existing_state),
                ProjectEvent::ProjectOwnershipWasTransferred { replacement_owner },
            ) => Some(Project {
                current_owner: replacement_owner.clone(),
                aggregate_revision: existing_state.aggregate_revision.advance(),
                ..existing_state
            }),
            (Some(existing_state), ProjectEvent::ProjectWasArchived) => Some(Project {
                lifecycle_status: ProjectLifecycleStatus::Archived,
                aggregate_revision: existing_state.aggregate_revision.advance(),
                ..existing_state
            }),
            (unchanged_state, _) => unchanged_state,
        }
    }

    pub fn rehydrate_from_event_stream(recorded_events: &[ProjectEvent]) -> Option<Project> {
        recorded_events.iter().fold(None, Project::apply_event)
    }

    pub fn identifier_lens() -> Lens<Project, ProjectId> {
        Lens::new(
            |project: &Project| project.project_identifier,
            |mut project: Project, replacement: ProjectId| {
                project.project_identifier = replacement;
                project
            },
        )
    }

    pub fn name_lens() -> Lens<Project, ProjectName> {
        Lens::new(
            |project: &Project| project.current_name.clone(),
            |mut project: Project, replacement: ProjectName| {
                project.current_name = replacement;
                project
            },
        )
    }

    pub fn owner_lens() -> Lens<Project, Email> {
        Lens::new(
            |project: &Project| project.current_owner.clone(),
            |mut project: Project, replacement: Email| {
                project.current_owner = replacement;
                project
            },
        )
    }

    pub fn status_lens() -> Lens<Project, ProjectLifecycleStatus> {
        Lens::new(
            |project: &Project| project.lifecycle_status,
            |mut project: Project, replacement: ProjectLifecycleStatus| {
                project.lifecycle_status = replacement;
                project
            },
        )
    }

    pub fn revision_lens() -> Lens<Project, Revision> {
        Lens::new(
            |project: &Project| project.aggregate_revision,
            |mut project: Project, replacement: Revision| {
                project.aggregate_revision = replacement;
                project
            },
        )
    }
}
