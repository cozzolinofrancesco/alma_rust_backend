use crate::value_objects::ids::entity_marker::EntityMarker;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct VideoMarker;

impl EntityMarker for VideoMarker {
    const ENTITY_NAME: &'static str = "video";
}
