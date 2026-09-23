use crate::categories::projects_files::collections::SAVED_PROJECTS_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::error::ApplicationError;
use alma_application::ports::document_collection::StoredDocument;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_macros::route;
use axum::Json;
use axum::extract::{Query, State};
use serde_json::{Value, json};
use std::collections::HashMap;

/// The schema version this handler emits after any migration has run.
const CURRENT_PROJECT_SCHEMA_VERSION: &str = "2";

/// The schema version assumed when a stored document declares none.
const LEGACY_PROJECT_SCHEMA_VERSION: &str = "1";

/// The upper bound on how long a project identifier may be. Identifiers are
/// opaque handles (typically UUIDs) so anything substantially longer than a
/// UUID is treated as malformed rather than merely "not found".
const MAXIMUM_PROJECT_IDENTIFIER_LENGTH: usize = 128;

#[route(method = "GET", path = "/api/load-project")]
pub async fn load_project_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Query(query_parameters): Query<HashMap<String, String>>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let owning_account = extract_owning_account_from_authorized_request(&authorized_request);

    let requested_identifier = extract_requested_identifier_from_query(&query_parameters)?;
    validate_load_project_identifier(&requested_identifier)?;

    let optionally_located_document =
        fetch_saved_project_document(&application_state, &requested_identifier).await?;
    let located_document = require_located_project_document(optionally_located_document)?;

    assert_account_may_access_project(&located_document, &owning_account)?;
    let requester_is_owner = account_is_owner_of_project(&located_document, &owning_account);

    let detected_schema_version = extract_project_schema_version(&located_document);
    let project_body = extract_project_body_for_response(located_document);
    let migrated_project_body =
        migrate_project_body_to_current_schema(project_body, &detected_schema_version);
    let annotated_project_body =
        augment_project_body_with_access_flags(migrated_project_body, &owning_account, requester_is_owner);

    let loaded_project_payload = build_loaded_project_payload(annotated_project_body);
    Ok(Json(loaded_project_payload))
}

/// Derive the account that owns/loads the project from the authorized principal.
/// The principal's email address is the canonical account key throughout the
/// projects_files category.
fn extract_owning_account_from_authorized_request(
    authorized_request: &HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> String {
    authorized_request.authorized_principal().as_str().to_string()
}

/// Pull the mandatory `identifier` query parameter, trimming incidental
/// whitespace. An absent or blank identifier is a malformed request.
fn extract_requested_identifier_from_query(
    query_parameters: &HashMap<String, String>,
) -> Result<String, HttpError> {
    let raw_identifier =
        query_parameters
            .get("identifier")
            .ok_or_else(|| HttpError::RequestBodyWasMalformed {
                explanation: String::from("the 'identifier' query parameter is required"),
            })?;
    let trimmed_identifier = raw_identifier.trim();
    if trimmed_identifier.is_empty() {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from("the 'identifier' query parameter must not be blank"),
        });
    }
    Ok(trimmed_identifier.to_string())
}

/// Guard the identifier against obviously invalid shapes before it reaches the
/// document collection: it must be non-empty, within the length bound, and free
/// of characters that could confuse a downstream collection lookup.
fn validate_load_project_identifier(raw_identifier: &str) -> Result<(), HttpError> {
    if raw_identifier.is_empty() {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from("the project identifier must not be empty"),
        });
    }
    if raw_identifier.len() > MAXIMUM_PROJECT_IDENTIFIER_LENGTH {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "the project identifier must be at most {MAXIMUM_PROJECT_IDENTIFIER_LENGTH} characters"
            ),
        });
    }
    let identifier_is_well_formed = raw_identifier
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_');
    if !identifier_is_well_formed {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from(
                "the project identifier may only contain letters, digits, hyphens and underscores",
            ),
        });
    }
    Ok(())
}

/// Fetch the stored project document from the saved-projects collection,
/// translating any port failure into the appropriate HTTP error.
fn fetch_saved_project_document<'a, TransactionalUnitOfWork: UnitOfWork>(
    application_state: &'a ApplicationState<TransactionalUnitOfWork>,
    requested_identifier: &'a str,
) -> impl std::future::Future<Output = Result<Option<StoredDocument>, HttpError>> + 'a {
    async move {
        application_state
            .document_collection
            .fetch_document(SAVED_PROJECTS_COLLECTION_NAME, requested_identifier)
            .await
            .map_err(map_document_collection_failure_to_http_error)
    }
}

/// Turn an optional lookup result into a concrete document, mapping absence to a
/// 404-style error.
fn require_located_project_document(
    optionally_located: Option<StoredDocument>,
) -> Result<StoredDocument, HttpError> {
    optionally_located.ok_or_else(|| HttpError::RequestedResourceWasNotFound {
        explanation: String::from("no saved project exists under the supplied identifier"),
    })
}

/// Enforce access control: an account may load a project only when it owns the
/// project or is listed among its collaborators.
fn assert_account_may_access_project(
    located_document: &StoredDocument,
    owning_account: &str,
) -> Result<(), HttpError> {
    if account_is_owner_of_project(located_document, owning_account)
        || account_is_collaborator_on_project(located_document, owning_account)
    {
        return Ok(());
    }
    Err(HttpError::AuthorizationWasDenied {
        explanation: String::from(
            "the authenticated account is not permitted to load this project",
        ),
    })
}

/// Determine whether the account owns the project. Ownership is recorded in the
/// document's `owning_account` field; some legacy documents instead carry the
/// owner inside the body under `owner`.
fn account_is_owner_of_project(located_document: &StoredDocument, owning_account: &str) -> bool {
    if let Some(recorded_owner) = located_document.owning_account.as_deref() {
        if recorded_owner == owning_account {
            return true;
        }
    }
    located_document
        .document_body
        .get("owner")
        .and_then(Value::as_str)
        .map(|body_owner| body_owner == owning_account)
        .unwrap_or(false)
}

/// Determine whether the account appears in the project's collaborators list.
/// Collaborators are stored as an array of account strings under
/// `collaborators` in the document body.
fn account_is_collaborator_on_project(
    located_document: &StoredDocument,
    owning_account: &str,
) -> bool {
    located_document
        .document_body
        .get("collaborators")
        .and_then(Value::as_array)
        .map(|collaborator_entries| {
            collaborator_entries
                .iter()
                .filter_map(Value::as_str)
                .any(|collaborator| collaborator == owning_account)
        })
        .unwrap_or(false)
}

/// Consume the located document and yield the body destined for the response.
fn extract_project_body_for_response(located_document: StoredDocument) -> Value {
    located_document.document_body
}

/// Attach per-request access metadata to the project body so the client knows
/// whether the current viewer owns the project and under which account it was
/// loaded. Non-object bodies are wrapped defensively rather than mutated.
fn augment_project_body_with_access_flags(
    project_body: Value,
    owning_account: &str,
    is_owner: bool,
) -> Value {
    match project_body {
        Value::Object(mut project_object) => {
            project_object.insert(
                String::from("loaded_by_account"),
                Value::String(owning_account.to_string()),
            );
            project_object.insert(String::from("viewer_is_owner"), Value::Bool(is_owner));
            Value::Object(project_object)
        }
        other_body => json!({
            "loaded_by_account": owning_account,
            "viewer_is_owner": is_owner,
            "project": other_body,
        }),
    }
}

/// Read the schema version declared inside the project body, defaulting to the
/// legacy version when the field is missing or not a string/number.
fn extract_project_schema_version(located_document: &StoredDocument) -> String {
    match located_document.document_body.get("schema_version") {
        Some(Value::String(declared_version)) if !declared_version.trim().is_empty() => {
            declared_version.trim().to_string()
        }
        Some(Value::Number(declared_number)) => declared_number.to_string(),
        _ => LEGACY_PROJECT_SCHEMA_VERSION.to_string(),
    }
}

/// Bring a project body up to the current schema version. The single supported
/// migration lifts legacy (v1) documents by renaming the historical `nodes`
/// field to `canvas_nodes` and stamping the current version. Documents already
/// at the current version are returned unchanged.
fn migrate_project_body_to_current_schema(
    project_body: Value,
    detected_schema_version: &str,
) -> Value {
    if detected_schema_version == CURRENT_PROJECT_SCHEMA_VERSION {
        return stamp_schema_version(project_body);
    }
    match project_body {
        Value::Object(mut project_object) => {
            if let Some(legacy_nodes) = project_object.remove("nodes") {
                project_object
                    .entry(String::from("canvas_nodes"))
                    .or_insert(legacy_nodes);
            }
            project_object.insert(
                String::from("schema_version"),
                Value::String(CURRENT_PROJECT_SCHEMA_VERSION.to_string()),
            );
            Value::Object(project_object)
        }
        other_body => other_body,
    }
}

/// Ensure an object body carries the current schema version without otherwise
/// altering it. Used on the no-migration path so the response is always
/// self-describing.
fn stamp_schema_version(project_body: Value) -> Value {
    match project_body {
        Value::Object(mut project_object) => {
            project_object.insert(
                String::from("schema_version"),
                Value::String(CURRENT_PROJECT_SCHEMA_VERSION.to_string()),
            );
            Value::Object(project_object)
        }
        other_body => other_body,
    }
}

/// Produce a monotonic-ish timestamp string used to record when the project was
/// last opened. This is derived from the wall clock in RFC-3339-like seconds
/// resolution; it is intentionally coarse and free of external dependencies.
fn stamp_project_last_opened_timestamp() -> String {
    let seconds_since_epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    format!("{seconds_since_epoch}")
}

/// Assemble the final response envelope wrapping the migrated, access-annotated
/// project body together with load metadata.
fn build_loaded_project_payload(project_body: Value) -> Value {
    json!({
        "project": project_body,
        "loaded_at": stamp_project_last_opened_timestamp(),
        "schema_version": CURRENT_PROJECT_SCHEMA_VERSION,
    })
}

/// Translate a document-collection application error into the matching HTTP
/// error. Resource-not-located maps to 404; everything else is an upstream
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
        other_error => HttpError::UpstreamApplicationFailure {
            explanation: other_error.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document_with(body: Value, owner: Option<&str>) -> StoredDocument {
        StoredDocument {
            document_identifier: String::from("project-1"),
            owning_account: owner.map(str::to_string),
            document_body: body,
        }
    }

    #[test]
    fn extract_requested_identifier_from_query_returns_trimmed_value() {
        let mut parameters = HashMap::new();
        parameters.insert(String::from("identifier"), String::from("  abc-123  "));
        let extracted = extract_requested_identifier_from_query(&parameters).unwrap();
        assert_eq!(extracted, "abc-123");
    }

    #[test]
    fn extract_requested_identifier_from_query_rejects_missing_and_blank() {
        let empty_parameters = HashMap::new();
        assert!(extract_requested_identifier_from_query(&empty_parameters).is_err());

        let mut blank_parameters = HashMap::new();
        blank_parameters.insert(String::from("identifier"), String::from("   "));
        assert!(extract_requested_identifier_from_query(&blank_parameters).is_err());
    }

    #[test]
    fn validate_load_project_identifier_accepts_well_formed_handles() {
        assert!(validate_load_project_identifier("proj_ABC-123").is_ok());
    }

    #[test]
    fn validate_load_project_identifier_rejects_bad_shapes() {
        assert!(validate_load_project_identifier("").is_err());
        assert!(validate_load_project_identifier("has space").is_err());
        assert!(validate_load_project_identifier("bad/slash").is_err());
        let too_long = "a".repeat(MAXIMUM_PROJECT_IDENTIFIER_LENGTH + 1);
        assert!(validate_load_project_identifier(&too_long).is_err());
    }

    #[test]
    fn require_located_project_document_maps_absence_to_not_found() {
        assert!(require_located_project_document(None).is_err());
        let present = document_with(json!({}), Some("a@b.com"));
        assert!(require_located_project_document(Some(present)).is_ok());
    }

    #[test]
    fn account_is_owner_of_project_matches_field_or_body() {
        let by_field = document_with(json!({}), Some("owner@example.com"));
        assert!(account_is_owner_of_project(&by_field, "owner@example.com"));
        assert!(!account_is_owner_of_project(&by_field, "other@example.com"));

        let by_body = document_with(json!({ "owner": "body@example.com" }), None);
        assert!(account_is_owner_of_project(&by_body, "body@example.com"));
    }

    #[test]
    fn account_is_collaborator_on_project_reads_collaborators_array() {
        let document = document_with(
            json!({ "collaborators": ["x@e.com", "y@e.com"] }),
            Some("owner@e.com"),
        );
        assert!(account_is_collaborator_on_project(&document, "y@e.com"));
        assert!(!account_is_collaborator_on_project(&document, "z@e.com"));

        let no_collaborators = document_with(json!({}), Some("owner@e.com"));
        assert!(!account_is_collaborator_on_project(&no_collaborators, "y@e.com"));
    }

    #[test]
    fn assert_account_may_access_project_allows_owner_and_collaborator() {
        let owner_doc = document_with(json!({}), Some("owner@e.com"));
        assert!(assert_account_may_access_project(&owner_doc, "owner@e.com").is_ok());

        let collab_doc =
            document_with(json!({ "collaborators": ["c@e.com"] }), Some("owner@e.com"));
        assert!(assert_account_may_access_project(&collab_doc, "c@e.com").is_ok());

        assert!(assert_account_may_access_project(&owner_doc, "stranger@e.com").is_err());
    }

    #[test]
    fn extract_project_body_for_response_returns_owned_body() {
        let document = document_with(json!({ "title": "Thesis" }), Some("owner@e.com"));
        let body = extract_project_body_for_response(document);
        assert_eq!(body.get("title").and_then(Value::as_str), Some("Thesis"));
    }

    #[test]
    fn augment_project_body_with_access_flags_adds_flags_to_object() {
        let body = json!({ "title": "T" });
        let augmented = augment_project_body_with_access_flags(body, "me@e.com", true);
        assert_eq!(
            augmented.get("loaded_by_account").and_then(Value::as_str),
            Some("me@e.com")
        );
        assert_eq!(augmented.get("viewer_is_owner").and_then(Value::as_bool), Some(true));
        assert_eq!(augmented.get("title").and_then(Value::as_str), Some("T"));
    }

    #[test]
    fn augment_project_body_with_access_flags_wraps_non_object() {
        let augmented = augment_project_body_with_access_flags(json!(42), "me@e.com", false);
        assert_eq!(augmented.get("project").and_then(Value::as_i64), Some(42));
        assert_eq!(augmented.get("viewer_is_owner").and_then(Value::as_bool), Some(false));
    }

    #[test]
    fn extract_project_schema_version_reads_string_number_and_default() {
        let string_version = document_with(json!({ "schema_version": "2" }), None);
        assert_eq!(extract_project_schema_version(&string_version), "2");

        let numeric_version = document_with(json!({ "schema_version": 3 }), None);
        assert_eq!(extract_project_schema_version(&numeric_version), "3");

        let missing_version = document_with(json!({}), None);
        assert_eq!(
            extract_project_schema_version(&missing_version),
            LEGACY_PROJECT_SCHEMA_VERSION
        );
    }

    #[test]
    fn migrate_project_body_to_current_schema_lifts_legacy_documents() {
        let legacy_body = json!({ "nodes": [1, 2, 3], "title": "Old" });
        let migrated = migrate_project_body_to_current_schema(legacy_body, LEGACY_PROJECT_SCHEMA_VERSION);
        assert!(migrated.get("nodes").is_none());
        assert_eq!(
            migrated.get("canvas_nodes").and_then(Value::as_array).map(|a| a.len()),
            Some(3)
        );
        assert_eq!(
            migrated.get("schema_version").and_then(Value::as_str),
            Some(CURRENT_PROJECT_SCHEMA_VERSION)
        );
    }

    #[test]
    fn migrate_project_body_to_current_schema_leaves_current_documents() {
        let current_body = json!({ "canvas_nodes": [], "title": "New" });
        let migrated =
            migrate_project_body_to_current_schema(current_body, CURRENT_PROJECT_SCHEMA_VERSION);
        assert_eq!(migrated.get("title").and_then(Value::as_str), Some("New"));
        assert_eq!(
            migrated.get("schema_version").and_then(Value::as_str),
            Some(CURRENT_PROJECT_SCHEMA_VERSION)
        );
    }

    #[test]
    fn stamp_project_last_opened_timestamp_is_non_empty_numeric() {
        let stamp = stamp_project_last_opened_timestamp();
        assert!(!stamp.is_empty());
        assert!(stamp.chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn build_loaded_project_payload_wraps_body_with_metadata() {
        let payload = build_loaded_project_payload(json!({ "title": "T" }));
        assert_eq!(
            payload.get("project").and_then(|p| p.get("title")).and_then(Value::as_str),
            Some("T")
        );
        assert_eq!(
            payload.get("schema_version").and_then(Value::as_str),
            Some(CURRENT_PROJECT_SCHEMA_VERSION)
        );
        assert!(payload.get("loaded_at").and_then(Value::as_str).is_some());
    }

    #[test]
    fn map_document_collection_failure_to_http_error_maps_variants() {
        let not_found = map_document_collection_failure_to_http_error(
            ApplicationError::RequestedResourceCouldNotBeLocated,
        );
        assert!(matches!(not_found, HttpError::RequestedResourceWasNotFound { .. }));

        let denied = map_document_collection_failure_to_http_error(
            ApplicationError::AuthorizationWasDenied,
        );
        assert!(matches!(denied, HttpError::AuthorizationWasDenied { .. }));

        let upstream = map_document_collection_failure_to_http_error(
            ApplicationError::DocumentCollectionFailure {
                failure_description: String::from("boom"),
            },
        );
        assert!(matches!(upstream, HttpError::UpstreamApplicationFailure { .. }));
    }
}
