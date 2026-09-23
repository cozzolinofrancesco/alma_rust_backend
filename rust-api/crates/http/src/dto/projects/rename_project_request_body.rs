use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct RenameProjectRequestBody {
    pub replacement_name: String,
}
