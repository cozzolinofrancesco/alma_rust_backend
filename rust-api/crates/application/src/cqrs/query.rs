use crate::cqrs::sealed::SealedDispatchableMessage;

pub trait Query: SealedDispatchableMessage + Send + 'static {
    type QueryOutcome: Send + 'static;
}
