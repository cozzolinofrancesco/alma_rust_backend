use alma_application::error::ApplicationError;
use alma_application::ports::repository::ProjectRepository;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::projects::{Project, ProjectEvent};
use alma_domain::value_objects::{Email, ProjectId};
use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[derive(Debug, Clone, Default)]
pub struct InMemoryEventStoreState {
    recorded_events_indexed_by_project: HashMap<Uuid, Vec<ProjectEvent>>,
}

pub struct InMemoryTransactionalProjectRepository {
    isolated_working_copy: InMemoryEventStoreState,
}

#[async_trait]
impl ProjectRepository for InMemoryTransactionalProjectRepository {
    async fn load_recorded_events(
        &mut self,
        project_identifier: ProjectId,
    ) -> Result<Vec<ProjectEvent>, ApplicationError> {
        let lookup_key = *project_identifier.as_uuid();
        let recorded_events = self
            .isolated_working_copy
            .recorded_events_indexed_by_project
            .get(&lookup_key)
            .cloned()
            .unwrap_or_default();
        Ok(recorded_events)
    }

    async fn append_recorded_events(
        &mut self,
        project_identifier: ProjectId,
        newly_authored_events: Vec<ProjectEvent>,
    ) -> Result<(), ApplicationError> {
        let lookup_key = *project_identifier.as_uuid();
        let entry_for_project = self
            .isolated_working_copy
            .recorded_events_indexed_by_project
            .entry(lookup_key)
            .or_default();
        entry_for_project.extend(newly_authored_events);
        Ok(())
    }

    async fn list_snapshots_owned_by(
        &mut self,
        owning_account: Email,
    ) -> Result<Vec<Project>, ApplicationError> {
        let owner_focusing_lens = Project::owner_lens();
        let mut matching_snapshots: Vec<Project> = Vec::new();
        for recorded_events in self
            .isolated_working_copy
            .recorded_events_indexed_by_project
            .values()
        {
            if let Some(rehydrated_aggregate) =
                Project::rehydrate_from_event_stream(recorded_events)
            {
                let aggregate_owner = owner_focusing_lens.get(&rehydrated_aggregate);
                if aggregate_owner == owning_account {
                    matching_snapshots.push(rehydrated_aggregate);
                }
            }
        }
        Ok(matching_snapshots)
    }
}

pub struct InMemoryUnitOfWork {
    shared_event_store_state: Arc<Mutex<InMemoryEventStoreState>>,
}

impl InMemoryUnitOfWork {
    pub fn construct_empty() -> Self {
        Self {
            shared_event_store_state: Arc::new(Mutex::new(InMemoryEventStoreState::default())),
        }
    }
}

impl Default for InMemoryUnitOfWork {
    fn default() -> Self {
        Self::construct_empty()
    }
}

#[async_trait]
impl UnitOfWork for InMemoryUnitOfWork {
    async fn execute_within_transaction<TransactionalOperation, ProducedOutcome>(
        &self,
        transactional_operation: TransactionalOperation,
    ) -> Result<ProducedOutcome, ApplicationError>
    where
        ProducedOutcome: Send + 'static,
        TransactionalOperation: for<'transaction_scope> FnOnce(
                &'transaction_scope mut (dyn ProjectRepository + Send),
            ) -> alma_application::ports::unit_of_work::ScopedTransactionFuture<
                'transaction_scope,
                ProducedOutcome,
            > + Send
            + 'static,
    {
        let isolated_working_copy = {
            let acquired_guard = self
                .shared_event_store_state
                .lock()
                .expect("the in-memory event store mutex was poisoned");
            acquired_guard.clone()
        };

        let mut scoped_repository = InMemoryTransactionalProjectRepository {
            isolated_working_copy,
        };

        let produced_outcome = transactional_operation(&mut scoped_repository).await?;

        let mut acquired_guard = self
            .shared_event_store_state
            .lock()
            .expect("the in-memory event store mutex was poisoned");
        *acquired_guard = scoped_repository.isolated_working_copy;

        Ok(produced_outcome)
    }
}
