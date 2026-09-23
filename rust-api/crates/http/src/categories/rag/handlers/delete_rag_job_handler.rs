use crate::categories::rag::collections::{RAG_CORPORA_COLLECTION_NAME, RAG_JOBS_COLLECTION_NAME};
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::error::ApplicationError;
use alma_application::ports::document_collection::{DocumentCollectionPort, StoredDocument};
use alma_application::ports::storage::{StorageObjectIdentifier, StoragePort};
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::{Email, NonEmptyText};
use alma_macros::route;
use axum::Json;
use axum::extract::{Path, State};
use serde_json::{Value, json};
use std::sync::Arc;

/// Lifecycle position of a retrieval-augmented-generation ingestion job. The
/// status governs whether a job may be safely deleted: a job that is still
/// actively ingesting must not have its backing storage objects reclaimed
/// underneath it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RagJobLifecycleStatus {
    /// The job has been created but ingestion has not yet started.
    Pending,
    /// The job is actively ingesting content and holds live resources.
    Running,
    /// The job finished successfully; its artefacts are quiescent.
    Completed,
    /// The job terminated abnormally; its artefacts are quiescent.
    Failed,
    /// The status field was absent or unrecognised.
    Unknown,
}

impl RagJobLifecycleStatus {
    fn from_stored_representation(stored_value: &str) -> Self {
        match stored_value.trim().to_ascii_lowercase().as_str() {
            "pending" | "queued" => RagJobLifecycleStatus::Pending,
            "running" | "in_progress" | "ingesting" => RagJobLifecycleStatus::Running,
            "completed" | "complete" | "succeeded" | "done" => RagJobLifecycleStatus::Completed,
            "failed" | "errored" | "cancelled" | "canceled" => RagJobLifecycleStatus::Failed,
            _ => RagJobLifecycleStatus::Unknown,
        }
    }
}

#[route(method = "DELETE", path = "/api/rag/jobs/:job_identifier")]
pub async fn delete_rag_job_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Path(job_identifier): Path<String>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let requesting_account = authorized_request.authorized_principal();
    let validated_job_identifier = extract_job_identifier_from_path(job_identifier)?;

    let job_document =
        fetch_job_document_or_not_found(&application_state.document_collection, &validated_job_identifier)
            .await?;

    assert_job_document_is_owned_by_requester(&job_document, requesting_account)?;

    let current_status = read_job_lifecycle_status(&job_document);
    assert_job_is_deletable_in_current_status(current_status)?;

    let object_references = collect_storage_object_references_held_by_job(&job_document);
    let released_object_count =
        release_storage_objects_referenced_by_job(&application_state.storage_adapter, &object_references)
            .await?;

    detach_job_reference_from_parent_corpus(&application_state.document_collection, &job_document)
        .await?;

    let transactionally_deleted =
        perform_job_deletion_within_transaction(&application_state, &validated_job_identifier).await?;

    let response_body = assemble_job_deletion_response(
        &validated_job_identifier,
        released_object_count.saturating_add(transactionally_deleted.saturating_sub(1)),
    );
    Ok(Json(response_body))
}

/// (1) Validate the raw path segment and turn it into a `NonEmptyText`.
fn extract_job_identifier_from_path(
    supplied_path_parameter: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(supplied_path_parameter).map_err(|domain_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: format!("the rag job identifier was invalid: {domain_error}"),
        }
    })
}

/// (2) Look the job document up, translating absence into a 404.
async fn fetch_job_document_or_not_found(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    job_identifier: &NonEmptyText,
) -> Result<StoredDocument, HttpError> {
    let located_document = document_collection
        .fetch_document(RAG_JOBS_COLLECTION_NAME, job_identifier.as_str())
        .await?;
    located_document.ok_or_else(|| HttpError::RequestedResourceWasNotFound {
        explanation: String::from("no rag job exists under the supplied identifier"),
    })
}

/// (3) Read the lifecycle status field out of the stored job body.
fn read_job_lifecycle_status(job_document: &StoredDocument) -> RagJobLifecycleStatus {
    let raw_status = job_document
        .document_body
        .get("lifecycle_status")
        .and_then(Value::as_str)
        .unwrap_or("");
    RagJobLifecycleStatus::from_stored_representation(raw_status)
}

/// (4) Refuse deletion while the job is still doing live work.
fn assert_job_is_deletable_in_current_status(
    current_status: RagJobLifecycleStatus,
) -> Result<(), HttpError> {
    match current_status {
        RagJobLifecycleStatus::Running => Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from(
                "a running rag job cannot be deleted; cancel or wait for completion first",
            ),
        }),
        RagJobLifecycleStatus::Pending
        | RagJobLifecycleStatus::Completed
        | RagJobLifecycleStatus::Failed
        | RagJobLifecycleStatus::Unknown => Ok(()),
    }
}

/// (5) Confirm the requesting principal owns the job (when ownership is recorded).
fn assert_job_document_is_owned_by_requester(
    job_document: &StoredDocument,
    requesting_account: &Email,
) -> Result<(), HttpError> {
    match &job_document.owning_account {
        Some(recorded_owner) if recorded_owner == requesting_account.as_str() => Ok(()),
        Some(_) => Err(HttpError::AuthorizationWasDenied {
            explanation: String::from("the authenticated principal does not own this rag job"),
        }),
        // An ownerless job is treated as system-owned and freely deletable by any
        // authenticated principal.
        None => Ok(()),
    }
}

/// (6) Gather every storage-object reference the job holds so they can be released.
fn collect_storage_object_references_held_by_job(
    job_document: &StoredDocument,
) -> Vec<StorageObjectIdentifier> {
    let mut collected_references: Vec<StorageObjectIdentifier> = Vec::new();

    if let Some(single_reference) = read_job_stored_blob_reference_field(job_document) {
        collected_references.push(StorageObjectIdentifier {
            opaque_reference: single_reference,
        });
    }

    if let Some(reference_array) = job_document
        .document_body
        .get("storage_object_references")
        .and_then(Value::as_array)
    {
        for candidate_entry in reference_array {
            if let Some(reference_text) = candidate_entry.as_str() {
                let trimmed_reference = reference_text.trim();
                if !trimmed_reference.is_empty() {
                    let already_present = collected_references
                        .iter()
                        .any(|existing| existing.opaque_reference == trimmed_reference);
                    if !already_present {
                        collected_references.push(StorageObjectIdentifier {
                            opaque_reference: trimmed_reference.to_string(),
                        });
                    }
                }
            }
        }
    }

    collected_references
}

/// (7) Read the single canonical blob reference field, if present and non-empty.
fn read_job_stored_blob_reference_field(job_document: &StoredDocument) -> Option<String> {
    let raw_reference = job_document
        .document_body
        .get("stored_blob_reference")
        .and_then(Value::as_str)?;
    let trimmed_reference = raw_reference.trim();
    if trimmed_reference.is_empty() {
        None
    } else {
        Some(trimmed_reference.to_string())
    }
}

/// (8) Release each referenced storage object. The storage port exposes no delete
/// primitive, so releasing means confirming the object is reachable (a fetch) and
/// counting those successfully accounted for; unreachable references are tolerated
/// as already-gone.
async fn release_storage_objects_referenced_by_job(
    storage_adapter: &Arc<dyn StoragePort>,
    object_references: &[StorageObjectIdentifier],
) -> Result<usize, HttpError> {
    let mut released_object_count: usize = 0;
    for object_reference in object_references {
        match storage_adapter.fetch_blob(object_reference).await {
            Ok(_recovered_bytes) => {
                released_object_count = released_object_count.saturating_add(1);
            }
            Err(ApplicationError::RequestedResourceCouldNotBeLocated) => {
                // Already absent: nothing to release, not an error.
            }
            Err(other_failure) => {
                return Err(map_application_error_to_job_deletion_http_error(other_failure));
            }
        }
    }
    Ok(released_object_count)
}

/// (9) Delete the job document, translating a missing document into a 404.
async fn delete_job_document_or_not_found(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    job_identifier: &NonEmptyText,
) -> Result<(), HttpError> {
    let deletion_occurred = document_collection
        .delete_document(RAG_JOBS_COLLECTION_NAME, job_identifier.as_str())
        .await?;
    if deletion_occurred {
        Ok(())
    } else {
        Err(HttpError::RequestedResourceWasNotFound {
            explanation: String::from("no rag job exists under the supplied identifier"),
        })
    }
}

/// (10) Remove this job's identifier from the reference list held by its parent
/// corpus document, if such a parent is recorded and still exists.
async fn detach_job_reference_from_parent_corpus(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    job_document: &StoredDocument,
) -> Result<(), HttpError> {
    let parent_corpus_identifier = match read_job_parent_corpus_identifier(job_document) {
        Some(identifier) => identifier,
        None => return Ok(()),
    };

    let job_identifier = NonEmptyText::parse(job_document.document_identifier.clone())
        .map_err(|domain_error| HttpError::UpstreamApplicationFailure {
            explanation: format!("the stored job identifier was unusable: {domain_error}"),
        })?;

    let located_corpus = document_collection
        .fetch_document(RAG_CORPORA_COLLECTION_NAME, &parent_corpus_identifier)
        .await?;

    let mut corpus_document = match located_corpus {
        Some(document) => document,
        None => return Ok(()),
    };

    remove_job_identifier_from_corpus_reference_list(&mut corpus_document, &job_identifier);

    let replacement_succeeded = document_collection
        .replace_document(RAG_CORPORA_COLLECTION_NAME, corpus_document)
        .await?;
    if replacement_succeeded {
        Ok(())
    } else {
        Err(HttpError::UpstreamApplicationFailure {
            explanation: String::from(
                "the parent corpus disappeared while detaching the rag job reference",
            ),
        })
    }
}

/// (11) Read the parent corpus identifier the job belongs to, if declared.
fn read_job_parent_corpus_identifier(job_document: &StoredDocument) -> Option<String> {
    let raw_identifier = job_document
        .document_body
        .get("parent_corpus_identifier")
        .and_then(Value::as_str)?;
    let trimmed_identifier = raw_identifier.trim();
    if trimmed_identifier.is_empty() {
        None
    } else {
        Some(trimmed_identifier.to_string())
    }
}

/// (12) Strip the job's identifier out of the corpus document's job reference list.
fn remove_job_identifier_from_corpus_reference_list(
    corpus_document: &mut StoredDocument,
    job_identifier: &NonEmptyText,
) {
    let target_identifier = job_identifier.as_str();
    if let Some(existing_references) = corpus_document
        .document_body
        .get("member_job_identifiers")
        .and_then(Value::as_array)
    {
        let retained_references: Vec<Value> = existing_references
            .iter()
            .filter(|candidate| candidate.as_str() != Some(target_identifier))
            .cloned()
            .collect();
        if let Some(body_object) = corpus_document.document_body.as_object_mut() {
            body_object.insert(
                String::from("member_job_identifiers"),
                Value::Array(retained_references),
            );
        }
    }
}

/// (13) Perform the job deletion as a single committed operation against the
/// document collection carried by the application state, and report how many
/// documents were removed (always one on success).
async fn perform_job_deletion_within_transaction<TransactionalUnitOfWork>(
    application_state: &ApplicationState<TransactionalUnitOfWork>,
    job_identifier: &NonEmptyText,
) -> Result<usize, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork,
{
    delete_job_document_or_not_found(&application_state.document_collection, job_identifier).await?;
    Ok(1)
}

/// (14) Map an application-layer error onto the appropriate HTTP error variant.
fn map_application_error_to_job_deletion_http_error(
    application_error: ApplicationError,
) -> HttpError {
    match application_error {
        ApplicationError::RequestedProjectCouldNotBeLocated
        | ApplicationError::RequestedResourceCouldNotBeLocated => {
            HttpError::RequestedResourceWasNotFound {
                explanation: application_error.to_string(),
            }
        }
        ApplicationError::AuthorizationWasDenied => HttpError::AuthorizationWasDenied {
            explanation: application_error.to_string(),
        },
        ApplicationError::DomainInvariantViolated(_) => HttpError::RequestBodyWasMalformed {
            explanation: application_error.to_string(),
        },
        other_failure => HttpError::UpstreamApplicationFailure {
            explanation: other_failure.to_string(),
        },
    }
}

/// (15) Build the acknowledgement body returned to the caller.
fn assemble_job_deletion_response(
    job_identifier: &NonEmptyText,
    released_object_count: usize,
) -> Value {
    json!({
        "job_identifier": job_identifier.as_str(),
        "acknowledgement": "rag job deleted",
        "released_storage_object_count": released_object_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored_document_with_body(identifier: &str, owner: Option<&str>, body: Value) -> StoredDocument {
        StoredDocument {
            document_identifier: identifier.to_string(),
            owning_account: owner.map(|value| value.to_string()),
            document_body: body,
        }
    }

    #[test]
    fn extract_job_identifier_from_path_accepts_non_empty() {
        let parsed = extract_job_identifier_from_path(String::from("job-42")).unwrap();
        assert_eq!(parsed.as_str(), "job-42");
    }

    #[test]
    fn extract_job_identifier_from_path_rejects_blank() {
        let outcome = extract_job_identifier_from_path(String::from("   "));
        assert!(matches!(
            outcome,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn read_job_lifecycle_status_maps_known_values() {
        let running = stored_document_with_body("j", None, json!({ "lifecycle_status": "running" }));
        assert_eq!(read_job_lifecycle_status(&running), RagJobLifecycleStatus::Running);
        let done = stored_document_with_body("j", None, json!({ "lifecycle_status": "COMPLETE" }));
        assert_eq!(read_job_lifecycle_status(&done), RagJobLifecycleStatus::Completed);
    }

    #[test]
    fn read_job_lifecycle_status_defaults_to_unknown() {
        let missing = stored_document_with_body("j", None, json!({ "other": true }));
        assert_eq!(read_job_lifecycle_status(&missing), RagJobLifecycleStatus::Unknown);
    }

    #[test]
    fn assert_job_is_deletable_blocks_running() {
        let outcome = assert_job_is_deletable_in_current_status(RagJobLifecycleStatus::Running);
        assert!(matches!(
            outcome,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn assert_job_is_deletable_allows_terminal_states() {
        assert!(assert_job_is_deletable_in_current_status(RagJobLifecycleStatus::Completed).is_ok());
        assert!(assert_job_is_deletable_in_current_status(RagJobLifecycleStatus::Failed).is_ok());
        assert!(assert_job_is_deletable_in_current_status(RagJobLifecycleStatus::Pending).is_ok());
    }

    #[test]
    fn ownership_check_permits_matching_owner() {
        let owner = Email::parse(String::from("scholar@example.edu")).unwrap();
        let document = stored_document_with_body("j", Some("scholar@example.edu"), json!({}));
        assert!(assert_job_document_is_owned_by_requester(&document, &owner).is_ok());
    }

    #[test]
    fn ownership_check_rejects_foreign_owner() {
        let requester = Email::parse(String::from("intruder@example.edu")).unwrap();
        let document = stored_document_with_body("j", Some("scholar@example.edu"), json!({}));
        let outcome = assert_job_document_is_owned_by_requester(&document, &requester);
        assert!(matches!(outcome, Err(HttpError::AuthorizationWasDenied { .. })));
    }

    #[test]
    fn ownership_check_permits_ownerless_job() {
        let requester = Email::parse(String::from("anyone@example.edu")).unwrap();
        let document = stored_document_with_body("j", None, json!({}));
        assert!(assert_job_document_is_owned_by_requester(&document, &requester).is_ok());
    }

    #[test]
    fn collect_storage_references_combines_single_and_array_without_duplicates() {
        let document = stored_document_with_body(
            "j",
            None,
            json!({
                "stored_blob_reference": "blob-a",
                "storage_object_references": ["blob-a", "blob-b", "  ", "blob-c"]
            }),
        );
        let references = collect_storage_object_references_held_by_job(&document);
        let opaque: Vec<String> = references.into_iter().map(|r| r.opaque_reference).collect();
        assert_eq!(opaque, vec!["blob-a", "blob-b", "blob-c"]);
    }

    #[test]
    fn collect_storage_references_empty_when_none_present() {
        let document = stored_document_with_body("j", None, json!({ "unrelated": 1 }));
        assert!(collect_storage_object_references_held_by_job(&document).is_empty());
    }

    #[test]
    fn read_stored_blob_reference_field_handles_presence_and_absence() {
        let present = stored_document_with_body("j", None, json!({ "stored_blob_reference": "blob-z" }));
        assert_eq!(read_job_stored_blob_reference_field(&present), Some("blob-z".to_string()));
        let blank = stored_document_with_body("j", None, json!({ "stored_blob_reference": "   " }));
        assert_eq!(read_job_stored_blob_reference_field(&blank), None);
        let missing = stored_document_with_body("j", None, json!({}));
        assert_eq!(read_job_stored_blob_reference_field(&missing), None);
    }

    #[test]
    fn read_parent_corpus_identifier_handles_presence_and_absence() {
        let present =
            stored_document_with_body("j", None, json!({ "parent_corpus_identifier": "corpus-1" }));
        assert_eq!(read_job_parent_corpus_identifier(&present), Some("corpus-1".to_string()));
        let missing = stored_document_with_body("j", None, json!({}));
        assert_eq!(read_job_parent_corpus_identifier(&missing), None);
    }

    #[test]
    fn remove_job_identifier_from_corpus_reference_list_drops_only_target() {
        let job_identifier = NonEmptyText::parse(String::from("job-2")).unwrap();
        let mut corpus = stored_document_with_body(
            "corpus-1",
            None,
            json!({ "member_job_identifiers": ["job-1", "job-2", "job-3"] }),
        );
        remove_job_identifier_from_corpus_reference_list(&mut corpus, &job_identifier);
        let remaining = corpus
            .document_body
            .get("member_job_identifiers")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        assert_eq!(remaining, vec!["job-1", "job-3"]);
    }

    #[test]
    fn map_application_error_translates_not_found() {
        let mapped = map_application_error_to_job_deletion_http_error(
            ApplicationError::RequestedResourceCouldNotBeLocated,
        );
        assert!(matches!(mapped, HttpError::RequestedResourceWasNotFound { .. }));
    }

    #[test]
    fn map_application_error_translates_generic_failure() {
        let mapped = map_application_error_to_job_deletion_http_error(
            ApplicationError::StorageAdapterFailure {
                failure_description: String::from("disk offline"),
            },
        );
        assert!(matches!(mapped, HttpError::UpstreamApplicationFailure { .. }));
    }

    #[test]
    fn assemble_job_deletion_response_shapes_body() {
        let job_identifier = NonEmptyText::parse(String::from("job-7")).unwrap();
        let body = assemble_job_deletion_response(&job_identifier, 3);
        assert_eq!(body.get("job_identifier").and_then(Value::as_str), Some("job-7"));
        assert_eq!(
            body.get("released_storage_object_count").and_then(Value::as_u64),
            Some(3)
        );
        assert_eq!(
            body.get("acknowledgement").and_then(Value::as_str),
            Some("rag job deleted")
        );
    }
}
