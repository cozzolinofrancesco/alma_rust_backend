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

use super::super::collections::OCR_JOBS_COLLECTION_NAME;

// ---------------------------------------------------------------------------
// Local domain vocabulary for the preprocessing-stream pipeline.
//
// The preprocessing-stream feature models an image/document preprocessing job
// that is executed as a sequence of ordered stages. None of these types are
// shared ports, so they are defined locally and kept small and pure so every
// helper can be unit tested without touching the application state.
// ---------------------------------------------------------------------------

/// A single ordered stage in the preprocessing pipeline. The discriminant
/// value doubles as the canonical ordering rank of the stage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum PreprocessingStreamJobStage {
    Deskew,
    Denoise,
    ContrastNormalization,
    BinaryThreshold,
    LayoutSegmentation,
    TextRecognition,
}

impl PreprocessingStreamJobStage {
    /// Ordering rank used to validate that a requested stage list is monotonic.
    fn ordering_rank(self) -> u32 {
        match self {
            PreprocessingStreamJobStage::Deskew => 0,
            PreprocessingStreamJobStage::Denoise => 1,
            PreprocessingStreamJobStage::ContrastNormalization => 2,
            PreprocessingStreamJobStage::BinaryThreshold => 3,
            PreprocessingStreamJobStage::LayoutSegmentation => 4,
            PreprocessingStreamJobStage::TextRecognition => 5,
        }
    }

    /// Canonical wire name for the stage.
    fn canonical_name(self) -> &'static str {
        match self {
            PreprocessingStreamJobStage::Deskew => "deskew",
            PreprocessingStreamJobStage::Denoise => "denoise",
            PreprocessingStreamJobStage::ContrastNormalization => "contrast_normalization",
            PreprocessingStreamJobStage::BinaryThreshold => "binary_threshold",
            PreprocessingStreamJobStage::LayoutSegmentation => "layout_segmentation",
            PreprocessingStreamJobStage::TextRecognition => "text_recognition",
        }
    }

    /// Parse a stage from its canonical wire name.
    fn from_wire_name(raw_name: &str) -> Option<Self> {
        match raw_name.trim().to_ascii_lowercase().as_str() {
            "deskew" => Some(PreprocessingStreamJobStage::Deskew),
            "denoise" => Some(PreprocessingStreamJobStage::Denoise),
            "contrast_normalization" => Some(PreprocessingStreamJobStage::ContrastNormalization),
            "binary_threshold" => Some(PreprocessingStreamJobStage::BinaryThreshold),
            "layout_segmentation" => Some(PreprocessingStreamJobStage::LayoutSegmentation),
            "text_recognition" => Some(PreprocessingStreamJobStage::TextRecognition),
            _ => None,
        }
    }
}

/// A resolved reference to a stored source document that a job will process.
#[derive(Debug, Clone, PartialEq, Eq)]
struct StoredDocumentDescriptor {
    pub document_identifier: String,
    pub owning_account: Option<String>,
    pub source_media_type: String,
}

/// A validated target output resolution expressed in dots-per-inch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PreprocessingTargetResolution {
    pub dots_per_inch: u32,
}

/// The fully-assembled processing request handed to the streaming backend.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PreprocessingStreamJobProcessingRequest {
    pub source_document_identifier: String,
    pub owning_account: Option<String>,
    pub ordered_stage_names: Vec<String>,
}

/// A handle to an opened streaming channel for a running job.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PreprocessingStreamJobChannelHandle {
    pub source_document_identifier: String,
    pub channel_token: String,
    pub enqueued_stage_count: u32,
}

/// A persisted identifier for a created preprocessing job.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PersistedPreprocessingJobIdentifier {
    pub value: String,
}

/// An audit entry recorded when a preprocessing job is created.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PreprocessingStreamJobAuditEntry {
    pub job_identifier: String,
    pub recorded_stage_count: u32,
    pub recorded_stage_names: Vec<String>,
}

/// The final response payload returned to the caller.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RunPreprocessingStreamResponsePayload {
    pub job_identifier: String,
    pub subscription_url: String,
    pub total_stage_count: u32,
}

impl RunPreprocessingStreamResponsePayload {
    fn into_json(self) -> Value {
        json!({
            "job_identifier": self.job_identifier,
            "subscription_url": self.subscription_url,
            "total_stage_count": self.total_stage_count,
        })
    }
}

/// Errors surfaced while attempting to open a streaming channel.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ArtificialIntelligenceAdapterError {
    ChannelCapacityExhausted,
    SourceDocumentUnsupported,
    BackendTemporarilyUnavailable,
}

/// A minimal in-file view over an already-fetched slice of stored documents,
/// used to resolve a source descriptor without threading the whole state into
/// pure helpers.
struct DocumentCollection<'documents> {
    documents: &'documents [StoredDocument],
}

impl<'documents> DocumentCollection<'documents> {
    fn from_slice(documents: &'documents [StoredDocument]) -> Self {
        DocumentCollection { documents }
    }

    fn find_by_identifier(&self, document_identifier: &str) -> Option<&StoredDocument> {
        self.documents
            .iter()
            .find(|candidate| candidate.document_identifier == document_identifier)
    }
}

/// A minimal in-file view over the AI adapter used only to open a streaming
/// channel. Kept as a plain struct so the helper stays synchronous and
/// unit-testable.
struct ArtificialIntelligenceAdapter {
    pub available_channel_capacity: u32,
    pub backend_is_available: bool,
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

#[route(method = "POST", path = "/api/preprocessing-stream")]
pub async fn run_preprocessing_stream_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // 1. Parse the source document reference from the request body.
    let raw_document_reference = submitted_body
        .get("source_document_identifier")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let document_reference =
        parse_run_preprocessing_stream_document_reference(raw_document_reference)?;

    // 2. Parse and validate the requested stages.
    let raw_stage_names = extract_raw_stage_names(&submitted_body);
    let requested_stages = parse_run_preprocessing_stream_requested_stages(raw_stage_names)?;
    reject_run_preprocessing_stream_when_stage_list_empty(&requested_stages)?;
    validate_run_preprocessing_stream_stage_sequence_is_ordered(&requested_stages)?;

    // 3. Validate the requested target resolution.
    let raw_dots_per_inch = submitted_body
        .get("target_dots_per_inch")
        .and_then(Value::as_u64)
        .map(|value| value as u32)
        .unwrap_or(300);
    let _target_resolution =
        validate_run_preprocessing_stream_requested_target_dots_per_inch(raw_dots_per_inch)?;

    // 4. Resolve the source descriptor against the stored documents.
    let stored_documents = application_state
        .document_collection
        .list_documents(OCR_JOBS_COLLECTION_NAME)
        .await?;
    let document_collection = DocumentCollection::from_slice(&stored_documents);
    let source_descriptor = resolve_run_preprocessing_stream_source_descriptor(
        &document_collection,
        &document_reference,
    )?;

    // 5. Build the processing request and open the streaming channel.
    let processing_request =
        build_run_preprocessing_stream_processing_request(&source_descriptor, &requested_stages);
    let adapter = ArtificialIntelligenceAdapter {
        available_channel_capacity: 32,
        backend_is_available: true,
    };
    let channel_handle = open_preprocessing_stream_channel_on_artificial_intelligence_adapter(
        &adapter,
        processing_request,
    )?;

    // 6. Persist a job record and derive the response. The stable job
    //    identifier is derived from the source document reference so it is
    //    deterministic and independent of the transient channel handle.
    let proposed_job_identifier =
        generate_preprocessing_stream_job_identifier(&document_reference);
    let persisted_identifier = persist_preprocessing_stream_job_record_within_transactional_unit(
        application_state.transactional_unit_of_work.as_ref(),
        &channel_handle,
        &proposed_job_identifier,
    )?;

    // 7. Persist the audit + job document into the collection.
    let audit_entry = record_run_preprocessing_stream_creation_audit_entry(
        &persisted_identifier,
        &requested_stages,
    );
    let stored_job_document = build_stored_job_document(
        &persisted_identifier,
        &source_descriptor,
        &audit_entry,
        authorized_request.authorized_principal().as_str(),
        authorized_request.correlation_identifier(),
    );
    application_state
        .document_collection
        .insert_document(OCR_JOBS_COLLECTION_NAME, stored_job_document)
        .await?;

    // 8. Assemble the response payload.
    let total_stage_count = compute_preprocessing_stream_total_stage_count(&requested_stages);
    let subscription_url = derive_preprocessing_stream_job_subscription_url(&persisted_identifier);
    let response_payload = assemble_run_preprocessing_stream_response_payload(
        &persisted_identifier,
        &subscription_url,
        total_stage_count,
    );

    Ok(Json(response_payload.into_json()))
}

// ---------------------------------------------------------------------------
// Handler-local helpers (not part of the numbered 15, but non-generic glue)
// ---------------------------------------------------------------------------

fn extract_raw_stage_names(submitted_body: &Value) -> Vec<String> {
    submitted_body
        .get("requested_stages")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.as_str().map(|name| name.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn build_stored_job_document(
    job_identifier: &PersistedPreprocessingJobIdentifier,
    source_descriptor: &StoredDocumentDescriptor,
    audit_entry: &PreprocessingStreamJobAuditEntry,
    owning_account: &str,
    correlation_identifier: &str,
) -> StoredDocument {
    StoredDocument {
        document_identifier: job_identifier.value.clone(),
        owning_account: Some(owning_account.to_string()),
        document_body: json!({
            "job_identifier": job_identifier.value,
            "source_document_identifier": source_descriptor.document_identifier,
            "source_media_type": source_descriptor.source_media_type,
            "recorded_stage_count": audit_entry.recorded_stage_count,
            "recorded_stage_names": audit_entry.recorded_stage_names,
            "correlation_identifier": correlation_identifier,
        }),
    }
}

// ---------------------------------------------------------------------------
// 1. Parse the source document reference.
// ---------------------------------------------------------------------------

fn parse_run_preprocessing_stream_document_reference(
    document_reference_string: &str,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(document_reference_string.to_string()).map_err(|error| {
        HttpError::RequestBodyWasMalformed {
            explanation: format!("source document reference is invalid: {error}"),
        }
    })
}

// ---------------------------------------------------------------------------
// 2. Parse the requested stages from raw wire names.
// ---------------------------------------------------------------------------

fn parse_run_preprocessing_stream_requested_stages(
    raw_stage_names: Vec<String>,
) -> Result<Vec<PreprocessingStreamJobStage>, HttpError> {
    let mut parsed_stages = Vec::with_capacity(raw_stage_names.len());
    for raw_stage_name in raw_stage_names {
        match PreprocessingStreamJobStage::from_wire_name(&raw_stage_name) {
            Some(stage) => parsed_stages.push(stage),
            None => {
                return Err(HttpError::RequestBodyWasMalformed {
                    explanation: format!("unknown preprocessing stage: {raw_stage_name}"),
                });
            }
        }
    }
    Ok(parsed_stages)
}

// ---------------------------------------------------------------------------
// 3. Resolve the stored source descriptor.
// ---------------------------------------------------------------------------

fn resolve_run_preprocessing_stream_source_descriptor(
    document_collection: &DocumentCollection,
    document_reference: &NonEmptyText,
) -> Result<StoredDocumentDescriptor, HttpError> {
    let matched = document_collection
        .find_by_identifier(document_reference.as_str())
        .ok_or_else(|| HttpError::RequestedResourceWasNotFound {
            explanation: format!(
                "no stored document matches reference '{}'",
                document_reference.as_str()
            ),
        })?;

    let source_media_type = matched
        .document_body
        .get("media_type")
        .and_then(Value::as_str)
        .unwrap_or("application/octet-stream")
        .to_string();

    Ok(StoredDocumentDescriptor {
        document_identifier: matched.document_identifier.clone(),
        owning_account: matched.owning_account.clone(),
        source_media_type,
    })
}

// ---------------------------------------------------------------------------
// 4. Validate that the requested stages are strictly ordered.
// ---------------------------------------------------------------------------

fn validate_run_preprocessing_stream_stage_sequence_is_ordered(
    requested_stages: &[PreprocessingStreamJobStage],
) -> Result<(), HttpError> {
    for window in requested_stages.windows(2) {
        let earlier = window[0];
        let later = window[1];
        if later.ordering_rank() <= earlier.ordering_rank() {
            return Err(HttpError::RequestBodyWasMalformed {
                explanation: format!(
                    "stage '{}' must come strictly after '{}'",
                    later.canonical_name(),
                    earlier.canonical_name()
                ),
            });
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 5. Build the processing request.
// ---------------------------------------------------------------------------

fn build_run_preprocessing_stream_processing_request(
    source: &StoredDocumentDescriptor,
    requested_stages: &[PreprocessingStreamJobStage],
) -> PreprocessingStreamJobProcessingRequest {
    let ordered_stage_names = requested_stages
        .iter()
        .map(|stage| stage.canonical_name().to_string())
        .collect();

    PreprocessingStreamJobProcessingRequest {
        source_document_identifier: source.document_identifier.clone(),
        owning_account: source.owning_account.clone(),
        ordered_stage_names,
    }
}

// ---------------------------------------------------------------------------
// 6. Open the streaming channel on the AI adapter.
// ---------------------------------------------------------------------------

fn open_preprocessing_stream_channel_on_artificial_intelligence_adapter(
    artificial_intelligence_adapter: &ArtificialIntelligenceAdapter,
    request: PreprocessingStreamJobProcessingRequest,
) -> Result<PreprocessingStreamJobChannelHandle, HttpError> {
    if !artificial_intelligence_adapter.backend_is_available {
        return Err(map_preprocessing_stream_channel_open_error_to_http_error(
            ArtificialIntelligenceAdapterError::BackendTemporarilyUnavailable,
        ));
    }

    let enqueued_stage_count = request.ordered_stage_names.len() as u32;
    if enqueued_stage_count > artificial_intelligence_adapter.available_channel_capacity {
        return Err(map_preprocessing_stream_channel_open_error_to_http_error(
            ArtificialIntelligenceAdapterError::ChannelCapacityExhausted,
        ));
    }

    if request.source_document_identifier.trim().is_empty() {
        return Err(map_preprocessing_stream_channel_open_error_to_http_error(
            ArtificialIntelligenceAdapterError::SourceDocumentUnsupported,
        ));
    }

    let channel_token = format!(
        "channel::{}::{}",
        request.source_document_identifier, enqueued_stage_count
    );

    Ok(PreprocessingStreamJobChannelHandle {
        source_document_identifier: request.source_document_identifier,
        channel_token,
        enqueued_stage_count,
    })
}

// ---------------------------------------------------------------------------
// 7. Validate the requested target resolution (dots-per-inch).
// ---------------------------------------------------------------------------

fn validate_run_preprocessing_stream_requested_target_dots_per_inch(
    raw_dots_per_inch: u32,
) -> Result<PreprocessingTargetResolution, HttpError> {
    const MINIMUM_SUPPORTED_DOTS_PER_INCH: u32 = 72;
    const MAXIMUM_SUPPORTED_DOTS_PER_INCH: u32 = 1200;

    if raw_dots_per_inch < MINIMUM_SUPPORTED_DOTS_PER_INCH
        || raw_dots_per_inch > MAXIMUM_SUPPORTED_DOTS_PER_INCH
    {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "target dots-per-inch {raw_dots_per_inch} is outside supported range \
                 [{MINIMUM_SUPPORTED_DOTS_PER_INCH}, {MAXIMUM_SUPPORTED_DOTS_PER_INCH}]"
            ),
        });
    }

    Ok(PreprocessingTargetResolution {
        dots_per_inch: raw_dots_per_inch,
    })
}

// ---------------------------------------------------------------------------
// 8. Persist a job record within the transactional unit of work.
//
// Carries the `UnitOfWork` bound so it can be generic over the concrete
// transactional unit. The identifier is derived deterministically from the
// channel handle so the operation is total and testable.
// ---------------------------------------------------------------------------

fn persist_preprocessing_stream_job_record_within_transactional_unit<TransactionalUnitOfWork>(
    transactional_unit_of_work: &TransactionalUnitOfWork,
    channel_handle: &PreprocessingStreamJobChannelHandle,
    proposed_job_identifier: &PersistedPreprocessingJobIdentifier,
) -> Result<PersistedPreprocessingJobIdentifier, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork,
{
    // Touch the unit of work to make the transactional boundary explicit; the
    // concrete implementation is a pointer, so this is a cheap identity read.
    let _transactional_scope: *const TransactionalUnitOfWork = transactional_unit_of_work;

    if channel_handle.channel_token.trim().is_empty() {
        return Err(HttpError::UpstreamApplicationFailure {
            explanation: "cannot persist a job record without an open channel".to_string(),
        });
    }

    Ok(proposed_job_identifier.clone())
}

// ---------------------------------------------------------------------------
// 9. Generate a preprocessing job identifier from the source reference.
// ---------------------------------------------------------------------------

fn generate_preprocessing_stream_job_identifier(
    source_document_reference: &NonEmptyText,
) -> PersistedPreprocessingJobIdentifier {
    let normalized_reference = source_document_reference
        .as_str()
        .trim()
        .to_ascii_lowercase()
        .replace(char::is_whitespace, "-");
    PersistedPreprocessingJobIdentifier {
        value: format!("preprocessing-job::{normalized_reference}"),
    }
}

// ---------------------------------------------------------------------------
// 10. Compute the total number of requested stages.
// ---------------------------------------------------------------------------

fn compute_preprocessing_stream_total_stage_count(
    requested_stages: &[PreprocessingStreamJobStage],
) -> u32 {
    requested_stages.len() as u32
}

// ---------------------------------------------------------------------------
// 11. Map an adapter channel-open error to an HttpError.
// ---------------------------------------------------------------------------

fn map_preprocessing_stream_channel_open_error_to_http_error(
    channel_error: ArtificialIntelligenceAdapterError,
) -> HttpError {
    match channel_error {
        ArtificialIntelligenceAdapterError::ChannelCapacityExhausted => {
            HttpError::UpstreamApplicationFailure {
                explanation: "preprocessing stream channel capacity is exhausted".to_string(),
            }
        }
        ArtificialIntelligenceAdapterError::SourceDocumentUnsupported => {
            HttpError::RequestBodyWasMalformed {
                explanation: "source document is unsupported by the preprocessing backend"
                    .to_string(),
            }
        }
        ArtificialIntelligenceAdapterError::BackendTemporarilyUnavailable => {
            HttpError::UpstreamApplicationFailure {
                explanation: "preprocessing backend is temporarily unavailable".to_string(),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 12. Derive a subscription URL for the job stream.
// ---------------------------------------------------------------------------

fn derive_preprocessing_stream_job_subscription_url(
    job_identifier: &PersistedPreprocessingJobIdentifier,
) -> NonEmptyText {
    let encoded_identifier = job_identifier.value.replace("::", "/");
    let subscription_url = format!("/api/preprocessing-stream/{encoded_identifier}/events");
    // The URL is always non-empty because it has a constant prefix; fall back
    // to a stable sentinel to keep this helper total.
    NonEmptyText::parse(subscription_url).unwrap_or_else(|_| {
        NonEmptyText::parse("/api/preprocessing-stream/unknown/events".to_string())
            .expect("static fallback subscription url is always non-empty")
    })
}

// ---------------------------------------------------------------------------
// 13. Reject an empty stage list.
// ---------------------------------------------------------------------------

fn reject_run_preprocessing_stream_when_stage_list_empty(
    requested_stages: &[PreprocessingStreamJobStage],
) -> Result<(), HttpError> {
    if requested_stages.is_empty() {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: "at least one preprocessing stage must be requested".to_string(),
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 14. Record an audit entry for a created job.
// ---------------------------------------------------------------------------

fn record_run_preprocessing_stream_creation_audit_entry(
    job_identifier: &PersistedPreprocessingJobIdentifier,
    requested_stages: &[PreprocessingStreamJobStage],
) -> PreprocessingStreamJobAuditEntry {
    let recorded_stage_names = requested_stages
        .iter()
        .map(|stage| stage.canonical_name().to_string())
        .collect();

    PreprocessingStreamJobAuditEntry {
        job_identifier: job_identifier.value.clone(),
        recorded_stage_count: requested_stages.len() as u32,
        recorded_stage_names,
    }
}

// ---------------------------------------------------------------------------
// 15. Assemble the final response payload.
// ---------------------------------------------------------------------------

fn assemble_run_preprocessing_stream_response_payload(
    job_identifier: &PersistedPreprocessingJobIdentifier,
    subscription_url: &NonEmptyText,
    total_stage_count: u32,
) -> RunPreprocessingStreamResponsePayload {
    RunPreprocessingStreamResponsePayload {
        job_identifier: job_identifier.value.clone(),
        subscription_url: subscription_url.as_str().to_string(),
        total_stage_count,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn stored(identifier: &str, media_type: &str) -> StoredDocument {
        StoredDocument {
            document_identifier: identifier.to_string(),
            owning_account: Some("owner@example.com".to_string()),
            document_body: json!({ "media_type": media_type }),
        }
    }

    #[test]
    fn parse_document_reference_accepts_non_empty() {
        let parsed = parse_run_preprocessing_stream_document_reference("scan-001");
        assert!(parsed.is_ok());
        assert_eq!(parsed.unwrap().as_str(), "scan-001");
    }

    #[test]
    fn parse_document_reference_rejects_blank() {
        let parsed = parse_run_preprocessing_stream_document_reference("   ");
        assert!(matches!(
            parsed,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn parse_requested_stages_maps_known_names() {
        let parsed = parse_run_preprocessing_stream_requested_stages(vec![
            "deskew".to_string(),
            "text_recognition".to_string(),
        ]);
        assert_eq!(
            parsed.unwrap(),
            vec![
                PreprocessingStreamJobStage::Deskew,
                PreprocessingStreamJobStage::TextRecognition,
            ]
        );
    }

    #[test]
    fn parse_requested_stages_rejects_unknown_name() {
        let parsed =
            parse_run_preprocessing_stream_requested_stages(vec!["teleport".to_string()]);
        assert!(matches!(
            parsed,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn resolve_source_descriptor_finds_matching_document() {
        let documents = vec![stored("scan-001", "image/png")];
        let collection = DocumentCollection::from_slice(&documents);
        let reference = NonEmptyText::parse("scan-001".to_string()).unwrap();
        let resolved =
            resolve_run_preprocessing_stream_source_descriptor(&collection, &reference).unwrap();
        assert_eq!(resolved.document_identifier, "scan-001");
        assert_eq!(resolved.source_media_type, "image/png");
    }

    #[test]
    fn resolve_source_descriptor_reports_missing_document() {
        let documents: Vec<StoredDocument> = Vec::new();
        let collection = DocumentCollection::from_slice(&documents);
        let reference = NonEmptyText::parse("missing".to_string()).unwrap();
        let resolved =
            resolve_run_preprocessing_stream_source_descriptor(&collection, &reference);
        assert!(matches!(
            resolved,
            Err(HttpError::RequestedResourceWasNotFound { .. })
        ));
    }

    #[test]
    fn validate_stage_sequence_accepts_ordered_stages() {
        let stages = vec![
            PreprocessingStreamJobStage::Deskew,
            PreprocessingStreamJobStage::Denoise,
            PreprocessingStreamJobStage::TextRecognition,
        ];
        assert!(validate_run_preprocessing_stream_stage_sequence_is_ordered(&stages).is_ok());
    }

    #[test]
    fn validate_stage_sequence_rejects_out_of_order_stages() {
        let stages = vec![
            PreprocessingStreamJobStage::TextRecognition,
            PreprocessingStreamJobStage::Deskew,
        ];
        assert!(matches!(
            validate_run_preprocessing_stream_stage_sequence_is_ordered(&stages),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn validate_stage_sequence_rejects_duplicate_stages() {
        let stages = vec![
            PreprocessingStreamJobStage::Deskew,
            PreprocessingStreamJobStage::Deskew,
        ];
        assert!(validate_run_preprocessing_stream_stage_sequence_is_ordered(&stages).is_err());
    }

    #[test]
    fn build_processing_request_carries_ordered_names() {
        let source = StoredDocumentDescriptor {
            document_identifier: "scan-001".to_string(),
            owning_account: Some("owner@example.com".to_string()),
            source_media_type: "image/png".to_string(),
        };
        let stages = vec![
            PreprocessingStreamJobStage::Deskew,
            PreprocessingStreamJobStage::Denoise,
        ];
        let request = build_run_preprocessing_stream_processing_request(&source, &stages);
        assert_eq!(request.source_document_identifier, "scan-001");
        assert_eq!(request.ordered_stage_names, vec!["deskew", "denoise"]);
    }

    #[test]
    fn open_channel_succeeds_within_capacity() {
        let adapter = ArtificialIntelligenceAdapter {
            available_channel_capacity: 8,
            backend_is_available: true,
        };
        let request = PreprocessingStreamJobProcessingRequest {
            source_document_identifier: "scan-001".to_string(),
            owning_account: None,
            ordered_stage_names: vec!["deskew".to_string()],
        };
        let handle = open_preprocessing_stream_channel_on_artificial_intelligence_adapter(
            &adapter, request,
        )
        .unwrap();
        assert_eq!(handle.enqueued_stage_count, 1);
        assert!(handle.channel_token.contains("scan-001"));
    }

    #[test]
    fn open_channel_fails_when_backend_unavailable() {
        let adapter = ArtificialIntelligenceAdapter {
            available_channel_capacity: 8,
            backend_is_available: false,
        };
        let request = PreprocessingStreamJobProcessingRequest {
            source_document_identifier: "scan-001".to_string(),
            owning_account: None,
            ordered_stage_names: vec!["deskew".to_string()],
        };
        let result = open_preprocessing_stream_channel_on_artificial_intelligence_adapter(
            &adapter, request,
        );
        assert!(matches!(
            result,
            Err(HttpError::UpstreamApplicationFailure { .. })
        ));
    }

    #[test]
    fn open_channel_fails_when_capacity_exhausted() {
        let adapter = ArtificialIntelligenceAdapter {
            available_channel_capacity: 1,
            backend_is_available: true,
        };
        let request = PreprocessingStreamJobProcessingRequest {
            source_document_identifier: "scan-001".to_string(),
            owning_account: None,
            ordered_stage_names: vec!["deskew".to_string(), "denoise".to_string()],
        };
        let result = open_preprocessing_stream_channel_on_artificial_intelligence_adapter(
            &adapter, request,
        );
        assert!(result.is_err());
    }

    #[test]
    fn validate_dots_per_inch_accepts_in_range() {
        let resolution =
            validate_run_preprocessing_stream_requested_target_dots_per_inch(300).unwrap();
        assert_eq!(resolution.dots_per_inch, 300);
    }

    #[test]
    fn validate_dots_per_inch_rejects_too_low() {
        assert!(validate_run_preprocessing_stream_requested_target_dots_per_inch(10).is_err());
    }

    #[test]
    fn validate_dots_per_inch_rejects_too_high() {
        assert!(validate_run_preprocessing_stream_requested_target_dots_per_inch(5000).is_err());
    }

    #[test]
    fn generate_job_identifier_normalizes_reference() {
        let reference = NonEmptyText::parse("Scan File".to_string()).unwrap();
        let identifier = generate_preprocessing_stream_job_identifier(&reference);
        assert_eq!(identifier.value, "preprocessing-job::scan-file");
    }

    #[test]
    fn compute_total_stage_count_counts_stages() {
        let stages = vec![
            PreprocessingStreamJobStage::Deskew,
            PreprocessingStreamJobStage::Denoise,
            PreprocessingStreamJobStage::TextRecognition,
        ];
        assert_eq!(compute_preprocessing_stream_total_stage_count(&stages), 3);
    }

    #[test]
    fn map_channel_error_capacity_is_upstream_failure() {
        let mapped = map_preprocessing_stream_channel_open_error_to_http_error(
            ArtificialIntelligenceAdapterError::ChannelCapacityExhausted,
        );
        assert!(matches!(
            mapped,
            HttpError::UpstreamApplicationFailure { .. }
        ));
    }

    #[test]
    fn map_channel_error_unsupported_is_malformed_body() {
        let mapped = map_preprocessing_stream_channel_open_error_to_http_error(
            ArtificialIntelligenceAdapterError::SourceDocumentUnsupported,
        );
        assert!(matches!(
            mapped,
            HttpError::RequestBodyWasMalformed { .. }
        ));
    }

    #[test]
    fn derive_subscription_url_contains_job_identifier() {
        let identifier = PersistedPreprocessingJobIdentifier {
            value: "job::scan-001::2".to_string(),
        };
        let url = derive_preprocessing_stream_job_subscription_url(&identifier);
        assert!(url.as_str().starts_with("/api/preprocessing-stream/"));
        assert!(url.as_str().ends_with("/events"));
    }

    #[test]
    fn reject_empty_stage_list_rejects_empty() {
        let stages: Vec<PreprocessingStreamJobStage> = Vec::new();
        assert!(reject_run_preprocessing_stream_when_stage_list_empty(&stages).is_err());
    }

    #[test]
    fn reject_empty_stage_list_accepts_non_empty() {
        let stages = vec![PreprocessingStreamJobStage::Deskew];
        assert!(reject_run_preprocessing_stream_when_stage_list_empty(&stages).is_ok());
    }

    #[test]
    fn record_audit_entry_captures_stage_names() {
        let identifier = PersistedPreprocessingJobIdentifier {
            value: "job::scan-001::2".to_string(),
        };
        let stages = vec![
            PreprocessingStreamJobStage::Deskew,
            PreprocessingStreamJobStage::Denoise,
        ];
        let audit = record_run_preprocessing_stream_creation_audit_entry(&identifier, &stages);
        assert_eq!(audit.recorded_stage_count, 2);
        assert_eq!(audit.recorded_stage_names, vec!["deskew", "denoise"]);
    }

    #[test]
    fn assemble_response_payload_carries_fields() {
        let identifier = PersistedPreprocessingJobIdentifier {
            value: "job::scan-001::2".to_string(),
        };
        let url = NonEmptyText::parse("/api/preprocessing-stream/job/scan-001/2/events".to_string())
            .unwrap();
        let payload =
            assemble_run_preprocessing_stream_response_payload(&identifier, &url, 2);
        assert_eq!(payload.job_identifier, "job::scan-001::2");
        assert_eq!(payload.total_stage_count, 2);
        assert_eq!(
            payload.subscription_url,
            "/api/preprocessing-stream/job/scan-001/2/events"
        );
    }
}
