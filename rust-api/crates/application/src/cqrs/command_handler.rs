use crate::cqrs::command::Command;
use crate::error::ApplicationError;
use async_trait::async_trait;

#[async_trait]
pub trait CommandHandler<HandledCommand>: Send + Sync
where
    HandledCommand: Command,
{
    async fn handle_command(
        &self,
        command_to_handle: HandledCommand,
    ) -> Result<HandledCommand::CommandOutcome, ApplicationError>;
}
