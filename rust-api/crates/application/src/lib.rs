#![allow(clippy::needless_lifetimes)]

pub mod cqrs;
pub mod error;
pub mod ports;
pub mod projects;
pub mod support;

pub mod prelude {
    pub use crate::cqrs::{
        Command, CommandDispatchBus, CommandHandler, Query, QueryDispatchBus, QueryHandler,
    };
    pub use crate::error::ApplicationError;
    pub use crate::ports::{
        ArtificialIntelligencePort, DocumentCollectionPort, GeneratedCompletion, LiteraturePort,
        ProjectRepository, PublicationSummary, ScopedTransactionFuture, StorageBlob,
        StorageObjectIdentifier, StoragePort, StoredDocument, UnitOfWork,
    };
    pub use crate::projects::{
        CreateProjectCommand, CreateProjectCommandHandler, ListProjectsOwnedByQuery,
        ListProjectsOwnedByQueryHandler, LoadProjectQuery, LoadProjectQueryHandler, ProjectView,
        RenameProjectCommand, RenameProjectCommandHandler,
    };
    pub use crate::support::{LendingRecordCursor, OwnedRecordLendingCursor};
}
