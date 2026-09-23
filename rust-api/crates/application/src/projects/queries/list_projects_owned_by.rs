use crate::cqrs::{Query, QueryHandler, SealedDispatchableMessage};
use crate::error::ApplicationError;
use crate::ports::repository::ProjectRepository;
use crate::ports::unit_of_work::UnitOfWork;
use crate::projects::read_model::ProjectView;
use crate::support::lending::{LendingRecordCursor, OwnedRecordLendingCursor};
use alma_domain::projects::Project;
use alma_domain::value_objects::Email;
use async_trait::async_trait;
use std::sync::Arc;

pub struct ListProjectsOwnedByQuery {
    pub owning_account: Email,
}

impl SealedDispatchableMessage for ListProjectsOwnedByQuery {}

impl Query for ListProjectsOwnedByQuery {
    type QueryOutcome = Vec<ProjectView>;
}

pub struct ListProjectsOwnedByQueryHandler<TransactionalUnitOfWork>
where
    TransactionalUnitOfWork: UnitOfWork,
{
    transactional_unit_of_work: Arc<TransactionalUnitOfWork>,
}

impl<TransactionalUnitOfWork> ListProjectsOwnedByQueryHandler<TransactionalUnitOfWork>
where
    TransactionalUnitOfWork: UnitOfWork,
{
    pub fn construct_with(transactional_unit_of_work: Arc<TransactionalUnitOfWork>) -> Self {
        Self {
            transactional_unit_of_work,
        }
    }
}

#[async_trait]
impl<TransactionalUnitOfWork> QueryHandler<ListProjectsOwnedByQuery>
    for ListProjectsOwnedByQueryHandler<TransactionalUnitOfWork>
where
    TransactionalUnitOfWork: UnitOfWork,
{
    async fn handle_query(
        &self,
        query_to_handle: ListProjectsOwnedByQuery,
    ) -> Result<Vec<ProjectView>, ApplicationError> {
        let owning_account = query_to_handle.owning_account;

        let owned_snapshots = self
            .transactional_unit_of_work
            .execute_within_transaction(
                move |scoped_repository: &mut (dyn ProjectRepository + Send)| {
                    Box::pin(async move {
                        scoped_repository
                            .list_snapshots_owned_by(owning_account)
                            .await
                    })
                },
            )
            .await?;

        let mut lending_cursor: OwnedRecordLendingCursor<Project> =
            OwnedRecordLendingCursor::over(owned_snapshots);
        let mut accumulated_views: Vec<ProjectView> = Vec::new();
        while let Some(borrowed_snapshot) = lending_cursor.advance_to_next_record() {
            accumulated_views.push(ProjectView::project_from_aggregate(borrowed_snapshot));
        }
        Ok(accumulated_views)
    }
}
