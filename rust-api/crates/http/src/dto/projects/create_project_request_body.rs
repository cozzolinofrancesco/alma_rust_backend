use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct CreateProjectRequestBody {
    pub project_name: String,
}
