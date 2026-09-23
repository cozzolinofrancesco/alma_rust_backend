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

/// The default MIME type applied to a stored project file when the submitted
/// body does not declare one explicitly.
const DEFAULT_PROJECT_FILE_MIME_TYPE: &str = "application/octet-stream";

#[route(
    method = "POST",
    path = "/api/projects/:project_identifier/files/:file_identifier"
)]
pub async fn store_project_file_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Path(path_parameters): Path<(String, String)>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // (1) Destructure the two path segments into named identifiers.
    let (raw_project_identifier, raw_file_identifier) =
        destructure_store_project_file_path_parameters(path_parameters);

    // (2) Derive the owning account from the authenticated principal.
    let owning_account = extract_owning_account_from_authorized_request(&authorized_request);

    // (3)/(4) Validate the two identifiers as non-empty text.
    let validated_project_identifier = validate_store_project_identifier(raw_project_identifier)?;
    let validated_file_identifier = validate_store_file_identifier(raw_file_identifier)?;

    // (6) Resolve the MIME type declared on the payload (or fall back).
    let resolved_mime_type = extract_stored_file_mime_type(&submitted_body);

    // (7) Assemble the enriched document body with metadata folded in.
    let document_body = assemble_stored_project_file_body(
        submitted_body,
        validated_project_identifier.as_str(),
        &resolved_mime_type,
    );

    // (8) Build the persistence document.
    let document_to_persist = build_project_file_stored_document(
        validated_file_identifier.as_str().to_string(),
        owning_account,
        document_body,
    );

    // (11) Upsert: replace when present, otherwise insert.
    let was_replacement = upsert_project_file_document(&application_state, document_to_persist).await?;

    // (14) Build and return the acknowledgement envelope.
    Ok(Json(build_store_project_file_acknowledgement(
        validated_file_identifier.as_str(),
        was_replacement,
    )))
}

/// (1) Split the two-tuple of raw path segments into named owned strings.
///
/// The path layout is `/api/projects/:project_identifier/files/:file_identifier`,
/// so the first element is the project identifier and the second is the file
/// identifier.
fn destructure_store_project_file_path_parameters(
    path_parameters: (String, String),
) -> (String, String) {
    let (raw_project_identifier, raw_file_identifier) = path_parameters;
    (raw_project_identifier, raw_file_identifier)
}

/// (2) Read the authenticated principal's e-mail and return it as an owned
/// string suitable for recording ownership on the stored document.
fn extract_owning_account_from_authorized_request(
    authorized_request: &HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> String {
    authorized_request
        .authorized_principal()
        .as_str()
        .to_string()
}

/// (3) Validate the raw project identifier as non-empty text.
fn validate_store_project_identifier(
    raw_project_identifier: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(raw_project_identifier).map_err(|parse_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: format!("the project identifier was invalid: {parse_error}"),
        }
    })
}

/// (4) Validate the raw file identifier as non-empty text.
fn validate_store_file_identifier(raw_file_identifier: String) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(raw_file_identifier).map_err(|parse_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: format!("the file identifier was invalid: {parse_error}"),
        }
    })
}

/// (5) Pull an optional human-friendly display name from the submitted body.
///
/// A display name is only accepted when it is a JSON string containing at least
/// one non-whitespace character; anything else yields `None`.
fn extract_stored_file_display_name(submitted_body: &Value) -> Option<String> {
    submitted_body
        .get("display_name")
        .and_then(|candidate| candidate.as_str())
        .map(str::trim)
        .filter(|trimmed| !trimmed.is_empty())
        .map(str::to_string)
}

/// (6) Resolve the MIME type declared on the payload, defaulting when absent
/// or blank.
fn extract_stored_file_mime_type(submitted_body: &Value) -> String {
    submitted_body
        .get("mime_type")
        .and_then(|candidate| candidate.as_str())
        .map(str::trim)
        .filter(|trimmed| !trimmed.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| DEFAULT_PROJECT_FILE_MIME_TYPE.to_string())
}

/// (7) Fold server-computed metadata into the stored representation of the
/// project file.
///
/// The original client payload is preserved under `content`, while
/// server-derived fields (owning project, resolved MIME type, byte size,
/// stored timestamp, and — when present — the display name) are recorded
/// alongside it so downstream reads have a self-describing document.
fn assemble_stored_project_file_body(
    submitted_body: Value,
    project_identifier: &str,
    mime_type: &str,
) -> Value {
    let display_name = extract_stored_file_display_name(&submitted_body);
    let size_in_bytes = compute_stored_file_size_bytes(&submitted_body);
    let stored_at = stamp_project_file_stored_timestamp();

    let mut assembled = json!({
        "project_identifier": project_identifier,
        "mime_type": mime_type,
        "size_in_bytes": size_in_bytes,
        "stored_at": stored_at,
        "content": submitted_body,
    });

    if let Some(name) = display_name {
        if let Some(object) = assembled.as_object_mut() {
            object.insert("display_name".to_string(), Value::String(name));
        }
    }

    assembled
}

/// (8) Construct the `StoredDocument` that will be persisted.
fn build_project_file_stored_document(
    file_identifier: String,
    owning_account: String,
    document_body: Value,
) -> StoredDocument {
    StoredDocument {
        document_identifier: file_identifier,
        owning_account: Some(owning_account),
        document_body,
    }
}

/// (9) Attempt to replace an existing project-file document, returning whether
/// a matching document was found and replaced.
fn attempt_replace_project_file_document<'a, TransactionalUnitOfWork: UnitOfWork>(
    application_state: &'a ApplicationState<TransactionalUnitOfWork>,
    document_to_persist: StoredDocument,
) -> impl std::future::Future<Output = Result<bool, HttpError>> + 'a {
    async move {
        application_state
            .document_collection
            .replace_document(PROJECT_FILES_COLLECTION_NAME, document_to_persist)
            .await
            .map_err(map_document_collection_failure_to_http_error)
    }
}

/// (10) Insert a project-file document that is known to be absent.
fn insert_project_file_document_when_absent<'a, TransactionalUnitOfWork: UnitOfWork>(
    application_state: &'a ApplicationState<TransactionalUnitOfWork>,
    document_to_persist: StoredDocument,
) -> impl std::future::Future<Output = Result<(), HttpError>> + 'a {
    async move {
        application_state
            .document_collection
            .insert_document(PROJECT_FILES_COLLECTION_NAME, document_to_persist)
            .await
            .map_err(map_document_collection_failure_to_http_error)
    }
}

/// (11) Upsert the document: try to replace first, and fall back to inserting
/// when no existing document was found. Returns `true` when the operation was a
/// replacement, `false` when it was a fresh insert.
fn upsert_project_file_document<'a, TransactionalUnitOfWork: UnitOfWork>(
    application_state: &'a ApplicationState<TransactionalUnitOfWork>,
    document_to_persist: StoredDocument,
) -> impl std::future::Future<Output = Result<bool, HttpError>> + 'a {
    async move {
        let replacement_succeeded =
            attempt_replace_project_file_document(application_state, document_to_persist.clone())
                .await?;
        if replacement_succeeded {
            return Ok(true);
        }
        insert_project_file_document_when_absent(application_state, document_to_persist).await?;
        Ok(false)
    }
}

/// (12) Compute an approximate stored size, in bytes, for the file body by
/// serializing it to its compact JSON representation.
fn compute_stored_file_size_bytes(document_body: &Value) -> usize {
    serde_json::to_vec(document_body)
        .map(|serialized| serialized.len())
        .unwrap_or(0)
}

/// (13) Produce a stored-at timestamp string.
///
/// The HTTP crate deliberately avoids a time dependency, so this stamps a
/// monotonic-ish marker derived from the wall clock via the standard library.
/// It records the number of seconds since the Unix epoch, or `"unknown"` when
/// the clock is set before the epoch.
fn stamp_project_file_stored_timestamp() -> String {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(elapsed) => format!("{}", elapsed.as_secs()),
        Err(_) => "unknown".to_string(),
    }
}

/// (14) Build the JSON acknowledgement returned to the client.
fn build_store_project_file_acknowledgement(file_identifier: &str, was_replacement: bool) -> Value {
    let acknowledgement = if was_replacement {
        "project file replaced"
    } else {
        "project file stored"
    };
    json!({
        "document_identifier": file_identifier,
        "was_replacement": was_replacement,
        "acknowledgement": acknowledgement,
    })
}

/// (15) Translate a document-collection `ApplicationError` into the appropriate
/// `HttpError` for the response.
fn map_document_collection_failure_to_http_error(originating_error: ApplicationError) -> HttpError {
    match originating_error {
        ApplicationError::AuthorizationWasDenied => HttpError::AuthorizationWasDenied {
            explanation: "the principal is not authorized to store this project file".to_string(),
        },
        ApplicationError::RequestedResourceCouldNotBeLocated
        | ApplicationError::RequestedProjectCouldNotBeLocated => {
            HttpError::RequestedResourceWasNotFound {
                explanation: "the target project file could not be located".to_string(),
            }
        }
        ApplicationError::DomainInvariantViolated(domain_error) => {
            HttpError::RequestBodyWasMalformed {
                explanation: domain_error.to_string(),
            }
        }
        other_failure => HttpError::UpstreamApplicationFailure {
            explanation: other_failure.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destructure_path_parameters_preserves_order() {
        let (project, file) = destructure_store_project_file_path_parameters((
            "proj-1".to_string(),
            "file-9".to_string(),
        ));
        assert_eq!(project, "proj-1");
        assert_eq!(file, "file-9");
    }

    #[test]
    fn validate_project_identifier_accepts_non_empty() {
        let validated = validate_store_project_identifier("alpha".to_string()).unwrap();
        assert_eq!(validated.as_str(), "alpha");
    }

    #[test]
    fn validate_project_identifier_rejects_empty() {
        let outcome = validate_store_project_identifier(String::new());
        assert!(matches!(
            outcome,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn validate_file_identifier_accepts_non_empty() {
        let validated = validate_store_file_identifier("report.pdf".to_string()).unwrap();
        assert_eq!(validated.as_str(), "report.pdf");
    }

    #[test]
    fn validate_file_identifier_rejects_blank() {
        let outcome = validate_store_file_identifier("   ".to_string());
        assert!(matches!(
            outcome,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn extract_display_name_reads_present_string() {
        let body = json!({ "display_name": "  My Report  " });
        assert_eq!(
            extract_stored_file_display_name(&body),
            Some("My Report".to_string())
        );
    }

    #[test]
    fn extract_display_name_absent_or_blank_is_none() {
        assert_eq!(extract_stored_file_display_name(&json!({})), None);
        assert_eq!(
            extract_stored_file_display_name(&json!({ "display_name": "   " })),
            None
        );
        assert_eq!(
            extract_stored_file_display_name(&json!({ "display_name": 42 })),
            None
        );
    }

    #[test]
    fn extract_mime_type_reads_declared_value() {
        let body = json!({ "mime_type": "application/pdf" });
        assert_eq!(extract_stored_file_mime_type(&body), "application/pdf");
    }

    #[test]
    fn extract_mime_type_falls_back_when_absent_or_blank() {
        assert_eq!(
            extract_stored_file_mime_type(&json!({})),
            DEFAULT_PROJECT_FILE_MIME_TYPE
        );
        assert_eq!(
            extract_stored_file_mime_type(&json!({ "mime_type": "  " })),
            DEFAULT_PROJECT_FILE_MIME_TYPE
        );
    }

    #[test]
    fn assemble_body_folds_in_metadata_and_preserves_content() {
        let original = json!({ "display_name": "Doc", "payload": [1, 2, 3] });
        let assembled = assemble_stored_project_file_body(original.clone(), "proj-7", "text/plain");
        assert_eq!(assembled["project_identifier"], json!("proj-7"));
        assert_eq!(assembled["mime_type"], json!("text/plain"));
        assert_eq!(assembled["display_name"], json!("Doc"));
        assert_eq!(assembled["content"], original);
        assert!(assembled["size_in_bytes"].as_u64().is_some());
        assert!(assembled["stored_at"].is_string());
    }

    #[test]
    fn assemble_body_omits_display_name_when_absent() {
        let original = json!({ "payload": "x" });
        let assembled = assemble_stored_project_file_body(original, "p", "m");
        assert!(assembled.get("display_name").is_none());
    }

    #[test]
    fn build_stored_document_sets_expected_fields() {
        let document = build_project_file_stored_document(
            "file-1".to_string(),
            "user@example.com".to_string(),
            json!({ "a": 1 }),
        );
        assert_eq!(document.document_identifier, "file-1");
        assert_eq!(document.owning_account, Some("user@example.com".to_string()));
        assert_eq!(document.document_body, json!({ "a": 1 }));
    }

    #[test]
    fn compute_size_matches_compact_serialization() {
        let body = json!({ "k": "v" });
        let expected = serde_json::to_vec(&body).unwrap().len();
        assert_eq!(compute_stored_file_size_bytes(&body), expected);
        assert!(compute_stored_file_size_bytes(&body) > 0);
    }

    #[test]
    fn stamp_timestamp_is_non_empty() {
        let stamped = stamp_project_file_stored_timestamp();
        assert!(!stamped.is_empty());
    }

    #[test]
    fn acknowledgement_reflects_replacement_flag() {
        let replaced = build_store_project_file_acknowledgement("f1", true);
        assert_eq!(replaced["was_replacement"], json!(true));
        assert_eq!(replaced["acknowledgement"], json!("project file replaced"));
        assert_eq!(replaced["document_identifier"], json!("f1"));

        let inserted = build_store_project_file_acknowledgement("f2", false);
        assert_eq!(inserted["was_replacement"], json!(false));
        assert_eq!(inserted["acknowledgement"], json!("project file stored"));
    }

    #[test]
    fn map_failure_authorization_denied() {
        let mapped = map_document_collection_failure_to_http_error(
            ApplicationError::AuthorizationWasDenied,
        );
        assert!(matches!(mapped, HttpError::AuthorizationWasDenied { .. }));
    }

    #[test]
    fn map_failure_not_found() {
        let mapped = map_document_collection_failure_to_http_error(
            ApplicationError::RequestedResourceCouldNotBeLocated,
        );
        assert!(matches!(
            mapped,
            HttpError::RequestedResourceWasNotFound { .. }
        ));
    }

    #[test]
    fn map_failure_generic_is_upstream() {
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
