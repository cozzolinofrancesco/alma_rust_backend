use crate::categories::projects_files::collections::PROJECT_FILES_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::error::ApplicationError;
use alma_application::ports::document_collection::StoredDocument;
use alma_application::ports::storage::StorageObjectIdentifier;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::NonEmptyText;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};

/// POST /api/download-pdf
///
/// Given a stored project-file document identifier, this handler:
///   1. authorizes and identifies the owning account,
///   2. locates the corresponding stored document in the project-files collection,
///   3. extracts the storage-object reference that points at the persisted PDF blob,
///   4. fetches the raw blob bytes through the storage adapter,
///   5. validates that the bytes are actually a PDF,
///   6. base64-encodes the bytes and returns a "download ready" payload.
#[route(method = "POST", path = "/api/download-pdf")]
pub async fn download_pdf_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // Identify who is asking. Currently used to authorize access to the located
    // document (the owning account of the document must match, when set).
    let requesting_account = extract_owning_account_from_authorized_request(&authorized_request);

    // Required: which stored document holds the PDF we want.
    let source_identifier = extract_source_document_identifier_field(&submitted_body)?;

    // Optional: a source URL the client claims the PDF originated from. We do not
    // fetch it here, but we validate it so a malformed value is rejected early.
    if let Some(raw_source_url) = extract_pdf_source_url_field(&submitted_body) {
        let _validated_source_url = validate_pdf_source_url(raw_source_url)?;
    }

    // Optional: a page range the client is interested in. We validate the bounds
    // and echo them back so downstream tooling can honour them.
    let requested_page_range = match extract_requested_pdf_page_range(&submitted_body) {
        Some(page_range) => Some(validate_pdf_page_range_bounds(page_range)?),
        None => None,
    };

    // Locate the stored document.
    let located_document = fetch_pdf_source_document(&application_state, &source_identifier)
        .await?
        .ok_or_else(|| HttpError::RequestedResourceWasNotFound {
            explanation: format!(
                "no project file document exists with identifier '{source_identifier}'"
            ),
        })?;

    // Enforce ownership: if the document declares an owner, it must be the caller.
    if let Some(owning_account) = located_document.owning_account.as_deref() {
        if owning_account != requesting_account {
            return Err(HttpError::AuthorizationWasDenied {
                explanation: format!(
                    "principal '{requesting_account}' is not permitted to download document '{source_identifier}'"
                ),
            });
        }
    }

    // Resolve the storage reference embedded in the document body.
    let storage_reference = extract_pdf_storage_reference_from_document(&located_document)?;

    // Pull the raw bytes from the storage adapter.
    let raw_bytes = fetch_pdf_blob_bytes(&application_state, &storage_reference).await?;

    // Make sure what we got back is actually a PDF.
    assert_bytes_begin_with_pdf_magic_number(&raw_bytes)?;

    // Assemble the response payload.
    let encoded_body = encode_pdf_bytes_as_base64(&raw_bytes);
    let byte_length = compute_pdf_byte_length(&raw_bytes);
    let file_name = derive_downloaded_pdf_file_name(&source_identifier);

    let mut payload = build_pdf_download_ready_payload(&file_name, encoded_body, byte_length);

    // Attach the (already validated) requested page range if the client supplied one.
    if let Some((first_page, last_page)) = requested_page_range {
        if let Value::Object(object) = &mut payload {
            object.insert(
                "requested_page_range".to_string(),
                json!({ "first_page": first_page, "last_page": last_page }),
            );
        }
    }

    Ok(Json(payload))
}

/// (1) Resolve the account performing the request. The authorized principal is an
/// e-mail; its string form doubles as the owning-account key in stored documents.
fn extract_owning_account_from_authorized_request(
    authorized_request: &HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> String {
    authorized_request.authorized_principal().as_str().to_string()
}

/// (2) Pull the required `source_document_identifier` field out of the request body.
fn extract_source_document_identifier_field(submitted_body: &Value) -> Result<String, HttpError> {
    let raw_value = submitted_body
        .get("source_document_identifier")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|candidate| !candidate.is_empty());

    match raw_value {
        Some(identifier) => Ok(identifier.to_string()),
        None => Err(HttpError::RequestBodyWasMalformed {
            explanation:
                "the request body must contain a non-empty 'source_document_identifier' string"
                    .to_string(),
        }),
    }
}

/// (3) Pull the optional `pdf_source_url` field, if present and a string.
fn extract_pdf_source_url_field(submitted_body: &Value) -> Option<String> {
    submitted_body
        .get("pdf_source_url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|candidate| !candidate.is_empty())
        .map(str::to_string)
}

/// (4) Validate the optional source URL: it must be non-empty and use an
/// http(s) scheme. Returns the parsed `NonEmptyText` on success.
fn validate_pdf_source_url(raw_source_url: String) -> Result<NonEmptyText, HttpError> {
    let parsed = NonEmptyText::parse(raw_source_url)
        .map_err(|e| HttpError::RequestBodyWasMalformed { explanation: e.to_string() })?;

    let scheme_is_supported = parsed.as_str().starts_with("http://")
        || parsed.as_str().starts_with("https://");

    if !scheme_is_supported {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: "'pdf_source_url' must begin with 'http://' or 'https://'".to_string(),
        });
    }

    Ok(parsed)
}

/// (5) Pull the optional `page_range` field. Accepts either an object
/// `{ "first_page": n, "last_page": m }` or a two-element array `[n, m]`.
fn extract_requested_pdf_page_range(submitted_body: &Value) -> Option<(usize, usize)> {
    let page_range_value = submitted_body.get("page_range")?;

    if let Value::Object(object) = page_range_value {
        let first_page = object.get("first_page").and_then(Value::as_u64)?;
        let last_page = object.get("last_page").and_then(Value::as_u64)?;
        return Some((first_page as usize, last_page as usize));
    }

    if let Value::Array(array) = page_range_value {
        if array.len() == 2 {
            let first_page = array[0].as_u64()?;
            let last_page = array[1].as_u64()?;
            return Some((first_page as usize, last_page as usize));
        }
    }

    None
}

/// (6) Validate a requested page range: pages are 1-indexed and the first page
/// must not exceed the last.
fn validate_pdf_page_range_bounds(page_range: (usize, usize)) -> Result<(usize, usize), HttpError> {
    let (first_page, last_page) = page_range;

    if first_page == 0 || last_page == 0 {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: "page numbers in 'page_range' are 1-indexed and must be greater than zero"
                .to_string(),
        });
    }

    if first_page > last_page {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "invalid 'page_range': first_page ({first_page}) must not exceed last_page ({last_page})"
            ),
        });
    }

    Ok((first_page, last_page))
}

/// (7) Look up the stored document that holds the PDF's storage reference.
fn fetch_pdf_source_document<'a, TransactionalUnitOfWork: UnitOfWork>(
    application_state: &'a ApplicationState<TransactionalUnitOfWork>,
    source_identifier: &'a str,
) -> impl std::future::Future<Output = Result<Option<StoredDocument>, HttpError>> + 'a {
    async move {
        let located = application_state
            .document_collection
            .fetch_document(PROJECT_FILES_COLLECTION_NAME, source_identifier)
            .await?;
        Ok(located)
    }
}

/// (8) Extract the storage-object reference from a located document's body.
/// The body is expected to carry a `storage_object_reference` string.
fn extract_pdf_storage_reference_from_document(
    located_document: &StoredDocument,
) -> Result<StorageObjectIdentifier, HttpError> {
    let opaque_reference = located_document
        .document_body
        .get("storage_object_reference")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|candidate| !candidate.is_empty());

    match opaque_reference {
        Some(reference) => Ok(StorageObjectIdentifier {
            opaque_reference: reference.to_string(),
        }),
        None => Err(HttpError::RequestedResourceWasNotFound {
            explanation: format!(
                "document '{}' does not carry a 'storage_object_reference' pointing at a stored PDF",
                located_document.document_identifier
            ),
        }),
    }
}

/// (9) Fetch the raw blob bytes for a storage reference through the adapter.
fn fetch_pdf_blob_bytes<'a, TransactionalUnitOfWork: UnitOfWork>(
    application_state: &'a ApplicationState<TransactionalUnitOfWork>,
    object_identifier: &'a StorageObjectIdentifier,
) -> impl std::future::Future<Output = Result<Vec<u8>, HttpError>> + 'a {
    async move {
        application_state
            .storage_adapter
            .fetch_blob(object_identifier)
            .await
            .map_err(map_storage_failure_to_http_error)
    }
}

/// (10) Confirm the byte stream begins with the PDF magic number `%PDF-`.
fn assert_bytes_begin_with_pdf_magic_number(raw_bytes: &[u8]) -> Result<(), HttpError> {
    const PDF_MAGIC_NUMBER: &[u8] = b"%PDF-";

    if raw_bytes.len() >= PDF_MAGIC_NUMBER.len()
        && &raw_bytes[..PDF_MAGIC_NUMBER.len()] == PDF_MAGIC_NUMBER
    {
        Ok(())
    } else {
        Err(HttpError::UpstreamApplicationFailure {
            explanation: "the fetched blob does not begin with the PDF magic number '%PDF-'"
                .to_string(),
        })
    }
}

/// (11) Encode raw bytes as standard (RFC 4648) base64 with `=` padding.
fn encode_pdf_bytes_as_base64(raw_bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let mut encoded = String::with_capacity((raw_bytes.len() + 2) / 3 * 4);

    for chunk in raw_bytes.chunks(3) {
        let byte_zero = chunk[0] as usize;
        let byte_one = chunk.get(1).copied().unwrap_or(0) as usize;
        let byte_two = chunk.get(2).copied().unwrap_or(0) as usize;

        let combined = (byte_zero << 16) | (byte_one << 8) | byte_two;

        encoded.push(ALPHABET[(combined >> 18) & 0x3F] as char);
        encoded.push(ALPHABET[(combined >> 12) & 0x3F] as char);

        if chunk.len() > 1 {
            encoded.push(ALPHABET[(combined >> 6) & 0x3F] as char);
        } else {
            encoded.push('=');
        }

        if chunk.len() > 2 {
            encoded.push(ALPHABET[combined & 0x3F] as char);
        } else {
            encoded.push('=');
        }
    }

    encoded
}

/// (12) Derive a user-facing download file name from the source identifier,
/// guaranteeing a `.pdf` extension.
fn derive_downloaded_pdf_file_name(source_identifier: &str) -> String {
    let trimmed = source_identifier.trim();

    // Keep only the final path segment so identifiers like "folder/abc" become "abc".
    let last_segment = trimmed
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(trimmed)
        .trim();

    let base = if last_segment.is_empty() {
        "download"
    } else {
        last_segment
    };

    if base.to_ascii_lowercase().ends_with(".pdf") {
        base.to_string()
    } else {
        format!("{base}.pdf")
    }
}

/// (13) Compute the byte length of the blob.
fn compute_pdf_byte_length(raw_bytes: &[u8]) -> usize {
    raw_bytes.len()
}

/// (14) Assemble the "download ready" JSON payload.
fn build_pdf_download_ready_payload(
    file_name: &str,
    encoded_body: String,
    byte_length: usize,
) -> Value {
    json!({
        "download_ready": true,
        "file_name": file_name,
        "content_type": "application/pdf",
        "encoding": "base64",
        "byte_length": byte_length,
        "encoded_body": encoded_body,
    })
}

/// (15) Translate a storage-layer application error into an HTTP error.
fn map_storage_failure_to_http_error(originating_error: ApplicationError) -> HttpError {
    match originating_error {
        ApplicationError::RequestedResourceCouldNotBeLocated => {
            HttpError::RequestedResourceWasNotFound {
                explanation: "the referenced PDF blob could not be located in storage".to_string(),
            }
        }
        ApplicationError::AuthorizationWasDenied => HttpError::AuthorizationWasDenied {
            explanation: "access to the referenced PDF blob was denied".to_string(),
        },
        other => HttpError::UpstreamApplicationFailure {
            explanation: format!("failed to read the PDF blob from storage: {other}"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_source_document_identifier_field_accepts_valid_value() {
        let body = json!({ "source_document_identifier": "  file-123  " });
        let extracted = extract_source_document_identifier_field(&body).unwrap();
        assert_eq!(extracted, "file-123");
    }

    #[test]
    fn extract_source_document_identifier_field_rejects_missing_or_blank() {
        let missing = json!({});
        assert!(extract_source_document_identifier_field(&missing).is_err());

        let blank = json!({ "source_document_identifier": "   " });
        assert!(extract_source_document_identifier_field(&blank).is_err());
    }

    #[test]
    fn extract_pdf_source_url_field_returns_some_and_none() {
        let present = json!({ "pdf_source_url": "https://example.com/a.pdf" });
        assert_eq!(
            extract_pdf_source_url_field(&present),
            Some("https://example.com/a.pdf".to_string())
        );

        let absent = json!({});
        assert_eq!(extract_pdf_source_url_field(&absent), None);

        let blank = json!({ "pdf_source_url": "   " });
        assert_eq!(extract_pdf_source_url_field(&blank), None);
    }

    #[test]
    fn validate_pdf_source_url_accepts_http_schemes() {
        assert!(validate_pdf_source_url("https://example.com/a.pdf".to_string()).is_ok());
        assert!(validate_pdf_source_url("http://example.com/a.pdf".to_string()).is_ok());
    }

    #[test]
    fn validate_pdf_source_url_rejects_unsupported_scheme() {
        assert!(validate_pdf_source_url("ftp://example.com/a.pdf".to_string()).is_err());
        assert!(validate_pdf_source_url("   ".to_string()).is_err());
    }

    #[test]
    fn extract_requested_pdf_page_range_handles_object_array_and_missing() {
        let object_form = json!({ "page_range": { "first_page": 2, "last_page": 5 } });
        assert_eq!(extract_requested_pdf_page_range(&object_form), Some((2, 5)));

        let array_form = json!({ "page_range": [3, 9] });
        assert_eq!(extract_requested_pdf_page_range(&array_form), Some((3, 9)));

        let missing = json!({});
        assert_eq!(extract_requested_pdf_page_range(&missing), None);

        let malformed = json!({ "page_range": [1, 2, 3] });
        assert_eq!(extract_requested_pdf_page_range(&malformed), None);
    }

    #[test]
    fn validate_pdf_page_range_bounds_accepts_valid_range() {
        assert_eq!(validate_pdf_page_range_bounds((1, 10)).unwrap(), (1, 10));
        assert_eq!(validate_pdf_page_range_bounds((4, 4)).unwrap(), (4, 4));
    }

    #[test]
    fn validate_pdf_page_range_bounds_rejects_zero_and_inverted() {
        assert!(validate_pdf_page_range_bounds((0, 5)).is_err());
        assert!(validate_pdf_page_range_bounds((5, 0)).is_err());
        assert!(validate_pdf_page_range_bounds((9, 3)).is_err());
    }

    #[test]
    fn extract_pdf_storage_reference_from_document_reads_reference() {
        let document = StoredDocument {
            document_identifier: "file-1".to_string(),
            owning_account: None,
            document_body: json!({ "storage_object_reference": "blob-abc" }),
        };
        let reference = extract_pdf_storage_reference_from_document(&document).unwrap();
        assert_eq!(reference.opaque_reference, "blob-abc");
    }

    #[test]
    fn extract_pdf_storage_reference_from_document_errors_when_absent() {
        let document = StoredDocument {
            document_identifier: "file-1".to_string(),
            owning_account: None,
            document_body: json!({ "other": "value" }),
        };
        assert!(extract_pdf_storage_reference_from_document(&document).is_err());
    }

    #[test]
    fn assert_bytes_begin_with_pdf_magic_number_accepts_pdf() {
        let bytes = b"%PDF-1.7\n...";
        assert!(assert_bytes_begin_with_pdf_magic_number(bytes).is_ok());
    }

    #[test]
    fn assert_bytes_begin_with_pdf_magic_number_rejects_non_pdf() {
        assert!(assert_bytes_begin_with_pdf_magic_number(b"NOPE").is_err());
        assert!(assert_bytes_begin_with_pdf_magic_number(b"").is_err());
    }

    #[test]
    fn encode_pdf_bytes_as_base64_matches_known_vectors() {
        assert_eq!(encode_pdf_bytes_as_base64(b""), "");
        assert_eq!(encode_pdf_bytes_as_base64(b"f"), "Zg==");
        assert_eq!(encode_pdf_bytes_as_base64(b"fo"), "Zm8=");
        assert_eq!(encode_pdf_bytes_as_base64(b"foo"), "Zm9v");
        assert_eq!(encode_pdf_bytes_as_base64(b"foob"), "Zm9vYg==");
        assert_eq!(encode_pdf_bytes_as_base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(encode_pdf_bytes_as_base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn derive_downloaded_pdf_file_name_adds_extension_and_strips_path() {
        assert_eq!(derive_downloaded_pdf_file_name("report"), "report.pdf");
        assert_eq!(derive_downloaded_pdf_file_name("report.pdf"), "report.pdf");
        assert_eq!(derive_downloaded_pdf_file_name("Report.PDF"), "Report.PDF");
        assert_eq!(derive_downloaded_pdf_file_name("folder/sub/doc"), "doc.pdf");
        assert_eq!(derive_downloaded_pdf_file_name("   "), "download.pdf");
    }

    #[test]
    fn compute_pdf_byte_length_returns_length() {
        assert_eq!(compute_pdf_byte_length(b""), 0);
        assert_eq!(compute_pdf_byte_length(b"%PDF-"), 5);
    }

    #[test]
    fn build_pdf_download_ready_payload_contains_expected_fields() {
        let payload = build_pdf_download_ready_payload("doc.pdf", "Zm9v".to_string(), 3);
        assert_eq!(payload["download_ready"], json!(true));
        assert_eq!(payload["file_name"], json!("doc.pdf"));
        assert_eq!(payload["content_type"], json!("application/pdf"));
        assert_eq!(payload["encoding"], json!("base64"));
        assert_eq!(payload["byte_length"], json!(3));
        assert_eq!(payload["encoded_body"], json!("Zm9v"));
    }

    #[test]
    fn map_storage_failure_to_http_error_maps_variants() {
        let not_found = map_storage_failure_to_http_error(
            ApplicationError::RequestedResourceCouldNotBeLocated,
        );
        assert!(matches!(not_found, HttpError::RequestedResourceWasNotFound { .. }));

        let denied =
            map_storage_failure_to_http_error(ApplicationError::AuthorizationWasDenied);
        assert!(matches!(denied, HttpError::AuthorizationWasDenied { .. }));

        let other = map_storage_failure_to_http_error(
            ApplicationError::StorageAdapterFailure {
                failure_description: "boom".to_string(),
            },
        );
        assert!(matches!(other, HttpError::UpstreamApplicationFailure { .. }));
    }
}
