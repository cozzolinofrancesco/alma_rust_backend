#![allow(clippy::type_complexity)]

pub mod agentnodes;
pub mod builders;
pub mod error;
pub mod optics;
pub mod projects;
pub mod qc;
pub mod value_objects;

pub mod prelude {
    pub use crate::builders::{FieldHasBeenSupplied, FieldIsStillMissing, ProjectBuilder};
    pub use crate::error::{DomainError, DomainInvariant, InvariantCode};
    pub use crate::optics::{Lens, OptionalAccess, Prism};
    pub use crate::projects::{Project, ProjectEvent, ProjectLifecycleStatus, Revision};
    pub use crate::value_objects::{
        CorpusId, Email, EntityMarker, Id, NonEmptyText, ProjectId, ProjectName, UserId, VideoId,
    };
}
