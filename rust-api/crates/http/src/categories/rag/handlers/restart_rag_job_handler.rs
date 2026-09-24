use crate::categories::rag::collections::RAG_JOBS_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::ports::ai::ArtificialIntelligencePort;
use alma_application::ports::document_collection::{DocumentCollectionPort, StoredDocument};
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::{Email, NonEmptyText};
use alma_macros::route;
use axum::Json;
use axum::extract::{Path, State};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// Options that steer how a RAG job is restarted. Because this handler is bound
/// by its existing route contract (a `Path` extractor, no request body), the
/// options are ordinarily parsed from a default/empty value, but the parser is
/// written so that a real body can drive it without any change to the shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RagJobRestartOptions {
    /// When true, every file entry is reprocessed regardless of its previous
    /// status; when false, only entries that did not reach `completed` are
    /// selected for reprocessing.
    pub reprocess_all_files: bool,
    /// When true, a reprocessing prompt is dispatched to the AI adapter after
    /// the job document has been persisted.
    pub dispatch_reprocessing_prompt: bool,
}

impl Default for RagJobRestartOptions {
    fn default() -> Self {
        Self {
            reprocess_all_files: false,
            dispatch_reprocessing_prompt: true,
        }
    }
}

/// The lifecycle status a RAG job can occupy. Anything the persisted document
/// does not recognise is treated as `Unknown`, which is conservatively
/// non-restartable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RagJobLifecycleStatus {
    Queued,
    Processing,
    Completed,
    Failed,
    Restarted,
    Unknown,
}

impl RagJobLifecycleStatus {
    fn as_persisted_str(self) -> &'static str {
        match self {
            RagJobLifecycleStatus::Queued => "queued",
            RagJobLifecycleStatus::Processing => "processing",
            RagJobLifecycleStatus::Completed => "completed",
            RagJobLifecycleStatus::Failed => "failed",
            RagJobLifecycleStatus::Restarted => "restarted",
            RagJobLifecycleStatus::Unknown => "unknown",
        }
    }
}

/// A single file tracked by a RAG job. Mirrors the JSON object shape stored in
/// the job document's `files` array.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RagJobFileEntry {
    pub file_identifier: String,
    pub processing_status: String,
}

#[route(method = "POST", path = "/api/rag/jobs/:job_identifier/restart")]
pub async fn restart_rag_job_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Path(job_identifier): Path<String>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let validated_job_identifier = extract_job_identifier_from_path(job_identifier)?;
    let requesting_account = authorized_request.authorized_principal();

    // No request body extractor is part of this route's contract, so the
    // restart options are derived from a default value. The parser remains a
    // pure, testable function that would accept a real body unchanged.
    let restart_options = parse_restart_options_from_body(&Value::Null);

    let mut job_document = fetch_job_document_or_not_found(
        &application_state.document_collection,
        &validated_job_identifier,
    )
    .await?;

    assert_job_document_is_owned_by_requester(&job_document, requesting_account)?;

    let current_status = read_job_lifecycle_status(&job_document);
    assert_job_is_restartable_in_current_status(current_status)?;

    let mut file_entries_to_reprocess =
        select_file_entries_to_reprocess(&job_document, &restart_options);
    for file_entry in file_entries_to_reprocess.iter_mut() {
        reset_file_entry_processing_status_to_pending(file_entry);
    }
    let files_to_reprocess_count = file_entries_to_reprocess.len();

    clear_job_failure_reason_field(&mut job_document);
    transition_job_lifecycle_status_to_queued(&mut job_document);
    reset_job_processed_file_counter(&mut job_document, files_to_reprocess_count);
    write_file_entries_back_into_document(&mut job_document, &file_entries_to_reprocess);
    stamp_job_restart_timestamp(&mut job_document, current_unix_timestamp_seconds());

    let restarted_identifier = job_document.document_identifier.clone();
    persist_restarted_job_document(&application_state.document_collection, job_document).await?;

    if restart_options.dispatch_reprocessing_prompt && files_to_reprocess_count > 0 {
        dispatch_reprocessing_prompt_for_job(
            &application_state.artificial_intelligence_adapter,
            &validated_job_identifier,
            files_to_reprocess_count,
        )
        .await?;
    }

    let _ = restarted_identifier;
    Ok(Json(assemble_job_restart_response(
        &validated_job_identifier,
        files_to_reprocess_count,
    )))
}

/// (1) Validate the path parameter into a `NonEmptyText` job identifier.
fn extract_job_identifier_from_path(
    supplied_path_parameter: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(supplied_path_parameter).map_err(|parse_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "the supplied rag job identifier was not valid: {parse_error}"
            ),
        }
    })
}

/// (2) Parse restart options from a request body. Absent or non-object bodies
/// yield the sensible defaults.
fn parse_restart_options_from_body(submitted_body: &Value) -> RagJobRestartOptions {
    let defaults = RagJobRestartOptions::default();
    let Some(body_object) = submitted_body.as_object() else {
        return defaults;
    };
    let reprocess_all_files = body_object
        .get("reprocessAll")
        .and_then(Value::as_bool)
        .unwrap_or(defaults.reprocess_all_files);
    let dispatch_reprocessing_prompt = body_object
        .get("dispatchPrompt")
        .and_then(Value::as_bool)
        .unwrap_or(defaults.dispatch_reprocessing_prompt);
    RagJobRestartOptions {
        reprocess_all_files,
        dispatch_reprocessing_prompt,
    }
}

/// (3) Fetch the job document, translating absence into a not-found error.
async fn fetch_job_document_or_not_found(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    job_identifier: &NonEmptyText,
) -> Result<StoredDocument, HttpError> {
    let optionally_located_document = document_collection
        .fetch_document(RAG_JOBS_COLLECTION_NAME, job_identifier.as_str())
        .await?;
    optionally_located_document.ok_or_else(|| HttpError::RequestedResourceWasNotFound {
        explanation: String::from("no rag job exists under the supplied identifier"),
    })
}

/// (4) Confirm the job belongs to the requester.
///
/// RUST-IDOR-003: documents that carry no owner are NOT public — an ownerless
/// job is default-denied rather than restartable by any authenticated caller.
fn assert_job_document_is_owned_by_requester(
    job_document: &StoredDocument,
    requesting_account: &Email,
) -> Result<(), HttpError> {
    match job_document.owning_account.as_deref() {
        Some(owner) if owner == requesting_account.as_str() => Ok(()),
        Some(_) => Err(HttpError::AuthorizationWasDenied {
            explanation: String::from(
                "the authenticated principal does not own this rag job",
            ),
        }),
        None => Err(HttpError::AuthorizationWasDenied {
            explanation: String::from("the requested rag job has no recorded owner"),
        }),
    }
}

/// (5) Read the lifecycle status from the persisted document body.
fn read_job_lifecycle_status(job_document: &StoredDocument) -> RagJobLifecycleStatus {
    let raw_status = job_document
        .document_body
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("");
    match raw_status.trim().to_ascii_lowercase().as_str() {
        "queued" => RagJobLifecycleStatus::Queued,
        "processing" => RagJobLifecycleStatus::Processing,
        "completed" => RagJobLifecycleStatus::Completed,
        "failed" => RagJobLifecycleStatus::Failed,
        "restarted" => RagJobLifecycleStatus::Restarted,
        _ => RagJobLifecycleStatus::Unknown,
    }
}

/// (6) A job may only be restarted from a terminal or already-restarted state.
/// Jobs still queued or actively processing must not be restarted.
fn assert_job_is_restartable_in_current_status(
    current_status: RagJobLifecycleStatus,
) -> Result<(), HttpError> {
    match current_status {
        RagJobLifecycleStatus::Completed
        | RagJobLifecycleStatus::Failed
        | RagJobLifecycleStatus::Restarted => Ok(()),
        RagJobLifecycleStatus::Queued | RagJobLifecycleStatus::Processing => {
            Err(HttpError::RequestBodyWasMalformed {
                explanation: format!(
                    "a rag job in status '{}' is still in flight and cannot be restarted",
                    current_status.as_persisted_str()
                ),
            })
        }
        RagJobLifecycleStatus::Unknown => Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from(
                "the rag job has no recognisable status and cannot be restarted",
            ),
        }),
    }
}

/// (7) Choose which file entries to reprocess. With `reprocess_all_files` set,
/// every entry is selected; otherwise only entries that have not completed.
fn select_file_entries_to_reprocess(
    job_document: &StoredDocument,
    restart_options: &RagJobRestartOptions,
) -> Vec<RagJobFileEntry> {
    let file_entries = read_file_entries_from_document(job_document);
    file_entries
        .into_iter()
        .filter(|file_entry| {
            restart_options.reprocess_all_files
                || !file_entry
                    .processing_status
                    .eq_ignore_ascii_case("completed")
        })
        .collect()
}

/// (8) Reset a single file entry so it is queued for a fresh pass.
fn reset_file_entry_processing_status_to_pending(file_entry: &mut RagJobFileEntry) {
    file_entry.processing_status = String::from("pending");
}

/// (9) Remove any lingering failure reason from a job that is being restarted.
fn clear_job_failure_reason_field(job_document: &mut StoredDocument) {
    if let Some(body_object) = job_document.document_body.as_object_mut() {
        body_object.remove("failureReason");
        body_object.remove("errorMessage");
    }
}

/// (10) Move the job back into the queued state ready for reprocessing.
fn transition_job_lifecycle_status_to_queued(job_document: &mut StoredDocument) {
    set_body_field(
        job_document,
        "status",
        Value::String(String::from(
            RagJobLifecycleStatus::Queued.as_persisted_str(),
        )),
    );
}

/// (11) Reset the processed-file counter and record how many files remain.
fn reset_job_processed_file_counter(
    job_document: &mut StoredDocument,
    files_to_reprocess_count: usize,
) {
    set_body_field(job_document, "processedFileCount", json!(0));
    set_body_field(
        job_document,
        "pendingFileCount",
        json!(files_to_reprocess_count),
    );
}

/// (12) Stamp the restart instant onto the document as unix-epoch seconds.
fn stamp_job_restart_timestamp(job_document: &mut StoredDocument, restart_instant: u64) {
    set_body_field(job_document, "restartedAt", json!(restart_instant));
}

/// (13) Persist the restarted job document, mapping a missing document to a
/// not-found error.
async fn persist_restarted_job_document(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    job_document: StoredDocument,
) -> Result<(), HttpError> {
    let document_was_replaced = document_collection
        .replace_document(RAG_JOBS_COLLECTION_NAME, job_document)
        .await?;
    if document_was_replaced {
        Ok(())
    } else {
        Err(HttpError::RequestedResourceWasNotFound {
            explanation: String::from(
                "the rag job vanished before the restart could be persisted",
            ),
        })
    }
}

/// (14) Ask the AI adapter to acknowledge the reprocessing request. Failures
/// here surface as upstream failures.
async fn dispatch_reprocessing_prompt_for_job(
    artificial_intelligence_adapter: &Arc<dyn ArtificialIntelligencePort>,
    job_identifier: &NonEmptyText,
    files_to_reprocess_count: usize,
) -> Result<(), HttpError> {
    let prompt_text = build_reprocessing_prompt_text(job_identifier, files_to_reprocess_count);
    let prompt_instruction = NonEmptyText::parse(prompt_text).map_err(|parse_error| {
        HttpError::UpstreamApplicationFailure {
            explanation: format!(
                "failed to assemble the reprocessing prompt: {parse_error}"
            ),
        }
    })?;
    artificial_intelligence_adapter
        .generate_completion(&prompt_instruction)
        .await?;
    Ok(())
}

/// (15) Build the JSON response body describing the restarted job.
fn assemble_job_restart_response(
    job_identifier: &NonEmptyText,
    files_to_reprocess_count: usize,
) -> Value {
    json!({
        "newJobId": job_identifier.as_str(),
        "status": RagJobLifecycleStatus::Queued.as_persisted_str(),
        "filesToReprocess": files_to_reprocess_count,
    })
}

// ---------------------------------------------------------------------------
// Internal helpers (not part of the numbered plan; small private utilities).
// ---------------------------------------------------------------------------

/// Read the `files` array of a job document into typed entries.
fn read_file_entries_from_document(job_document: &StoredDocument) -> Vec<RagJobFileEntry> {
    let Some(file_values) = job_document
        .document_body
        .get("files")
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    file_values
        .iter()
        .filter_map(|file_value| {
            let file_object = file_value.as_object()?;
            let file_identifier = file_object
                .get("fileId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let processing_status = file_object
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("pending")
                .to_string();
            Some(RagJobFileEntry {
                file_identifier,
                processing_status,
            })
        })
        .collect()
}

/// Write the mutated file entries back into the job document body.
fn write_file_entries_back_into_document(
    job_document: &mut StoredDocument,
    file_entries: &[RagJobFileEntry],
) {
    let serialized_entries: Vec<Value> = file_entries
        .iter()
        .map(|file_entry| {
            json!({
                "fileId": file_entry.file_identifier,
                "status": file_entry.processing_status,
            })
        })
        .collect();
    set_body_field(job_document, "files", Value::Array(serialized_entries));
}

/// Assign a field on the document body, upgrading a non-object body to an
/// object first.
fn set_body_field(job_document: &mut StoredDocument, field_name: &str, field_value: Value) {
    if !job_document.document_body.is_object() {
        job_document.document_body = json!({});
    }
    if let Some(body_object) = job_document.document_body.as_object_mut() {
        body_object.insert(String::from(field_name), field_value);
    }
}

/// Compose the natural-language prompt sent to the AI adapter.
fn build_reprocessing_prompt_text(
    job_identifier: &NonEmptyText,
    files_to_reprocess_count: usize,
) -> String {
    format!(
        "The retrieval-augmented-generation job '{}' has been restarted. \
Reprocess its {} pending file(s) and rebuild the knowledge index.",
        job_identifier.as_str(),
        files_to_reprocess_count
    )
}

/// Current unix-epoch seconds; zero if the clock is before the epoch.
fn current_unix_timestamp_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_job_document(body: Value, owner: Option<&str>) -> StoredDocument {
        StoredDocument {
            document_identifier: String::from("job-1"),
            owning_account: owner.map(String::from),
            document_body: body,
        }
    }

    #[test]
    fn extract_job_identifier_from_path_accepts_non_empty() {
        let extracted = extract_job_identifier_from_path(String::from("job-42")).unwrap();
        assert_eq!(extracted.as_str(), "job-42");
    }

    #[test]
    fn extract_job_identifier_from_path_rejects_empty() {
        let outcome = extract_job_identifier_from_path(String::from("   "));
        assert!(matches!(
            outcome,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn parse_restart_options_from_body_uses_defaults_for_null() {
        let options = parse_restart_options_from_body(&Value::Null);
        assert_eq!(options, RagJobRestartOptions::default());
    }

    #[test]
    fn parse_restart_options_from_body_reads_explicit_flags() {
        let options = parse_restart_options_from_body(&json!({
            "reprocessAll": true,
            "dispatchPrompt": false,
        }));
        assert!(options.reprocess_all_files);
        assert!(!options.dispatch_reprocessing_prompt);
    }

    #[test]
    fn assert_job_document_is_owned_by_requester_allows_owner() {
        let document = build_job_document(json!({}), Some("owner@example.com"));
        let requester = Email::parse(String::from("owner@example.com")).unwrap();
        assert!(assert_job_document_is_owned_by_requester(&document, &requester).is_ok());
    }

    #[test]
    fn assert_job_document_is_owned_by_requester_denies_unowned() {
        // RUST-IDOR-003: ownerless jobs are default-denied, not public.
        let document = build_job_document(json!({}), None);
        let requester = Email::parse(String::from("anyone@example.com")).unwrap();
        assert!(matches!(
            assert_job_document_is_owned_by_requester(&document, &requester),
            Err(HttpError::AuthorizationWasDenied { .. })
        ));
    }

    #[test]
    fn assert_job_document_is_owned_by_requester_denies_stranger() {
        let document = build_job_document(json!({}), Some("owner@example.com"));
        let requester = Email::parse(String::from("intruder@example.com")).unwrap();
        assert!(matches!(
            assert_job_document_is_owned_by_requester(&document, &requester),
            Err(HttpError::AuthorizationWasDenied { .. })
        ));
    }

    #[test]
    fn read_job_lifecycle_status_maps_known_values() {
        let document = build_job_document(json!({ "status": "FAILED" }), None);
        assert_eq!(
            read_job_lifecycle_status(&document),
            RagJobLifecycleStatus::Failed
        );
    }

    #[test]
    fn read_job_lifecycle_status_maps_missing_to_unknown() {
        let document = build_job_document(json!({}), None);
        assert_eq!(
            read_job_lifecycle_status(&document),
            RagJobLifecycleStatus::Unknown
        );
    }

    #[test]
    fn assert_job_is_restartable_accepts_terminal_states() {
        assert!(assert_job_is_restartable_in_current_status(RagJobLifecycleStatus::Failed).is_ok());
        assert!(
            assert_job_is_restartable_in_current_status(RagJobLifecycleStatus::Completed).is_ok()
        );
    }

    #[test]
    fn assert_job_is_restartable_rejects_in_flight_states() {
        assert!(matches!(
            assert_job_is_restartable_in_current_status(RagJobLifecycleStatus::Processing),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
        assert!(matches!(
            assert_job_is_restartable_in_current_status(RagJobLifecycleStatus::Unknown),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn select_file_entries_to_reprocess_skips_completed_by_default() {
        let document = build_job_document(
            json!({
                "files": [
                    { "fileId": "a", "status": "completed" },
                    { "fileId": "b", "status": "failed" },
                ]
            }),
            None,
        );
        let selected =
            select_file_entries_to_reprocess(&document, &RagJobRestartOptions::default());
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].file_identifier, "b");
    }

    #[test]
    fn select_file_entries_to_reprocess_includes_all_when_requested() {
        let document = build_job_document(
            json!({
                "files": [
                    { "fileId": "a", "status": "completed" },
                    { "fileId": "b", "status": "failed" },
                ]
            }),
            None,
        );
        let options = RagJobRestartOptions {
            reprocess_all_files: true,
            dispatch_reprocessing_prompt: true,
        };
        let selected = select_file_entries_to_reprocess(&document, &options);
        assert_eq!(selected.len(), 2);
    }

    #[test]
    fn reset_file_entry_processing_status_to_pending_sets_pending() {
        let mut entry = RagJobFileEntry {
            file_identifier: String::from("a"),
            processing_status: String::from("failed"),
        };
        reset_file_entry_processing_status_to_pending(&mut entry);
        assert_eq!(entry.processing_status, "pending");
    }

    #[test]
    fn clear_job_failure_reason_field_removes_error_keys() {
        let mut document = build_job_document(
            json!({ "failureReason": "boom", "errorMessage": "bang", "status": "failed" }),
            None,
        );
        clear_job_failure_reason_field(&mut document);
        assert!(document.document_body.get("failureReason").is_none());
        assert!(document.document_body.get("errorMessage").is_none());
        assert!(document.document_body.get("status").is_some());
    }

    #[test]
    fn transition_job_lifecycle_status_to_queued_sets_queued() {
        let mut document = build_job_document(json!({ "status": "failed" }), None);
        transition_job_lifecycle_status_to_queued(&mut document);
        assert_eq!(
            document.document_body.get("status").and_then(Value::as_str),
            Some("queued")
        );
    }

    #[test]
    fn transition_job_lifecycle_status_upgrades_non_object_body() {
        let mut document = build_job_document(Value::Null, None);
        transition_job_lifecycle_status_to_queued(&mut document);
        assert_eq!(
            document.document_body.get("status").and_then(Value::as_str),
            Some("queued")
        );
    }

    #[test]
    fn reset_job_processed_file_counter_writes_counts() {
        let mut document = build_job_document(json!({}), None);
        reset_job_processed_file_counter(&mut document, 5);
        assert_eq!(
            document
                .document_body
                .get("processedFileCount")
                .and_then(Value::as_u64),
            Some(0)
        );
        assert_eq!(
            document
                .document_body
                .get("pendingFileCount")
                .and_then(Value::as_u64),
            Some(5)
        );
    }

    #[test]
    fn stamp_job_restart_timestamp_records_value() {
        let mut document = build_job_document(json!({}), None);
        stamp_job_restart_timestamp(&mut document, 1_700_000_000);
        assert_eq!(
            document
                .document_body
                .get("restartedAt")
                .and_then(Value::as_u64),
            Some(1_700_000_000)
        );
    }

    #[test]
    fn write_file_entries_back_into_document_serializes_entries() {
        let mut document = build_job_document(json!({}), None);
        let entries = vec![RagJobFileEntry {
            file_identifier: String::from("a"),
            processing_status: String::from("pending"),
        }];
        write_file_entries_back_into_document(&mut document, &entries);
        let files = document
            .document_body
            .get("files")
            .and_then(Value::as_array)
            .unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].get("fileId").and_then(Value::as_str), Some("a"));
        assert_eq!(
            files[0].get("status").and_then(Value::as_str),
            Some("pending")
        );
    }

    #[test]
    fn build_reprocessing_prompt_text_mentions_job_and_count() {
        let identifier = NonEmptyText::parse(String::from("job-9")).unwrap();
        let prompt = build_reprocessing_prompt_text(&identifier, 3);
        assert!(prompt.contains("job-9"));
        assert!(prompt.contains("3"));
    }

    #[test]
    fn assemble_job_restart_response_reports_identifier_and_count() {
        let identifier = NonEmptyText::parse(String::from("job-9")).unwrap();
        let response = assemble_job_restart_response(&identifier, 4);
        assert_eq!(
            response.get("newJobId").and_then(Value::as_str),
            Some("job-9")
        );
        assert_eq!(
            response.get("filesToReprocess").and_then(Value::as_u64),
            Some(4)
        );
        assert_eq!(
            response.get("status").and_then(Value::as_str),
            Some("queued")
        );
    }
}
