use crate::value_objects::ids::entity_marker::EntityMarker;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CorpusMarker;

impl EntityMarker for CorpusMarker {
    const ENTITY_NAME: &'static str = "corpus";
}
