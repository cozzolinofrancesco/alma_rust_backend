use crate::cqrs::{Command, CommandHandler, SealedDispatchableMessage};
use crate::error::ApplicationError;
use crate::ports::repository::ProjectRepository;
use crate::ports::unit_of_work::UnitOfWork;
use alma_domain::projects::Project;
use alma_domain::value_objects::{Email, ProjectId, ProjectName};
use async_trait::async_trait;
use std::sync::Arc;

pub struct RenameProjectCommand {
    pub target_identifier: ProjectId,
    pub replacement_name: ProjectName,
    pub requesting_principal: Email,
}

impl SealedDispatchableMessage for RenameProjectCommand {}

impl Command for RenameProjectCommand {
    type CommandOutcome = ();
}

pub struct RenameProjectCommandHandler<TransactionalUnitOfWork>
where
    TransactionalUnitOfWork: UnitOfWork,
{
    transactional_unit_of_work: Arc<TransactionalUnitOfWork>,
}

impl<TransactionalUnitOfWork> RenameProjectCommandHandler<TransactionalUnitOfWork>
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
impl<TransactionalUnitOfWork> CommandHandler<RenameProjectCommand>
    for RenameProjectCommandHandler<TransactionalUnitOfWork>
where
    TransactionalUnitOfWork: UnitOfWork,
{
    async fn handle_command(
        &self,
        command_to_handle: RenameProjectCommand,
    ) -> Result<(), ApplicationError> {
        let target_identifier = command_to_handle.target_identifier;
        let replacement_name = command_to_handle.replacement_name;
        let requesting_principal = command_to_handle.requesting_principal;

        self.transactional_unit_of_work
            .execute_within_transaction(
                move |scoped_repository: &mut (dyn ProjectRepository + Send)| {
                    Box::pin(async move {
                        let recorded_events = scoped_repository
                            .load_recorded_events(target_identifier)
                            .await?;
                        let rehydrated_aggregate =
                            Project::rehydrate_from_event_stream(&recorded_events)
                                .ok_or(ApplicationError::RequestedProjectCouldNotBeLocated)?;
                        let owning_account = Project::owner_lens().get(&rehydrated_aggregate);
                        if owning_account != requesting_principal {
                            return Err(ApplicationError::AuthorizationWasDenied);
                        }
                        let rename_event =
                            rehydrated_aggregate.author_rename_event(replacement_name)?;
                        scoped_repository
                            .append_recorded_events(target_identifier, vec![rename_event])
                            .await?;
                        Ok(())
                    })
                },
            )
            .await
    }
}
