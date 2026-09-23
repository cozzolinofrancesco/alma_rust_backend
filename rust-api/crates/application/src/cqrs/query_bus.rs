use crate::cqrs::query::Query;
use crate::cqrs::query_handler::QueryHandler;
use crate::error::ApplicationError;

pub struct QueryDispatchBus;

impl QueryDispatchBus {
    pub async fn dispatch_query<DispatchedQuery, ResolvingHandler>(
        resolving_handler: &ResolvingHandler,
        query_to_dispatch: DispatchedQuery,
    ) -> Result<DispatchedQuery::QueryOutcome, ApplicationError>
    where
        DispatchedQuery: Query,
        ResolvingHandler: QueryHandler<DispatchedQuery>,
    {
        resolving_handler.handle_query(query_to_dispatch).await
    }
}
