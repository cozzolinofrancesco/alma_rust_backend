use crate::value_objects::ids::entity_marker::EntityMarker;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ProjectMarker;

impl EntityMarker for ProjectMarker {
    const ENTITY_NAME: &'static str = "project";
}
