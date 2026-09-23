use crate::value_objects::ids::identifier::Id;
use crate::value_objects::ids::markers::{CorpusMarker, ProjectMarker, UserMarker, VideoMarker};

pub type ProjectId = Id<ProjectMarker>;
pub type UserId = Id<UserMarker>;
pub type VideoId = Id<VideoMarker>;
pub type CorpusId = Id<CorpusMarker>;
