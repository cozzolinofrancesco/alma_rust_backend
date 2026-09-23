use alma_domain::error::DomainError;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ApplicationError {
    #[error("a domain invariant was violated: {0}")]
    DomainInvariantViolated(#[from] DomainError),
    #[error("the storage adapter reported a failure: {failure_description}")]
    StorageAdapterFailure { failure_description: String },
    #[error("the artificial intelligence adapter reported a failure: {failure_description}")]
    ArtificialIntelligenceAdapterFailure { failure_description: String },
    #[error("the literature adapter reported a failure: {failure_description}")]
    LiteratureAdapterFailure { failure_description: String },
    #[error("the persistence layer reported a failure: {failure_description}")]
    PersistenceLayerFailure { failure_description: String },
    #[error("the requested project could not be located")]
    RequestedProjectCouldNotBeLocated,
    #[error("the authenticated principal is not authorized to act on this resource")]
    AuthorizationWasDenied,
    #[error("the document collection reported a failure: {failure_description}")]
    DocumentCollectionFailure { failure_description: String },
    #[error("the requested resource could not be located")]
    RequestedResourceCouldNotBeLocated,
    #[error("the Google Drive adapter reported a failure: {failure_description}")]
    GoogleDriveAdapterFailure { failure_description: String },
}
