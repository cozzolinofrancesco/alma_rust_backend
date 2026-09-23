use crate::cqrs::sealed::SealedDispatchableMessage;

pub trait Command: SealedDispatchableMessage + Send + 'static {
    type CommandOutcome: Send + 'static;
}
