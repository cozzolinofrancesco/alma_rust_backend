use crate::optics::{OptionalAccess, Prism};
use crate::projects::aggregate::{Project, ProjectLifecycleStatus};

pub fn active_status_prism() -> Prism<ProjectLifecycleStatus, ()> {
    Prism::new(
        |lifecycle_status: &ProjectLifecycleStatus| match lifecycle_status {
            ProjectLifecycleStatus::Active => Some(()),
            ProjectLifecycleStatus::Archived => None,
        },
        |_unit_focus: ()| ProjectLifecycleStatus::Active,
    )
}

pub fn archived_status_prism() -> Prism<ProjectLifecycleStatus, ()> {
    Prism::new(
        |lifecycle_status: &ProjectLifecycleStatus| match lifecycle_status {
            ProjectLifecycleStatus::Archived => Some(()),
            ProjectLifecycleStatus::Active => None,
        },
        |_unit_focus: ()| ProjectLifecycleStatus::Archived,
    )
}

pub fn project_is_active_access() -> OptionalAccess<Project, ()> {
    OptionalAccess::from_lens_then_prism(Project::status_lens(), active_status_prism())
}

pub fn project_is_archived_access() -> OptionalAccess<Project, ()> {
    OptionalAccess::from_lens_then_prism(Project::status_lens(), archived_status_prism())
}
