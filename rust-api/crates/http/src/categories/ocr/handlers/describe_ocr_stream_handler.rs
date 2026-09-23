use crate::categories::ocr::collections::OCR_JOBS_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::ports::document_collection::StoredDocument;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::NonEmptyText;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};

/// Strongly-typed identifier for a persisted OCR streaming job.
///
/// Wraps the opaque string identifier stored in the OCR jobs collection so that
/// the rest of the module manipulates a validated value rather than a bare
/// `String`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PersistedOcrStreamJobIdentifier {
    raw_identifier: String,
}

impl PersistedOcrStreamJobIdentifier {
    fn as_str(&self) -> &str {
        &self.raw_identifier
    }
}

/// A record of an OCR streaming job as persisted in the document collection.
///
/// This is the durable metadata about a job: who owns it, how many chunks the
/// underlying document was split into, and which page range it covers.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PersistedOcrStreamJobRecord {
    job_identifier: PersistedOcrStreamJobIdentifier,
    owning_account: Option<String>,
    total_chunk_count: u32,
    source_document_name: String,
}

/// A live snapshot of an OCR streaming job's progress.
///
/// Unlike [`PersistedOcrStreamJobRecord`] (durable metadata), a snapshot is the
/// transient per-chunk state produced by querying the AI adapter mid-stream.
#[derive(Debug, Clone, PartialEq, Eq)]
struct OcrStreamJobProgressSnapshot {
    total_chunk_count: u32,
    completed_chunk_indices: Vec<u32>,
    failed_chunk_indices: Vec<u32>,
    average_chunk_duration_seconds: u64,
}

/// The lifecycle phase an OCR streaming job is currently in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OcrStreamJobLifecycleState {
    Pending,
    Running,
    Completed,
    Failed,
}

impl OcrStreamJobLifecycleState {
    fn as_str(&self) -> &'static str {
        match self {
            OcrStreamJobLifecycleState::Pending => "pending",
            OcrStreamJobLifecycleState::Running => "running",
            OcrStreamJobLifecycleState::Completed => "completed",
            OcrStreamJobLifecycleState::Failed => "failed",
        }
    }
}

/// Per-chunk status suitable for serialising into the response.
#[derive(Debug, Clone, PartialEq, Eq)]
struct OcrStreamJobChunkStatusDescriptor {
    chunk_index: u32,
    chunk_status: &'static str,
}

/// The fully assembled response payload describing one OCR streaming job.
#[derive(Debug, Clone, PartialEq, Eq)]
struct DescribeOcrStreamResponsePayload {
    job_identifier: String,
    source_document_name: String,
    lifecycle_state: &'static str,
    completion_percentage: u8,
    is_terminal: bool,
    chunk_descriptors: Vec<OcrStreamJobChunkStatusDescriptor>,
}

impl DescribeOcrStreamResponsePayload {
    fn into_json(self) -> Value {
        let chunks: Vec<Value> = self
            .chunk_descriptors
            .into_iter()
            .map(|descriptor| {
                json!({
                    "chunk_index": descriptor.chunk_index,
                    "chunk_status": descriptor.chunk_status,
                })
            })
            .collect();

        json!({
            "job_identifier": self.job_identifier,
            "source_document_name": self.source_document_name,
            "lifecycle_state": self.lifecycle_state,
            "completion_percentage": self.completion_percentage,
            "is_terminal": self.is_terminal,
            "chunks": chunks,
        })
    }
}

// ---------------------------------------------------------------------------
// 1. Parse a raw job identifier into a validated value object.
// ---------------------------------------------------------------------------

fn parse_describe_ocr_stream_job_identifier(
    raw_job_identifier: &str,
) -> Result<PersistedOcrStreamJobIdentifier, HttpError> {
    let trimmed = raw_job_identifier.trim();
    if trimmed.is_empty() {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: "an ocr stream job identifier must be provided".to_string(),
        });
    }
    if trimmed.len() > 128 {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: "the ocr stream job identifier exceeds the permitted length".to_string(),
        });
    }
    let is_permitted = trimmed
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_');
    if !is_permitted {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: "the ocr stream job identifier contains unsupported characters".to_string(),
        });
    }
    Ok(PersistedOcrStreamJobIdentifier {
        raw_identifier: trimmed.to_string(),
    })
}

// ---------------------------------------------------------------------------
// 2. Load a persisted job record from an already-fetched document.
//
// The plan names a `TransactionalUnitOfWork`-generic loader; to avoid dragging
// the whole state (and its `UnitOfWork` bound) into a pure helper we operate on
// a concrete `StoredDocument` fetched by the handler.
// ---------------------------------------------------------------------------

fn load_ocr_stream_job_record_within_transactional_unit(
    stored_document: &StoredDocument,
    job_identifier: &PersistedOcrStreamJobIdentifier,
) -> Result<PersistedOcrStreamJobRecord, HttpError> {
    let body = &stored_document.document_body;

    let total_chunk_count = body
        .get("total_chunk_count")
        .and_then(Value::as_u64)
        .ok_or_else(|| HttpError::UpstreamApplicationFailure {
            explanation: "the persisted ocr job record is missing total_chunk_count".to_string(),
        })? as u32;

    let source_document_name = body
        .get("source_document_name")
        .and_then(Value::as_str)
        .unwrap_or("unnamed document")
        .to_string();

    Ok(PersistedOcrStreamJobRecord {
        job_identifier: job_identifier.clone(),
        owning_account: stored_document.owning_account.clone(),
        total_chunk_count,
        source_document_name,
    })
}

// ---------------------------------------------------------------------------
// 3. Query the current progress of a job.
//
// Progress is derived from the persisted job body's `progress` sub-object,
// which the streaming worker updates as chunks complete. The function returns a
// snapshot bounded by the record's total chunk count.
// ---------------------------------------------------------------------------

fn query_ocr_stream_job_current_progress(
    stored_document: &StoredDocument,
    record: &PersistedOcrStreamJobRecord,
) -> Result<OcrStreamJobProgressSnapshot, HttpError> {
    let body = &stored_document.document_body;

    let completed_chunk_indices =
        extract_chunk_index_array(body.get("progress").and_then(|p| p.get("completed_chunks")));
    let failed_chunk_indices =
        extract_chunk_index_array(body.get("progress").and_then(|p| p.get("failed_chunks")));

    let average_chunk_duration_seconds = body
        .get("progress")
        .and_then(|p| p.get("average_chunk_duration_seconds"))
        .and_then(Value::as_u64)
        .unwrap_or(0);

    // A progress sub-object that is present but not an object indicates the
    // upstream worker wrote a malformed progress record; surface it as an
    // adapter-shaped failure.
    if let Some(progress_value) = body.get("progress") {
        if !progress_value.is_object() {
            return Err(map_ocr_stream_progress_query_error_to_http_error(
                "the persisted progress record is not a json object".to_string(),
            ));
        }
    }

    if completed_chunk_indices
        .iter()
        .chain(failed_chunk_indices.iter())
        .any(|index| *index >= record.total_chunk_count)
    {
        return Err(HttpError::UpstreamApplicationFailure {
            explanation: "a reported chunk index exceeds the job's total chunk count".to_string(),
        });
    }

    Ok(OcrStreamJobProgressSnapshot {
        total_chunk_count: record.total_chunk_count,
        completed_chunk_indices,
        failed_chunk_indices,
        average_chunk_duration_seconds,
    })
}

/// Extract a sorted, deduplicated list of chunk indices from a JSON array.
fn extract_chunk_index_array(maybe_array: Option<&Value>) -> Vec<u32> {
    let mut indices: Vec<u32> = maybe_array
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(Value::as_u64)
                .map(|value| value as u32)
                .collect()
        })
        .unwrap_or_default();
    indices.sort_unstable();
    indices.dedup();
    indices
}

// ---------------------------------------------------------------------------
// 4. Completion percentage (0..=100).
// ---------------------------------------------------------------------------

fn compute_ocr_stream_job_completion_percentage(progress: &OcrStreamJobProgressSnapshot) -> u8 {
    if progress.total_chunk_count == 0 {
        return 100;
    }
    let settled = count_ocr_stream_job_completed_chunks(progress) as u64
        + progress.failed_chunk_indices.len() as u64;
    let percentage = settled * 100 / progress.total_chunk_count as u64;
    percentage.min(100) as u8
}

// ---------------------------------------------------------------------------
// 5. Derive lifecycle state.
// ---------------------------------------------------------------------------

fn derive_ocr_stream_job_lifecycle_state(
    progress: &OcrStreamJobProgressSnapshot,
) -> OcrStreamJobLifecycleState {
    let completed = count_ocr_stream_job_completed_chunks(progress);
    let failed = progress.failed_chunk_indices.len() as u32;
    let remaining = count_ocr_stream_job_remaining_chunks(progress);

    if progress.total_chunk_count == 0 {
        return OcrStreamJobLifecycleState::Completed;
    }
    if remaining == 0 {
        if failed > 0 {
            return OcrStreamJobLifecycleState::Failed;
        }
        return OcrStreamJobLifecycleState::Completed;
    }
    if completed == 0 && failed == 0 {
        return OcrStreamJobLifecycleState::Pending;
    }
    OcrStreamJobLifecycleState::Running
}

// ---------------------------------------------------------------------------
// 6. Count completed chunks.
// ---------------------------------------------------------------------------

fn count_ocr_stream_job_completed_chunks(progress: &OcrStreamJobProgressSnapshot) -> u32 {
    progress.completed_chunk_indices.len() as u32
}

// ---------------------------------------------------------------------------
// 7. Count remaining chunks.
// ---------------------------------------------------------------------------

fn count_ocr_stream_job_remaining_chunks(progress: &OcrStreamJobProgressSnapshot) -> u32 {
    let settled =
        count_ocr_stream_job_completed_chunks(progress) + progress.failed_chunk_indices.len() as u32;
    progress.total_chunk_count.saturating_sub(settled)
}

// ---------------------------------------------------------------------------
// 8. Estimate remaining duration in seconds.
// ---------------------------------------------------------------------------

fn estimate_ocr_stream_job_remaining_duration_seconds(
    progress: &OcrStreamJobProgressSnapshot,
) -> u64 {
    let remaining = count_ocr_stream_job_remaining_chunks(progress) as u64;
    remaining.saturating_mul(progress.average_chunk_duration_seconds)
}

// ---------------------------------------------------------------------------
// 9. Collect failed chunk indices.
// ---------------------------------------------------------------------------

fn collect_ocr_stream_job_failed_chunk_indices(
    progress: &OcrStreamJobProgressSnapshot,
) -> Vec<u32> {
    progress.failed_chunk_indices.clone()
}

// ---------------------------------------------------------------------------
// 10. Map a missing job to an HTTP error.
// ---------------------------------------------------------------------------

fn map_ocr_stream_job_not_found_error_to_http_error(
    job_identifier: &PersistedOcrStreamJobIdentifier,
) -> HttpError {
    HttpError::RequestedResourceWasNotFound {
        explanation: format!(
            "no ocr stream job exists with identifier '{}'",
            job_identifier.as_str()
        ),
    }
}

// ---------------------------------------------------------------------------
// 11. Map a progress-query failure to an HTTP error.
//
// The plan references an adapter-specific error type; the codebase surfaces all
// adapter failures as strings, so we take the failure explanation directly.
// ---------------------------------------------------------------------------

fn map_ocr_stream_progress_query_error_to_http_error(adapter_error: String) -> HttpError {
    HttpError::UpstreamApplicationFailure {
        explanation: format!("failed to query ocr stream progress: {adapter_error}"),
    }
}

// ---------------------------------------------------------------------------
// 12. Resolve the SSE subscription URL for a job.
// ---------------------------------------------------------------------------

fn resolve_ocr_stream_job_subscription_url(
    job_identifier: &PersistedOcrStreamJobIdentifier,
) -> NonEmptyText {
    let url = format!("/api/ocr-stream/{}/events", job_identifier.as_str());
    // The formatted string is always non-empty because the identifier was
    // validated as non-empty on the way in; fall back to the base path if
    // parsing ever fails so the function remains total.
    NonEmptyText::parse(url).unwrap_or_else(|_| {
        NonEmptyText::parse("/api/ocr-stream".to_string())
            .expect("the base ocr stream path is a non-empty literal")
    })
}

// ---------------------------------------------------------------------------
// 13. Build per-chunk status descriptors.
// ---------------------------------------------------------------------------

fn build_ocr_stream_job_chunk_status_descriptors(
    progress: &OcrStreamJobProgressSnapshot,
) -> Vec<OcrStreamJobChunkStatusDescriptor> {
    let failed = collect_ocr_stream_job_failed_chunk_indices(progress);
    (0..progress.total_chunk_count)
        .map(|chunk_index| {
            let chunk_status = if failed.contains(&chunk_index) {
                "failed"
            } else if progress.completed_chunk_indices.contains(&chunk_index) {
                "completed"
            } else {
                "pending"
            };
            OcrStreamJobChunkStatusDescriptor {
                chunk_index,
                chunk_status,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 14. Assemble the response payload.
// ---------------------------------------------------------------------------

fn assemble_describe_ocr_stream_response_payload(
    record: &PersistedOcrStreamJobRecord,
    lifecycle_state: OcrStreamJobLifecycleState,
    completion_percentage: u8,
    chunk_descriptors: Vec<OcrStreamJobChunkStatusDescriptor>,
) -> DescribeOcrStreamResponsePayload {
    DescribeOcrStreamResponsePayload {
        job_identifier: record.job_identifier.as_str().to_string(),
        source_document_name: record.source_document_name.clone(),
        lifecycle_state: lifecycle_state.as_str(),
        completion_percentage,
        is_terminal: determine_ocr_stream_job_is_terminal(&lifecycle_state),
        chunk_descriptors,
    }
}

// ---------------------------------------------------------------------------
// 15. Whether a lifecycle state is terminal.
// ---------------------------------------------------------------------------

fn determine_ocr_stream_job_is_terminal(lifecycle_state: &OcrStreamJobLifecycleState) -> bool {
    matches!(
        lifecycle_state,
        OcrStreamJobLifecycleState::Completed | OcrStreamJobLifecycleState::Failed
    )
}

// ---------------------------------------------------------------------------
// Handler
//
// GET /api/ocr-stream — describe every OCR streaming job owned by the caller,
// including live progress, lifecycle state and per-chunk status. Because the
// route carries no path/query parameters we enumerate the caller's jobs from
// the OCR jobs collection and describe each one.
// ---------------------------------------------------------------------------

#[route(method = "GET", path = "/api/ocr-stream")]
pub async fn describe_ocr_stream_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let owning_account = authorized_request.authorized_principal().as_str();

    let stored_jobs = application_state
        .document_collection
        .list_documents_owned_by(OCR_JOBS_COLLECTION_NAME, owning_account)
        .await?;

    let mut described_jobs: Vec<Value> = Vec::with_capacity(stored_jobs.len());

    for stored_document in &stored_jobs {
        let job_identifier =
            parse_describe_ocr_stream_job_identifier(&stored_document.document_identifier)?;

        let record = load_ocr_stream_job_record_within_transactional_unit(
            stored_document,
            &job_identifier,
        )?;

        // Validate ownership defensively: the persisted record must belong to
        // the caller. If it somehow does not, treat it as not found.
        if let Some(record_owner) = &record.owning_account {
            if record_owner != owning_account {
                return Err(map_ocr_stream_job_not_found_error_to_http_error(
                    &job_identifier,
                ));
            }
        }

        let progress = query_ocr_stream_job_current_progress(stored_document, &record)?;

        let lifecycle_state = derive_ocr_stream_job_lifecycle_state(&progress);
        let completion_percentage = compute_ocr_stream_job_completion_percentage(&progress);
        let chunk_descriptors = build_ocr_stream_job_chunk_status_descriptors(&progress);
        let subscription_url = resolve_ocr_stream_job_subscription_url(&job_identifier);
        let remaining_seconds = estimate_ocr_stream_job_remaining_duration_seconds(&progress);
        let failed_chunk_indices = collect_ocr_stream_job_failed_chunk_indices(&progress);
        let remaining_chunks = count_ocr_stream_job_remaining_chunks(&progress);

        let payload = assemble_describe_ocr_stream_response_payload(
            &record,
            lifecycle_state,
            completion_percentage,
            chunk_descriptors,
        );

        let mut described = payload.into_json();
        if let Value::Object(map) = &mut described {
            map.insert(
                "subscription_url".to_string(),
                json!(subscription_url.as_str()),
            );
            map.insert(
                "estimated_remaining_seconds".to_string(),
                json!(remaining_seconds),
            );
            map.insert("remaining_chunk_count".to_string(), json!(remaining_chunks));
            map.insert("failed_chunk_indices".to_string(), json!(failed_chunk_indices));
        }
        described_jobs.push(described);
    }

    Ok(Json(json!({
        "streaming_available": true,
        "transport": "server sent events",
        "resource": "ocr",
        "job_count": described_jobs.len(),
        "jobs": described_jobs,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(total: u32, completed: Vec<u32>, failed: Vec<u32>, avg: u64) -> OcrStreamJobProgressSnapshot {
        OcrStreamJobProgressSnapshot {
            total_chunk_count: total,
            completed_chunk_indices: completed,
            failed_chunk_indices: failed,
            average_chunk_duration_seconds: avg,
        }
    }

    #[test]
    fn parse_identifier_accepts_valid_and_trims() {
        let parsed = parse_describe_ocr_stream_job_identifier("  job-abc_123 ").unwrap();
        assert_eq!(parsed.as_str(), "job-abc_123");
    }

    #[test]
    fn parse_identifier_rejects_empty_and_bad_characters() {
        assert!(parse_describe_ocr_stream_job_identifier("   ").is_err());
        assert!(parse_describe_ocr_stream_job_identifier("bad id!").is_err());
        let too_long = "a".repeat(129);
        assert!(parse_describe_ocr_stream_job_identifier(&too_long).is_err());
    }

    #[test]
    fn load_record_reads_body_fields() {
        let document = StoredDocument {
            document_identifier: "job-1".to_string(),
            owning_account: Some("alice@example.com".to_string()),
            document_body: json!({
                "total_chunk_count": 4,
                "source_document_name": "scan.pdf"
            }),
        };
        let identifier = parse_describe_ocr_stream_job_identifier("job-1").unwrap();
        let record =
            load_ocr_stream_job_record_within_transactional_unit(&document, &identifier).unwrap();
        assert_eq!(record.total_chunk_count, 4);
        assert_eq!(record.source_document_name, "scan.pdf");
    }

    #[test]
    fn load_record_fails_without_chunk_count() {
        let document = StoredDocument {
            document_identifier: "job-2".to_string(),
            owning_account: None,
            document_body: json!({ "source_document_name": "x.pdf" }),
        };
        let identifier = parse_describe_ocr_stream_job_identifier("job-2").unwrap();
        assert!(load_ocr_stream_job_record_within_transactional_unit(&document, &identifier).is_err());
    }

    #[test]
    fn query_progress_extracts_and_validates_indices() {
        let document = StoredDocument {
            document_identifier: "job-3".to_string(),
            owning_account: None,
            document_body: json!({
                "total_chunk_count": 3,
                "progress": {
                    "completed_chunks": [0, 1, 1],
                    "failed_chunks": [2],
                    "average_chunk_duration_seconds": 5
                }
            }),
        };
        let identifier = parse_describe_ocr_stream_job_identifier("job-3").unwrap();
        let record =
            load_ocr_stream_job_record_within_transactional_unit(&document, &identifier).unwrap();
        let progress = query_ocr_stream_job_current_progress(&document, &record).unwrap();
        assert_eq!(progress.completed_chunk_indices, vec![0, 1]);
        assert_eq!(progress.failed_chunk_indices, vec![2]);
        assert_eq!(progress.average_chunk_duration_seconds, 5);
    }

    #[test]
    fn query_progress_rejects_out_of_range_index() {
        let document = StoredDocument {
            document_identifier: "job-4".to_string(),
            owning_account: None,
            document_body: json!({
                "total_chunk_count": 2,
                "progress": { "completed_chunks": [5] }
            }),
        };
        let identifier = parse_describe_ocr_stream_job_identifier("job-4").unwrap();
        let record =
            load_ocr_stream_job_record_within_transactional_unit(&document, &identifier).unwrap();
        assert!(query_ocr_stream_job_current_progress(&document, &record).is_err());
    }

    #[test]
    fn completion_percentage_handles_empty_and_partial() {
        assert_eq!(
            compute_ocr_stream_job_completion_percentage(&snapshot(0, vec![], vec![], 0)),
            100
        );
        assert_eq!(
            compute_ocr_stream_job_completion_percentage(&snapshot(4, vec![0, 1], vec![], 0)),
            50
        );
        assert_eq!(
            compute_ocr_stream_job_completion_percentage(&snapshot(4, vec![0], vec![1], 0)),
            50
        );
    }

    #[test]
    fn lifecycle_state_transitions() {
        assert_eq!(
            derive_ocr_stream_job_lifecycle_state(&snapshot(0, vec![], vec![], 0)),
            OcrStreamJobLifecycleState::Completed
        );
        assert_eq!(
            derive_ocr_stream_job_lifecycle_state(&snapshot(3, vec![], vec![], 0)),
            OcrStreamJobLifecycleState::Pending
        );
        assert_eq!(
            derive_ocr_stream_job_lifecycle_state(&snapshot(3, vec![0], vec![], 0)),
            OcrStreamJobLifecycleState::Running
        );
        assert_eq!(
            derive_ocr_stream_job_lifecycle_state(&snapshot(2, vec![0, 1], vec![], 0)),
            OcrStreamJobLifecycleState::Completed
        );
        assert_eq!(
            derive_ocr_stream_job_lifecycle_state(&snapshot(2, vec![0], vec![1], 0)),
            OcrStreamJobLifecycleState::Failed
        );
    }

    #[test]
    fn count_completed_and_remaining() {
        let snap = snapshot(5, vec![0, 1], vec![2], 0);
        assert_eq!(count_ocr_stream_job_completed_chunks(&snap), 2);
        assert_eq!(count_ocr_stream_job_remaining_chunks(&snap), 2);
    }

    #[test]
    fn remaining_duration_estimate() {
        let snap = snapshot(5, vec![0, 1], vec![2], 4);
        // 2 remaining chunks * 4 seconds each = 8
        assert_eq!(estimate_ocr_stream_job_remaining_duration_seconds(&snap), 8);
    }

    #[test]
    fn failed_indices_are_collected() {
        let snap = snapshot(4, vec![0], vec![2, 3], 0);
        assert_eq!(collect_ocr_stream_job_failed_chunk_indices(&snap), vec![2, 3]);
    }

    #[test]
    fn not_found_error_mentions_identifier() {
        let identifier = parse_describe_ocr_stream_job_identifier("job-missing").unwrap();
        let error = map_ocr_stream_job_not_found_error_to_http_error(&identifier);
        match error {
            HttpError::RequestedResourceWasNotFound { explanation } => {
                assert!(explanation.contains("job-missing"));
            }
            _ => panic!("expected a not found error"),
        }
    }

    #[test]
    fn progress_query_error_is_upstream_failure() {
        let error = map_ocr_stream_progress_query_error_to_http_error("timeout".to_string());
        match error {
            HttpError::UpstreamApplicationFailure { explanation } => {
                assert!(explanation.contains("timeout"));
            }
            _ => panic!("expected an upstream failure"),
        }
    }

    #[test]
    fn subscription_url_is_built() {
        let identifier = parse_describe_ocr_stream_job_identifier("job-9").unwrap();
        let url = resolve_ocr_stream_job_subscription_url(&identifier);
        assert_eq!(url.as_str(), "/api/ocr-stream/job-9/events");
    }

    #[test]
    fn chunk_status_descriptors_reflect_progress() {
        let snap = snapshot(3, vec![0], vec![2], 0);
        let descriptors = build_ocr_stream_job_chunk_status_descriptors(&snap);
        assert_eq!(descriptors.len(), 3);
        assert_eq!(descriptors[0].chunk_status, "completed");
        assert_eq!(descriptors[1].chunk_status, "pending");
        assert_eq!(descriptors[2].chunk_status, "failed");
    }

    #[test]
    fn assemble_payload_populates_fields() {
        let identifier = parse_describe_ocr_stream_job_identifier("job-x").unwrap();
        let record = PersistedOcrStreamJobRecord {
            job_identifier: identifier,
            owning_account: Some("bob@example.com".to_string()),
            total_chunk_count: 2,
            source_document_name: "doc.pdf".to_string(),
        };
        let descriptors = build_ocr_stream_job_chunk_status_descriptors(&snapshot(2, vec![0, 1], vec![], 0));
        let payload = assemble_describe_ocr_stream_response_payload(
            &record,
            OcrStreamJobLifecycleState::Completed,
            100,
            descriptors,
        );
        assert_eq!(payload.job_identifier, "job-x");
        assert_eq!(payload.completion_percentage, 100);
        assert!(payload.is_terminal);
        assert_eq!(payload.lifecycle_state, "completed");
    }

    #[test]
    fn terminal_states_are_completed_or_failed() {
        assert!(determine_ocr_stream_job_is_terminal(&OcrStreamJobLifecycleState::Completed));
        assert!(determine_ocr_stream_job_is_terminal(&OcrStreamJobLifecycleState::Failed));
        assert!(!determine_ocr_stream_job_is_terminal(&OcrStreamJobLifecycleState::Pending));
        assert!(!determine_ocr_stream_job_is_terminal(&OcrStreamJobLifecycleState::Running));
    }
}
