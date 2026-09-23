use thiserror::Error;

mod sealed {
    pub trait SealedDomainInvariant {}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum InvariantCode {
    EmailMalformed,
    ProjectNameEmpty,
    ProjectNameTooLong,
    NonEmptyTextEmpty,
    IdentifierMalformed,
    ProjectAlreadyArchived,
}

pub trait DomainInvariant:
    sealed::SealedDomainInvariant + core::fmt::Debug + core::fmt::Display
{
    fn invariant_code(&self) -> InvariantCode;
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum DomainError {
    #[error("email is malformed: {reason}")]
    EmailMalformed { reason: String },
    #[error("project name must not be empty")]
    ProjectNameEmpty,
    #[error("project name exceeds the maximum length of {maximum} characters")]
    ProjectNameTooLong { maximum: usize },
    #[error("text value must not be empty")]
    NonEmptyTextEmpty,
    #[error("identifier is malformed: {reason}")]
    IdentifierMalformed { reason: String },
    #[error("project has already been archived and cannot be modified")]
    ProjectAlreadyArchived,
}

impl sealed::SealedDomainInvariant for DomainError {}

impl DomainInvariant for DomainError {
    fn invariant_code(&self) -> InvariantCode {
        match self {
            DomainError::EmailMalformed { .. } => InvariantCode::EmailMalformed,
            DomainError::ProjectNameEmpty => InvariantCode::ProjectNameEmpty,
            DomainError::ProjectNameTooLong { .. } => InvariantCode::ProjectNameTooLong,
            DomainError::NonEmptyTextEmpty => InvariantCode::NonEmptyTextEmpty,
            DomainError::IdentifierMalformed { .. } => InvariantCode::IdentifierMalformed,
            DomainError::ProjectAlreadyArchived => InvariantCode::ProjectAlreadyArchived,
        }
    }
}
