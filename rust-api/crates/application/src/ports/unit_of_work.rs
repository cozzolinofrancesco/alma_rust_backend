use crate::error::ApplicationError;
use crate::ports::repository::ProjectRepository;
use async_trait::async_trait;
use std::future::Future;
use std::pin::Pin;

pub type ScopedTransactionFuture<'transaction_scope, ProducedOutcome> = Pin<
    Box<dyn Future<Output = Result<ProducedOutcome, ApplicationError>> + Send + 'transaction_scope>,
>;

#[async_trait]
pub trait UnitOfWork: Send + Sync {
    async fn execute_within_transaction<TransactionalOperation, ProducedOutcome>(
        &self,
        transactional_operation: TransactionalOperation,
    ) -> Result<ProducedOutcome, ApplicationError>
    where
        ProducedOutcome: Send + 'static,
        TransactionalOperation: for<'transaction_scope> FnOnce(
                &'transaction_scope mut (dyn ProjectRepository + Send),
            ) -> ScopedTransactionFuture<
                'transaction_scope,
                ProducedOutcome,
            > + Send
            + 'static;
}
