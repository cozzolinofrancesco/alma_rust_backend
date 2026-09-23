use crate::value_objects::{Email, ProjectId, ProjectName};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event_type", content = "event_payload")]
pub enum ProjectEvent {
    ProjectWasCreated {
        project_identifier: ProjectId,
        assigned_name: ProjectName,
        owning_account: Email,
    },
    ProjectWasRenamed {
        replacement_name: ProjectName,
    },
    ProjectOwnershipWasTransferred {
        replacement_owner: Email,
    },
    ProjectWasArchived,
}
