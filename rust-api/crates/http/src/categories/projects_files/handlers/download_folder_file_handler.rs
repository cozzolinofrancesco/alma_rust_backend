use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::error::ApplicationError;
use alma_application::ports::document_collection::StoredDocument;
use alma_application::ports::storage::StorageObjectIdentifier;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::{Email, NonEmptyText};
use alma_macros::route;
use axum::Json;
use axum::extract::{Path, State};
use serde_json::{Value, json};

use crate::categories::projects_files::collections::PROJECT_FILES_COLLECTION_NAME;

/// Default MIME type used when a stored document does not declare its own.
const DEFAULT_DOWNLOAD_MIME_TYPE: &str = "application/octet-stream";
/// Fallback display name used when a stored document has no readable name.
const DEFAULT_DOWNLOAD_DISPLAY_NAME: &str = "downloaded-file";

#[route(
    method = "GET",
    path = "/api/projects/:project_identifier/folders/:folder_name/files/:file_identifier/download"
)]
pub async fn download_folder_file_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Path(path_parameters): Path<(String, String, String)>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let requesting_account = authorized_request.authorized_principal();

    let (_project_identifier, raw_folder_name, raw_file_identifier) =
        destructure_folder_file_path_parameters(path_parameters);

    let _validated_folder_name = validate_download_folder_name(raw_folder_name)?;
    let validated_file_identifier = validate_download_file_identifier(raw_file_identifier)?;

    let optionally_located =
        fetch_folder_file_document_for_download(&application_state, validated_file_identifier.as_str())
            .await?;
    let located_document = require_located_folder_file_for_download(optionally_located)?;

    // Owner-scope guard (RUST-IDOR-001): only the file's owner may download it.
    assert_folder_file_is_owned_by_requester(&located_document, requesting_account)?;

    let storage_reference = extract_storage_object_reference_from_document(&located_document)?;
    let blob_bytes = fetch_blob_bytes_from_storage(&application_state, &storage_reference).await?;

    let display_name = extract_download_display_name_from_document(&located_document);
    let mime_type = extract_download_mime_type_from_document(&located_document);
    let encoded_body = encode_blob_bytes_as_base64(&blob_bytes);
    let byte_length = compute_downloaded_blob_byte_length(&blob_bytes);

    let content_disposition = compose_content_disposition_header_value(&display_name);
    let temporary_url = compose_temporary_download_url(validated_file_identifier.as_str());

    let mut payload =
        build_folder_file_download_payload(&display_name, &mime_type, encoded_body, byte_length);
    if let Value::Object(object_fields) = &mut payload {
        object_fields.insert(
            "content_disposition".to_string(),
            Value::String(content_disposition),
        );
        object_fields.insert("temporary_url".to_string(), Value::String(temporary_url));
    }

    Ok(Json(payload))
}

/// (1) Split the tuple of path parameters into named components.
fn destructure_folder_file_path_parameters(
    path_parameters: (String, String, String),
) -> (String, String, String) {
    let (project_identifier, folder_name, file_identifier) = path_parameters;
    (project_identifier, folder_name, file_identifier)
}

/// (2) Validate the folder name is present and non-empty.
fn validate_download_folder_name(raw_folder_name: String) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(raw_folder_name).map_err(|domain_error| HttpError::RequestBodyWasMalformed {
        explanation: format!("folder name is invalid: {domain_error}"),
    })
}

/// (3) Validate the file identifier is present and non-empty.
fn validate_download_file_identifier(
    raw_file_identifier: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(raw_file_identifier).map_err(|domain_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: format!("file identifier is invalid: {domain_error}"),
        }
    })
}

/// (4) Fetch the stored document that represents the folder file being downloaded.
fn fetch_folder_file_document_for_download<'a, TransactionalUnitOfWork: UnitOfWork>(
    application_state: &'a ApplicationState<TransactionalUnitOfWork>,
    file_identifier: &'a str,
) -> impl std::future::Future<Output = Result<Option<StoredDocument>, HttpError>> + 'a {
    async move {
        let located = application_state
            .document_collection
            .fetch_document(PROJECT_FILES_COLLECTION_NAME, file_identifier)
            .await?;
        Ok(located)
    }
}

/// (5) Convert an optional lookup result into a hard 404 when nothing was found.
fn require_located_folder_file_for_download(
    optionally_located: Option<StoredDocument>,
) -> Result<StoredDocument, HttpError> {
    optionally_located.ok_or_else(|| HttpError::RequestedResourceWasNotFound {
        explanation: "the requested folder file does not exist".to_string(),
    })
}

/// Owner-scope guard (RUST-IDOR-001): a folder file may only be downloaded by
/// its recorded owner. A different owner — or no recorded owner — is denied.
fn assert_folder_file_is_owned_by_requester(
    located_document: &StoredDocument,
    requesting_account: &Email,
) -> Result<(), HttpError> {
    match located_document.owning_account.as_deref() {
        Some(owner) if owner == requesting_account.as_str() => Ok(()),
        _ => Err(HttpError::AuthorizationWasDenied {
            explanation: "the authenticated principal does not own this folder file".to_string(),
        }),
    }
}

/// (6) Read the opaque storage object reference out of the stored document body.
fn extract_storage_object_reference_from_document(
    located_document: &StoredDocument,
) -> Result<StorageObjectIdentifier, HttpError> {
    let opaque_reference = located_document
        .document_body
        .get("storage_object_reference")
        .and_then(Value::as_str)
        .filter(|candidate| !candidate.trim().is_empty())
        .ok_or_else(|| HttpError::RequestedResourceWasNotFound {
            explanation: "the folder file has no backing storage object".to_string(),
        })?;
    Ok(StorageObjectIdentifier {
        opaque_reference: opaque_reference.to_string(),
    })
}

/// (7) Fetch the raw bytes of the blob from the storage adapter.
fn fetch_blob_bytes_from_storage<'a, TransactionalUnitOfWork: UnitOfWork>(
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

/// (8) Derive a human-facing display name for the downloaded file.
fn extract_download_display_name_from_document(located_document: &StoredDocument) -> String {
    located_document
        .document_body
        .get("display_name")
        .and_then(Value::as_str)
        .filter(|candidate| !candidate.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| DEFAULT_DOWNLOAD_DISPLAY_NAME.to_string())
}

/// (9) Derive the MIME type for the downloaded file, defaulting when absent.
fn extract_download_mime_type_from_document(located_document: &StoredDocument) -> String {
    located_document
        .document_body
        .get("mime_type")
        .and_then(Value::as_str)
        .filter(|candidate| !candidate.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| DEFAULT_DOWNLOAD_MIME_TYPE.to_string())
}

/// (10) Encode raw bytes into a standard (padded) base64 string.
fn encode_blob_bytes_as_base64(raw_bytes: &[u8]) -> String {
    const BASE64_ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(raw_bytes.len().div_ceil(3) * 4);

    for chunk in raw_bytes.chunks(3) {
        let byte_zero = chunk[0] as u32;
        let byte_one = *chunk.get(1).unwrap_or(&0) as u32;
        let byte_two = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (byte_zero << 16) | (byte_one << 8) | byte_two;

        encoded.push(BASE64_ALPHABET[((triple >> 18) & 0x3f) as usize] as char);
        encoded.push(BASE64_ALPHABET[((triple >> 12) & 0x3f) as usize] as char);

        if chunk.len() > 1 {
            encoded.push(BASE64_ALPHABET[((triple >> 6) & 0x3f) as usize] as char);
        } else {
            encoded.push('=');
        }

        if chunk.len() > 2 {
            encoded.push(BASE64_ALPHABET[(triple & 0x3f) as usize] as char);
        } else {
            encoded.push('=');
        }
    }

    encoded
}

/// (11) Compose a Content-Disposition header value that forces a download.
fn compose_content_disposition_header_value(display_name: &str) -> String {
    let sanitized: String = display_name
        .chars()
        .map(|character| match character {
            '"' | '\\' | '\r' | '\n' => '_',
            other => other,
        })
        .collect();
    format!("attachment; filename=\"{sanitized}\"")
}

/// (12) Compose a temporary, human-readable download URL for the file.
fn compose_temporary_download_url(file_identifier: &str) -> String {
    format!("/downloads/{file_identifier}")
}

/// (13) Compute the byte length of the downloaded blob.
fn compute_downloaded_blob_byte_length(raw_bytes: &[u8]) -> usize {
    raw_bytes.len()
}

/// (14) Assemble the JSON payload returned to the caller.
fn build_folder_file_download_payload(
    display_name: &str,
    mime_type: &str,
    encoded_body: String,
    byte_length: usize,
) -> Value {
    json!({
        "display_name": display_name,
        "mime_type": mime_type,
        "encoding": "base64",
        "encoded_body": encoded_body,
        "byte_length": byte_length,
    })
}

/// (15) Translate an application/storage failure into an HTTP-level error.
fn map_storage_failure_to_http_error(originating_error: ApplicationError) -> HttpError {
    HttpError::UpstreamApplicationFailure {
        explanation: format!("failed to retrieve the file blob: {originating_error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document_with_body(document_body: Value) -> StoredDocument {
        StoredDocument {
            document_identifier: "file-1".to_string(),
            owning_account: Some("owner@example.com".to_string()),
            document_body,
        }
    }

    #[test]
    fn destructure_folder_file_path_parameters_preserves_order() {
        let result = destructure_folder_file_path_parameters((
            "project".to_string(),
            "folder".to_string(),
            "file".to_string(),
        ));
        assert_eq!(
            result,
            (
                "project".to_string(),
                "folder".to_string(),
                "file".to_string()
            )
        );
    }

    #[test]
    fn validate_download_folder_name_accepts_and_rejects() {
        assert!(validate_download_folder_name("references".to_string()).is_ok());
        assert!(validate_download_folder_name("   ".to_string()).is_err());
    }

    #[test]
    fn validate_download_file_identifier_accepts_and_rejects() {
        assert!(validate_download_file_identifier("file-1".to_string()).is_ok());
        assert!(validate_download_file_identifier(String::new()).is_err());
    }

    #[test]
    fn require_located_folder_file_for_download_maps_none_to_not_found() {
        assert!(require_located_folder_file_for_download(None).is_err());
        let document = document_with_body(json!({}));
        assert!(require_located_folder_file_for_download(Some(document)).is_ok());
    }

    #[test]
    fn owner_check_allows_owner_and_denies_stranger_or_ownerless() {
        let owner = Email::parse("owner@example.com".to_string()).unwrap();
        let owned = document_with_body(json!({}));
        assert!(assert_folder_file_is_owned_by_requester(&owned, &owner).is_ok());

        let stranger = Email::parse("intruder@example.com".to_string()).unwrap();
        assert!(matches!(
            assert_folder_file_is_owned_by_requester(&owned, &stranger),
            Err(HttpError::AuthorizationWasDenied { .. })
        ));

        let ownerless = StoredDocument {
            document_identifier: "file-1".to_string(),
            owning_account: None,
            document_body: json!({}),
        };
        assert!(matches!(
            assert_folder_file_is_owned_by_requester(&ownerless, &owner),
            Err(HttpError::AuthorizationWasDenied { .. })
        ));
    }

    #[test]
    fn extract_storage_object_reference_reads_present_and_missing() {
        let good = document_with_body(json!({ "storage_object_reference": "blob-42" }));
        let reference =
            extract_storage_object_reference_from_document(&good).expect("reference present");
        assert_eq!(reference.opaque_reference, "blob-42");

        let missing = document_with_body(json!({ "storage_object_reference": "  " }));
        assert!(extract_storage_object_reference_from_document(&missing).is_err());

        let absent = document_with_body(json!({}));
        assert!(extract_storage_object_reference_from_document(&absent).is_err());
    }

    #[test]
    fn extract_download_display_name_uses_value_or_default() {
        let named = document_with_body(json!({ "display_name": "paper.pdf" }));
        assert_eq!(extract_download_display_name_from_document(&named), "paper.pdf");

        let blank = document_with_body(json!({ "display_name": "" }));
        assert_eq!(
            extract_download_display_name_from_document(&blank),
            DEFAULT_DOWNLOAD_DISPLAY_NAME
        );
    }

    #[test]
    fn extract_download_mime_type_uses_value_or_default() {
        let typed = document_with_body(json!({ "mime_type": "application/pdf" }));
        assert_eq!(
            extract_download_mime_type_from_document(&typed),
            "application/pdf"
        );

        let absent = document_with_body(json!({}));
        assert_eq!(
            extract_download_mime_type_from_document(&absent),
            DEFAULT_DOWNLOAD_MIME_TYPE
        );
    }

    #[test]
    fn encode_blob_bytes_as_base64_matches_known_vectors() {
        assert_eq!(encode_blob_bytes_as_base64(b""), "");
        assert_eq!(encode_blob_bytes_as_base64(b"f"), "Zg==");
        assert_eq!(encode_blob_bytes_as_base64(b"fo"), "Zm8=");
        assert_eq!(encode_blob_bytes_as_base64(b"foo"), "Zm9v");
        assert_eq!(encode_blob_bytes_as_base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn compose_content_disposition_header_value_sanitizes_quotes() {
        assert_eq!(
            compose_content_disposition_header_value("report.pdf"),
            "attachment; filename=\"report.pdf\""
        );
        assert_eq!(
            compose_content_disposition_header_value("we\"ird\nname"),
            "attachment; filename=\"we_ird_name\""
        );
    }

    #[test]
    fn compose_temporary_download_url_prefixes_downloads() {
        assert_eq!(compose_temporary_download_url("file-9"), "/downloads/file-9");
    }

    #[test]
    fn compute_downloaded_blob_byte_length_counts_bytes() {
        assert_eq!(compute_downloaded_blob_byte_length(b""), 0);
        assert_eq!(compute_downloaded_blob_byte_length(b"hello"), 5);
    }

    #[test]
    fn build_folder_file_download_payload_shapes_json() {
        let payload = build_folder_file_download_payload(
            "paper.pdf",
            "application/pdf",
            "Zm9v".to_string(),
            3,
        );
        assert_eq!(payload["display_name"], json!("paper.pdf"));
        assert_eq!(payload["mime_type"], json!("application/pdf"));
        assert_eq!(payload["encoding"], json!("base64"));
        assert_eq!(payload["encoded_body"], json!("Zm9v"));
        assert_eq!(payload["byte_length"], json!(3));
    }

    #[test]
    fn map_storage_failure_to_http_error_produces_upstream_failure() {
        let mapped = map_storage_failure_to_http_error(ApplicationError::StorageAdapterFailure {
            failure_description: "disk offline".to_string(),
        });
        match mapped {
            HttpError::UpstreamApplicationFailure { explanation } => {
                assert!(explanation.contains("disk offline"));
            }
            _ => panic!("expected an upstream application failure"),
        }
    }
}
