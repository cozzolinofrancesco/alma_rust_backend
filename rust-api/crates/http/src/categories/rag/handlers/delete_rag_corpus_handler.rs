use crate::categories::rag::collections::{
    RAG_CORPORA_COLLECTION_NAME, RAG_JOBS_COLLECTION_NAME, RAG_KNOWLEDGE_COLLECTION_NAME,
};
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::error::ApplicationError;
use alma_application::ports::document_collection::{DocumentCollectionPort, StoredDocument};
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::{Email, NonEmptyText};
use alma_macros::route;
use axum::Json;
use axum::extract::{Path, State};
use serde_json::{Value, json};
use std::sync::Arc;

/// Aggregated result of a cascading corpus deletion, reported back to the caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CorpusDeletionOutcome {
    pub deleted_job_count: usize,
    pub deleted_knowledge_count: usize,
}

#[route(method = "DELETE", path = "/api/rag/corpora/:corpus_identifier")]
pub async fn delete_rag_corpus_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Path(corpus_identifier): Path<String>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let validated_corpus_identifier = extract_corpus_identifier_from_path(corpus_identifier)?;
    let requesting_account = authorized_request.authorized_principal();

    // Confirm the corpus exists and that the caller owns it before touching anything.
    let corpus_document =
        fetch_corpus_document_or_not_found(&application_state.document_collection, &validated_corpus_identifier)
            .await?;
    assert_corpus_document_is_owned_by_requester(&corpus_document, requesting_account)?;

    let deletion_outcome = perform_cascading_corpus_deletion_within_transaction(
        &application_state,
        &validated_corpus_identifier,
        &corpus_document,
    )
    .await?;

    Ok(Json(assemble_corpus_deletion_response(
        &validated_corpus_identifier,
        &deletion_outcome,
    )))
}

/// (1) Parse the raw path segment into a validated, non-empty corpus identifier.
fn extract_corpus_identifier_from_path(
    supplied_path_parameter: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(supplied_path_parameter).map_err(|domain_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: format!("the supplied corpus identifier was invalid: {domain_error}"),
        }
    })
}

/// (2) Fetch the corpus document, translating a missing corpus into a 404-style error.
async fn fetch_corpus_document_or_not_found(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    corpus_identifier: &NonEmptyText,
) -> Result<StoredDocument, HttpError> {
    let maybe_corpus_document = document_collection
        .fetch_document(RAG_CORPORA_COLLECTION_NAME, corpus_identifier.as_str())
        .await
        .map_err(map_application_error_to_deletion_http_error)?;

    maybe_corpus_document.ok_or_else(|| HttpError::RequestedResourceWasNotFound {
        explanation: String::from("no rag corpus exists under the supplied identifier"),
    })
}

/// (3) Enforce that the authenticated principal owns the corpus before mutating it.
fn assert_corpus_document_is_owned_by_requester(
    corpus_document: &StoredDocument,
    requesting_account: &Email,
) -> Result<(), HttpError> {
    match read_corpus_owning_account(corpus_document) {
        Some(owning_account) if owning_account == requesting_account.as_str() => Ok(()),
        Some(_) => Err(HttpError::AuthorizationWasDenied {
            explanation: String::from(
                "the authenticated principal does not own the requested rag corpus",
            ),
        }),
        None => Err(HttpError::AuthorizationWasDenied {
            explanation: String::from("the requested rag corpus has no recorded owner"),
        }),
    }
}

/// (4) Read the owning account recorded on a corpus document, if any.
fn read_corpus_owning_account(corpus_document: &StoredDocument) -> Option<String> {
    if let Some(owning_account) = &corpus_document.owning_account {
        return Some(owning_account.clone());
    }
    corpus_document
        .document_body
        .get("owning_account")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// (5) Collect explicit child job identifiers listed inside the corpus document body.
fn collect_child_job_identifiers_referenced_by_corpus(
    corpus_document: &StoredDocument,
) -> Vec<String> {
    let mut referenced_job_identifiers = Vec::new();
    if let Some(job_array) = corpus_document
        .document_body
        .get("job_identifiers")
        .and_then(Value::as_array)
    {
        for job_entry in job_array {
            if let Some(job_identifier) = job_entry.as_str() {
                let trimmed_identifier = job_identifier.trim();
                if !trimmed_identifier.is_empty() {
                    referenced_job_identifiers.push(trimmed_identifier.to_owned());
                }
            }
        }
    }
    referenced_job_identifiers
}

/// (6) Load every job document whose body references the corpus being deleted.
async fn load_jobs_belonging_to_corpus(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    corpus_identifier: &NonEmptyText,
) -> Result<Vec<StoredDocument>, HttpError> {
    let all_job_documents = document_collection
        .list_documents(RAG_JOBS_COLLECTION_NAME)
        .await
        .map_err(map_application_error_to_deletion_http_error)?;

    let jobs_belonging_to_corpus = all_job_documents
        .into_iter()
        .filter(|job_document| does_job_document_reference_corpus(job_document, corpus_identifier))
        .collect();
    Ok(jobs_belonging_to_corpus)
}

/// (7) Decide whether a single job document references the given corpus.
fn does_job_document_reference_corpus(
    job_document: &StoredDocument,
    corpus_identifier: &NonEmptyText,
) -> bool {
    let target_identifier = corpus_identifier.as_str();

    if let Some(direct_reference) = job_document
        .document_body
        .get("corpus_identifier")
        .and_then(Value::as_str)
    {
        if direct_reference == target_identifier {
            return true;
        }
    }

    job_document
        .document_body
        .get("submission")
        .and_then(|submission| submission.get("corpus_identifier"))
        .and_then(Value::as_str)
        .map(|nested_reference| nested_reference == target_identifier)
        .unwrap_or(false)
}

/// (8) Delete each supplied job document, counting how many were actually removed.
async fn cascade_delete_jobs_for_corpus(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    job_identifiers: &[String],
) -> Result<usize, HttpError> {
    let mut deleted_job_count = 0_usize;
    for job_identifier in job_identifiers {
        let deletion_occurred = document_collection
            .delete_document(RAG_JOBS_COLLECTION_NAME, job_identifier)
            .await
            .map_err(map_application_error_to_deletion_http_error)?;
        if deletion_occurred {
            deleted_job_count += 1;
        }
    }
    Ok(deleted_job_count)
}

/// (9) Remove every knowledge entry that references the corpus, counting deletions.
async fn cascade_delete_knowledge_entries_for_corpus(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    corpus_identifier: &NonEmptyText,
) -> Result<usize, HttpError> {
    let all_knowledge_documents = document_collection
        .list_documents(RAG_KNOWLEDGE_COLLECTION_NAME)
        .await
        .map_err(map_application_error_to_deletion_http_error)?;

    let knowledge_identifiers_to_delete =
        collect_knowledge_identifiers_referencing_corpus(&all_knowledge_documents, corpus_identifier);

    let mut deleted_knowledge_count = 0_usize;
    for knowledge_identifier in knowledge_identifiers_to_delete {
        let deletion_occurred = document_collection
            .delete_document(RAG_KNOWLEDGE_COLLECTION_NAME, &knowledge_identifier)
            .await
            .map_err(map_application_error_to_deletion_http_error)?;
        if deletion_occurred {
            deleted_knowledge_count += 1;
        }
    }
    Ok(deleted_knowledge_count)
}

/// (10) Collect the identifiers of knowledge documents that point at the corpus.
fn collect_knowledge_identifiers_referencing_corpus(
    knowledge_documents: &[StoredDocument],
    corpus_identifier: &NonEmptyText,
) -> Vec<String> {
    let target_identifier = corpus_identifier.as_str();
    knowledge_documents
        .iter()
        .filter(|knowledge_document| {
            knowledge_document
                .document_body
                .get("corpus_identifier")
                .and_then(Value::as_str)
                .map(|reference| reference == target_identifier)
                .unwrap_or(false)
        })
        .map(|knowledge_document| knowledge_document.document_identifier.clone())
        .collect()
}

/// (11) Delete the corpus document itself, or surface a not-found error.
async fn delete_corpus_document_or_not_found(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    corpus_identifier: &NonEmptyText,
) -> Result<(), HttpError> {
    let deletion_occurred = document_collection
        .delete_document(RAG_CORPORA_COLLECTION_NAME, corpus_identifier.as_str())
        .await
        .map_err(map_application_error_to_deletion_http_error)?;

    if deletion_occurred {
        Ok(())
    } else {
        Err(HttpError::RequestedResourceWasNotFound {
            explanation: String::from("no rag corpus exists under the supplied identifier"),
        })
    }
}

/// (12) Orchestrate the full cascade: jobs, knowledge, then the corpus document.
async fn perform_cascading_corpus_deletion_within_transaction<TransactionalUnitOfWork>(
    application_state: &ApplicationState<TransactionalUnitOfWork>,
    corpus_identifier: &NonEmptyText,
    corpus_document: &StoredDocument,
) -> Result<CorpusDeletionOutcome, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork,
{
    let document_collection = &application_state.document_collection;

    // Union the jobs discovered by scanning with those explicitly listed on the corpus,
    // so a job is removed even if its own body lost the back-reference.
    let jobs_belonging_to_corpus =
        load_jobs_belonging_to_corpus(document_collection, corpus_identifier).await?;
    let mut job_identifiers_to_delete: Vec<String> = jobs_belonging_to_corpus
        .iter()
        .map(|job_document| job_document.document_identifier.clone())
        .collect();
    for explicit_job_identifier in collect_child_job_identifiers_referenced_by_corpus(corpus_document)
    {
        if !job_identifiers_to_delete.contains(&explicit_job_identifier) {
            job_identifiers_to_delete.push(explicit_job_identifier);
        }
    }

    let deleted_job_count =
        cascade_delete_jobs_for_corpus(document_collection, &job_identifiers_to_delete).await?;
    let deleted_knowledge_count =
        cascade_delete_knowledge_entries_for_corpus(document_collection, corpus_identifier).await?;

    delete_corpus_document_or_not_found(document_collection, corpus_identifier).await?;

    Ok(tally_corpus_deletion_outcome(
        deleted_job_count,
        deleted_knowledge_count,
    ))
}

/// (13) Bundle the individual deletion counts into a single outcome value.
fn tally_corpus_deletion_outcome(
    deleted_job_count: usize,
    deleted_knowledge_count: usize,
) -> CorpusDeletionOutcome {
    CorpusDeletionOutcome {
        deleted_job_count,
        deleted_knowledge_count,
    }
}

/// (14) Translate an application-layer failure into the deletion-specific HTTP error.
fn map_application_error_to_deletion_http_error(application_error: ApplicationError) -> HttpError {
    match application_error {
        ApplicationError::RequestedResourceCouldNotBeLocated
        | ApplicationError::RequestedProjectCouldNotBeLocated => {
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
        other_application_error => HttpError::UpstreamApplicationFailure {
            explanation: other_application_error.to_string(),
        },
    }
}

/// (15) Assemble the JSON acknowledgement returned to the caller.
fn assemble_corpus_deletion_response(
    corpus_identifier: &NonEmptyText,
    outcome: &CorpusDeletionOutcome,
) -> Value {
    json!({
        "corpus_identifier": corpus_identifier.as_str(),
        "acknowledgement": "rag corpus deleted",
        "cascade": {
            "deleted_job_count": outcome.deleted_job_count,
            "deleted_knowledge_count": outcome.deleted_knowledge_count,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored_document(
        identifier: &str,
        owning_account: Option<&str>,
        body: Value,
    ) -> StoredDocument {
        StoredDocument {
            document_identifier: identifier.to_owned(),
            owning_account: owning_account.map(str::to_owned),
            document_body: body,
        }
    }

    fn corpus_id(raw: &str) -> NonEmptyText {
        NonEmptyText::parse(raw.to_owned()).expect("test corpus identifier must be non-empty")
    }

    #[test]
    fn extract_corpus_identifier_accepts_non_empty_value() {
        let parsed = extract_corpus_identifier_from_path(String::from("corpus-42"))
            .expect("a non-empty path segment should parse");
        assert_eq!(parsed.as_str(), "corpus-42");
    }

    #[test]
    fn extract_corpus_identifier_rejects_blank_value() {
        let outcome = extract_corpus_identifier_from_path(String::from("   "));
        assert!(matches!(
            outcome,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn assert_ownership_accepts_matching_owner() {
        let owner = Email::parse(String::from("owner@example.com")).expect("valid email");
        let document = stored_document("c1", Some("owner@example.com"), json!({}));
        assert!(assert_corpus_document_is_owned_by_requester(&document, &owner).is_ok());
    }

    #[test]
    fn assert_ownership_rejects_different_owner() {
        let requester = Email::parse(String::from("intruder@example.com")).expect("valid email");
        let document = stored_document("c1", Some("owner@example.com"), json!({}));
        let outcome = assert_corpus_document_is_owned_by_requester(&document, &requester);
        assert!(matches!(
            outcome,
            Err(HttpError::AuthorizationWasDenied { .. })
        ));
    }

    #[test]
    fn assert_ownership_rejects_ownerless_corpus() {
        let requester = Email::parse(String::from("owner@example.com")).expect("valid email");
        let document = stored_document("c1", None, json!({}));
        let outcome = assert_corpus_document_is_owned_by_requester(&document, &requester);
        assert!(matches!(
            outcome,
            Err(HttpError::AuthorizationWasDenied { .. })
        ));
    }

    #[test]
    fn read_owning_account_prefers_top_level_field() {
        let document = stored_document(
            "c1",
            Some("top@example.com"),
            json!({ "owning_account": "body@example.com" }),
        );
        assert_eq!(read_corpus_owning_account(&document).as_deref(), Some("top@example.com"));
    }

    #[test]
    fn read_owning_account_falls_back_to_body() {
        let document =
            stored_document("c1", None, json!({ "owning_account": "body@example.com" }));
        assert_eq!(read_corpus_owning_account(&document).as_deref(), Some("body@example.com"));
    }

    #[test]
    fn read_owning_account_returns_none_when_absent() {
        let document = stored_document("c1", None, json!({}));
        assert_eq!(read_corpus_owning_account(&document), None);
    }

    #[test]
    fn collect_child_job_identifiers_extracts_valid_entries() {
        let document = stored_document(
            "c1",
            Some("owner@example.com"),
            json!({ "job_identifiers": ["job-1", "  ", "job-2"] }),
        );
        let collected = collect_child_job_identifiers_referenced_by_corpus(&document);
        assert_eq!(collected, vec![String::from("job-1"), String::from("job-2")]);
    }

    #[test]
    fn collect_child_job_identifiers_handles_missing_array() {
        let document = stored_document("c1", Some("owner@example.com"), json!({}));
        assert!(collect_child_job_identifiers_referenced_by_corpus(&document).is_empty());
    }

    #[test]
    fn job_references_corpus_via_direct_field() {
        let corpus = corpus_id("corpus-7");
        let job = stored_document("job-1", None, json!({ "corpus_identifier": "corpus-7" }));
        assert!(does_job_document_reference_corpus(&job, &corpus));
    }

    #[test]
    fn job_references_corpus_via_nested_submission() {
        let corpus = corpus_id("corpus-7");
        let job = stored_document(
            "job-1",
            None,
            json!({ "submission": { "corpus_identifier": "corpus-7" } }),
        );
        assert!(does_job_document_reference_corpus(&job, &corpus));
    }

    #[test]
    fn job_does_not_reference_unrelated_corpus() {
        let corpus = corpus_id("corpus-7");
        let job = stored_document("job-1", None, json!({ "corpus_identifier": "corpus-9" }));
        assert!(!does_job_document_reference_corpus(&job, &corpus));
    }

    #[test]
    fn collect_knowledge_identifiers_filters_by_corpus() {
        let corpus = corpus_id("corpus-7");
        let documents = vec![
            stored_document("k1", None, json!({ "corpus_identifier": "corpus-7" })),
            stored_document("k2", None, json!({ "corpus_identifier": "corpus-9" })),
            stored_document("k3", None, json!({ "corpus_identifier": "corpus-7" })),
        ];
        let collected = collect_knowledge_identifiers_referencing_corpus(&documents, &corpus);
        assert_eq!(collected, vec![String::from("k1"), String::from("k3")]);
    }

    #[test]
    fn collect_knowledge_identifiers_returns_empty_for_no_match() {
        let corpus = corpus_id("corpus-7");
        let documents = vec![stored_document(
            "k1",
            None,
            json!({ "corpus_identifier": "corpus-9" }),
        )];
        assert!(collect_knowledge_identifiers_referencing_corpus(&documents, &corpus).is_empty());
    }

    #[test]
    fn tally_outcome_records_both_counts() {
        let outcome = tally_corpus_deletion_outcome(3, 5);
        assert_eq!(outcome.deleted_job_count, 3);
        assert_eq!(outcome.deleted_knowledge_count, 5);
    }

    #[test]
    fn map_error_translates_not_found() {
        let mapped =
            map_application_error_to_deletion_http_error(ApplicationError::RequestedResourceCouldNotBeLocated);
        assert!(matches!(mapped, HttpError::RequestedResourceWasNotFound { .. }));
    }

    #[test]
    fn map_error_translates_generic_failure_to_upstream() {
        let mapped = map_application_error_to_deletion_http_error(
            ApplicationError::DocumentCollectionFailure {
                failure_description: String::from("boom"),
            },
        );
        assert!(matches!(mapped, HttpError::UpstreamApplicationFailure { .. }));
    }

    #[test]
    fn assemble_response_contains_counts_and_identifier() {
        let corpus = corpus_id("corpus-7");
        let outcome = tally_corpus_deletion_outcome(2, 4);
        let response = assemble_corpus_deletion_response(&corpus, &outcome);
        assert_eq!(response["corpus_identifier"], json!("corpus-7"));
        assert_eq!(response["cascade"]["deleted_job_count"], json!(2));
        assert_eq!(response["cascade"]["deleted_knowledge_count"], json!(4));
    }
}
