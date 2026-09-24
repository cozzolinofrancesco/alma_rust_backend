use crate::categories::rag::collections::RAG_JOBS_COLLECTION_NAME;
use crate::categories::rag::collections::RAG_KNOWLEDGE_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::ports::document_collection::{DocumentCollectionPort, StoredDocument};
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::{Email, NonEmptyText};
use alma_macros::route;
use axum::Json;
use axum::extract::{Path, State};
use serde_json::{Value, json};
use std::sync::Arc;

/// Lifecycle status a RAG ingestion job can be in.
///
/// The stored document persists the status as a free-form string; this enum is
/// the normalised, exhaustive view the handler reasons about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RagJobLifecycleStatus {
    Pending,
    Processing,
    Completed,
    Failed,
}

impl RagJobLifecycleStatus {
    /// Canonical wire string used in the JSON response.
    fn as_wire_value(self) -> &'static str {
        match self {
            RagJobLifecycleStatus::Pending => "pending",
            RagJobLifecycleStatus::Processing => "processing",
            RagJobLifecycleStatus::Completed => "completed",
            RagJobLifecycleStatus::Failed => "failed",
        }
    }

    /// Parse a persisted status string into the normalised enum. Unknown or
    /// missing values default to `Pending` so a partially-written document
    /// still yields a coherent view rather than an error.
    fn from_persisted_value(persisted_value: &str) -> RagJobLifecycleStatus {
        match persisted_value.trim().to_ascii_lowercase().as_str() {
            "processing" | "running" | "in_progress" | "indexing" => {
                RagJobLifecycleStatus::Processing
            }
            "completed" | "complete" | "done" | "succeeded" | "success" => {
                RagJobLifecycleStatus::Completed
            }
            "failed" | "error" | "errored" | "cancelled" | "canceled" => {
                RagJobLifecycleStatus::Failed
            }
            _ => RagJobLifecycleStatus::Pending,
        }
    }
}

/// Fully-derived progress view for a single RAG job. Everything the response
/// needs is materialised here so serialisation is a pure, testable step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RagJobProgressView {
    pub job_identifier: String,
    pub owning_account: Option<String>,
    pub lifecycle_status: RagJobLifecycleStatus,
    pub processed_file_count: usize,
    pub total_file_count: usize,
    pub recorded_file_count: usize,
    pub completion_percentage: u8,
    pub parent_corpus_identifier: Option<String>,
    pub created_timestamp: Option<String>,
    pub last_updated_timestamp: Option<String>,
    pub failure_reason: Option<String>,
}

#[route(method = "GET", path = "/api/rag/jobs/:job_identifier")]
pub async fn fetch_rag_job_handler<TransactionalUnitOfWork>(
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

    assert_job_document_is_visible_to_requester(&job_document, requesting_account)?;

    let recorded_file_count =
        count_files_recorded_for_job(&application_state.document_collection, &validated_job_identifier)
            .await?;

    let progress_view = build_job_progress_view(&job_document, recorded_file_count);
    let response_body = assemble_fetch_job_response(&job_document, &progress_view);

    Ok(Json(response_body))
}

/// (1) Validate the raw path segment into a non-empty job identifier.
fn extract_job_identifier_from_path(
    supplied_path_parameter: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(supplied_path_parameter).map_err(|domain_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: format!("job identifier is invalid: {domain_error}"),
        }
    })
}

/// (2) Fetch the job document, translating a missing document into a 404-style error.
async fn fetch_job_document_or_not_found(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    job_identifier: &NonEmptyText,
) -> Result<StoredDocument, HttpError> {
    let optionally_located_document = document_collection
        .fetch_document(RAG_JOBS_COLLECTION_NAME, job_identifier.as_str())
        .await?;

    optionally_located_document.ok_or_else(|| HttpError::RequestedResourceWasNotFound {
        explanation: format!("no RAG job exists with identifier '{}'", job_identifier.as_str()),
    })
}

/// (3) Enforce ownership: an owned job may only be read by its owner.
///
/// RUST-IDOR-003: a job with no `owning_account` is NOT world-visible — an
/// ownerless job is default-denied rather than treated as shared/system-owned.
fn assert_job_document_is_visible_to_requester(
    job_document: &StoredDocument,
    requesting_account: &Email,
) -> Result<(), HttpError> {
    match job_document.owning_account.as_deref() {
        Some(owner) if owner.eq_ignore_ascii_case(requesting_account.as_str()) => Ok(()),
        Some(_) => Err(HttpError::AuthorizationWasDenied {
            explanation: "this RAG job belongs to a different account".to_string(),
        }),
        None => Err(HttpError::AuthorizationWasDenied {
            explanation: "the requested RAG job has no recorded owner".to_string(),
        }),
    }
}

/// (4) Read the normalised lifecycle status from the document body.
fn read_job_lifecycle_status(job_document: &StoredDocument) -> RagJobLifecycleStatus {
    let persisted_status = job_document
        .document_body
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("");
    RagJobLifecycleStatus::from_persisted_value(persisted_status)
}

/// (5) Read how many files have been fully processed.
fn read_job_processed_file_count(job_document: &StoredDocument) -> usize {
    read_non_negative_count(&job_document.document_body, "processedFiles")
}

/// (6) Read the declared total file count for the job.
fn read_job_total_file_count(job_document: &StoredDocument) -> usize {
    read_non_negative_count(&job_document.document_body, "totalFiles")
}

/// Shared numeric reader: accepts either a JSON number or a numeric string,
/// clamping negatives and non-numeric values to zero.
fn read_non_negative_count(document_body: &Value, field_name: &str) -> usize {
    match document_body.get(field_name) {
        Some(Value::Number(number)) => number
            .as_i64()
            .filter(|value| *value >= 0)
            .map(|value| value as usize)
            .unwrap_or(0),
        Some(Value::String(text)) => text.trim().parse::<i64>().ok().filter(|value| *value >= 0).map(|value| value as usize).unwrap_or(0),
        _ => 0,
    }
}

/// (7) Compute an integer completion percentage in the range 0..=100.
///
/// A zero total yields 0% (unknown work) rather than dividing by zero, and the
/// processed count is capped at the total so overcounting cannot exceed 100%.
fn compute_job_completion_percentage(processed_count: usize, total_count: usize) -> u8 {
    if total_count == 0 {
        return 0;
    }
    let effective_processed = processed_count.min(total_count);
    let percentage = (effective_processed as u128 * 100) / (total_count as u128);
    percentage.min(100) as u8
}

/// (8) Read the creation timestamp if present.
fn read_job_created_timestamp(job_document: &StoredDocument) -> Option<String> {
    read_non_empty_string_field(&job_document.document_body, "createdAt")
}

/// (9) Read the last-updated timestamp if present.
fn read_job_last_updated_timestamp(job_document: &StoredDocument) -> Option<String> {
    read_non_empty_string_field(&job_document.document_body, "updatedAt")
}

/// (10) Extract a failure reason, but only for jobs that actually failed.
///
/// This avoids leaking a stale error message from a document whose status was
/// later flipped back to a healthy state.
fn extract_job_failure_reason_if_present(job_document: &StoredDocument) -> Option<String> {
    if read_job_lifecycle_status(job_document) != RagJobLifecycleStatus::Failed {
        return None;
    }
    read_non_empty_string_field(&job_document.document_body, "failureReason")
        .or_else(|| read_non_empty_string_field(&job_document.document_body, "error"))
}

/// Shared string reader that treats blank strings as absent.
fn read_non_empty_string_field(document_body: &Value, field_name: &str) -> Option<String> {
    document_body
        .get(field_name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

/// (11) Count knowledge records that were ingested under this job.
///
/// The knowledge collection is scanned and filtered by the `jobId` field so the
/// response can report the *actual* number of indexed chunks/files, independent
/// of whatever `totalFiles` the job document claims.
async fn count_files_recorded_for_job(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    job_identifier: &NonEmptyText,
) -> Result<usize, HttpError> {
    let knowledge_records = document_collection
        .list_documents(RAG_KNOWLEDGE_COLLECTION_NAME)
        .await?;

    let matching = knowledge_records
        .iter()
        .filter(|record| knowledge_record_belongs_to_job(record, job_identifier.as_str()))
        .count();

    Ok(matching)
}

/// Predicate: does a knowledge record reference the given job identifier?
fn knowledge_record_belongs_to_job(knowledge_record: &StoredDocument, job_identifier: &str) -> bool {
    knowledge_record
        .document_body
        .get("jobId")
        .and_then(Value::as_str)
        .map(|recorded_job| recorded_job == job_identifier)
        .unwrap_or(false)
}

/// (12) Read the parent corpus identifier the job feeds into.
fn read_job_parent_corpus_identifier(job_document: &StoredDocument) -> Option<String> {
    read_non_empty_string_field(&job_document.document_body, "corpusId")
        .or_else(|| read_non_empty_string_field(&job_document.document_body, "corpusIdentifier"))
}

/// (13) Assemble the fully-derived progress view from a job document plus the
/// externally-counted knowledge record total. Pure and deterministic.
fn build_job_progress_view(
    job_document: &StoredDocument,
    recorded_file_count: usize,
) -> RagJobProgressView {
    let processed_file_count = read_job_processed_file_count(job_document);
    let total_file_count = read_job_total_file_count(job_document);
    let completion_percentage =
        compute_job_completion_percentage(processed_file_count, total_file_count);

    RagJobProgressView {
        job_identifier: job_document.document_identifier.clone(),
        owning_account: job_document.owning_account.clone(),
        lifecycle_status: read_job_lifecycle_status(job_document),
        processed_file_count,
        total_file_count,
        recorded_file_count,
        completion_percentage,
        parent_corpus_identifier: read_job_parent_corpus_identifier(job_document),
        created_timestamp: read_job_created_timestamp(job_document),
        last_updated_timestamp: read_job_last_updated_timestamp(job_document),
        failure_reason: extract_job_failure_reason_if_present(job_document),
    }
}

/// (14) Serialise the progress view into its JSON representation.
fn serialize_job_progress_view_to_json(progress_view: &RagJobProgressView) -> Value {
    json!({
        "jobId": progress_view.job_identifier,
        "owningAccount": progress_view.owning_account,
        "status": progress_view.lifecycle_status.as_wire_value(),
        "processedFiles": progress_view.processed_file_count,
        "totalFiles": progress_view.total_file_count,
        "recordedFiles": progress_view.recorded_file_count,
        "completionPercentage": progress_view.completion_percentage,
        "corpusId": progress_view.parent_corpus_identifier,
        "createdAt": progress_view.created_timestamp,
        "updatedAt": progress_view.last_updated_timestamp,
        "failureReason": progress_view.failure_reason,
    })
}

/// (15) Assemble the final response body, embedding the raw persisted file list
/// (if any) alongside the derived progress view.
fn assemble_fetch_job_response(
    job_document: &StoredDocument,
    progress_view: &RagJobProgressView,
) -> Value {
    let mut response_body = serialize_job_progress_view_to_json(progress_view);

    let persisted_files = job_document
        .document_body
        .get("files")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));

    let display_name = read_non_empty_string_field(&job_document.document_body, "displayName")
        .unwrap_or_else(|| job_document.document_identifier.clone());

    if let Value::Object(response_map) = &mut response_body {
        response_map.insert("displayName".to_string(), Value::String(display_name));
        response_map.insert("files".to_string(), persisted_files);
    }

    response_body
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored_document_with_body(body: Value) -> StoredDocument {
        StoredDocument {
            document_identifier: "job-123".to_string(),
            owning_account: Some("owner@example.com".to_string()),
            document_body: body,
        }
    }

    #[test]
    fn extract_job_identifier_accepts_non_empty() {
        let parsed = extract_job_identifier_from_path("job-abc".to_string()).unwrap();
        assert_eq!(parsed.as_str(), "job-abc");
    }

    #[test]
    fn extract_job_identifier_rejects_blank() {
        let result = extract_job_identifier_from_path("   ".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn visibility_allows_matching_owner_case_insensitively() {
        let document = stored_document_with_body(json!({}));
        let requester = Email::parse("OWNER@example.com".to_string()).unwrap();
        assert!(assert_job_document_is_visible_to_requester(&document, &requester).is_ok());
    }

    #[test]
    fn visibility_denies_other_owner() {
        let document = stored_document_with_body(json!({}));
        let requester = Email::parse("intruder@example.com".to_string()).unwrap();
        assert!(assert_job_document_is_visible_to_requester(&document, &requester).is_err());
    }

    #[test]
    fn visibility_denies_unowned_job() {
        // RUST-IDOR-003: ownerless jobs are default-denied, not world-visible.
        let document = StoredDocument {
            document_identifier: "job-shared".to_string(),
            owning_account: None,
            document_body: json!({}),
        };
        let requester = Email::parse("anyone@example.com".to_string()).unwrap();
        assert!(assert_job_document_is_visible_to_requester(&document, &requester).is_err());
    }

    #[test]
    fn lifecycle_status_normalisation() {
        assert_eq!(
            RagJobLifecycleStatus::from_persisted_value("RUNNING"),
            RagJobLifecycleStatus::Processing
        );
        assert_eq!(
            RagJobLifecycleStatus::from_persisted_value("done"),
            RagJobLifecycleStatus::Completed
        );
        assert_eq!(
            RagJobLifecycleStatus::from_persisted_value("error"),
            RagJobLifecycleStatus::Failed
        );
        assert_eq!(
            RagJobLifecycleStatus::from_persisted_value("banana"),
            RagJobLifecycleStatus::Pending
        );
    }

    #[test]
    fn read_lifecycle_status_from_document() {
        let document = stored_document_with_body(json!({ "status": "completed" }));
        assert_eq!(
            read_job_lifecycle_status(&document),
            RagJobLifecycleStatus::Completed
        );
    }

    #[test]
    fn read_lifecycle_status_defaults_when_missing() {
        let document = stored_document_with_body(json!({}));
        assert_eq!(
            read_job_lifecycle_status(&document),
            RagJobLifecycleStatus::Pending
        );
    }

    #[test]
    fn read_counts_handles_numbers_and_strings() {
        let document = stored_document_with_body(json!({
            "processedFiles": 3,
            "totalFiles": "5"
        }));
        assert_eq!(read_job_processed_file_count(&document), 3);
        assert_eq!(read_job_total_file_count(&document), 5);
    }

    #[test]
    fn read_counts_clamps_negative_and_garbage() {
        let document = stored_document_with_body(json!({
            "processedFiles": -4,
            "totalFiles": "abc"
        }));
        assert_eq!(read_job_processed_file_count(&document), 0);
        assert_eq!(read_job_total_file_count(&document), 0);
    }

    #[test]
    fn completion_percentage_basic() {
        assert_eq!(compute_job_completion_percentage(1, 2), 50);
        assert_eq!(compute_job_completion_percentage(2, 2), 100);
    }

    #[test]
    fn completion_percentage_zero_total_is_zero() {
        assert_eq!(compute_job_completion_percentage(0, 0), 0);
        assert_eq!(compute_job_completion_percentage(3, 0), 0);
    }

    #[test]
    fn completion_percentage_caps_at_hundred() {
        assert_eq!(compute_job_completion_percentage(10, 2), 100);
    }

    #[test]
    fn read_created_and_updated_timestamps() {
        let document = stored_document_with_body(json!({
            "createdAt": "2026-05-12T09:20:00.000Z",
            "updatedAt": "2026-05-12T09:24:00.000Z"
        }));
        assert_eq!(
            read_job_created_timestamp(&document),
            Some("2026-05-12T09:20:00.000Z".to_string())
        );
        assert_eq!(
            read_job_last_updated_timestamp(&document),
            Some("2026-05-12T09:24:00.000Z".to_string())
        );
    }

    #[test]
    fn read_timestamps_treats_blank_as_absent() {
        let document = stored_document_with_body(json!({ "createdAt": "   " }));
        assert_eq!(read_job_created_timestamp(&document), None);
    }

    #[test]
    fn failure_reason_only_when_failed() {
        let failed = stored_document_with_body(json!({
            "status": "failed",
            "failureReason": "upstream timeout"
        }));
        assert_eq!(
            extract_job_failure_reason_if_present(&failed),
            Some("upstream timeout".to_string())
        );

        let completed = stored_document_with_body(json!({
            "status": "completed",
            "failureReason": "stale message"
        }));
        assert_eq!(extract_job_failure_reason_if_present(&completed), None);
    }

    #[test]
    fn failure_reason_falls_back_to_error_field() {
        let failed = stored_document_with_body(json!({
            "status": "error",
            "error": "disk full"
        }));
        assert_eq!(
            extract_job_failure_reason_if_present(&failed),
            Some("disk full".to_string())
        );
    }

    #[test]
    fn knowledge_record_matching() {
        let matching = StoredDocument {
            document_identifier: "k1".to_string(),
            owning_account: None,
            document_body: json!({ "jobId": "job-123" }),
        };
        let non_matching = StoredDocument {
            document_identifier: "k2".to_string(),
            owning_account: None,
            document_body: json!({ "jobId": "other" }),
        };
        assert!(knowledge_record_belongs_to_job(&matching, "job-123"));
        assert!(!knowledge_record_belongs_to_job(&non_matching, "job-123"));
    }

    #[test]
    fn read_parent_corpus_identifier_variants() {
        let primary = stored_document_with_body(json!({ "corpusId": "corpus-a" }));
        assert_eq!(
            read_job_parent_corpus_identifier(&primary),
            Some("corpus-a".to_string())
        );
        let fallback = stored_document_with_body(json!({ "corpusIdentifier": "corpus-b" }));
        assert_eq!(
            read_job_parent_corpus_identifier(&fallback),
            Some("corpus-b".to_string())
        );
        let none = stored_document_with_body(json!({}));
        assert_eq!(read_job_parent_corpus_identifier(&none), None);
    }

    #[test]
    fn build_progress_view_derives_fields() {
        let document = stored_document_with_body(json!({
            "status": "processing",
            "processedFiles": 1,
            "totalFiles": 4,
            "corpusId": "corpus-x",
            "createdAt": "t0",
            "updatedAt": "t1"
        }));
        let view = build_job_progress_view(&document, 7);
        assert_eq!(view.job_identifier, "job-123");
        assert_eq!(view.lifecycle_status, RagJobLifecycleStatus::Processing);
        assert_eq!(view.processed_file_count, 1);
        assert_eq!(view.total_file_count, 4);
        assert_eq!(view.recorded_file_count, 7);
        assert_eq!(view.completion_percentage, 25);
        assert_eq!(view.parent_corpus_identifier, Some("corpus-x".to_string()));
    }

    #[test]
    fn serialize_progress_view_shape() {
        let view = RagJobProgressView {
            job_identifier: "job-1".to_string(),
            owning_account: Some("o@e.com".to_string()),
            lifecycle_status: RagJobLifecycleStatus::Completed,
            processed_file_count: 2,
            total_file_count: 2,
            recorded_file_count: 2,
            completion_percentage: 100,
            parent_corpus_identifier: Some("corpus-1".to_string()),
            created_timestamp: Some("t0".to_string()),
            last_updated_timestamp: Some("t1".to_string()),
            failure_reason: None,
        };
        let serialized = serialize_job_progress_view_to_json(&view);
        assert_eq!(serialized["jobId"], json!("job-1"));
        assert_eq!(serialized["status"], json!("completed"));
        assert_eq!(serialized["completionPercentage"], json!(100));
        assert_eq!(serialized["recordedFiles"], json!(2));
    }

    #[test]
    fn assemble_response_includes_files_and_display_name() {
        let document = stored_document_with_body(json!({
            "status": "completed",
            "processedFiles": 2,
            "totalFiles": 2,
            "displayName": "Oncology Trials 2026",
            "files": [ { "id": "f1", "name": "a.pdf" } ]
        }));
        let view = build_job_progress_view(&document, 2);
        let response = assemble_fetch_job_response(&document, &view);
        assert_eq!(response["displayName"], json!("Oncology Trials 2026"));
        assert_eq!(response["files"][0]["id"], json!("f1"));
        assert_eq!(response["status"], json!("completed"));
    }

    #[test]
    fn assemble_response_defaults_missing_files_to_empty_array() {
        let document = stored_document_with_body(json!({ "status": "pending" }));
        let view = build_job_progress_view(&document, 0);
        let response = assemble_fetch_job_response(&document, &view);
        assert_eq!(response["files"], json!([]));
        assert_eq!(response["displayName"], json!("job-123"));
    }
}
