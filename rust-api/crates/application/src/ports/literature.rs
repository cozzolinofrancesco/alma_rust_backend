use crate::error::ApplicationError;
use alma_domain::value_objects::NonEmptyText;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicationSummary {
    pub publication_title: String,
    pub digital_object_identifier: Option<String>,
    pub originating_source: String,
}

#[async_trait]
pub trait LiteraturePort: Send + Sync {
    async fn search_publications(
        &self,
        search_expression: &NonEmptyText,
    ) -> Result<Vec<PublicationSummary>, ApplicationError>;
}
