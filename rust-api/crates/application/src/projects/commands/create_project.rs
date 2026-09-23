use crate::cqrs::{Command, CommandHandler, SealedDispatchableMessage};
use crate::error::ApplicationError;
use crate::ports::repository::ProjectRepository;
use crate::ports::unit_of_work::UnitOfWork;
use alma_domain::builders::{ProjectBuilder, ProjectCreationOutcome};
use alma_domain::projects::Project;
use alma_domain::value_objects::{Email, ProjectId, ProjectName};
use async_trait::async_trait;
use std::sync::Arc;

pub struct CreateProjectCommand {
    pub requested_identifier: ProjectId,
    pub requested_name: ProjectName,
    pub requested_owner: Email,
}

impl SealedDispatchableMessage for CreateProjectCommand {}

impl Command for CreateProjectCommand {
    type CommandOutcome = ProjectId;
}

pub struct CreateProjectCommandHandler<TransactionalUnitOfWork>
where
    TransactionalUnitOfWork: UnitOfWork,
{
    transactional_unit_of_work: Arc<TransactionalUnitOfWork>,
}

impl<TransactionalUnitOfWork> CreateProjectCommandHandler<TransactionalUnitOfWork>
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
impl<TransactionalUnitOfWork> CommandHandler<CreateProjectCommand>
    for CreateProjectCommandHandler<TransactionalUnitOfWork>
where
    TransactionalUnitOfWork: UnitOfWork,
{
    async fn handle_command(
        &self,
        command_to_handle: CreateProjectCommand,
    ) -> Result<ProjectId, ApplicationError> {
        let ProjectCreationOutcome {
            birth_event,
            initial_aggregate,
        } = ProjectBuilder::begin()
            .with_identifier(command_to_handle.requested_identifier)
            .with_name(command_to_handle.requested_name)
            .with_owner(command_to_handle.requested_owner)
            .build();

        let persisted_identifier = Project::identifier_lens().get(&initial_aggregate);
        let events_to_persist = vec![birth_event];

        self.transactional_unit_of_work
            .execute_within_transaction(
                move |scoped_repository: &mut (dyn ProjectRepository + Send)| {
                    Box::pin(async move {
                        scoped_repository
                            .append_recorded_events(persisted_identifier, events_to_persist)
                            .await?;
                        Ok(persisted_identifier)
                    })
                },
            )
            .await
    }
}
