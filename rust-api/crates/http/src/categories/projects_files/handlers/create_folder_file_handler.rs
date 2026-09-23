use crate::categories::projects_files::collections::PROJECT_FILES_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::error::ApplicationError;
use alma_application::ports::document_collection::StoredDocument;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::NonEmptyText;
use alma_macros::route;
use axum::Json;
use axum::extract::{Path, State};
use serde_json::{Value, json};
use uuid::Uuid;

/// The canonical set of top-level folders every project is scaffolded with.
/// A folder file may only be created inside one of these folders.
const CANONICAL_FOLDER_SET: [&str; 5] = [
    "documents",
    "manuscripts",
    "figures",
    "datasets",
    "references",
];

/// Fallback MIME type used when the client neither declares one nor allows a
/// sensible inference from the display name.
const DEFAULT_FALLBACK_MIME_TYPE: &str = "application/octet-stream";

#[route(
    method = "POST",
    path = "/api/projects/:project_identifier/folders/:folder_name/files"
)]
pub async fn create_folder_file_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Path((_project_identifier, folder_name)): Path<(String, String)>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // Establish ownership from the authorized principal.
    let owning_account = extract_owning_account_from_authorized_request(&authorized_request);

    // Validate the containing folder taken from the request path.
    let validated_folder_name = validate_containing_folder_name(folder_name)?;
    assert_folder_name_is_within_canonical_folder_set(validated_folder_name.as_str())?;

    // Validate the file display name supplied in the body.
    let raw_display_name = extract_new_file_display_name(&submitted_body)?;
    let validated_display_name = validate_new_file_display_name(raw_display_name)?;

    // Resolve the effective MIME type: prefer the client-declared value, then
    // an inference from the file extension, then the fallback.
    let declared_mime_type = extract_declared_file_mime_type(&submitted_body);
    let effective_mime_type = if declared_mime_type == DEFAULT_FALLBACK_MIME_TYPE {
        infer_mime_type_from_display_name(validated_display_name.as_str())
    } else {
        declared_mime_type
    };

    // Extract the opaque file content payload (defaults to null when absent).
    let file_content = extract_new_file_content_field(&submitted_body);

    // Assemble the persisted document.
    let generated_identifier = generate_folder_file_identifier();
    let document_body = assemble_folder_file_document_body(
        &validated_display_name,
        &validated_folder_name,
        &effective_mime_type,
        file_content,
    );
    let document_to_insert = build_folder_file_stored_document(
        generated_identifier.clone(),
        owning_account,
        document_body,
    );

    // Persist and acknowledge.
    insert_folder_file_document(&application_state, document_to_insert).await?;

    Ok(Json(build_folder_file_creation_acknowledgement(
        &generated_identifier,
        validated_folder_name.as_str(),
    )))
}

/// (1) Extract the owning account (the authorized principal's email) as an owned
/// String suitable for storing on the document.
fn extract_owning_account_from_authorized_request(
    authorized_request: &HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> String {
    authorized_request
        .authorized_principal()
        .as_str()
        .to_string()
}

/// (2) Validate the folder name taken from the request path into a NonEmptyText.
fn validate_containing_folder_name(raw_folder_name: String) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(raw_folder_name)
        .map_err(|domain_error| HttpError::RequestBodyWasMalformed {
            explanation: format!("the folder name is not valid: {domain_error}"),
        })
}

/// (3) Reject folder names that are not part of the canonical scaffold. The
/// comparison is case-insensitive so `Documents` and `documents` are equivalent.
fn assert_folder_name_is_within_canonical_folder_set(
    candidate_folder_name: &str,
) -> Result<(), HttpError> {
    let normalized_candidate = candidate_folder_name.trim().to_ascii_lowercase();
    let is_canonical = CANONICAL_FOLDER_SET
        .iter()
        .any(|canonical| *canonical == normalized_candidate);
    if is_canonical {
        Ok(())
    } else {
        Err(HttpError::RequestedResourceWasNotFound {
            explanation: format!(
                "the folder '{candidate_folder_name}' is not one of the canonical project folders"
            ),
        })
    }
}

/// (4) Pull the `display_name` field out of the submitted body as a raw String.
fn extract_new_file_display_name(submitted_body: &Value) -> Result<String, HttpError> {
    submitted_body
        .get("display_name")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: "the request body must contain a string 'display_name' field".to_string(),
        })
}

/// (5) Validate the raw display name into a NonEmptyText.
fn validate_new_file_display_name(raw_display_name: String) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(raw_display_name)
        .map_err(|domain_error| HttpError::RequestBodyWasMalformed {
            explanation: format!("the file display name is not valid: {domain_error}"),
        })
}

/// (6) Extract the client-declared MIME type, falling back to a generic binary
/// type when it is absent or empty.
fn extract_declared_file_mime_type(submitted_body: &Value) -> String {
    submitted_body
        .get("mime_type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|declared| !declared.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| DEFAULT_FALLBACK_MIME_TYPE.to_string())
}

/// (7) Extract the opaque file content payload; defaults to JSON null when the
/// caller does not supply one.
fn extract_new_file_content_field(submitted_body: &Value) -> Value {
    submitted_body
        .get("content")
        .cloned()
        .unwrap_or(Value::Null)
}

/// (8) Generate a fresh, unique identifier for the folder file.
fn generate_folder_file_identifier() -> String {
    Uuid::new_v4().to_string()
}

/// (9) Build the JSON document body persisted for a folder file.
fn assemble_folder_file_document_body(
    display_name: &NonEmptyText,
    folder_name: &NonEmptyText,
    mime_type: &str,
    file_content: Value,
) -> Value {
    json!({
        "resource_kind": "folder_file",
        "display_name": display_name.as_str(),
        "containing_folder": folder_name.as_str(),
        "mime_type": mime_type,
        "content": file_content,
        "created_at": stamp_folder_file_created_timestamp(),
    })
}

/// (10) Wrap the assembled document body into a StoredDocument.
fn build_folder_file_stored_document(
    generated_identifier: String,
    owning_account: String,
    document_body: Value,
) -> StoredDocument {
    StoredDocument {
        document_identifier: generated_identifier,
        owning_account: Some(owning_account),
        document_body,
    }
}

/// (11) Persist the folder file document into the project files collection.
/// Any document collection failure is mapped explicitly to an HttpError.
fn insert_folder_file_document<'a, TransactionalUnitOfWork: UnitOfWork>(
    application_state: &'a ApplicationState<TransactionalUnitOfWork>,
    document_to_insert: StoredDocument,
) -> impl std::future::Future<Output = Result<(), HttpError>> + 'a {
    async move {
        application_state
            .document_collection
            .insert_document(PROJECT_FILES_COLLECTION_NAME, document_to_insert)
            .await
            .map_err(map_document_collection_failure_to_http_error)
    }
}

/// (12) Produce a creation timestamp. A monotonic seconds-since-epoch string is
/// used to avoid pulling in a datetime dependency while remaining sortable.
fn stamp_folder_file_created_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let elapsed_seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    elapsed_seconds.to_string()
}

/// (13) Infer a MIME type from the file's display name extension. Returns the
/// generic binary type when no known extension is present.
fn infer_mime_type_from_display_name(display_name: &str) -> String {
    let lowercased = display_name.to_ascii_lowercase();
    let extension = match lowercased.rfind('.') {
        Some(dot_index) if dot_index + 1 < lowercased.len() => &lowercased[dot_index + 1..],
        _ => return DEFAULT_FALLBACK_MIME_TYPE.to_string(),
    };
    let resolved = match extension {
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "html" | "htm" => "text/html",
        "doc" => "application/msword",
        "docx" => {
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        }
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "zip" => "application/zip",
        _ => DEFAULT_FALLBACK_MIME_TYPE,
    };
    resolved.to_string()
}

/// (14) Build the JSON acknowledgement returned to the client on success.
fn build_folder_file_creation_acknowledgement(
    generated_identifier: &str,
    folder_name: &str,
) -> Value {
    json!({
        "document_identifier": generated_identifier,
        "containing_folder": folder_name,
        "acknowledgement": "folder file created",
    })
}

/// (15) Map a document collection ApplicationError into the appropriate
/// HttpError. Not-found conditions become 404; everything else is an upstream
/// failure.
fn map_document_collection_failure_to_http_error(originating_error: ApplicationError) -> HttpError {
    match originating_error {
        ApplicationError::RequestedResourceCouldNotBeLocated
        | ApplicationError::RequestedProjectCouldNotBeLocated => {
            HttpError::RequestedResourceWasNotFound {
                explanation: originating_error.to_string(),
            }
        }
        ApplicationError::AuthorizationWasDenied => HttpError::AuthorizationWasDenied {
            explanation: originating_error.to_string(),
        },
        ApplicationError::DomainInvariantViolated(_) => HttpError::RequestBodyWasMalformed {
            explanation: originating_error.to_string(),
        },
        other_error => HttpError::UpstreamApplicationFailure {
            explanation: other_error.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_containing_folder_name_accepts_non_empty_input() {
        let result = validate_containing_folder_name("documents".to_string());
        assert!(result.is_ok());
        assert_eq!(result.unwrap().as_str(), "documents");
    }

    #[test]
    fn validate_containing_folder_name_rejects_empty_input() {
        let result = validate_containing_folder_name("   ".to_string());
        assert!(matches!(
            result,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn assert_folder_name_is_within_canonical_folder_set_accepts_canonical() {
        assert!(assert_folder_name_is_within_canonical_folder_set("documents").is_ok());
        // Case-insensitive.
        assert!(assert_folder_name_is_within_canonical_folder_set("Manuscripts").is_ok());
    }

    #[test]
    fn assert_folder_name_is_within_canonical_folder_set_rejects_unknown() {
        let result = assert_folder_name_is_within_canonical_folder_set("secret_stash");
        assert!(matches!(
            result,
            Err(HttpError::RequestedResourceWasNotFound { .. })
        ));
    }

    #[test]
    fn extract_new_file_display_name_reads_string_field() {
        let body = json!({ "display_name": "report.pdf" });
        assert_eq!(extract_new_file_display_name(&body).unwrap(), "report.pdf");
    }

    #[test]
    fn extract_new_file_display_name_rejects_missing_field() {
        let body = json!({ "unrelated": 1 });
        assert!(matches!(
            extract_new_file_display_name(&body),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn validate_new_file_display_name_accepts_good_and_rejects_empty() {
        assert!(validate_new_file_display_name("figure.png".to_string()).is_ok());
        assert!(matches!(
            validate_new_file_display_name("".to_string()),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn extract_declared_file_mime_type_prefers_declared_value() {
        let body = json!({ "mime_type": "application/pdf" });
        assert_eq!(extract_declared_file_mime_type(&body), "application/pdf");
    }

    #[test]
    fn extract_declared_file_mime_type_falls_back_when_absent_or_blank() {
        let absent = json!({});
        assert_eq!(
            extract_declared_file_mime_type(&absent),
            DEFAULT_FALLBACK_MIME_TYPE
        );
        let blank = json!({ "mime_type": "   " });
        assert_eq!(
            extract_declared_file_mime_type(&blank),
            DEFAULT_FALLBACK_MIME_TYPE
        );
    }

    #[test]
    fn extract_new_file_content_field_returns_value_or_null() {
        let with_content = json!({ "content": { "bytes": "abc" } });
        assert_eq!(
            extract_new_file_content_field(&with_content),
            json!({ "bytes": "abc" })
        );
        let without_content = json!({});
        assert_eq!(extract_new_file_content_field(&without_content), Value::Null);
    }

    #[test]
    fn generate_folder_file_identifier_produces_distinct_values() {
        let first = generate_folder_file_identifier();
        let second = generate_folder_file_identifier();
        assert_ne!(first, second);
        assert_eq!(first.len(), 36);
    }

    #[test]
    fn assemble_folder_file_document_body_contains_expected_fields() {
        let display_name = NonEmptyText::parse("notes.md".to_string()).unwrap();
        let folder_name = NonEmptyText::parse("documents".to_string()).unwrap();
        let body = assemble_folder_file_document_body(
            &display_name,
            &folder_name,
            "text/markdown",
            json!("hello"),
        );
        assert_eq!(body["resource_kind"], "folder_file");
        assert_eq!(body["display_name"], "notes.md");
        assert_eq!(body["containing_folder"], "documents");
        assert_eq!(body["mime_type"], "text/markdown");
        assert_eq!(body["content"], json!("hello"));
        assert!(body["created_at"].is_string());
    }

    #[test]
    fn build_folder_file_stored_document_sets_owner_and_body() {
        let document = build_folder_file_stored_document(
            "id-123".to_string(),
            "user@example.com".to_string(),
            json!({ "k": "v" }),
        );
        assert_eq!(document.document_identifier, "id-123");
        assert_eq!(document.owning_account, Some("user@example.com".to_string()));
        assert_eq!(document.document_body, json!({ "k": "v" }));
    }

    #[test]
    fn stamp_folder_file_created_timestamp_is_numeric_string() {
        let stamp = stamp_folder_file_created_timestamp();
        assert!(stamp.chars().all(|character| character.is_ascii_digit()));
        assert!(!stamp.is_empty());
    }

    #[test]
    fn infer_mime_type_from_display_name_recognizes_known_extensions() {
        assert_eq!(infer_mime_type_from_display_name("paper.pdf"), "application/pdf");
        assert_eq!(infer_mime_type_from_display_name("IMAGE.PNG"), "image/png");
        assert_eq!(infer_mime_type_from_display_name("data.json"), "application/json");
    }

    #[test]
    fn infer_mime_type_from_display_name_falls_back_for_unknown() {
        assert_eq!(
            infer_mime_type_from_display_name("archive.unknownext"),
            DEFAULT_FALLBACK_MIME_TYPE
        );
        assert_eq!(
            infer_mime_type_from_display_name("noextension"),
            DEFAULT_FALLBACK_MIME_TYPE
        );
        assert_eq!(
            infer_mime_type_from_display_name("trailingdot."),
            DEFAULT_FALLBACK_MIME_TYPE
        );
    }

    #[test]
    fn build_folder_file_creation_acknowledgement_reports_identifiers() {
        let acknowledgement = build_folder_file_creation_acknowledgement("id-9", "figures");
        assert_eq!(acknowledgement["document_identifier"], "id-9");
        assert_eq!(acknowledgement["containing_folder"], "figures");
        assert_eq!(acknowledgement["acknowledgement"], "folder file created");
    }

    #[test]
    fn map_document_collection_failure_to_http_error_maps_not_found() {
        let mapped = map_document_collection_failure_to_http_error(
            ApplicationError::RequestedResourceCouldNotBeLocated,
        );
        assert!(matches!(
            mapped,
            HttpError::RequestedResourceWasNotFound { .. }
        ));
    }

    #[test]
    fn map_document_collection_failure_to_http_error_maps_generic_to_upstream() {
        let mapped = map_document_collection_failure_to_http_error(
            ApplicationError::DocumentCollectionFailure {
                failure_description: "boom".to_string(),
            },
        );
        assert!(matches!(
            mapped,
            HttpError::UpstreamApplicationFailure { .. }
        ));
    }
}
