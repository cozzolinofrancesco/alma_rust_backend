use crate::cqrs::{Query, QueryHandler, SealedDispatchableMessage};
use crate::error::ApplicationError;
use crate::ports::repository::ProjectRepository;
use crate::ports::unit_of_work::UnitOfWork;
use crate::projects::read_model::ProjectView;
use alma_domain::projects::Project;
use alma_domain::value_objects::{Email, ProjectId};
use async_trait::async_trait;
use std::sync::Arc;

pub struct LoadProjectQuery {
    pub target_identifier: ProjectId,
    pub requesting_principal: Email,
}

impl SealedDispatchableMessage for LoadProjectQuery {}

impl Query for LoadProjectQuery {
    type QueryOutcome = Option<ProjectView>;
}

pub struct LoadProjectQueryHandler<TransactionalUnitOfWork>
where
    TransactionalUnitOfWork: UnitOfWork,
{
    transactional_unit_of_work: Arc<TransactionalUnitOfWork>,
}

impl<TransactionalUnitOfWork> LoadProjectQueryHandler<TransactionalUnitOfWork>
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
impl<TransactionalUnitOfWork> QueryHandler<LoadProjectQuery>
    for LoadProjectQueryHandler<TransactionalUnitOfWork>
where
    TransactionalUnitOfWork: UnitOfWork,
{
    async fn handle_query(
        &self,
        query_to_handle: LoadProjectQuery,
    ) -> Result<Option<ProjectView>, ApplicationError> {
        let target_identifier = query_to_handle.target_identifier;
        let requesting_principal = query_to_handle.requesting_principal;

        self.transactional_unit_of_work
            .execute_within_transaction(
                move |scoped_repository: &mut (dyn ProjectRepository + Send)| {
                    Box::pin(async move {
                        let recorded_events = scoped_repository
                            .load_recorded_events(target_identifier)
                            .await?;
                        let rehydrated_aggregate =
                            Project::rehydrate_from_event_stream(&recorded_events);
                        let projected_view = match rehydrated_aggregate {
                            Some(ref located_aggregate) => {
                                let owning_account = Project::owner_lens().get(located_aggregate);
                                if owning_account == requesting_principal {
                                    Some(ProjectView::project_from_aggregate(located_aggregate))
                                } else {
                                    None
                                }
                            }
                            None => None,
                        };
                        Ok(projected_view)
                    })
                },
            )
            .await
    }
}
