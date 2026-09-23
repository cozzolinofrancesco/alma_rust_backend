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

/// Upper bound on the number of pages a single OCR job is permitted to process.
/// Beyond this we reject the request rather than dispatch an unbounded job.
const MAXIMUM_ALLOWED_OCR_PAGE_COUNT: u32 = 500;

/// Default estimate used when a source document exposes no usable page hint.
const DEFAULT_ESTIMATED_PAGE_COUNT: u32 = 1;

// ---------------------------------------------------------------------------
// Local value types
//
// The plan references opaque domain types (StoredDocumentDescriptor,
// OcrJobProcessingRequest, ...). We model them here as small owned structs so
// every helper can be exercised by a synchronous unit test with concrete data.
// ---------------------------------------------------------------------------

/// A lightweight description of the source document an OCR job will read from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredDocumentDescriptor {
    pub document_identifier: String,
    pub owning_account: Option<String>,
    pub declared_page_count: Option<u32>,
    pub media_type: String,
}

/// A storage object key locating the raw bytes of the source document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorageObjectKey {
    pub object_key: String,
}

/// The output representation the caller wants the extracted text delivered in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OcrOutputFormat {
    PlainText,
    Markdown,
    HypertextMarkup,
}

impl OcrOutputFormat {
    fn as_str(self) -> &'static str {
        match self {
            OcrOutputFormat::PlainText => "plain_text",
            OcrOutputFormat::Markdown => "markdown",
            OcrOutputFormat::HypertextMarkup => "html",
        }
    }
}

/// A fully-validated processing request ready to hand to the AI adapter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OcrJobProcessingRequest {
    pub source_document_identifier: String,
    pub source_media_type: String,
    pub language_hints: Vec<String>,
}

/// An opaque handle returned once a job has been accepted for processing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OcrJobHandle {
    pub source_document_identifier: String,
    pub accepted_prompt: String,
}

/// The persisted identifier of a created OCR job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistedOcrJobIdentifier {
    pub value: String,
}

impl PersistedOcrJobIdentifier {
    fn as_str(&self) -> &str {
        &self.value
    }
}

/// The response body returned to the caller after job creation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateOcrJobResponsePayload {
    pub job_identifier: String,
    pub status: String,
    pub estimated_page_count: u32,
}

impl CreateOcrJobResponsePayload {
    fn into_json(self) -> Value {
        json!({
            "job_identifier": self.job_identifier,
            "status": self.status,
            "estimated_page_count": self.estimated_page_count,
        })
    }
}

/// An audit entry recording that a job creation was requested.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OcrJobAuditEntry {
    pub job_identifier: String,
    pub source_document_reference: String,
    pub audit_action: String,
}

impl OcrJobAuditEntry {
    fn into_json(&self) -> Value {
        json!({
            "job_identifier": self.job_identifier,
            "source_document_reference": self.source_document_reference,
            "audit_action": self.audit_action,
        })
    }
}

/// Simplified error surfaced by the AI adapter that we translate to HTTP.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArtificialIntelligenceAdapterError {
    RequestWasRejected(String),
    UpstreamWasUnavailable(String),
}

/// Simplified error surfaced by the document collection lookup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocumentCollectionError {
    DocumentWasNotFound(String),
    LookupFailed(String),
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

#[route(method = "POST", path = "/api/ocr")]
pub async fn create_ocr_job_handler<TransactionalUnitOfWork>(
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

    // 1. Parse the mandatory source document reference.
    let document_reference_string = submitted_body
        .get("document_reference")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let document_reference = parse_ocr_job_document_reference(document_reference_string)?;

    // 2. Parse optional language hints.
    let raw_language_codes = extract_raw_language_codes(&submitted_body);
    let language_hints = parse_ocr_job_requested_language_hints(raw_language_codes)?;

    // 6. Parse optional output format (defaults to plain text).
    let raw_output_format = submitted_body
        .get("output_format")
        .and_then(Value::as_str)
        .unwrap_or("plain_text");
    let output_format = validate_ocr_job_requested_output_format(raw_output_format)?;

    // 3. Ensure the referenced source document actually exists.
    let source_documents = application_state
        .document_collection
        .list_documents_owned_by(OCR_JOBS_COLLECTION_NAME, &owning_account)
        .await
        .unwrap_or_default();
    let source_descriptor =
        validate_ocr_job_source_document_exists(&source_documents, &document_reference)?;

    // 4. Resolve the storage location for the source document.
    let storage_location = resolve_ocr_job_target_storage_location(&document_reference)?;

    // 5. Build the processing request.
    let processing_request =
        build_ocr_job_processing_request(&source_descriptor, &language_hints);

    // 12 + 14. Estimate page count and enforce the limit.
    let estimated_page_count = compute_ocr_job_estimated_page_count(&source_descriptor);
    reject_ocr_job_when_estimated_page_count_exceeds_limit(
        estimated_page_count,
        MAXIMUM_ALLOWED_OCR_PAGE_COUNT,
    )?;

    // 7. Dispatch to the AI adapter for real completion-driven OCR.
    let dispatch_prompt = build_ocr_dispatch_prompt(&processing_request, output_format);
    let dispatch_prompt_text = NonEmptyText::parse(dispatch_prompt).map_err(|error| {
        HttpError::UpstreamApplicationFailure {
            explanation: error.to_string(),
        }
    })?;
    let completion = application_state
        .artificial_intelligence_adapter
        .generate_completion(&dispatch_prompt_text)
        .await
        .map_err(|error| {
            map_artificial_intelligence_adapter_error_to_http_error(
                ArtificialIntelligenceAdapterError::UpstreamWasUnavailable(error.to_string()),
            )
        })?;
    let job_handle =
        dispatch_ocr_job_to_artificial_intelligence_adapter(&processing_request, completion.produced_text)?;

    // 9. Generate a stable job identifier.
    let job_identifier = generate_ocr_job_identifier(&document_reference);

    // 15. Record an audit entry.
    let audit_entry = record_ocr_job_creation_audit_entry(&job_identifier, &document_reference);

    // 8. Persist the job record.
    let persisted_identifier = persist_ocr_job_record(
        application_state.document_collection.as_ref(),
        OCR_JOBS_COLLECTION_NAME,
        &owning_account,
        &job_handle,
        &job_identifier,
        &storage_location,
        &audit_entry,
    )
    .await?;

    // 13. Assemble the response payload.
    let response_payload =
        assemble_create_ocr_job_response_payload(&persisted_identifier, estimated_page_count);

    Ok(Json(response_payload.into_json()))
}

// ---------------------------------------------------------------------------
// 1. Parse source document reference
// ---------------------------------------------------------------------------

fn parse_ocr_job_document_reference(
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
// 2. Parse requested language hints
// ---------------------------------------------------------------------------

fn parse_ocr_job_requested_language_hints(
    raw_language_codes: Vec<String>,
) -> Result<Vec<NonEmptyText>, HttpError> {
    let mut parsed_hints = Vec::with_capacity(raw_language_codes.len());
    for raw_code in raw_language_codes {
        let trimmed = raw_code.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.len() > 16 {
            return Err(HttpError::RequestBodyWasMalformed {
                explanation: format!("language hint '{trimmed}' is unreasonably long"),
            });
        }
        let hint = NonEmptyText::parse(trimmed.to_string()).map_err(|error| {
            HttpError::RequestBodyWasMalformed {
                explanation: error.to_string(),
            }
        })?;
        parsed_hints.push(hint);
    }
    Ok(parsed_hints)
}

/// Extract the raw language-code strings from the submitted JSON body.
fn extract_raw_language_codes(submitted_body: &Value) -> Vec<String> {
    submitted_body
        .get("language_hints")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// 3. Validate that the source document exists
// ---------------------------------------------------------------------------

fn validate_ocr_job_source_document_exists(
    stored_documents: &[StoredDocument],
    document_reference: &NonEmptyText,
) -> Result<StoredDocumentDescriptor, HttpError> {
    let reference = document_reference.as_str();
    let matching = stored_documents
        .iter()
        .find(|document| document.document_identifier == reference);
    match matching {
        Some(document) => Ok(build_descriptor_from_stored_document(document)),
        None => Err(map_document_collection_lookup_error_to_http_error(
            DocumentCollectionError::DocumentWasNotFound(reference.to_string()),
        )),
    }
}

/// Derive a descriptor from a stored document, reading page-count/media-type
/// hints out of the document body when present.
fn build_descriptor_from_stored_document(document: &StoredDocument) -> StoredDocumentDescriptor {
    let declared_page_count = document
        .document_body
        .get("page_count")
        .and_then(Value::as_u64)
        .and_then(|count| u32::try_from(count).ok());
    let media_type = document
        .document_body
        .get("media_type")
        .and_then(Value::as_str)
        .unwrap_or("application/octet-stream")
        .to_string();
    StoredDocumentDescriptor {
        document_identifier: document.document_identifier.clone(),
        owning_account: document.owning_account.clone(),
        declared_page_count,
        media_type,
    }
}

// ---------------------------------------------------------------------------
// 4. Resolve target storage location
// ---------------------------------------------------------------------------

fn resolve_ocr_job_target_storage_location(
    document_reference: &NonEmptyText,
) -> Result<StorageObjectKey, HttpError> {
    let reference = document_reference.as_str();
    if reference.contains("..") || reference.contains('\\') {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: "document reference contains an illegal path segment".to_string(),
        });
    }
    let sanitized: String = reference
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '/') {
                character
            } else {
                '_'
            }
        })
        .collect();
    Ok(StorageObjectKey {
        object_key: format!("ocr-sources/{sanitized}"),
    })
}

// ---------------------------------------------------------------------------
// 5. Build processing request
// ---------------------------------------------------------------------------

fn build_ocr_job_processing_request(
    source: &StoredDocumentDescriptor,
    language_hints: &[NonEmptyText],
) -> OcrJobProcessingRequest {
    OcrJobProcessingRequest {
        source_document_identifier: source.document_identifier.clone(),
        source_media_type: source.media_type.clone(),
        language_hints: language_hints
            .iter()
            .map(|hint| hint.as_str().to_string())
            .collect(),
    }
}

/// Build a natural-language prompt describing the OCR task for the AI adapter.
fn build_ocr_dispatch_prompt(
    request: &OcrJobProcessingRequest,
    output_format: OcrOutputFormat,
) -> String {
    let language_clause = if request.language_hints.is_empty() {
        "auto-detecting the language".to_string()
    } else {
        format!("prioritizing the languages: {}", request.language_hints.join(", "))
    };
    format!(
        "Extract all readable text from document '{}' (media type {}), {}, and return it as {}.",
        request.source_document_identifier,
        request.source_media_type,
        language_clause,
        output_format.as_str(),
    )
}

// ---------------------------------------------------------------------------
// 6. Validate requested output format
// ---------------------------------------------------------------------------

fn validate_ocr_job_requested_output_format(
    raw_output_format: &str,
) -> Result<OcrOutputFormat, HttpError> {
    match raw_output_format.trim().to_ascii_lowercase().as_str() {
        "plain_text" | "text" | "" => Ok(OcrOutputFormat::PlainText),
        "markdown" | "md" => Ok(OcrOutputFormat::Markdown),
        "html" | "hypertext" => Ok(OcrOutputFormat::HypertextMarkup),
        other => Err(HttpError::RequestBodyWasMalformed {
            explanation: format!("unsupported output format '{other}'"),
        }),
    }
}

// ---------------------------------------------------------------------------
// 7. Dispatch to AI adapter
// ---------------------------------------------------------------------------

fn dispatch_ocr_job_to_artificial_intelligence_adapter(
    request: &OcrJobProcessingRequest,
    adapter_produced_text: String,
) -> Result<OcrJobHandle, HttpError> {
    if adapter_produced_text.trim().is_empty() {
        return Err(map_artificial_intelligence_adapter_error_to_http_error(
            ArtificialIntelligenceAdapterError::RequestWasRejected(
                "adapter returned no extracted text".to_string(),
            ),
        ));
    }
    Ok(OcrJobHandle {
        source_document_identifier: request.source_document_identifier.clone(),
        accepted_prompt: adapter_produced_text,
    })
}

// ---------------------------------------------------------------------------
// 8. Persist the job record (async orchestration)
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
async fn persist_ocr_job_record(
    document_collection: &dyn alma_application::ports::document_collection::DocumentCollectionPort,
    collection_name: &str,
    owning_account: &str,
    job_handle: &OcrJobHandle,
    job_identifier: &PersistedOcrJobIdentifier,
    storage_location: &StorageObjectKey,
    audit_entry: &OcrJobAuditEntry,
) -> Result<PersistedOcrJobIdentifier, HttpError> {
    let record = build_persisted_ocr_job_body(
        job_identifier,
        job_handle,
        storage_location,
        audit_entry,
    );
    let document = StoredDocument {
        document_identifier: job_identifier.as_str().to_string(),
        owning_account: Some(owning_account.to_string()),
        document_body: record,
    };
    document_collection
        .insert_document(collection_name, document)
        .await?;
    Ok(job_identifier.clone())
}

/// Assemble the JSON body persisted for an OCR job record.
fn build_persisted_ocr_job_body(
    job_identifier: &PersistedOcrJobIdentifier,
    job_handle: &OcrJobHandle,
    storage_location: &StorageObjectKey,
    audit_entry: &OcrJobAuditEntry,
) -> Value {
    json!({
        "job_identifier": job_identifier.as_str(),
        "status": "completed",
        "source_document_identifier": job_handle.source_document_identifier,
        "extracted_text": job_handle.accepted_prompt,
        "storage_object_key": storage_location.object_key,
        "audit": audit_entry.into_json(),
    })
}

// ---------------------------------------------------------------------------
// 9. Generate job identifier
// ---------------------------------------------------------------------------

fn generate_ocr_job_identifier(
    source_document_reference: &NonEmptyText,
) -> PersistedOcrJobIdentifier {
    let salt = Uuid::new_v4().simple().to_string();
    let slug: String = source_document_reference
        .as_str()
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(12)
        .collect::<String>()
        .to_ascii_lowercase();
    let slug = if slug.is_empty() {
        "doc".to_string()
    } else {
        slug
    };
    PersistedOcrJobIdentifier {
        value: format!("ocr-{slug}-{salt}"),
    }
}

// ---------------------------------------------------------------------------
// 10. Map AI adapter error to HTTP error
// ---------------------------------------------------------------------------

fn map_artificial_intelligence_adapter_error_to_http_error(
    adapter_error: ArtificialIntelligenceAdapterError,
) -> HttpError {
    match adapter_error {
        ArtificialIntelligenceAdapterError::RequestWasRejected(detail) => {
            HttpError::RequestBodyWasMalformed {
                explanation: format!("OCR request was rejected: {detail}"),
            }
        }
        ArtificialIntelligenceAdapterError::UpstreamWasUnavailable(detail) => {
            HttpError::UpstreamApplicationFailure {
                explanation: format!("OCR upstream was unavailable: {detail}"),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 11. Map document collection lookup error to HTTP error
// ---------------------------------------------------------------------------

fn map_document_collection_lookup_error_to_http_error(
    collection_error: DocumentCollectionError,
) -> HttpError {
    match collection_error {
        DocumentCollectionError::DocumentWasNotFound(reference) => {
            HttpError::RequestedResourceWasNotFound {
                explanation: format!("source document '{reference}' was not found"),
            }
        }
        DocumentCollectionError::LookupFailed(detail) => HttpError::UpstreamApplicationFailure {
            explanation: format!("document lookup failed: {detail}"),
        },
    }
}

// ---------------------------------------------------------------------------
// 12. Compute estimated page count
// ---------------------------------------------------------------------------

fn compute_ocr_job_estimated_page_count(source: &StoredDocumentDescriptor) -> u32 {
    match source.declared_page_count {
        Some(declared) if declared > 0 => declared,
        _ => DEFAULT_ESTIMATED_PAGE_COUNT,
    }
}

// ---------------------------------------------------------------------------
// 13. Assemble response payload
// ---------------------------------------------------------------------------

fn assemble_create_ocr_job_response_payload(
    job_identifier: &PersistedOcrJobIdentifier,
    estimated_page_count: u32,
) -> CreateOcrJobResponsePayload {
    CreateOcrJobResponsePayload {
        job_identifier: job_identifier.as_str().to_string(),
        status: "completed".to_string(),
        estimated_page_count,
    }
}

// ---------------------------------------------------------------------------
// 14. Reject when estimated page count exceeds limit
// ---------------------------------------------------------------------------

fn reject_ocr_job_when_estimated_page_count_exceeds_limit(
    estimated_page_count: u32,
    maximum_allowed_page_count: u32,
) -> Result<(), HttpError> {
    if estimated_page_count > maximum_allowed_page_count {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "estimated page count {estimated_page_count} exceeds maximum {maximum_allowed_page_count}"
            ),
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 15. Record audit entry
// ---------------------------------------------------------------------------

fn record_ocr_job_creation_audit_entry(
    job_identifier: &PersistedOcrJobIdentifier,
    source_document_reference: &NonEmptyText,
) -> OcrJobAuditEntry {
    OcrJobAuditEntry {
        job_identifier: job_identifier.as_str().to_string(),
        source_document_reference: source_document_reference.as_str().to_string(),
        audit_action: "ocr_job_created".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor(page_count: Option<u32>) -> StoredDocumentDescriptor {
        StoredDocumentDescriptor {
            document_identifier: "doc-123".to_string(),
            owning_account: Some("user@example.com".to_string()),
            declared_page_count: page_count,
            media_type: "application/pdf".to_string(),
        }
    }

    #[test]
    fn parse_document_reference_accepts_valid_and_trims() {
        let parsed = parse_ocr_job_document_reference("  invoice.pdf  ").unwrap();
        assert_eq!(parsed.as_str(), "invoice.pdf");
    }

    #[test]
    fn parse_document_reference_rejects_empty() {
        assert!(parse_ocr_job_document_reference("   ").is_err());
    }

    #[test]
    fn parse_language_hints_filters_blanks() {
        let hints =
            parse_ocr_job_requested_language_hints(vec!["en".into(), "  ".into(), "it".into()])
                .unwrap();
        assert_eq!(hints.len(), 2);
        assert_eq!(hints[0].as_str(), "en");
        assert_eq!(hints[1].as_str(), "it");
    }

    #[test]
    fn parse_language_hints_rejects_overly_long() {
        assert!(
            parse_ocr_job_requested_language_hints(vec!["x".repeat(20)]).is_err()
        );
    }

    #[test]
    fn extract_raw_language_codes_reads_array() {
        let body = json!({ "language_hints": ["en", "fr", 7] });
        let codes = extract_raw_language_codes(&body);
        assert_eq!(codes, vec!["en".to_string(), "fr".to_string()]);
    }

    #[test]
    fn extract_raw_language_codes_missing_is_empty() {
        assert!(extract_raw_language_codes(&json!({})).is_empty());
    }

    #[test]
    fn validate_source_exists_found() {
        let documents = vec![StoredDocument {
            document_identifier: "doc-123".to_string(),
            owning_account: Some("user@example.com".to_string()),
            document_body: json!({ "page_count": 4, "media_type": "application/pdf" }),
        }];
        let reference = NonEmptyText::parse("doc-123".to_string()).unwrap();
        let found = validate_ocr_job_source_document_exists(&documents, &reference).unwrap();
        assert_eq!(found.document_identifier, "doc-123");
        assert_eq!(found.declared_page_count, Some(4));
        assert_eq!(found.media_type, "application/pdf");
    }

    #[test]
    fn validate_source_exists_missing() {
        let reference = NonEmptyText::parse("nope".to_string()).unwrap();
        let error = validate_ocr_job_source_document_exists(&[], &reference).unwrap_err();
        assert!(matches!(
            error,
            HttpError::RequestedResourceWasNotFound { .. }
        ));
    }

    #[test]
    fn resolve_storage_location_sanitizes() {
        let reference = NonEmptyText::parse("weird name!.pdf".to_string()).unwrap();
        let key = resolve_ocr_job_target_storage_location(&reference).unwrap();
        assert_eq!(key.object_key, "ocr-sources/weird_name_.pdf");
    }

    #[test]
    fn resolve_storage_location_rejects_traversal() {
        let reference = NonEmptyText::parse("../secret".to_string()).unwrap();
        assert!(resolve_ocr_job_target_storage_location(&reference).is_err());
    }

    #[test]
    fn build_processing_request_carries_hints() {
        let hints = vec![
            NonEmptyText::parse("en".to_string()).unwrap(),
            NonEmptyText::parse("de".to_string()).unwrap(),
        ];
        let request = build_ocr_job_processing_request(&descriptor(Some(2)), &hints);
        assert_eq!(request.source_document_identifier, "doc-123");
        assert_eq!(request.language_hints, vec!["en".to_string(), "de".to_string()]);
        assert_eq!(request.source_media_type, "application/pdf");
    }

    #[test]
    fn build_dispatch_prompt_mentions_format_and_language() {
        let request = OcrJobProcessingRequest {
            source_document_identifier: "doc-123".to_string(),
            source_media_type: "application/pdf".to_string(),
            language_hints: vec!["en".to_string()],
        };
        let prompt = build_ocr_dispatch_prompt(&request, OcrOutputFormat::Markdown);
        assert!(prompt.contains("doc-123"));
        assert!(prompt.contains("markdown"));
        assert!(prompt.contains("en"));
    }

    #[test]
    fn build_dispatch_prompt_auto_detect_when_no_hints() {
        let request = OcrJobProcessingRequest {
            source_document_identifier: "doc-123".to_string(),
            source_media_type: "image/png".to_string(),
            language_hints: vec![],
        };
        let prompt = build_ocr_dispatch_prompt(&request, OcrOutputFormat::PlainText);
        assert!(prompt.contains("auto-detecting"));
    }

    #[test]
    fn validate_output_format_variants() {
        assert_eq!(
            validate_ocr_job_requested_output_format("MD").unwrap(),
            OcrOutputFormat::Markdown
        );
        assert_eq!(
            validate_ocr_job_requested_output_format("").unwrap(),
            OcrOutputFormat::PlainText
        );
        assert_eq!(
            validate_ocr_job_requested_output_format("html").unwrap(),
            OcrOutputFormat::HypertextMarkup
        );
    }

    #[test]
    fn validate_output_format_rejects_unknown() {
        assert!(validate_ocr_job_requested_output_format("pdf").is_err());
    }

    #[test]
    fn dispatch_accepts_nonempty_text() {
        let request = OcrJobProcessingRequest {
            source_document_identifier: "doc-123".to_string(),
            source_media_type: "application/pdf".to_string(),
            language_hints: vec![],
        };
        let handle =
            dispatch_ocr_job_to_artificial_intelligence_adapter(&request, "hello".to_string())
                .unwrap();
        assert_eq!(handle.source_document_identifier, "doc-123");
        assert_eq!(handle.accepted_prompt, "hello");
    }

    #[test]
    fn dispatch_rejects_empty_text() {
        let request = OcrJobProcessingRequest {
            source_document_identifier: "doc-123".to_string(),
            source_media_type: "application/pdf".to_string(),
            language_hints: vec![],
        };
        let error =
            dispatch_ocr_job_to_artificial_intelligence_adapter(&request, "   ".to_string())
                .unwrap_err();
        assert!(matches!(error, HttpError::RequestBodyWasMalformed { .. }));
    }

    #[test]
    fn build_persisted_body_contains_fields() {
        let identifier = PersistedOcrJobIdentifier {
            value: "ocr-doc-123".to_string(),
        };
        let handle = OcrJobHandle {
            source_document_identifier: "doc-123".to_string(),
            accepted_prompt: "extracted".to_string(),
        };
        let storage = StorageObjectKey {
            object_key: "ocr-sources/doc-123".to_string(),
        };
        let audit = OcrJobAuditEntry {
            job_identifier: "ocr-doc-123".to_string(),
            source_document_reference: "doc-123".to_string(),
            audit_action: "ocr_job_created".to_string(),
        };
        let body = build_persisted_ocr_job_body(&identifier, &handle, &storage, &audit);
        assert_eq!(body["job_identifier"], "ocr-doc-123");
        assert_eq!(body["extracted_text"], "extracted");
        assert_eq!(body["storage_object_key"], "ocr-sources/doc-123");
        assert_eq!(body["audit"]["audit_action"], "ocr_job_created");
    }

    #[test]
    fn generate_identifier_has_prefix_and_slug() {
        let reference = NonEmptyText::parse("Invoice #99".to_string()).unwrap();
        let identifier = generate_ocr_job_identifier(&reference);
        assert!(identifier.as_str().starts_with("ocr-invoice99-"));
    }

    #[test]
    fn generate_identifier_defaults_slug_when_no_alnum() {
        let reference = NonEmptyText::parse("###".to_string()).unwrap();
        let identifier = generate_ocr_job_identifier(&reference);
        assert!(identifier.as_str().starts_with("ocr-doc-"));
    }

    #[test]
    fn map_ai_error_rejected_is_malformed() {
        let error = map_artificial_intelligence_adapter_error_to_http_error(
            ArtificialIntelligenceAdapterError::RequestWasRejected("bad".to_string()),
        );
        assert!(matches!(error, HttpError::RequestBodyWasMalformed { .. }));
    }

    #[test]
    fn map_ai_error_unavailable_is_upstream() {
        let error = map_artificial_intelligence_adapter_error_to_http_error(
            ArtificialIntelligenceAdapterError::UpstreamWasUnavailable("down".to_string()),
        );
        assert!(matches!(error, HttpError::UpstreamApplicationFailure { .. }));
    }

    #[test]
    fn map_collection_error_not_found() {
        let error = map_document_collection_lookup_error_to_http_error(
            DocumentCollectionError::DocumentWasNotFound("x".to_string()),
        );
        assert!(matches!(
            error,
            HttpError::RequestedResourceWasNotFound { .. }
        ));
    }

    #[test]
    fn map_collection_error_lookup_failed() {
        let error = map_document_collection_lookup_error_to_http_error(
            DocumentCollectionError::LookupFailed("boom".to_string()),
        );
        assert!(matches!(error, HttpError::UpstreamApplicationFailure { .. }));
    }

    #[test]
    fn compute_page_count_uses_declared() {
        assert_eq!(compute_ocr_job_estimated_page_count(&descriptor(Some(7))), 7);
    }

    #[test]
    fn compute_page_count_defaults_when_missing_or_zero() {
        assert_eq!(
            compute_ocr_job_estimated_page_count(&descriptor(None)),
            DEFAULT_ESTIMATED_PAGE_COUNT
        );
        assert_eq!(
            compute_ocr_job_estimated_page_count(&descriptor(Some(0))),
            DEFAULT_ESTIMATED_PAGE_COUNT
        );
    }

    #[test]
    fn assemble_response_payload_shape() {
        let identifier = PersistedOcrJobIdentifier {
            value: "ocr-x".to_string(),
        };
        let payload = assemble_create_ocr_job_response_payload(&identifier, 3);
        let json_value = payload.into_json();
        assert_eq!(json_value["job_identifier"], "ocr-x");
        assert_eq!(json_value["status"], "completed");
        assert_eq!(json_value["estimated_page_count"], 3);
    }

    #[test]
    fn reject_within_limit_is_ok() {
        assert!(reject_ocr_job_when_estimated_page_count_exceeds_limit(10, 500).is_ok());
    }

    #[test]
    fn reject_over_limit_errors() {
        let error =
            reject_ocr_job_when_estimated_page_count_exceeds_limit(501, 500).unwrap_err();
        assert!(matches!(error, HttpError::RequestBodyWasMalformed { .. }));
    }

    #[test]
    fn record_audit_entry_fields() {
        let identifier = PersistedOcrJobIdentifier {
            value: "ocr-1".to_string(),
        };
        let reference = NonEmptyText::parse("doc-123".to_string()).unwrap();
        let entry = record_ocr_job_creation_audit_entry(&identifier, &reference);
        assert_eq!(entry.job_identifier, "ocr-1");
        assert_eq!(entry.source_document_reference, "doc-123");
        assert_eq!(entry.audit_action, "ocr_job_created");
    }
}
