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
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Local domain model for the OCR stream-job creation workflow.
//
// The handler orchestrates the request/response contract for
// `POST /api/ocr-stream`. The types below model the intermediate values that
// flow between the pure helper functions. They are deliberately concrete and
// side-effect free so each helper can be unit tested in isolation.
// ---------------------------------------------------------------------------

/// Minimum number of pages that may be requested per streamed chunk.
const OCR_STREAM_JOB_MINIMUM_CHUNK_SIZE: u32 = 1;

/// Maximum number of pages that may be requested per streamed chunk.
const OCR_STREAM_JOB_MAXIMUM_CHUNK_SIZE: u32 = 250;

/// Fallback estimate for how many pages a source document contains when the
/// stored descriptor does not carry an explicit page count.
const OCR_STREAM_JOB_DEFAULT_ESTIMATED_PAGE_COUNT: u32 = 1;

/// Maximum number of pages the streaming channel can accept for a single job
/// before it reports its capacity as exhausted.
const OCR_STREAM_JOB_MAXIMUM_CHANNEL_PAGE_CAPACITY: u32 = 100_000;

/// A validated per-chunk page size for an OCR stream job.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct OcrStreamChunkSize {
    pages_per_chunk: u32,
}

impl OcrStreamChunkSize {
    fn value(&self) -> u32 {
        self.pages_per_chunk
    }
}

/// The requested serialization format for the OCR output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OcrOutputFormat {
    PlainText,
    Markdown,
    HypertextMarkup,
}

impl OcrOutputFormat {
    fn wire_label(&self) -> &'static str {
        match self {
            OcrOutputFormat::PlainText => "plain_text",
            OcrOutputFormat::Markdown => "markdown",
            OcrOutputFormat::HypertextMarkup => "hypertext_markup",
        }
    }
}

/// A resolved reference to the stored source document that will be processed.
#[derive(Debug, Clone, PartialEq, Eq)]
struct StoredDocumentDescriptor {
    document_identifier: String,
    owning_account: Option<String>,
    estimated_page_count: u32,
}

/// The request handed to the OCR channel opener once validation succeeds.
#[derive(Debug, Clone, PartialEq, Eq)]
struct OcrStreamJobProcessingRequest {
    source_document_identifier: String,
    chunk_size: u32,
    estimated_page_count: u32,
}

/// A handle to an opened streaming channel produced by the AI adapter.
#[derive(Debug, Clone, PartialEq, Eq)]
struct OcrStreamJobChannelHandle {
    channel_identifier: String,
    source_document_identifier: String,
    chunk_size: u32,
    estimated_page_count: u32,
}

/// Tracks in-flight progress of a stream job while chunks are emitted.
#[derive(Debug, Clone, PartialEq, Eq)]
struct OcrStreamJobProgressTracker {
    total_chunk_count: u32,
    completed_chunk_count: u32,
}

/// The persisted, externally visible identifier of a stream job.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PersistedOcrStreamJobIdentifier {
    identifier_value: String,
}

impl PersistedOcrStreamJobIdentifier {
    fn as_str(&self) -> &str {
        &self.identifier_value
    }
}

/// The response body returned to the caller on successful job creation.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CreateOcrStreamJobResponsePayload {
    job_identifier: String,
    subscription_url: String,
    total_chunk_count: u32,
}

impl CreateOcrStreamJobResponsePayload {
    fn into_json(self) -> Value {
        json!({
            "job_identifier": self.job_identifier,
            "subscription_url": self.subscription_url,
            "total_chunk_count": self.total_chunk_count,
            "status": "accepted",
        })
    }
}

/// A single audit-log entry describing job creation.
#[derive(Debug, Clone, PartialEq, Eq)]
struct OcrStreamJobAuditEntry {
    job_identifier: String,
    chunk_size: u32,
    audit_action: String,
}

/// Error surface for the local OCR channel-open simulation. Mirrors the shape
/// of an adapter error so it can be mapped onto an [`HttpError`].
#[derive(Debug, Clone, PartialEq, Eq)]
enum ArtificialIntelligenceAdapterError {
    ChannelCapacityExhausted { explanation: String },
    SourceDocumentUnprocessable { explanation: String },
    UpstreamUnavailable { explanation: String },
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

#[route(method = "POST", path = "/api/ocr-stream")]
pub async fn create_ocr_stream_job_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let owning_account = authorized_request
        .authorized_principal()
        .as_str()
        .to_string();

    // (1) Parse and validate the document reference the caller supplied.
    let raw_document_reference = submitted_body
        .get("document_reference")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let document_reference = parse_ocr_stream_job_document_reference(raw_document_reference)?;

    // (2) Validate the requested chunk size.
    let raw_chunk_size = submitted_body
        .get("chunk_size")
        .and_then(Value::as_u64)
        .map(|value| value as u32)
        .unwrap_or(OCR_STREAM_JOB_MINIMUM_CHUNK_SIZE);
    let chunk_size = validate_ocr_stream_job_requested_chunk_size(raw_chunk_size)?;

    // (14) Enforce the absolute minimum after size-range validation.
    reject_ocr_stream_job_when_chunk_size_below_minimum(
        chunk_size,
        OCR_STREAM_JOB_MINIMUM_CHUNK_SIZE,
    )?;

    // (10) Validate the requested output format.
    let raw_output_format = submitted_body
        .get("output_format")
        .and_then(Value::as_str)
        .unwrap_or("plain_text");
    let output_format = validate_ocr_stream_job_requested_output_format(raw_output_format)?;

    // (3) Resolve the stored source document into a descriptor.
    let fetched_document = application_state
        .document_collection
        .fetch_document(OCR_JOBS_COLLECTION_NAME, document_reference.as_str())
        .await?;
    let source_descriptor =
        resolve_ocr_stream_job_source_descriptor(fetched_document, &document_reference)?;

    // (4) Build the processing request handed to the AI channel opener.
    let processing_request =
        build_ocr_stream_job_processing_request(&source_descriptor, chunk_size);

    // (5) Open the streaming channel on the AI adapter (simulated locally).
    let channel_handle =
        open_ocr_stream_job_channel_on_artificial_intelligence_adapter(processing_request)?;

    // (6) Allocate a progress tracker for observability.
    let progress_tracker =
        allocate_ocr_stream_job_progress_tracker(&source_descriptor, chunk_size);

    // (9) Generate the persisted, externally visible job identifier.
    let job_identifier = generate_ocr_stream_job_identifier(&document_reference);

    // (8) Persist the job record and confirm the persisted identifier.
    let persisted_identifier =
        persist_ocr_stream_job_record(job_identifier.clone(), &channel_handle);

    // (15) Record an audit entry for the creation event.
    let audit_entry =
        record_ocr_stream_job_creation_audit_entry(&persisted_identifier, chunk_size);

    // (12) Derive the subscription URL clients poll for streamed chunks.
    let subscription_url = derive_ocr_stream_job_subscription_url(&persisted_identifier);

    // (13) Assemble the response payload.
    let response_payload = assemble_create_ocr_stream_job_response_payload(
        &persisted_identifier,
        &subscription_url,
        progress_tracker.total_chunk_count,
    );

    // Persist the durable job record in the document collection.
    let persisted_body = json!({
        "job_identifier": persisted_identifier.as_str(),
        "source_document_reference": document_reference.as_str(),
        "chunk_size": chunk_size.value(),
        "output_format": output_format.wire_label(),
        "channel_identifier": channel_handle.channel_identifier,
        "total_chunk_count": progress_tracker.total_chunk_count,
        "completed_chunk_count": progress_tracker.completed_chunk_count,
        "subscription_url": subscription_url.as_str(),
        "audit_action": audit_entry.audit_action,
        "status": "accepted",
    });
    let document_to_insert = StoredDocument {
        document_identifier: persisted_identifier.as_str().to_string(),
        owning_account: Some(owning_account),
        document_body: persisted_body,
    };
    application_state
        .document_collection
        .insert_document(OCR_JOBS_COLLECTION_NAME, document_to_insert)
        .await?;

    Ok(Json(response_payload.into_json()))
}

// ---------------------------------------------------------------------------
// (1) Parse the document reference.
// ---------------------------------------------------------------------------
fn parse_ocr_stream_job_document_reference(
    document_reference_string: &str,
) -> Result<NonEmptyText, HttpError> {
    let trimmed = document_reference_string.trim();
    if trimmed.is_empty() {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: "a non-empty 'document_reference' is required".to_string(),
        });
    }
    NonEmptyText::parse(trimmed.to_string()).map_err(|error| HttpError::RequestBodyWasMalformed {
        explanation: error.to_string(),
    })
}

// ---------------------------------------------------------------------------
// (2) Validate the requested chunk size against the permitted range.
// ---------------------------------------------------------------------------
fn validate_ocr_stream_job_requested_chunk_size(
    raw_chunk_size: u32,
) -> Result<OcrStreamChunkSize, HttpError> {
    if raw_chunk_size < OCR_STREAM_JOB_MINIMUM_CHUNK_SIZE {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "'chunk_size' must be at least {OCR_STREAM_JOB_MINIMUM_CHUNK_SIZE}"
            ),
        });
    }
    if raw_chunk_size > OCR_STREAM_JOB_MAXIMUM_CHUNK_SIZE {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "'chunk_size' must not exceed {OCR_STREAM_JOB_MAXIMUM_CHUNK_SIZE}"
            ),
        });
    }
    Ok(OcrStreamChunkSize {
        pages_per_chunk: raw_chunk_size,
    })
}

// ---------------------------------------------------------------------------
// (3) Resolve a fetched stored document into a source descriptor.
//
// Takes the already-fetched `Option<StoredDocument>` rather than the whole
// application state so it stays pure and testable and avoids a generic bound.
// ---------------------------------------------------------------------------
fn resolve_ocr_stream_job_source_descriptor(
    fetched_document: Option<StoredDocument>,
    document_reference: &NonEmptyText,
) -> Result<StoredDocumentDescriptor, HttpError> {
    match fetched_document {
        Some(stored_document) => Ok(StoredDocumentDescriptor {
            estimated_page_count: extract_estimated_page_count(&stored_document.document_body),
            document_identifier: stored_document.document_identifier,
            owning_account: stored_document.owning_account,
        }),
        None => Err(HttpError::RequestedResourceWasNotFound {
            explanation: format!(
                "no source document found for reference '{}'",
                document_reference.as_str()
            ),
        }),
    }
}

/// Best-effort extraction of a page-count estimate from a stored document body.
fn extract_estimated_page_count(document_body: &Value) -> u32 {
    document_body
        .get("estimated_page_count")
        .and_then(Value::as_u64)
        .map(|value| value as u32)
        .filter(|count| *count > 0)
        .unwrap_or(OCR_STREAM_JOB_DEFAULT_ESTIMATED_PAGE_COUNT)
}

// ---------------------------------------------------------------------------
// (4) Build the processing request.
// ---------------------------------------------------------------------------
fn build_ocr_stream_job_processing_request(
    source: &StoredDocumentDescriptor,
    chunk_size: OcrStreamChunkSize,
) -> OcrStreamJobProcessingRequest {
    OcrStreamJobProcessingRequest {
        source_document_identifier: source.document_identifier.clone(),
        chunk_size: chunk_size.value(),
        estimated_page_count: source.estimated_page_count,
    }
}

// ---------------------------------------------------------------------------
// (5) Open the streaming channel.
//
// Simulated deterministically from the processing request: an empty document
// identifier is treated as unprocessable, an over-large page count as capacity
// exhaustion. On success a stable channel handle is produced.
// ---------------------------------------------------------------------------
fn open_ocr_stream_job_channel_on_artificial_intelligence_adapter(
    request: OcrStreamJobProcessingRequest,
) -> Result<OcrStreamJobChannelHandle, HttpError> {
    if request.source_document_identifier.trim().is_empty() {
        return Err(map_ocr_stream_channel_open_error_to_http_error(
            ArtificialIntelligenceAdapterError::SourceDocumentUnprocessable {
                explanation: "source document identifier was empty".to_string(),
            },
        ));
    }
    if request.estimated_page_count == 0 {
        return Err(map_ocr_stream_channel_open_error_to_http_error(
            ArtificialIntelligenceAdapterError::UpstreamUnavailable {
                explanation: "source document reported zero pages".to_string(),
            },
        ));
    }
    if request.estimated_page_count > OCR_STREAM_JOB_MAXIMUM_CHANNEL_PAGE_CAPACITY {
        return Err(map_ocr_stream_channel_open_error_to_http_error(
            ArtificialIntelligenceAdapterError::ChannelCapacityExhausted {
                explanation: format!(
                    "source document reported {} pages, exceeding the channel capacity of {}",
                    request.estimated_page_count, OCR_STREAM_JOB_MAXIMUM_CHANNEL_PAGE_CAPACITY
                ),
            },
        ));
    }
    let channel_identifier = format!(
        "ocr-channel::{}",
        Uuid::new_v4()
    );
    Ok(OcrStreamJobChannelHandle {
        channel_identifier,
        source_document_identifier: request.source_document_identifier,
        chunk_size: request.chunk_size,
        estimated_page_count: request.estimated_page_count,
    })
}

// ---------------------------------------------------------------------------
// (6) Allocate the progress tracker.
// ---------------------------------------------------------------------------
fn allocate_ocr_stream_job_progress_tracker(
    source: &StoredDocumentDescriptor,
    chunk_size: OcrStreamChunkSize,
) -> OcrStreamJobProgressTracker {
    let total_chunk_count =
        compute_ocr_stream_job_total_chunk_count(source.estimated_page_count, chunk_size);
    OcrStreamJobProgressTracker {
        total_chunk_count,
        completed_chunk_count: 0,
    }
}

// ---------------------------------------------------------------------------
// (7) Compute the total chunk count (ceiling division).
// ---------------------------------------------------------------------------
fn compute_ocr_stream_job_total_chunk_count(
    estimated_page_count: u32,
    chunk_size: OcrStreamChunkSize,
) -> u32 {
    let pages_per_chunk = chunk_size.value();
    if pages_per_chunk == 0 {
        return 0;
    }
    if estimated_page_count == 0 {
        return 0;
    }
    estimated_page_count.div_ceil(pages_per_chunk)
}

// ---------------------------------------------------------------------------
// (8) Persist the stream-job record.
//
// The durable insert is performed by the handler via the document-collection
// port; this helper deterministically confirms the persisted identifier that
// binds the generated job id to the opened channel, keeping it pure/testable.
// ---------------------------------------------------------------------------
fn persist_ocr_stream_job_record(
    generated_identifier: PersistedOcrStreamJobIdentifier,
    channel_handle: &OcrStreamJobChannelHandle,
) -> PersistedOcrStreamJobIdentifier {
    // Bind the durable identifier to the channel so the two remain traceable.
    let bound_value = format!(
        "{}#{}",
        generated_identifier.as_str(),
        short_channel_suffix(&channel_handle.channel_identifier)
    );
    PersistedOcrStreamJobIdentifier {
        identifier_value: bound_value,
    }
}

/// Derive a short, stable suffix from a channel identifier for binding.
fn short_channel_suffix(channel_identifier: &str) -> String {
    channel_identifier
        .rsplit("::")
        .next()
        .unwrap_or(channel_identifier)
        .chars()
        .take(8)
        .collect()
}

// ---------------------------------------------------------------------------
// (9) Generate the stream-job identifier.
// ---------------------------------------------------------------------------
fn generate_ocr_stream_job_identifier(
    source_document_reference: &NonEmptyText,
) -> PersistedOcrStreamJobIdentifier {
    let slug = slugify_reference(source_document_reference.as_str());
    PersistedOcrStreamJobIdentifier {
        identifier_value: format!("ocr-job::{slug}::{}", Uuid::new_v4()),
    }
}

/// Produce a lowercase, dash-separated slug limited to alphanumeric runs.
fn slugify_reference(raw: &str) -> String {
    let mut slug = String::new();
    let mut previous_was_dash = false;
    for character in raw.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
            previous_was_dash = false;
        } else if !previous_was_dash && !slug.is_empty() {
            slug.push('-');
            previous_was_dash = true;
        }
    }
    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        "document".to_string()
    } else {
        trimmed.chars().take(48).collect()
    }
}

// ---------------------------------------------------------------------------
// (10) Validate the requested output format.
// ---------------------------------------------------------------------------
fn validate_ocr_stream_job_requested_output_format(
    raw_output_format: &str,
) -> Result<OcrOutputFormat, HttpError> {
    match raw_output_format.trim().to_ascii_lowercase().as_str() {
        "plain_text" | "text" | "txt" => Ok(OcrOutputFormat::PlainText),
        "markdown" | "md" => Ok(OcrOutputFormat::Markdown),
        "html" | "hypertext_markup" => Ok(OcrOutputFormat::HypertextMarkup),
        other => Err(HttpError::RequestBodyWasMalformed {
            explanation: format!("unsupported 'output_format': '{other}'"),
        }),
    }
}

// ---------------------------------------------------------------------------
// (11) Map an adapter channel-open error onto an HttpError.
// ---------------------------------------------------------------------------
fn map_ocr_stream_channel_open_error_to_http_error(
    channel_error: ArtificialIntelligenceAdapterError,
) -> HttpError {
    match channel_error {
        ArtificialIntelligenceAdapterError::SourceDocumentUnprocessable { explanation } => {
            HttpError::RequestBodyWasMalformed { explanation }
        }
        ArtificialIntelligenceAdapterError::ChannelCapacityExhausted { explanation }
        | ArtificialIntelligenceAdapterError::UpstreamUnavailable { explanation } => {
            HttpError::UpstreamApplicationFailure { explanation }
        }
    }
}

// ---------------------------------------------------------------------------
// (12) Derive the subscription URL clients poll for streamed chunks.
// ---------------------------------------------------------------------------
fn derive_ocr_stream_job_subscription_url(
    job_identifier: &PersistedOcrStreamJobIdentifier,
) -> NonEmptyText {
    let url = format!("/api/ocr-stream/{}/events", job_identifier.as_str());
    // The URL always contains a static prefix, so parsing cannot fail; fall
    // back to a stable, non-empty default if that invariant is ever broken.
    NonEmptyText::parse(url).unwrap_or_else(|_| {
        NonEmptyText::parse("/api/ocr-stream/unknown/events".to_string())
            .expect("static fallback subscription url is non-empty")
    })
}

// ---------------------------------------------------------------------------
// (13) Assemble the response payload.
// ---------------------------------------------------------------------------
fn assemble_create_ocr_stream_job_response_payload(
    job_identifier: &PersistedOcrStreamJobIdentifier,
    subscription_url: &NonEmptyText,
    total_chunk_count: u32,
) -> CreateOcrStreamJobResponsePayload {
    CreateOcrStreamJobResponsePayload {
        job_identifier: job_identifier.as_str().to_string(),
        subscription_url: subscription_url.as_str().to_string(),
        total_chunk_count,
    }
}

// ---------------------------------------------------------------------------
// (14) Reject a job whose chunk size is below the enforced minimum.
// ---------------------------------------------------------------------------
fn reject_ocr_stream_job_when_chunk_size_below_minimum(
    chunk_size: OcrStreamChunkSize,
    minimum_chunk_size: u32,
) -> Result<(), HttpError> {
    if chunk_size.value() < minimum_chunk_size {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "'chunk_size' of {} is below the minimum of {}",
                chunk_size.value(),
                minimum_chunk_size
            ),
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// (15) Record a creation audit entry.
// ---------------------------------------------------------------------------
fn record_ocr_stream_job_creation_audit_entry(
    job_identifier: &PersistedOcrStreamJobIdentifier,
    chunk_size: OcrStreamChunkSize,
) -> OcrStreamJobAuditEntry {
    OcrStreamJobAuditEntry {
        job_identifier: job_identifier.as_str().to_string(),
        chunk_size: chunk_size.value(),
        audit_action: "ocr_stream_job_created".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(value: u32) -> OcrStreamChunkSize {
        OcrStreamChunkSize {
            pages_per_chunk: value,
        }
    }

    fn reference(value: &str) -> NonEmptyText {
        NonEmptyText::parse(value.to_string()).expect("test reference is non-empty")
    }

    #[test]
    fn parse_document_reference_accepts_non_empty() {
        let parsed = parse_ocr_stream_job_document_reference("doc-123").expect("should parse");
        assert_eq!(parsed.as_str(), "doc-123");
    }

    #[test]
    fn parse_document_reference_rejects_blank() {
        let error = parse_ocr_stream_job_document_reference("   ").unwrap_err();
        assert!(matches!(error, HttpError::RequestBodyWasMalformed { .. }));
    }

    #[test]
    fn validate_chunk_size_accepts_in_range() {
        let validated = validate_ocr_stream_job_requested_chunk_size(10).expect("in range");
        assert_eq!(validated.value(), 10);
    }

    #[test]
    fn validate_chunk_size_rejects_zero() {
        let error = validate_ocr_stream_job_requested_chunk_size(0).unwrap_err();
        assert!(matches!(error, HttpError::RequestBodyWasMalformed { .. }));
    }

    #[test]
    fn validate_chunk_size_rejects_too_large() {
        let error = validate_ocr_stream_job_requested_chunk_size(
            OCR_STREAM_JOB_MAXIMUM_CHUNK_SIZE + 1,
        )
        .unwrap_err();
        assert!(matches!(error, HttpError::RequestBodyWasMalformed { .. }));
    }

    #[test]
    fn resolve_source_descriptor_returns_descriptor_when_present() {
        let stored = StoredDocument {
            document_identifier: "doc-1".to_string(),
            owning_account: Some("user@example.com".to_string()),
            document_body: json!({ "estimated_page_count": 12 }),
        };
        let descriptor =
            resolve_ocr_stream_job_source_descriptor(Some(stored), &reference("doc-1"))
                .expect("should resolve");
        assert_eq!(descriptor.document_identifier, "doc-1");
        assert_eq!(descriptor.estimated_page_count, 12);
    }

    #[test]
    fn resolve_source_descriptor_errors_when_absent() {
        let error =
            resolve_ocr_stream_job_source_descriptor(None, &reference("missing")).unwrap_err();
        assert!(matches!(
            error,
            HttpError::RequestedResourceWasNotFound { .. }
        ));
    }

    #[test]
    fn extract_estimated_page_count_falls_back_to_default() {
        assert_eq!(
            extract_estimated_page_count(&json!({})),
            OCR_STREAM_JOB_DEFAULT_ESTIMATED_PAGE_COUNT
        );
        assert_eq!(
            extract_estimated_page_count(&json!({ "estimated_page_count": 0 })),
            OCR_STREAM_JOB_DEFAULT_ESTIMATED_PAGE_COUNT
        );
        assert_eq!(
            extract_estimated_page_count(&json!({ "estimated_page_count": 5 })),
            5
        );
    }

    #[test]
    fn build_processing_request_copies_fields() {
        let descriptor = StoredDocumentDescriptor {
            document_identifier: "doc-9".to_string(),
            owning_account: None,
            estimated_page_count: 20,
        };
        let request = build_ocr_stream_job_processing_request(&descriptor, chunk(4));
        assert_eq!(request.source_document_identifier, "doc-9");
        assert_eq!(request.chunk_size, 4);
        assert_eq!(request.estimated_page_count, 20);
    }

    #[test]
    fn open_channel_succeeds_for_valid_request() {
        let request = OcrStreamJobProcessingRequest {
            source_document_identifier: "doc-1".to_string(),
            chunk_size: 3,
            estimated_page_count: 9,
        };
        let handle = open_ocr_stream_job_channel_on_artificial_intelligence_adapter(request)
            .expect("should open");
        assert_eq!(handle.source_document_identifier, "doc-1");
        assert!(handle.channel_identifier.starts_with("ocr-channel::"));
    }

    #[test]
    fn open_channel_rejects_empty_source() {
        let request = OcrStreamJobProcessingRequest {
            source_document_identifier: "  ".to_string(),
            chunk_size: 3,
            estimated_page_count: 9,
        };
        let error = open_ocr_stream_job_channel_on_artificial_intelligence_adapter(request)
            .unwrap_err();
        assert!(matches!(error, HttpError::RequestBodyWasMalformed { .. }));
    }

    #[test]
    fn open_channel_rejects_zero_pages() {
        let request = OcrStreamJobProcessingRequest {
            source_document_identifier: "doc-1".to_string(),
            chunk_size: 3,
            estimated_page_count: 0,
        };
        let error = open_ocr_stream_job_channel_on_artificial_intelligence_adapter(request)
            .unwrap_err();
        assert!(matches!(error, HttpError::UpstreamApplicationFailure { .. }));
    }

    #[test]
    fn open_channel_rejects_capacity_exhaustion() {
        let request = OcrStreamJobProcessingRequest {
            source_document_identifier: "doc-1".to_string(),
            chunk_size: 3,
            estimated_page_count: OCR_STREAM_JOB_MAXIMUM_CHANNEL_PAGE_CAPACITY + 1,
        };
        let error = open_ocr_stream_job_channel_on_artificial_intelligence_adapter(request)
            .unwrap_err();
        assert!(matches!(error, HttpError::UpstreamApplicationFailure { .. }));
    }

    #[test]
    fn allocate_progress_tracker_sets_totals() {
        let descriptor = StoredDocumentDescriptor {
            document_identifier: "doc-1".to_string(),
            owning_account: None,
            estimated_page_count: 10,
        };
        let tracker = allocate_ocr_stream_job_progress_tracker(&descriptor, chunk(3));
        assert_eq!(tracker.total_chunk_count, 4);
        assert_eq!(tracker.completed_chunk_count, 0);
    }

    #[test]
    fn compute_total_chunk_count_ceiling_division() {
        assert_eq!(compute_ocr_stream_job_total_chunk_count(10, chunk(3)), 4);
        assert_eq!(compute_ocr_stream_job_total_chunk_count(9, chunk(3)), 3);
        assert_eq!(compute_ocr_stream_job_total_chunk_count(1, chunk(3)), 1);
    }

    #[test]
    fn compute_total_chunk_count_handles_zero_inputs() {
        assert_eq!(compute_ocr_stream_job_total_chunk_count(0, chunk(3)), 0);
        assert_eq!(compute_ocr_stream_job_total_chunk_count(10, chunk(0)), 0);
    }

    #[test]
    fn persist_record_binds_channel_suffix() {
        let identifier = PersistedOcrStreamJobIdentifier {
            identifier_value: "ocr-job::abc".to_string(),
        };
        let handle = OcrStreamJobChannelHandle {
            channel_identifier: "ocr-channel::deadbeefcafe".to_string(),
            source_document_identifier: "doc-1".to_string(),
            chunk_size: 3,
            estimated_page_count: 9,
        };
        let persisted = persist_ocr_stream_job_record(identifier, &handle);
        assert_eq!(persisted.as_str(), "ocr-job::abc#deadbeef");
    }

    #[test]
    fn short_channel_suffix_takes_tail() {
        assert_eq!(short_channel_suffix("ocr-channel::abcdefghijk"), "abcdefgh");
        assert_eq!(short_channel_suffix("plain"), "plain");
    }

    #[test]
    fn generate_identifier_uses_slug() {
        let identifier = generate_ocr_stream_job_identifier(&reference("My Doc 42"));
        assert!(identifier.as_str().starts_with("ocr-job::my-doc-42::"));
    }

    #[test]
    fn slugify_reference_handles_symbols_and_empty() {
        assert_eq!(slugify_reference("Hello, World!"), "hello-world");
        assert_eq!(slugify_reference("***"), "document");
    }

    #[test]
    fn validate_output_format_accepts_known_aliases() {
        assert_eq!(
            validate_ocr_stream_job_requested_output_format("MD").unwrap(),
            OcrOutputFormat::Markdown
        );
        assert_eq!(
            validate_ocr_stream_job_requested_output_format("text").unwrap(),
            OcrOutputFormat::PlainText
        );
        assert_eq!(
            validate_ocr_stream_job_requested_output_format("html").unwrap(),
            OcrOutputFormat::HypertextMarkup
        );
    }

    #[test]
    fn validate_output_format_rejects_unknown() {
        let error =
            validate_ocr_stream_job_requested_output_format("pdf").unwrap_err();
        assert!(matches!(error, HttpError::RequestBodyWasMalformed { .. }));
    }

    #[test]
    fn map_channel_error_distinguishes_client_and_upstream() {
        let client = map_ocr_stream_channel_open_error_to_http_error(
            ArtificialIntelligenceAdapterError::SourceDocumentUnprocessable {
                explanation: "bad".to_string(),
            },
        );
        assert!(matches!(client, HttpError::RequestBodyWasMalformed { .. }));

        let upstream = map_ocr_stream_channel_open_error_to_http_error(
            ArtificialIntelligenceAdapterError::ChannelCapacityExhausted {
                explanation: "full".to_string(),
            },
        );
        assert!(matches!(
            upstream,
            HttpError::UpstreamApplicationFailure { .. }
        ));
    }

    #[test]
    fn derive_subscription_url_contains_identifier() {
        let identifier = PersistedOcrStreamJobIdentifier {
            identifier_value: "ocr-job::xyz".to_string(),
        };
        let url = derive_ocr_stream_job_subscription_url(&identifier);
        assert_eq!(url.as_str(), "/api/ocr-stream/ocr-job::xyz/events");
    }

    #[test]
    fn assemble_response_payload_serializes_expected_json() {
        let identifier = PersistedOcrStreamJobIdentifier {
            identifier_value: "ocr-job::xyz".to_string(),
        };
        let url = reference("/api/ocr-stream/ocr-job::xyz/events");
        let payload =
            assemble_create_ocr_stream_job_response_payload(&identifier, &url, 7);
        let serialized = payload.into_json();
        assert_eq!(serialized["job_identifier"], json!("ocr-job::xyz"));
        assert_eq!(serialized["total_chunk_count"], json!(7));
        assert_eq!(serialized["status"], json!("accepted"));
    }

    #[test]
    fn reject_below_minimum_passes_when_at_minimum() {
        assert!(reject_ocr_stream_job_when_chunk_size_below_minimum(chunk(1), 1).is_ok());
    }

    #[test]
    fn reject_below_minimum_errors_when_below() {
        let error =
            reject_ocr_stream_job_when_chunk_size_below_minimum(chunk(1), 2).unwrap_err();
        assert!(matches!(error, HttpError::RequestBodyWasMalformed { .. }));
    }

    #[test]
    fn record_audit_entry_captures_fields() {
        let identifier = PersistedOcrStreamJobIdentifier {
            identifier_value: "ocr-job::xyz".to_string(),
        };
        let entry = record_ocr_stream_job_creation_audit_entry(&identifier, chunk(5));
        assert_eq!(entry.job_identifier, "ocr-job::xyz");
        assert_eq!(entry.chunk_size, 5);
        assert_eq!(entry.audit_action, "ocr_stream_job_created");
    }
}
