use crate::projects::aggregate::Project;
use crate::projects::events::ProjectEvent;
use crate::value_objects::{Email, ProjectId, ProjectName};
use core::marker::PhantomData;

pub struct ProjectCreationOutcome {
    pub birth_event: ProjectEvent,
    pub initial_aggregate: Project,
}

pub struct FieldHasBeenSupplied;
pub struct FieldIsStillMissing;

pub struct ProjectBuilder<IdentifierState, NameState, OwnerState> {
    accumulated_identifier: Option<ProjectId>,
    accumulated_name: Option<ProjectName>,
    accumulated_owner: Option<Email>,
    identifier_state_marker: PhantomData<IdentifierState>,
    name_state_marker: PhantomData<NameState>,
    owner_state_marker: PhantomData<OwnerState>,
}

impl ProjectBuilder<FieldIsStillMissing, FieldIsStillMissing, FieldIsStillMissing> {
    pub fn begin() -> Self {
        Self {
            accumulated_identifier: None,
            accumulated_name: None,
            accumulated_owner: None,
            identifier_state_marker: PhantomData,
            name_state_marker: PhantomData,
            owner_state_marker: PhantomData,
        }
    }
}

impl Default for ProjectBuilder<FieldIsStillMissing, FieldIsStillMissing, FieldIsStillMissing> {
    fn default() -> Self {
        Self::begin()
    }
}

impl<NameState, OwnerState> ProjectBuilder<FieldIsStillMissing, NameState, OwnerState> {
    pub fn with_identifier(
        self,
        supplied_identifier: ProjectId,
    ) -> ProjectBuilder<FieldHasBeenSupplied, NameState, OwnerState> {
        ProjectBuilder {
            accumulated_identifier: Some(supplied_identifier),
            accumulated_name: self.accumulated_name,
            accumulated_owner: self.accumulated_owner,
            identifier_state_marker: PhantomData,
            name_state_marker: PhantomData,
            owner_state_marker: PhantomData,
        }
    }
}

impl<IdentifierState, OwnerState> ProjectBuilder<IdentifierState, FieldIsStillMissing, OwnerState> {
    pub fn with_name(
        self,
        supplied_name: ProjectName,
    ) -> ProjectBuilder<IdentifierState, FieldHasBeenSupplied, OwnerState> {
        ProjectBuilder {
            accumulated_identifier: self.accumulated_identifier,
            accumulated_name: Some(supplied_name),
            accumulated_owner: self.accumulated_owner,
            identifier_state_marker: PhantomData,
            name_state_marker: PhantomData,
            owner_state_marker: PhantomData,
        }
    }
}

impl<IdentifierState, NameState> ProjectBuilder<IdentifierState, NameState, FieldIsStillMissing> {
    pub fn with_owner(
        self,
        supplied_owner: Email,
    ) -> ProjectBuilder<IdentifierState, NameState, FieldHasBeenSupplied> {
        ProjectBuilder {
            accumulated_identifier: self.accumulated_identifier,
            accumulated_name: self.accumulated_name,
            accumulated_owner: Some(supplied_owner),
            identifier_state_marker: PhantomData,
            name_state_marker: PhantomData,
            owner_state_marker: PhantomData,
        }
    }
}

impl ProjectBuilder<FieldHasBeenSupplied, FieldHasBeenSupplied, FieldHasBeenSupplied> {
    pub fn build(self) -> ProjectCreationOutcome {
        let resolved_identifier = self
            .accumulated_identifier
            .expect("identifier presence is guaranteed by the type-state marker");
        let resolved_name = self
            .accumulated_name
            .expect("name presence is guaranteed by the type-state marker");
        let resolved_owner = self
            .accumulated_owner
            .expect("owner presence is guaranteed by the type-state marker");
        let birth_event =
            Project::author_creation_event(resolved_identifier, resolved_name, resolved_owner);
        let initial_aggregate = Project::apply_event(None, &birth_event)
            .expect("the creation event always yields an initialized aggregate");
        ProjectCreationOutcome {
            birth_event,
            initial_aggregate,
        }
    }
}
