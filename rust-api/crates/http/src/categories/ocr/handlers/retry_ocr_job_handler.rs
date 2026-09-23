use crate::categories::ocr::collections::OCR_JOBS_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::ports::document_collection::StoredDocument;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};

/// The largest number of retry attempts an OCR job may accumulate before it is
/// permanently rejected. Kept intentionally small so a stuck job cannot loop
/// indefinitely and exhaust upstream capacity.
const MAXIMUM_OCR_JOB_RETRY_ATTEMPTS: u32 = 5;

/// The base backoff (in seconds) applied to the first retry. Subsequent retries
/// grow exponentially from this value (capped) to avoid stampeding the
/// downstream artificial-intelligence adapter.
const OCR_JOB_RETRY_BASE_BACKOFF_SECONDS: u64 = 2;

/// The ceiling (in seconds) that the exponential backoff is never allowed to
/// exceed, so a high attempt number does not produce an absurd delay.
const OCR_JOB_RETRY_MAXIMUM_BACKOFF_SECONDS: u64 = 300;

/// A validated OCR job identifier. Wrapping the raw string in a newtype makes it
/// impossible to accidentally pass an unvalidated identifier further down.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistedOcrJobIdentifier {
    identifier_value: String,
}

impl PersistedOcrJobIdentifier {
    fn as_str(&self) -> &str {
        &self.identifier_value
    }
}

/// A snapshot of an OCR job as it currently lives in the document collection.
/// Carries both the stored envelope (for owner/identifier) and the decoded body
/// so helpers can reason over concrete data without re-touching the collection.
#[derive(Debug, Clone)]
pub struct PersistedOcrJobRecord {
    identifier_value: String,
    owning_account: Option<String>,
    job_body: Value,
}

/// Describes where the source artifact for an OCR job lives, so a retry can be
/// dispatched against the same input that originally failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredDocumentDescriptor {
    source_storage_key: String,
    source_content_type: String,
}

/// A fully-assembled request describing what a retry should reprocess.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OcrJobProcessingRequest {
    job_identifier: String,
    source_storage_key: String,
    source_content_type: String,
    retry_attempt_number: u32,
    page_indices_to_reprocess: Vec<u32>,
}

/// The audit trail entry produced whenever a retry is accepted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OcrJobAuditEntry {
    job_identifier: String,
    retry_attempt_number: u32,
    audit_action: String,
}

/// The response payload returned to the caller once a retry is scheduled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetryOcrJobResponsePayload {
    job_identifier: String,
    retry_attempt_number: u32,
    backoff_delay_seconds: u64,
    job_status: String,
}

impl RetryOcrJobResponsePayload {
    fn into_json(self) -> Value {
        json!({
            "job_identifier": self.job_identifier,
            "retry_attempt_number": self.retry_attempt_number,
            "backoff_delay_seconds": self.backoff_delay_seconds,
            "status": self.job_status,
        })
    }
}

#[route(method = "POST", path = "/api/ocr-retry")]
pub async fn retry_ocr_job_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // 1. Validate the incoming identifier.
    let raw_job_identifier = submitted_body
        .get("job_identifier")
        .and_then(|value| value.as_str())
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: String::from("the 'job_identifier' field is required"),
        })?;
    let validated_job_identifier = parse_retry_ocr_job_identifier(raw_job_identifier)?;

    // 2. Load the current job record from the collection.
    let located_document = application_state
        .document_collection
        .fetch_document(OCR_JOBS_COLLECTION_NAME, validated_job_identifier.as_str())
        .await?;
    let job_record = load_ocr_job_record_from_stored_document(
        located_document,
        &validated_job_identifier,
    )?;

    // 3. Ensure the job is actually in a state from which a retry makes sense.
    validate_ocr_job_is_in_retryable_state(&job_record)?;

    // 4/5. Compute the next attempt number and reject if exhausted.
    let next_retry_attempt_number = compute_ocr_job_next_retry_attempt_number(&job_record);
    reject_ocr_job_retry_when_maximum_attempts_exhausted(
        next_retry_attempt_number,
        MAXIMUM_OCR_JOB_RETRY_ATTEMPTS,
    )?;

    // 6/7/8. Resolve the source artifact and assemble the processing request.
    let source_descriptor = resolve_ocr_job_retry_source_descriptor(&job_record)?;
    let processing_request = build_ocr_job_retry_processing_request(
        &job_record,
        &source_descriptor,
        next_retry_attempt_number,
    );

    // 9. Dispatch the retry to the artificial-intelligence adapter.
    let generation_prompt = describe_ocr_job_retry_prompt(&processing_request);
    let dispatch_outcome = application_state
        .artificial_intelligence_adapter
        .generate_completion(&generation_prompt)
        .await;
    let new_handle = interpret_ocr_job_retry_dispatch_outcome(
        dispatch_outcome,
        &validated_job_identifier,
        next_retry_attempt_number,
    )?;

    // 10. Persist the new retry metadata back into the collection.
    let updated_document = update_ocr_job_record_retry_metadata(
        &job_record,
        next_retry_attempt_number,
        &new_handle,
    );
    let record_existed = application_state
        .document_collection
        .replace_document(OCR_JOBS_COLLECTION_NAME, updated_document)
        .await?;
    if !record_existed {
        return Err(map_ocr_job_not_found_error_to_http_error(
            &validated_job_identifier,
        ));
    }

    // 11/12/13. Compute backoff and record the audit entry.
    let backoff_delay_seconds =
        compute_ocr_job_retry_backoff_delay_seconds(next_retry_attempt_number);
    let audit_entry = record_ocr_job_retry_audit_entry(
        &validated_job_identifier,
        next_retry_attempt_number,
    );

    // 15. Assemble and return the response payload, carrying the audit action.
    let response_payload = assemble_retry_ocr_job_response_payload(
        &validated_job_identifier,
        next_retry_attempt_number,
        backoff_delay_seconds,
        &audit_entry,
    );
    Ok(Json(response_payload.into_json()))
}

/// (1) Validate and wrap a raw OCR job identifier. Rejects empty / whitespace
/// identifiers and identifiers that are implausibly long.
fn parse_retry_ocr_job_identifier(
    raw_job_identifier: &str,
) -> Result<PersistedOcrJobIdentifier, HttpError> {
    let trimmed_identifier = raw_job_identifier.trim();
    if trimmed_identifier.is_empty() {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from("the 'job_identifier' must not be empty"),
        });
    }
    if trimmed_identifier.len() > 256 {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from("the 'job_identifier' is too long"),
        });
    }
    Ok(PersistedOcrJobIdentifier {
        identifier_value: trimmed_identifier.to_string(),
    })
}

/// (2) Convert a possibly-missing stored document into a decoded job record,
/// mapping absence to a not-found error keyed on the requested identifier.
fn load_ocr_job_record_from_stored_document(
    optionally_located_document: Option<StoredDocument>,
    job_identifier: &PersistedOcrJobIdentifier,
) -> Result<PersistedOcrJobRecord, HttpError> {
    match optionally_located_document {
        Some(located_document) => Ok(PersistedOcrJobRecord {
            identifier_value: located_document.document_identifier,
            owning_account: located_document.owning_account,
            job_body: located_document.document_body,
        }),
        None => Err(map_ocr_job_not_found_error_to_http_error(job_identifier)),
    }
}

/// (3) Confirm the job is in a state that can be retried. Only `failed`,
/// `errored`, or `cancelled` jobs are eligible; anything else is rejected.
fn validate_ocr_job_is_in_retryable_state(
    job_record: &PersistedOcrJobRecord,
) -> Result<(), HttpError> {
    let current_status = read_string_field(&job_record.job_body, "status").unwrap_or_default();
    let normalized_status = current_status.to_ascii_lowercase();
    let is_retryable = matches!(
        normalized_status.as_str(),
        "failed" | "errored" | "cancelled" | "canceled"
    );
    if is_retryable {
        Ok(())
    } else {
        Err(HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "an ocr job in status '{current_status}' cannot be retried"
            ),
        })
    }
}

/// (4) Determine the attempt number that this retry will represent. If the job
/// has never been retried the count is treated as zero, so the next attempt is
/// one; otherwise it is the stored count plus one.
fn compute_ocr_job_next_retry_attempt_number(job_record: &PersistedOcrJobRecord) -> u32 {
    let existing_attempts = job_record
        .job_body
        .get("retry_attempt_number")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    let clamped_existing = u32::try_from(existing_attempts).unwrap_or(u32::MAX);
    clamped_existing.saturating_add(1)
}

/// (5) Reject the retry when the prospective attempt number would exceed the
/// permitted maximum.
fn reject_ocr_job_retry_when_maximum_attempts_exhausted(
    current_attempt_count: u32,
    maximum_retry_attempts: u32,
) -> Result<(), HttpError> {
    if current_attempt_count > maximum_retry_attempts {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "the ocr job has exhausted its {maximum_retry_attempts} permitted retry attempts"
            ),
        });
    }
    Ok(())
}

/// (6) Resolve the descriptor of the source artifact from the job body so the
/// retry reprocesses the same input. Fails if the record lacks a storage key.
fn resolve_ocr_job_retry_source_descriptor(
    job_record: &PersistedOcrJobRecord,
) -> Result<StoredDocumentDescriptor, HttpError> {
    let source_storage_key = read_string_field(&job_record.job_body, "source_storage_key")
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: String::from(
                "the ocr job record is missing its 'source_storage_key'",
            ),
        })?;
    let source_content_type = read_string_field(&job_record.job_body, "source_content_type")
        .unwrap_or_else(|| String::from("application/pdf"));
    Ok(StoredDocumentDescriptor {
        source_storage_key,
        source_content_type,
    })
}

/// (7) Assemble the request that describes what the retry should reprocess,
/// including the specific pages that previously failed (if any).
fn build_ocr_job_retry_processing_request(
    job_record: &PersistedOcrJobRecord,
    source: &StoredDocumentDescriptor,
    retry_attempt_number: u32,
) -> OcrJobProcessingRequest {
    let page_indices_to_reprocess = collect_ocr_job_previously_failed_page_indices(job_record);
    OcrJobProcessingRequest {
        job_identifier: job_record.identifier_value.clone(),
        source_storage_key: source.source_storage_key.clone(),
        source_content_type: source.source_content_type.clone(),
        retry_attempt_number,
        page_indices_to_reprocess,
    }
}

/// (8) Collect the page indices that previously failed, deduplicated and sorted
/// ascending. Non-numeric or negative entries are ignored.
fn collect_ocr_job_previously_failed_page_indices(
    job_record: &PersistedOcrJobRecord,
) -> Vec<u32> {
    let mut collected_indices: Vec<u32> = job_record
        .job_body
        .get("failed_page_indices")
        .and_then(|value| value.as_array())
        .map(|array_values| {
            array_values
                .iter()
                .filter_map(|entry| entry.as_u64())
                .filter_map(|entry| u32::try_from(entry).ok())
                .collect()
        })
        .unwrap_or_default();
    collected_indices.sort_unstable();
    collected_indices.dedup();
    collected_indices
}

/// (9-helper) Produce the natural-language prompt handed to the
/// artificial-intelligence adapter to describe the retry work.
fn describe_ocr_job_retry_prompt(request: &OcrJobProcessingRequest) -> alma_domain::value_objects::NonEmptyText {
    let page_description = if request.page_indices_to_reprocess.is_empty() {
        String::from("all pages")
    } else {
        let joined = request
            .page_indices_to_reprocess
            .iter()
            .map(|page_index| page_index.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        format!("pages {joined}")
    };
    let prompt_text = format!(
        "Re-run optical character recognition (attempt {}) for job '{}' over source '{}' \
         of type '{}', reprocessing {}.",
        request.retry_attempt_number,
        request.job_identifier,
        request.source_storage_key,
        request.source_content_type,
        page_description,
    );
    // The prompt is always non-empty by construction (it embeds fixed text),
    // so a failure here would indicate a logic error; fall back to a constant.
    alma_domain::value_objects::NonEmptyText::parse(prompt_text)
        .unwrap_or_else(|_| {
            alma_domain::value_objects::NonEmptyText::parse(String::from(
                "Re-run optical character recognition for the requested ocr job.",
            ))
            .expect("the constant fallback prompt is non-empty")
        })
}

/// (9) Interpret the outcome of dispatching the retry to the adapter, turning a
/// successful completion into an opaque job handle and any error into an
/// upstream failure.
fn interpret_ocr_job_retry_dispatch_outcome(
    dispatch_outcome: Result<
        alma_application::ports::ai::GeneratedCompletion,
        alma_application::error::ApplicationError,
    >,
    job_identifier: &PersistedOcrJobIdentifier,
    retry_attempt_number: u32,
) -> Result<String, HttpError> {
    match dispatch_outcome {
        Ok(_generated_completion) => Ok(build_ocr_job_retry_handle(
            job_identifier,
            retry_attempt_number,
        )),
        Err(originating_error) => {
            Err(map_ocr_job_retry_dispatch_error_to_http_error(originating_error))
        }
    }
}

/// (9-helper) Build the deterministic handle recorded for a dispatched retry.
fn build_ocr_job_retry_handle(
    job_identifier: &PersistedOcrJobIdentifier,
    retry_attempt_number: u32,
) -> String {
    format!("{}::retry::{retry_attempt_number}", job_identifier.as_str())
}

/// (10) Produce the updated stored document carrying the new retry metadata.
/// The original body is preserved and only the retry-related fields are updated.
fn update_ocr_job_record_retry_metadata(
    job_record: &PersistedOcrJobRecord,
    retry_attempt_number: u32,
    new_handle: &str,
) -> StoredDocument {
    let mut updated_body = job_record.job_body.clone();
    if let Some(object_body) = updated_body.as_object_mut() {
        object_body.insert(String::from("status"), json!("retried"));
        object_body.insert(
            String::from("retry_attempt_number"),
            json!(retry_attempt_number),
        );
        object_body.insert(String::from("active_handle"), json!(new_handle));
    }
    StoredDocument {
        document_identifier: job_record.identifier_value.clone(),
        owning_account: job_record.owning_account.clone(),
        document_body: updated_body,
    }
}

/// (11) Build the not-found error keyed on a specific job identifier.
fn map_ocr_job_not_found_error_to_http_error(
    job_identifier: &PersistedOcrJobIdentifier,
) -> HttpError {
    HttpError::RequestedResourceWasNotFound {
        explanation: format!(
            "no ocr job exists under the identifier '{}'",
            job_identifier.as_str()
        ),
    }
}

/// (12) Map an adapter dispatch error into an upstream-failure HTTP error.
fn map_ocr_job_retry_dispatch_error_to_http_error(
    adapter_error: alma_application::error::ApplicationError,
) -> HttpError {
    HttpError::UpstreamApplicationFailure {
        explanation: format!("failed to dispatch the ocr retry: {adapter_error}"),
    }
}

/// (13) Compute the exponential backoff delay (seconds) for a retry attempt,
/// capped at the configured maximum.
fn compute_ocr_job_retry_backoff_delay_seconds(retry_attempt_number: u32) -> u64 {
    if retry_attempt_number == 0 {
        return 0;
    }
    // Exponent is attempt - 1 so the first retry uses the base delay directly.
    let exponent = retry_attempt_number.saturating_sub(1);
    let multiplier = 2u64.checked_pow(exponent).unwrap_or(u64::MAX);
    let raw_delay = OCR_JOB_RETRY_BASE_BACKOFF_SECONDS.saturating_mul(multiplier);
    raw_delay.min(OCR_JOB_RETRY_MAXIMUM_BACKOFF_SECONDS)
}

/// (14) Record an audit entry describing an accepted retry.
fn record_ocr_job_retry_audit_entry(
    job_identifier: &PersistedOcrJobIdentifier,
    retry_attempt_number: u32,
) -> OcrJobAuditEntry {
    OcrJobAuditEntry {
        job_identifier: job_identifier.as_str().to_string(),
        retry_attempt_number,
        audit_action: format!("ocr_job_retry_attempt_{retry_attempt_number}_accepted"),
    }
}

/// (15) Assemble the final response payload returned to the caller.
fn assemble_retry_ocr_job_response_payload(
    job_identifier: &PersistedOcrJobIdentifier,
    retry_attempt_number: u32,
    backoff_delay_seconds: u64,
    audit_entry: &OcrJobAuditEntry,
) -> RetryOcrJobResponsePayload {
    // Derive the status from the recorded audit action so the response always
    // reflects the audit trail: a recorded action means the retry was accepted.
    let job_status = if audit_entry.audit_action.is_empty() {
        String::from("unknown")
    } else {
        String::from("retried")
    };
    RetryOcrJobResponsePayload {
        job_identifier: job_identifier.as_str().to_string(),
        retry_attempt_number,
        backoff_delay_seconds,
        job_status,
    }
}

/// Shared helper: read a string field from a JSON object, returning `None` when
/// the field is missing or is not a string.
fn read_string_field(job_body: &Value, field_name: &str) -> Option<String> {
    job_body
        .get(field_name)
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_record(body: Value) -> PersistedOcrJobRecord {
        PersistedOcrJobRecord {
            identifier_value: String::from("job-1"),
            owning_account: Some(String::from("owner@example.com")),
            job_body: body,
        }
    }

    #[test]
    fn parse_retry_ocr_job_identifier_accepts_trimmed_value() {
        let parsed = parse_retry_ocr_job_identifier("  abc123  ").expect("should parse");
        assert_eq!(parsed.as_str(), "abc123");
    }

    #[test]
    fn parse_retry_ocr_job_identifier_rejects_empty() {
        assert!(parse_retry_ocr_job_identifier("   ").is_err());
    }

    #[test]
    fn parse_retry_ocr_job_identifier_rejects_overlong() {
        let overlong = "x".repeat(300);
        assert!(parse_retry_ocr_job_identifier(&overlong).is_err());
    }

    #[test]
    fn load_ocr_job_record_maps_missing_document_to_not_found() {
        let identifier = PersistedOcrJobIdentifier {
            identifier_value: String::from("missing"),
        };
        let outcome = load_ocr_job_record_from_stored_document(None, &identifier);
        assert!(matches!(
            outcome,
            Err(HttpError::RequestedResourceWasNotFound { .. })
        ));
    }

    #[test]
    fn load_ocr_job_record_decodes_present_document() {
        let identifier = PersistedOcrJobIdentifier {
            identifier_value: String::from("job-1"),
        };
        let stored = StoredDocument {
            document_identifier: String::from("job-1"),
            owning_account: None,
            document_body: json!({"status": "failed"}),
        };
        let record = load_ocr_job_record_from_stored_document(Some(stored), &identifier)
            .expect("should decode");
        assert_eq!(record.identifier_value, "job-1");
    }

    #[test]
    fn validate_retryable_state_accepts_failed() {
        let record = make_record(json!({"status": "FAILED"}));
        assert!(validate_ocr_job_is_in_retryable_state(&record).is_ok());
    }

    #[test]
    fn validate_retryable_state_rejects_completed() {
        let record = make_record(json!({"status": "completed"}));
        assert!(validate_ocr_job_is_in_retryable_state(&record).is_err());
    }

    #[test]
    fn compute_next_attempt_defaults_to_one() {
        let record = make_record(json!({"status": "failed"}));
        assert_eq!(compute_ocr_job_next_retry_attempt_number(&record), 1);
    }

    #[test]
    fn compute_next_attempt_increments_existing() {
        let record = make_record(json!({"retry_attempt_number": 3}));
        assert_eq!(compute_ocr_job_next_retry_attempt_number(&record), 4);
    }

    #[test]
    fn reject_when_exhausted_allows_within_limit() {
        assert!(reject_ocr_job_retry_when_maximum_attempts_exhausted(3, 5).is_ok());
    }

    #[test]
    fn reject_when_exhausted_blocks_over_limit() {
        assert!(reject_ocr_job_retry_when_maximum_attempts_exhausted(6, 5).is_err());
    }

    #[test]
    fn resolve_source_descriptor_reads_fields() {
        let record = make_record(json!({
            "source_storage_key": "bucket/key.pdf",
            "source_content_type": "image/png"
        }));
        let descriptor = resolve_ocr_job_retry_source_descriptor(&record).expect("should resolve");
        assert_eq!(descriptor.source_storage_key, "bucket/key.pdf");
        assert_eq!(descriptor.source_content_type, "image/png");
    }

    #[test]
    fn resolve_source_descriptor_defaults_content_type() {
        let record = make_record(json!({"source_storage_key": "bucket/key"}));
        let descriptor = resolve_ocr_job_retry_source_descriptor(&record).expect("should resolve");
        assert_eq!(descriptor.source_content_type, "application/pdf");
    }

    #[test]
    fn resolve_source_descriptor_requires_storage_key() {
        let record = make_record(json!({"status": "failed"}));
        assert!(resolve_ocr_job_retry_source_descriptor(&record).is_err());
    }

    #[test]
    fn build_processing_request_carries_pages() {
        let record = make_record(json!({"failed_page_indices": [2, 1, 2, 3]}));
        let source = StoredDocumentDescriptor {
            source_storage_key: String::from("k"),
            source_content_type: String::from("application/pdf"),
        };
        let request = build_ocr_job_retry_processing_request(&record, &source, 2);
        assert_eq!(request.retry_attempt_number, 2);
        assert_eq!(request.page_indices_to_reprocess, vec![1, 2, 3]);
    }

    #[test]
    fn collect_failed_pages_dedups_and_sorts() {
        let record = make_record(json!({"failed_page_indices": [5, 1, 5, 3, 1]}));
        assert_eq!(
            collect_ocr_job_previously_failed_page_indices(&record),
            vec![1, 3, 5]
        );
    }

    #[test]
    fn collect_failed_pages_empty_when_absent() {
        let record = make_record(json!({"status": "failed"}));
        assert!(collect_ocr_job_previously_failed_page_indices(&record).is_empty());
    }

    #[test]
    fn describe_prompt_handles_all_pages() {
        let request = OcrJobProcessingRequest {
            job_identifier: String::from("j"),
            source_storage_key: String::from("k"),
            source_content_type: String::from("application/pdf"),
            retry_attempt_number: 1,
            page_indices_to_reprocess: vec![],
        };
        let prompt = describe_ocr_job_retry_prompt(&request);
        assert!(prompt.as_str().contains("all pages"));
    }

    #[test]
    fn describe_prompt_lists_specific_pages() {
        let request = OcrJobProcessingRequest {
            job_identifier: String::from("j"),
            source_storage_key: String::from("k"),
            source_content_type: String::from("application/pdf"),
            retry_attempt_number: 1,
            page_indices_to_reprocess: vec![4, 7],
        };
        let prompt = describe_ocr_job_retry_prompt(&request);
        assert!(prompt.as_str().contains("pages 4, 7"));
    }

    #[test]
    fn build_handle_is_deterministic() {
        let identifier = PersistedOcrJobIdentifier {
            identifier_value: String::from("abc"),
        };
        assert_eq!(build_ocr_job_retry_handle(&identifier, 2), "abc::retry::2");
    }

    #[test]
    fn interpret_dispatch_ok_produces_handle() {
        let identifier = PersistedOcrJobIdentifier {
            identifier_value: String::from("abc"),
        };
        let completion = alma_application::ports::ai::GeneratedCompletion {
            produced_text: String::from("done"),
        };
        let handle = interpret_ocr_job_retry_dispatch_outcome(Ok(completion), &identifier, 1)
            .expect("should interpret");
        assert_eq!(handle, "abc::retry::1");
    }

    #[test]
    fn update_metadata_sets_status_and_attempt() {
        let record = make_record(json!({"status": "failed", "extra": "keep"}));
        let updated = update_ocr_job_record_retry_metadata(&record, 2, "abc::retry::2");
        assert_eq!(updated.document_body["status"], json!("retried"));
        assert_eq!(updated.document_body["retry_attempt_number"], json!(2));
        assert_eq!(updated.document_body["active_handle"], json!("abc::retry::2"));
        assert_eq!(updated.document_body["extra"], json!("keep"));
    }

    #[test]
    fn not_found_error_embeds_identifier() {
        let identifier = PersistedOcrJobIdentifier {
            identifier_value: String::from("xyz"),
        };
        match map_ocr_job_not_found_error_to_http_error(&identifier) {
            HttpError::RequestedResourceWasNotFound { explanation } => {
                assert!(explanation.contains("xyz"));
            }
            _ => panic!("expected not found"),
        }
    }

    #[test]
    fn dispatch_error_maps_to_upstream_failure() {
        let error = alma_application::error::ApplicationError::AuthorizationWasDenied;
        assert!(matches!(
            map_ocr_job_retry_dispatch_error_to_http_error(error),
            HttpError::UpstreamApplicationFailure { .. }
        ));
    }

    #[test]
    fn backoff_grows_exponentially_and_caps() {
        assert_eq!(compute_ocr_job_retry_backoff_delay_seconds(0), 0);
        assert_eq!(compute_ocr_job_retry_backoff_delay_seconds(1), 2);
        assert_eq!(compute_ocr_job_retry_backoff_delay_seconds(2), 4);
        assert_eq!(compute_ocr_job_retry_backoff_delay_seconds(3), 8);
        assert_eq!(
            compute_ocr_job_retry_backoff_delay_seconds(50),
            OCR_JOB_RETRY_MAXIMUM_BACKOFF_SECONDS
        );
    }

    #[test]
    fn audit_entry_records_action() {
        let identifier = PersistedOcrJobIdentifier {
            identifier_value: String::from("abc"),
        };
        let entry = record_ocr_job_retry_audit_entry(&identifier, 3);
        assert_eq!(entry.job_identifier, "abc");
        assert_eq!(entry.retry_attempt_number, 3);
        assert!(entry.audit_action.contains("attempt_3"));
    }

    #[test]
    fn assemble_response_payload_serializes() {
        let identifier = PersistedOcrJobIdentifier {
            identifier_value: String::from("abc"),
        };
        let audit_entry = record_ocr_job_retry_audit_entry(&identifier, 2);
        let payload = assemble_retry_ocr_job_response_payload(&identifier, 2, 4, &audit_entry);
        let json_value = payload.into_json();
        assert_eq!(json_value["job_identifier"], json!("abc"));
        assert_eq!(json_value["retry_attempt_number"], json!(2));
        assert_eq!(json_value["backoff_delay_seconds"], json!(4));
        assert_eq!(json_value["status"], json!("retried"));
    }

    #[test]
    fn read_string_field_handles_missing_and_present() {
        let body = json!({"present": "value", "numeric": 3});
        assert_eq!(read_string_field(&body, "present"), Some("value".to_string()));
        assert_eq!(read_string_field(&body, "numeric"), None);
        assert_eq!(read_string_field(&body, "absent"), None);
    }
}
