use crate::categories::projects_files::collections::PROJECT_FILES_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::error::ApplicationError;
use alma_application::ports::document_collection::StoredDocument;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::{Email, NonEmptyText};
use alma_macros::route;
use axum::Json;
use axum::extract::{Path, State};
use serde_json::{Value, json};

#[route(
    method = "GET",
    path = "/api/projects/:project_identifier/files/:file_identifier"
)]
pub async fn fetch_project_file_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Path(path_parameters): Path<(String, String)>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let requesting_account = authorized_request.authorized_principal();

    // Break the two-tuple produced by the router into named parts.
    let (raw_project_identifier, raw_file_identifier) =
        destructure_project_file_path_parameters(path_parameters);

    // Validate both identifiers before touching persistence.
    let validated_project_identifier = validate_fetch_project_identifier(raw_project_identifier)?;
    let validated_file_identifier = validate_fetch_project_file_identifier(raw_file_identifier)?;

    // Load the document (if present) from the document collection.
    let optionally_located_document =
        fetch_project_file_document(&application_state, validated_file_identifier.as_str()).await?;

    // A located file is owner-scoped: it must belong to the caller (RUST-IDOR-001)
    // and to the addressed project. A cross-tenant or ownerless file is denied.
    if let Some(located_document) = optionally_located_document.as_ref() {
        assert_project_file_is_owned_by_requester(located_document, requesting_account)?;
        assert_located_file_belongs_to_project(
            located_document,
            validated_project_identifier.as_str(),
        )?;
    }

    // Derive presentation metadata from whatever we managed to locate.
    let mime_type = infer_project_file_mime_type_from_identifier(validated_file_identifier.as_str());
    let display_name = optionally_located_document
        .as_ref()
        .map(|located_document| {
            extract_project_file_display_name_from_document(
                located_document,
                validated_file_identifier.as_str(),
            )
        })
        .unwrap_or_else(|| validated_file_identifier.as_str().to_string());

    let size_bytes = optionally_located_document
        .as_ref()
        .map(extract_project_file_size_bytes)
        .unwrap_or(0);
    let modified_timestamp = optionally_located_document
        .as_ref()
        .map(extract_project_file_modified_timestamp)
        .unwrap_or_else(|| "unknown".to_string());

    // Resolve the textual content, falling back to a placeholder body.
    let content_string = resolve_project_file_content_or_placeholder(optionally_located_document);
    let content_is_binary = detect_project_file_content_is_binary(&content_string);

    // Assemble the response payload with the enrichment metadata.
    let mut fetch_payload =
        build_project_file_fetch_payload(content_string, &mime_type, &display_name);
    if let Value::Object(payload_object) = &mut fetch_payload {
        payload_object.insert("sizeBytes".to_string(), json!(size_bytes));
        payload_object.insert("modifiedAt".to_string(), json!(modified_timestamp));
        payload_object.insert("isBinary".to_string(), json!(content_is_binary));
        payload_object.insert("name".to_string(), json!(display_name));
    }

    Ok(Json(fetch_payload))
}

/// 1. Split the router-provided path tuple into project and file identifiers.
fn destructure_project_file_path_parameters(
    path_parameters: (String, String),
) -> (String, String) {
    let (project_identifier, file_identifier) = path_parameters;
    (project_identifier, file_identifier)
}

/// 2. Validate the raw project identifier into a `NonEmptyText`.
fn validate_fetch_project_identifier(
    raw_project_identifier: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(raw_project_identifier).map_err(|domain_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: format!("project identifier was invalid: {domain_error}"),
        }
    })
}

/// 3. Validate the raw file identifier into a `NonEmptyText`.
fn validate_fetch_project_file_identifier(
    raw_file_identifier: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(raw_file_identifier).map_err(|domain_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: format!("file identifier was invalid: {domain_error}"),
        }
    })
}

/// 4. Fetch the stored document for the given file identifier.
fn fetch_project_file_document<'a, TransactionalUnitOfWork: UnitOfWork>(
    application_state: &'a ApplicationState<TransactionalUnitOfWork>,
    file_identifier: &'a str,
) -> impl std::future::Future<Output = Result<Option<StoredDocument>, HttpError>> + 'a {
    async move {
        application_state
            .document_collection
            .fetch_document(PROJECT_FILES_COLLECTION_NAME, file_identifier)
            .await
            .map_err(map_document_collection_failure_to_http_error)
    }
}

/// 5. Render a stored document body into its textual content representation.
fn render_project_file_body_as_content_string(document_body: Value) -> String {
    match document_body {
        Value::String(text_value) => text_value,
        Value::Object(object_value) => {
            // Prefer an explicit `content` field when present.
            if let Some(Value::String(nested_content)) = object_value.get("content") {
                nested_content.clone()
            } else {
                Value::Object(object_value).to_string()
            }
        }
        other_value => other_value.to_string(),
    }
}

/// 6. Build the placeholder body used when no file document exists.
fn build_placeholder_project_file_body() -> Value {
    json!({
        "name": "Sample Agent",
        "description": "A coherent sample agent definition",
        "layers": [
            { "id": "layer-1", "role": "planner", "prompt": "Plan the task" },
            { "id": "layer-2", "role": "executor", "prompt": "Execute the plan" }
        ]
    })
}

/// 7. Resolve the content string, substituting a placeholder when absent.
fn resolve_project_file_content_or_placeholder(
    optionally_located: Option<StoredDocument>,
) -> String {
    match optionally_located {
        Some(located_document) => {
            render_project_file_body_as_content_string(located_document.document_body)
        }
        None => render_project_file_body_as_content_string(build_placeholder_project_file_body()),
    }
}

/// 8. Ensure a located document belongs to the addressed project.
fn assert_located_file_belongs_to_project(
    located_document: &StoredDocument,
    project_identifier: &str,
) -> Result<(), HttpError> {
    let stored_project = located_document
        .document_body
        .get("projectIdentifier")
        .and_then(Value::as_str);
    match stored_project {
        // No association recorded → treat as accessible (legacy documents).
        None => Ok(()),
        Some(recorded_project_identifier) => {
            if recorded_project_identifier == project_identifier {
                Ok(())
            } else {
                Err(HttpError::RequestedResourceWasNotFound {
                    explanation: format!(
                        "file does not belong to project '{project_identifier}'"
                    ),
                })
            }
        }
    }
}

/// Owner-scope guard (RUST-IDOR-001): a located project file is only visible to
/// the principal recorded as its owner. A file owned by a different account — or
/// with no recorded owner — is treated as inaccessible rather than world-readable.
fn assert_project_file_is_owned_by_requester(
    located_document: &StoredDocument,
    requesting_account: &Email,
) -> Result<(), HttpError> {
    match located_document.owning_account.as_deref() {
        Some(owner) if owner == requesting_account.as_str() => Ok(()),
        _ => Err(HttpError::AuthorizationWasDenied {
            explanation: "the authenticated principal does not own this project file".to_string(),
        }),
    }
}

/// 9. Infer a MIME type from the file identifier's extension.
fn infer_project_file_mime_type_from_identifier(file_identifier: &str) -> String {
    let lowered = file_identifier.to_ascii_lowercase();
    let extension = lowered.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");
    match extension {
        "json" => "application/json",
        "md" | "markdown" => "text/markdown",
        "txt" => "text/plain",
        "html" | "htm" => "text/html",
        "csv" => "text/csv",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        _ => "application/json",
    }
    .to_string()
}

/// 10. Extract a display name from the document, defaulting to the identifier.
fn extract_project_file_display_name_from_document(
    located_document: &StoredDocument,
    file_identifier: &str,
) -> String {
    located_document
        .document_body
        .get("name")
        .and_then(Value::as_str)
        .filter(|candidate| !candidate.trim().is_empty())
        .map(|candidate| candidate.to_string())
        .unwrap_or_else(|| file_identifier.to_string())
}

/// 11. Estimate the file size in bytes from its rendered content.
fn extract_project_file_size_bytes(located_document: &StoredDocument) -> usize {
    if let Some(recorded_size) = located_document
        .document_body
        .get("sizeBytes")
        .and_then(Value::as_u64)
    {
        return recorded_size as usize;
    }
    let rendered = render_project_file_body_as_content_string(located_document.document_body.clone());
    rendered.len()
}

/// 12. Extract the last-modified timestamp, defaulting to a sentinel value.
fn extract_project_file_modified_timestamp(located_document: &StoredDocument) -> String {
    located_document
        .document_body
        .get("modifiedAt")
        .and_then(Value::as_str)
        .filter(|candidate| !candidate.trim().is_empty())
        .map(|candidate| candidate.to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

/// 13. Heuristically decide whether the content should be treated as binary.
fn detect_project_file_content_is_binary(content_string: &str) -> bool {
    content_string
        .chars()
        .any(|character| character == '\u{0}' || (character.is_control() && character != '\n' && character != '\r' && character != '\t'))
}

/// 14. Build the JSON response payload for a fetched project file.
fn build_project_file_fetch_payload(
    content_string: String,
    mime_type: &str,
    display_name: &str,
) -> Value {
    json!({
        "content": content_string,
        "mimeType": mime_type,
        "name": display_name
    })
}

/// 15. Map a document-collection application error to an HTTP error.
fn map_document_collection_failure_to_http_error(
    originating_error: ApplicationError,
) -> HttpError {
    match originating_error {
        ApplicationError::RequestedResourceCouldNotBeLocated
        | ApplicationError::RequestedProjectCouldNotBeLocated => {
            HttpError::RequestedResourceWasNotFound {
                explanation: "the requested project file could not be located".to_string(),
            }
        }
        ApplicationError::AuthorizationWasDenied => HttpError::AuthorizationWasDenied {
            explanation: "not authorized to access this project file".to_string(),
        },
        ApplicationError::DomainInvariantViolated(domain_error) => {
            HttpError::RequestBodyWasMalformed {
                explanation: domain_error.to_string(),
            }
        }
        other_error => HttpError::UpstreamApplicationFailure {
            explanation: other_error.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored_document_with_body(body: Value) -> StoredDocument {
        StoredDocument {
            document_identifier: "file-1".to_string(),
            owning_account: Some("owner@example.com".to_string()),
            document_body: body,
        }
    }

    #[test]
    fn destructures_path_parameters_into_named_parts() {
        let (project, file) =
            destructure_project_file_path_parameters(("proj".to_string(), "file".to_string()));
        assert_eq!(project, "proj");
        assert_eq!(file, "file");
    }

    #[test]
    fn validates_good_project_identifier() {
        let validated = validate_fetch_project_identifier("project-123".to_string());
        assert!(validated.is_ok());
        assert_eq!(validated.unwrap().as_str(), "project-123");
    }

    #[test]
    fn rejects_empty_project_identifier() {
        let validated = validate_fetch_project_identifier("   ".to_string());
        assert!(validated.is_err());
    }

    #[test]
    fn validates_good_file_identifier() {
        let validated = validate_fetch_project_file_identifier("notes.md".to_string());
        assert!(validated.is_ok());
        assert_eq!(validated.unwrap().as_str(), "notes.md");
    }

    #[test]
    fn rejects_empty_file_identifier() {
        let validated = validate_fetch_project_file_identifier(String::new());
        assert!(validated.is_err());
    }

    #[test]
    fn renders_string_body_directly() {
        let rendered = render_project_file_body_as_content_string(json!("hello world"));
        assert_eq!(rendered, "hello world");
    }

    #[test]
    fn renders_object_body_with_content_field() {
        let rendered =
            render_project_file_body_as_content_string(json!({ "content": "inner text" }));
        assert_eq!(rendered, "inner text");
    }

    #[test]
    fn renders_object_body_without_content_field_as_json() {
        let rendered = render_project_file_body_as_content_string(json!({ "key": "value" }));
        assert!(rendered.contains("\"key\""));
        assert!(rendered.contains("\"value\""));
    }

    #[test]
    fn placeholder_body_contains_expected_shape() {
        let placeholder = build_placeholder_project_file_body();
        assert_eq!(placeholder.get("name").and_then(Value::as_str), Some("Sample Agent"));
        assert!(placeholder.get("layers").and_then(Value::as_array).is_some());
    }

    #[test]
    fn resolves_content_from_present_document() {
        let document = stored_document_with_body(json!("stored content"));
        let resolved = resolve_project_file_content_or_placeholder(Some(document));
        assert_eq!(resolved, "stored content");
    }

    #[test]
    fn resolves_placeholder_when_document_absent() {
        let resolved = resolve_project_file_content_or_placeholder(None);
        assert!(resolved.contains("Sample Agent"));
    }

    #[test]
    fn owner_check_allows_owner_and_denies_stranger_or_ownerless() {
        let owner = Email::parse("owner@example.com".to_string()).unwrap();
        let owned = stored_document_with_body(json!({}));
        assert!(assert_project_file_is_owned_by_requester(&owned, &owner).is_ok());

        let stranger = Email::parse("intruder@example.com".to_string()).unwrap();
        assert!(matches!(
            assert_project_file_is_owned_by_requester(&owned, &stranger),
            Err(HttpError::AuthorizationWasDenied { .. })
        ));

        let ownerless = StoredDocument {
            document_identifier: "file-1".to_string(),
            owning_account: None,
            document_body: json!({}),
        };
        assert!(matches!(
            assert_project_file_is_owned_by_requester(&ownerless, &owner),
            Err(HttpError::AuthorizationWasDenied { .. })
        ));
    }

    #[test]
    fn accepts_file_with_matching_project() {
        let document = stored_document_with_body(json!({ "projectIdentifier": "proj-9" }));
        let result = assert_located_file_belongs_to_project(&document, "proj-9");
        assert!(result.is_ok());
    }

    #[test]
    fn rejects_file_with_mismatched_project() {
        let document = stored_document_with_body(json!({ "projectIdentifier": "other" }));
        let result = assert_located_file_belongs_to_project(&document, "proj-9");
        assert!(matches!(
            result,
            Err(HttpError::RequestedResourceWasNotFound { .. })
        ));
    }

    #[test]
    fn accepts_legacy_file_without_project_association() {
        let document = stored_document_with_body(json!({ "content": "legacy" }));
        let result = assert_located_file_belongs_to_project(&document, "proj-9");
        assert!(result.is_ok());
    }

    #[test]
    fn infers_json_mime_by_default() {
        assert_eq!(
            infer_project_file_mime_type_from_identifier("no-extension"),
            "application/json"
        );
    }

    #[test]
    fn infers_markdown_mime() {
        assert_eq!(
            infer_project_file_mime_type_from_identifier("README.MD"),
            "text/markdown"
        );
    }

    #[test]
    fn infers_plain_text_mime() {
        assert_eq!(
            infer_project_file_mime_type_from_identifier("notes.txt"),
            "text/plain"
        );
    }

    #[test]
    fn extracts_display_name_from_document() {
        let document = stored_document_with_body(json!({ "name": "My File" }));
        let display = extract_project_file_display_name_from_document(&document, "fallback");
        assert_eq!(display, "My File");
    }

    #[test]
    fn falls_back_to_identifier_for_display_name() {
        let document = stored_document_with_body(json!({ "content": "x" }));
        let display = extract_project_file_display_name_from_document(&document, "fallback.txt");
        assert_eq!(display, "fallback.txt");
    }

    #[test]
    fn extracts_recorded_size_bytes() {
        let document = stored_document_with_body(json!({ "sizeBytes": 42 }));
        assert_eq!(extract_project_file_size_bytes(&document), 42);
    }

    #[test]
    fn computes_size_bytes_from_content_when_unrecorded() {
        let document = stored_document_with_body(json!("abcde"));
        assert_eq!(extract_project_file_size_bytes(&document), 5);
    }

    #[test]
    fn extracts_recorded_modified_timestamp() {
        let document = stored_document_with_body(json!({ "modifiedAt": "2026-01-01T00:00:00Z" }));
        assert_eq!(
            extract_project_file_modified_timestamp(&document),
            "2026-01-01T00:00:00Z"
        );
    }

    #[test]
    fn defaults_modified_timestamp_when_absent() {
        let document = stored_document_with_body(json!({ "content": "x" }));
        assert_eq!(extract_project_file_modified_timestamp(&document), "unknown");
    }

    #[test]
    fn detects_plain_text_as_non_binary() {
        assert!(!detect_project_file_content_is_binary("hello\nworld\t!"));
    }

    #[test]
    fn detects_null_byte_as_binary() {
        assert!(detect_project_file_content_is_binary("abc\u{0}def"));
    }

    #[test]
    fn builds_fetch_payload_with_all_fields() {
        let payload = build_project_file_fetch_payload("body".to_string(), "text/plain", "name.txt");
        assert_eq!(payload.get("content").and_then(Value::as_str), Some("body"));
        assert_eq!(
            payload.get("mimeType").and_then(Value::as_str),
            Some("text/plain")
        );
        assert_eq!(payload.get("name").and_then(Value::as_str), Some("name.txt"));
    }

    #[test]
    fn maps_not_found_application_error() {
        let mapped = map_document_collection_failure_to_http_error(
            ApplicationError::RequestedResourceCouldNotBeLocated,
        );
        assert!(matches!(
            mapped,
            HttpError::RequestedResourceWasNotFound { .. }
        ));
    }

    #[test]
    fn maps_generic_failure_to_upstream_error() {
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
