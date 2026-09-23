use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct RenameProjectResponseBody {
    pub project_identifier: String,
    pub acknowledgement: String,
}
