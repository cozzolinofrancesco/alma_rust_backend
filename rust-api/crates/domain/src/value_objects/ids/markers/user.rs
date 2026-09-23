use crate::value_objects::ids::entity_marker::EntityMarker;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct UserMarker;

impl EntityMarker for UserMarker {
    const ENTITY_NAME: &'static str = "user";
}
