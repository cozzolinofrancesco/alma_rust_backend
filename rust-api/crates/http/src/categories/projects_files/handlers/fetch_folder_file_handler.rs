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
    path = "/api/projects/:project_identifier/folders/:folder_name/files/:file_identifier"
)]
pub async fn fetch_folder_file_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Path(path_parameters): Path<(String, String, String)>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let requesting_account = authorized_request.authorized_principal();

    let (_raw_project_identifier, raw_folder_name, raw_file_identifier) =
        destructure_folder_file_path_parameters(path_parameters);

    let validated_folder_name = validate_fetch_folder_name(raw_folder_name)?;
    let validated_file_identifier = validate_fetch_file_identifier(raw_file_identifier)?;

    let optionally_located_document =
        fetch_folder_file_document(&application_state, validated_file_identifier.as_str()).await?;

    // A located file is owner-scoped (RUST-IDOR-001): deny cross-tenant and
    // ownerless files before they are returned to the caller.
    if let Some(ref located_document) = optionally_located_document {
        assert_folder_file_is_owned_by_requester(located_document, requesting_account)?;
        assert_located_document_belongs_to_folder(located_document, validated_folder_name.as_str())?;
    }

    let display_name = match optionally_located_document {
        Some(ref located_document) => extract_folder_file_display_name_from_document(
            located_document,
            validated_file_identifier.as_str(),
        ),
        None => validated_file_identifier.as_str().to_string(),
    };

    let modified_timestamp = optionally_located_document
        .as_ref()
        .map(extract_folder_file_modified_timestamp)
        .unwrap_or_default();

    let content_string = resolve_folder_file_content_or_placeholder(optionally_located_document);
    let mime_type = infer_folder_file_mime_type_from_identifier(validated_file_identifier.as_str());

    let mut fetch_payload = build_folder_file_fetch_payload(content_string, &mime_type, &display_name);
    if let Value::Object(ref mut payload_map) = fetch_payload {
        payload_map.insert("modifiedAt".to_string(), Value::String(modified_timestamp));
    }

    Ok(Json(fetch_payload))
}

/// (1) Split the axum path tuple into its three named path segments.
fn destructure_folder_file_path_parameters(
    path_parameters: (String, String, String),
) -> (String, String, String) {
    let (project_identifier, folder_name, file_identifier) = path_parameters;
    (project_identifier, folder_name, file_identifier)
}

/// (2) Validate the folder name segment into a non-empty domain value.
fn validate_fetch_folder_name(raw_folder_name: String) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(raw_folder_name).map_err(|domain_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: format!("the folder name segment was invalid: {domain_error}"),
        }
    })
}

/// (3) Validate the file identifier segment into a non-empty domain value.
fn validate_fetch_file_identifier(
    raw_file_identifier: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(raw_file_identifier).map_err(|domain_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: format!("the file identifier segment was invalid: {domain_error}"),
        }
    })
}

/// (4) Fetch the folder file document from the document collection, mapping
/// any collection failure into an HTTP error.
fn fetch_folder_file_document<'a, TransactionalUnitOfWork: UnitOfWork>(
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

/// (5) Render a stored document body into a human-readable content string.
/// String bodies are unwrapped verbatim; other JSON is serialized.
fn render_document_body_as_content_string(document_body: Value) -> String {
    match document_body {
        Value::String(text_value) => text_value,
        Value::Object(ref object_map) => {
            if let Some(Value::String(inner_content)) = object_map.get("content") {
                inner_content.clone()
            } else {
                document_body.to_string()
            }
        }
        other_value => other_value.to_string(),
    }
}

/// (6) Build the placeholder agent definition returned when no document exists.
fn build_placeholder_agent_definition_body() -> Value {
    json!({
        "name": "Sample Agent",
        "description": "A coherent sample agent definition",
        "layers": [
            { "id": "layer-1", "role": "planner", "prompt": "Plan the task" },
            { "id": "layer-2", "role": "executor", "prompt": "Execute the plan" }
        ]
    })
}

/// (7) Resolve the content string from a located document or fall back to a
/// serialized placeholder agent definition.
fn resolve_folder_file_content_or_placeholder(
    optionally_located: Option<StoredDocument>,
) -> String {
    match optionally_located {
        Some(located_document) => {
            render_document_body_as_content_string(located_document.document_body)
        }
        None => render_document_body_as_content_string(build_placeholder_agent_definition_body()),
    }
}

/// Owner-scope guard (RUST-IDOR-001): a located folder file is only visible to
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

/// (8) Ensure a located document actually belongs to the requested folder.
/// When the document body carries a folder marker, it must match; otherwise
/// the document is accepted (legacy documents without a folder marker).
fn assert_located_document_belongs_to_folder(
    located_document: &StoredDocument,
    folder_name: &str,
) -> Result<(), HttpError> {
    if let Value::Object(ref body_map) = located_document.document_body {
        if let Some(Value::String(recorded_folder)) = body_map
            .get("folderName")
            .or_else(|| body_map.get("folder_name"))
        {
            if recorded_folder != folder_name {
                return Err(HttpError::RequestedResourceWasNotFound {
                    explanation: format!(
                        "the requested file does not belong to folder '{folder_name}'"
                    ),
                });
            }
        }
    }
    Ok(())
}

/// (9) Infer a MIME type from the file identifier's extension.
fn infer_folder_file_mime_type_from_identifier(file_identifier: &str) -> String {
    let lowered_identifier = file_identifier.to_ascii_lowercase();
    let inferred_mime_type = if lowered_identifier.ends_with(".json") {
        "application/json"
    } else if lowered_identifier.ends_with(".md") || lowered_identifier.ends_with(".markdown") {
        "text/markdown"
    } else if lowered_identifier.ends_with(".txt") {
        "text/plain"
    } else if lowered_identifier.ends_with(".html") || lowered_identifier.ends_with(".htm") {
        "text/html"
    } else if lowered_identifier.ends_with(".csv") {
        "text/csv"
    } else if lowered_identifier.ends_with(".pdf") {
        "application/pdf"
    } else {
        "application/json"
    };
    inferred_mime_type.to_string()
}

/// (10) Extract a display name from the document body, falling back to the
/// file identifier when no name field is present.
fn extract_folder_file_display_name_from_document(
    located_document: &StoredDocument,
    file_identifier: &str,
) -> String {
    if let Value::Object(ref body_map) = located_document.document_body {
        for candidate_key in ["displayName", "name", "title", "fileName"] {
            if let Some(Value::String(candidate_value)) = body_map.get(candidate_key) {
                if !candidate_value.trim().is_empty() {
                    return candidate_value.clone();
                }
            }
        }
    }
    file_identifier.to_string()
}

/// (11) Detect whether a content string parses as valid JSON.
fn detect_content_is_valid_json(content_string: &str) -> bool {
    serde_json::from_str::<Value>(content_string).is_ok()
}

/// (12) Extract a modified timestamp from the document body, defaulting to an
/// empty string when absent.
fn extract_folder_file_modified_timestamp(located_document: &StoredDocument) -> String {
    if let Value::Object(ref body_map) = located_document.document_body {
        for candidate_key in ["modifiedAt", "modified_at", "updatedAt", "updated_at"] {
            if let Some(Value::String(candidate_value)) = body_map.get(candidate_key) {
                if !candidate_value.trim().is_empty() {
                    return candidate_value.clone();
                }
            }
        }
    }
    String::new()
}

/// (13) Compute the character length of a content string (Unicode scalar count).
fn compute_content_character_length(content_string: &str) -> usize {
    content_string.chars().count()
}

/// (14) Build the JSON payload returned to the client for a fetched folder file.
fn build_folder_file_fetch_payload(
    content_string: String,
    mime_type: &str,
    display_name: &str,
) -> Value {
    let content_is_json = detect_content_is_valid_json(&content_string);
    let content_length = compute_content_character_length(&content_string);
    json!({
        "content": content_string,
        "mimeType": mime_type,
        "name": display_name,
        "isJson": content_is_json,
        "contentLength": content_length
    })
}

/// (15) Map a document-collection application error into the corresponding
/// HTTP error variant.
fn map_document_collection_failure_to_http_error(
    originating_error: ApplicationError,
) -> HttpError {
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

    fn stored_document_with_body(body: Value) -> StoredDocument {
        StoredDocument {
            document_identifier: "file-1".to_string(),
            owning_account: Some("owner@example.com".to_string()),
            document_body: body,
        }
    }

    #[test]
    fn destructure_folder_file_path_parameters_preserves_order() {
        let destructured = destructure_folder_file_path_parameters((
            "project-9".to_string(),
            "Reports".to_string(),
            "file-42".to_string(),
        ));
        assert_eq!(
            destructured,
            (
                "project-9".to_string(),
                "Reports".to_string(),
                "file-42".to_string()
            )
        );
    }

    #[test]
    fn validate_fetch_folder_name_accepts_non_empty() {
        let validated = validate_fetch_folder_name("Reports".to_string()).unwrap();
        assert_eq!(validated.as_str(), "Reports");
    }

    #[test]
    fn validate_fetch_folder_name_rejects_empty() {
        assert!(validate_fetch_folder_name("   ".to_string()).is_err());
    }

    #[test]
    fn validate_fetch_file_identifier_accepts_non_empty() {
        let validated = validate_fetch_file_identifier("file-42".to_string()).unwrap();
        assert_eq!(validated.as_str(), "file-42");
    }

    #[test]
    fn validate_fetch_file_identifier_rejects_empty() {
        assert!(validate_fetch_file_identifier(String::new()).is_err());
    }

    #[test]
    fn render_document_body_as_content_string_unwraps_string() {
        let rendered = render_document_body_as_content_string(Value::String("hello".to_string()));
        assert_eq!(rendered, "hello");
    }

    #[test]
    fn render_document_body_as_content_string_prefers_content_field() {
        let rendered =
            render_document_body_as_content_string(json!({ "content": "inner text" }));
        assert_eq!(rendered, "inner text");
    }

    #[test]
    fn render_document_body_as_content_string_serializes_other_json() {
        let rendered = render_document_body_as_content_string(json!({ "a": 1 }));
        assert!(rendered.contains("\"a\""));
        assert!(rendered.contains('1'));
    }

    #[test]
    fn build_placeholder_agent_definition_body_has_layers() {
        let placeholder = build_placeholder_agent_definition_body();
        assert_eq!(placeholder["name"], json!("Sample Agent"));
        assert_eq!(placeholder["layers"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn resolve_folder_file_content_or_placeholder_uses_document() {
        let content = resolve_folder_file_content_or_placeholder(Some(stored_document_with_body(
            Value::String("body text".to_string()),
        )));
        assert_eq!(content, "body text");
    }

    #[test]
    fn resolve_folder_file_content_or_placeholder_falls_back() {
        let content = resolve_folder_file_content_or_placeholder(None);
        assert!(content.contains("Sample Agent"));
    }

    #[test]
    fn owner_check_allows_owner_and_denies_stranger_or_ownerless() {
        let owner = Email::parse("owner@example.com".to_string()).unwrap();
        let owned = stored_document_with_body(json!({}));
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
    fn assert_located_document_belongs_to_folder_accepts_matching() {
        let located = stored_document_with_body(json!({ "folderName": "Reports" }));
        assert!(assert_located_document_belongs_to_folder(&located, "Reports").is_ok());
    }

    #[test]
    fn assert_located_document_belongs_to_folder_rejects_mismatch() {
        let located = stored_document_with_body(json!({ "folderName": "Drafts" }));
        assert!(assert_located_document_belongs_to_folder(&located, "Reports").is_err());
    }

    #[test]
    fn assert_located_document_belongs_to_folder_accepts_legacy_without_marker() {
        let located = stored_document_with_body(json!({ "content": "x" }));
        assert!(assert_located_document_belongs_to_folder(&located, "Reports").is_ok());
    }

    #[test]
    fn infer_folder_file_mime_type_recognizes_extensions() {
        assert_eq!(infer_folder_file_mime_type_from_identifier("a.json"), "application/json");
        assert_eq!(infer_folder_file_mime_type_from_identifier("a.MD"), "text/markdown");
        assert_eq!(infer_folder_file_mime_type_from_identifier("a.txt"), "text/plain");
        assert_eq!(infer_folder_file_mime_type_from_identifier("a.csv"), "text/csv");
        assert_eq!(infer_folder_file_mime_type_from_identifier("noext"), "application/json");
    }

    #[test]
    fn extract_folder_file_display_name_prefers_body_name() {
        let located = stored_document_with_body(json!({ "name": "My File" }));
        assert_eq!(
            extract_folder_file_display_name_from_document(&located, "file-1"),
            "My File"
        );
    }

    #[test]
    fn extract_folder_file_display_name_falls_back_to_identifier() {
        let located = stored_document_with_body(json!({ "unrelated": true }));
        assert_eq!(
            extract_folder_file_display_name_from_document(&located, "file-1"),
            "file-1"
        );
    }

    #[test]
    fn detect_content_is_valid_json_recognizes_json_and_non_json() {
        assert!(detect_content_is_valid_json("{\"a\":1}"));
        assert!(!detect_content_is_valid_json("not json {"));
    }

    #[test]
    fn extract_folder_file_modified_timestamp_reads_field() {
        let located = stored_document_with_body(json!({ "modifiedAt": "2026-07-07T00:00:00Z" }));
        assert_eq!(
            extract_folder_file_modified_timestamp(&located),
            "2026-07-07T00:00:00Z"
        );
    }

    #[test]
    fn extract_folder_file_modified_timestamp_defaults_empty() {
        let located = stored_document_with_body(json!({ "content": "x" }));
        assert_eq!(extract_folder_file_modified_timestamp(&located), "");
    }

    #[test]
    fn compute_content_character_length_counts_unicode_scalars() {
        assert_eq!(compute_content_character_length("abc"), 3);
        assert_eq!(compute_content_character_length("café"), 4);
        assert_eq!(compute_content_character_length(""), 0);
    }

    #[test]
    fn build_folder_file_fetch_payload_includes_metadata() {
        let payload =
            build_folder_file_fetch_payload("{\"a\":1}".to_string(), "application/json", "My File");
        assert_eq!(payload["content"], json!("{\"a\":1}"));
        assert_eq!(payload["mimeType"], json!("application/json"));
        assert_eq!(payload["name"], json!("My File"));
        assert_eq!(payload["isJson"], json!(true));
        assert_eq!(payload["contentLength"], json!(7));
    }

    #[test]
    fn map_document_collection_failure_maps_not_found() {
        let mapped = map_document_collection_failure_to_http_error(
            ApplicationError::RequestedResourceCouldNotBeLocated,
        );
        assert!(matches!(mapped, HttpError::RequestedResourceWasNotFound { .. }));
    }

    #[test]
    fn map_document_collection_failure_maps_authorization() {
        let mapped =
            map_document_collection_failure_to_http_error(ApplicationError::AuthorizationWasDenied);
        assert!(matches!(mapped, HttpError::AuthorizationWasDenied { .. }));
    }

    #[test]
    fn map_document_collection_failure_maps_generic_upstream() {
        let mapped = map_document_collection_failure_to_http_error(
            ApplicationError::DocumentCollectionFailure {
                failure_description: "boom".to_string(),
            },
        );
        assert!(matches!(mapped, HttpError::UpstreamApplicationFailure { .. }));
    }
}
