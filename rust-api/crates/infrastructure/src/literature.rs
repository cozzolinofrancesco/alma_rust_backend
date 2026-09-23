use alma_application::error::ApplicationError;
use alma_application::ports::literature::{LiteraturePort, PublicationSummary};
use alma_domain::value_objects::NonEmptyText;
use async_trait::async_trait;

pub struct CannedLiteratureSourceAdapter {
    advertised_source_name: String,
}

impl CannedLiteratureSourceAdapter {
    pub fn construct_with_source_name(advertised_source_name: String) -> Self {
        Self {
            advertised_source_name,
        }
    }
}

impl Default for CannedLiteratureSourceAdapter {
    fn default() -> Self {
        Self::construct_with_source_name(String::from("canned-source"))
    }
}

#[async_trait]
impl LiteraturePort for CannedLiteratureSourceAdapter {
    async fn search_publications(
        &self,
        search_expression: &NonEmptyText,
    ) -> Result<Vec<PublicationSummary>, ApplicationError> {
        Ok(vec![PublicationSummary {
            publication_title: format!("result for query '{}'", search_expression.as_str()),
            digital_object_identifier: Some(String::from("10.0000/canned")),
            originating_source: self.advertised_source_name.clone(),
        }])
    }
}
