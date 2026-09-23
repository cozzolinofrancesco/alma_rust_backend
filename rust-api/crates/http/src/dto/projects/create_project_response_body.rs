use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct CreateProjectResponseBody {
    pub project_identifier: String,
}
