use crate::cqrs::query::Query;
use crate::error::ApplicationError;
use async_trait::async_trait;

#[async_trait]
pub trait QueryHandler<HandledQuery>: Send + Sync
where
    HandledQuery: Query,
{
    async fn handle_query(
        &self,
        query_to_handle: HandledQuery,
    ) -> Result<HandledQuery::QueryOutcome, ApplicationError>;
}
