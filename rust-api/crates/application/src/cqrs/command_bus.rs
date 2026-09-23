use crate::cqrs::command::Command;
use crate::cqrs::command_handler::CommandHandler;
use crate::error::ApplicationError;

pub struct CommandDispatchBus;

impl CommandDispatchBus {
    pub async fn dispatch_command<DispatchedCommand, ResolvingHandler>(
        resolving_handler: &ResolvingHandler,
        command_to_dispatch: DispatchedCommand,
    ) -> Result<DispatchedCommand::CommandOutcome, ApplicationError>
    where
        DispatchedCommand: Command,
        ResolvingHandler: CommandHandler<DispatchedCommand>,
    {
        resolving_handler.handle_command(command_to_dispatch).await
    }
}
