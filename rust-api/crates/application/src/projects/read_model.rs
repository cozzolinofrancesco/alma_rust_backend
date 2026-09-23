use alma_domain::projects::{Project, ProjectLifecycleStatus};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectView {
    pub project_identifier: String,
    pub project_name: String,
    pub owning_account: String,
    pub lifecycle_status: String,
    pub aggregate_revision: u64,
}

impl ProjectView {
    pub fn project_from_aggregate(aggregate_to_project: &Project) -> Self {
        let identifier_focusing_lens = Project::identifier_lens();
        let name_focusing_lens = Project::name_lens();
        let owner_focusing_lens = Project::owner_lens();
        let status_focusing_lens = Project::status_lens();
        let revision_focusing_lens = Project::revision_lens();

        let focused_identifier = identifier_focusing_lens.get(aggregate_to_project);
        let focused_name = name_focusing_lens.get(aggregate_to_project);
        let focused_owner = owner_focusing_lens.get(aggregate_to_project);
        let focused_status = status_focusing_lens.get(aggregate_to_project);
        let focused_revision = revision_focusing_lens.get(aggregate_to_project);

        let rendered_lifecycle_status = match focused_status {
            ProjectLifecycleStatus::Active => String::from("active"),
            ProjectLifecycleStatus::Archived => String::from("archived"),
        };
        Self {
            project_identifier: focused_identifier.as_uuid().to_string(),
            project_name: focused_name.into_string(),
            owning_account: focused_owner.into_string(),
            lifecycle_status: rendered_lifecycle_status,
            aggregate_revision: focused_revision.value(),
        }
    }
}
