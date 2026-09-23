//! `GET /api/rag/drive/download/:file_identifier` — download a file from the
//! CALLER'S Google Drive.
//!
//! Authenticated with the caller's `Authorization: Bearer <token>` and forwarded
//! to Drive v3 via [`GoogleDriveObjectPort`]. Returns the real file bytes as a
//! binary response (Content-Type / Content-Disposition / Content-Length from the
//! Drive metadata), and records a download audit entry. `?disposition=inline`
//! renders in-browser; the default is an attachment. Google-native docs
//! (application/vnd.google-apps.*) need `:export` and are out of scope for v1.

use crate::categories::rag::collections::RAG_KNOWLEDGE_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::google_access_token::GoogleAccessToken;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::ports::document_collection::{DocumentCollectionPort, StoredDocument};
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::{Email, NonEmptyText};
use alma_macros::route;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::response::Response;
use http::header::{CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE};
use http::{HeaderValue, StatusCode};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

/// How the downloaded file should be presented to the client.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadDisposition {
    Attachment,
    Inline,
}

impl DownloadDisposition {
    fn as_header_token(self) -> &'static str {
        match self {
            DownloadDisposition::Attachment => "attachment",
            DownloadDisposition::Inline => "inline",
        }
    }
}

const DEFAULT_DOWNLOAD_CONTENT_TYPE: &str = "application/octet-stream";
const DEFAULT_DOWNLOAD_FILE_NAME: &str = "download.bin";

#[route(method = "GET", path = "/api/rag/drive/download/:file_identifier")]
pub async fn download_rag_drive_file_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    google_access_token: GoogleAccessToken,
    Path(file_identifier): Path<String>,
    Query(query_parameters): Query<HashMap<String, String>>,
) -> Result<Response, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let resolved_identifier = extract_drive_file_identifier_from_path(file_identifier)?;
    let requested_disposition = parse_requested_download_disposition(&query_parameters);

    // Real Drive download with the caller's token.
    let file_content = application_state
        .google_drive_adapter
        .download_file(google_access_token.as_str(), resolved_identifier.as_str())
        .await
        .map_err(HttpError::from)?;

    // Best-effort audit; a failure to persist the audit must not fail the download.
    let _ = record_drive_file_download_audit_entry(
        &application_state.document_collection,
        &resolved_identifier,
        authorized_request.authorized_principal(),
    )
    .await;

    build_binary_download_response(&file_content.mime_type, &file_content.name, requested_disposition, file_content.bytes)
}

/// (1) Validate and normalise the raw path parameter into a `NonEmptyText`.
fn extract_drive_file_identifier_from_path(
    supplied_path_parameter: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(supplied_path_parameter).map_err(|domain_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: format!("the supplied drive file identifier was invalid: {domain_error}"),
        }
    })
}

/// (2) Determine the requested download disposition, defaulting to `Attachment`.
fn parse_requested_download_disposition(
    query_parameters: &HashMap<String, String>,
) -> DownloadDisposition {
    match query_parameters
        .get("disposition")
        .map(|raw_value| raw_value.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("inline") => DownloadDisposition::Inline,
        _ => DownloadDisposition::Attachment,
    }
}

/// (3) Build the binary HTTP response carrying the downloaded bytes + headers.
fn build_binary_download_response(
    declared_content_type: &str,
    declared_file_name: &str,
    disposition: DownloadDisposition,
    file_bytes: Vec<u8>,
) -> Result<Response, HttpError> {
    let content_type = HeaderValue::from_str(declared_content_type)
        .unwrap_or_else(|_| HeaderValue::from_static(DEFAULT_DOWNLOAD_CONTENT_TYPE));
    let content_disposition = build_content_disposition_header(declared_file_name, disposition)?;
    let content_length = HeaderValue::from_str(&file_bytes.len().to_string())
        .unwrap_or_else(|_| HeaderValue::from_static("0"));

    let mut response = Response::new(Body::from(file_bytes));
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, content_type);
    headers.insert(CONTENT_DISPOSITION, content_disposition);
    headers.insert(CONTENT_LENGTH, content_length);
    Ok(response)
}

/// (4) Build the `Content-Disposition` header combining the disposition token
/// with a sanitised file name.
fn build_content_disposition_header(
    declared_file_name: &str,
    disposition: DownloadDisposition,
) -> Result<HeaderValue, HttpError> {
    let sanitized_name = sanitize_downloaded_file_name_for_header(declared_file_name);
    let header_text = format!(
        "{}; filename=\"{}\"",
        disposition.as_header_token(),
        sanitized_name
    );
    HeaderValue::from_str(&header_text).map_err(|encoding_error| {
        HttpError::UpstreamApplicationFailure {
            explanation: format!(
                "the content disposition header could not be encoded: {encoding_error}"
            ),
        }
    })
}

/// (5) Strip characters that would break the `Content-Disposition` header or
/// allow path traversal, always yielding a non-empty file name.
fn sanitize_downloaded_file_name_for_header(raw_declared_name: &str) -> String {
    let cleaned: String = raw_declared_name
        .chars()
        .map(|character| match character {
            '"' | '\\' | '/' | '\r' | '\n' => '_',
            control if control.is_control() => '_',
            other => other,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        DEFAULT_DOWNLOAD_FILE_NAME.to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// (6) Persist an audit record for the download into the knowledge collection.
async fn record_drive_file_download_audit_entry(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    file_identifier: &NonEmptyText,
    requesting_account: &Email,
) -> Result<(), HttpError> {
    let audit_document =
        assemble_drive_file_download_audit_document(file_identifier, requesting_account);
    document_collection
        .insert_document(RAG_KNOWLEDGE_COLLECTION_NAME, audit_document)
        .await
        .map_err(HttpError::from)
}

/// (7) Build the audit `StoredDocument` describing who downloaded what.
fn assemble_drive_file_download_audit_document(
    file_identifier: &NonEmptyText,
    requesting_account: &Email,
) -> StoredDocument {
    let audit_identifier = format!(
        "drive-download::{}::{}",
        requesting_account.as_str(),
        file_identifier.as_str()
    );
    StoredDocument {
        document_identifier: audit_identifier,
        owning_account: Some(requesting_account.as_str().to_owned()),
        document_body: json!({
            "audit_kind": "drive_file_download",
            "drive_file_identifier": file_identifier.as_str(),
            "requested_by": requesting_account.as_str(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_identifier_accepts_non_empty() {
        let resolved = extract_drive_file_identifier_from_path("file-42".to_owned()).unwrap();
        assert_eq!(resolved.as_str(), "file-42");
    }

    #[test]
    fn extract_identifier_rejects_blank() {
        let outcome = extract_drive_file_identifier_from_path("   ".to_owned());
        assert!(matches!(
            outcome,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn disposition_defaults_to_attachment() {
        let empty: HashMap<String, String> = HashMap::new();
        assert_eq!(
            parse_requested_download_disposition(&empty),
            DownloadDisposition::Attachment
        );
    }

    #[test]
    fn disposition_parses_inline_case_insensitively() {
        let mut parameters = HashMap::new();
        parameters.insert("disposition".to_owned(), "  INLINE ".to_owned());
        assert_eq!(
            parse_requested_download_disposition(&parameters),
            DownloadDisposition::Inline
        );
    }

    #[test]
    fn disposition_unknown_value_falls_back() {
        let mut parameters = HashMap::new();
        parameters.insert("disposition".to_owned(), "banana".to_owned());
        assert_eq!(
            parse_requested_download_disposition(&parameters),
            DownloadDisposition::Attachment
        );
    }

    #[test]
    fn content_disposition_header_attachment() {
        let header =
            build_content_disposition_header("report.pdf", DownloadDisposition::Attachment).unwrap();
        assert_eq!(
            header.to_str().unwrap(),
            "attachment; filename=\"report.pdf\""
        );
    }

    #[test]
    fn content_disposition_header_inline() {
        let header =
            build_content_disposition_header("report.pdf", DownloadDisposition::Inline).unwrap();
        assert!(header.to_str().unwrap().starts_with("inline;"));
    }

    #[test]
    fn sanitize_file_name_strips_dangerous_characters() {
        let cleaned = sanitize_downloaded_file_name_for_header("../ev\"il\\name.pdf");
        assert!(!cleaned.contains('"'));
        assert!(!cleaned.contains('\\'));
        assert!(!cleaned.contains('/'));
    }

    #[test]
    fn sanitize_file_name_defaults_when_empty() {
        assert_eq!(
            sanitize_downloaded_file_name_for_header("   ...  "),
            DEFAULT_DOWNLOAD_FILE_NAME
        );
    }

    #[test]
    fn build_binary_response_sets_status_and_headers() {
        let response = build_binary_download_response(
            "application/pdf",
            "report.pdf",
            DownloadDisposition::Attachment,
            vec![1, 2, 3, 4],
        )
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(CONTENT_TYPE).and_then(|v| v.to_str().ok()),
            Some("application/pdf")
        );
        assert_eq!(
            response.headers().get(CONTENT_LENGTH).and_then(|v| v.to_str().ok()),
            Some("4")
        );
    }

    #[test]
    fn build_binary_response_falls_back_on_bad_content_type() {
        let response = build_binary_download_response(
            "bad\nvalue",
            "x.bin",
            DownloadDisposition::Inline,
            vec![],
        )
        .unwrap();
        assert_eq!(
            response.headers().get(CONTENT_TYPE).and_then(|v| v.to_str().ok()),
            Some(DEFAULT_DOWNLOAD_CONTENT_TYPE)
        );
    }

    #[test]
    fn audit_document_has_expected_shape() {
        let identifier = NonEmptyText::parse("file-7".to_owned()).unwrap();
        let account = Email::parse("clinician@example.com".to_owned()).unwrap();
        let document = assemble_drive_file_download_audit_document(&identifier, &account);
        assert!(document.document_identifier.contains("file-7"));
        assert_eq!(
            document.owning_account.as_deref(),
            Some("clinician@example.com")
        );
        assert_eq!(
            document.document_body.get("audit_kind").and_then(serde_json::Value::as_str),
            Some("drive_file_download")
        );
    }
}
