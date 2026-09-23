use crate::categories::projects_files::collections::PROJECT_FOLDERS_COLLECTION_NAME;
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
use axum::extract::State;
use serde_json::{Value, json};
use uuid::Uuid;

/// Names that a subfolder is not permitted to take, because they collide with
/// filesystem-style special directories or with reserved bookkeeping folders.
const RESERVED_SUBFOLDER_NAMES: [&str; 5] = [".", "..", "root", "trash", "system"];

#[route(method = "POST", path = "/api/create-subfolder")]
pub async fn create_subfolder_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // Resolve the principal that will own the newly created subfolder.
    let owning_account = extract_owning_account_from_authorized_request(&authorized_request);

    // Pull the three caller-supplied fields out of the JSON body.
    let parent_project_identifier = extract_parent_project_identifier_field(&submitted_body)?;
    let parent_folder_name = extract_parent_folder_name_field(&submitted_body)?;
    let proposed_subfolder_name = extract_proposed_subfolder_name_field(&submitted_body)?;

    // Validate the proposed name: non-empty, not reserved, no traversal.
    let validated_subfolder_name = validate_proposed_subfolder_name(proposed_subfolder_name)?;
    reject_reserved_subfolder_name(validated_subfolder_name.as_str())?;
    reject_path_traversal_in_subfolder_name(validated_subfolder_name.as_str())?;

    // Build the fully-qualified path that locates the subfolder in the tree.
    let qualified_subfolder_path =
        compose_qualified_subfolder_path(&parent_folder_name, &validated_subfolder_name);

    // Assemble the persisted representation of the subfolder.
    let generated_identifier = generate_subfolder_identifier();
    let document_body = assemble_subfolder_document_body(
        &parent_project_identifier,
        &qualified_subfolder_path,
        &validated_subfolder_name,
    );
    let document_to_insert =
        build_subfolder_stored_document(generated_identifier.clone(), owning_account, document_body);

    // Persist and acknowledge.
    insert_subfolder_document(&application_state, document_to_insert).await?;

    Ok(Json(build_subfolder_creation_acknowledgement(
        &generated_identifier,
        &qualified_subfolder_path,
    )))
}

/// Extract the authenticated principal's email as the owning account string.
fn extract_owning_account_from_authorized_request(
    authorized_request: &HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> String {
    authorized_request
        .authorized_principal()
        .as_str()
        .to_string()
}

/// Read the `parent_project_identifier` field from the request body.
fn extract_parent_project_identifier_field(submitted_body: &Value) -> Result<String, HttpError> {
    extract_required_string_field(submitted_body, "parent_project_identifier")
}

/// Read the `parent_folder_name` field from the request body.
fn extract_parent_folder_name_field(submitted_body: &Value) -> Result<String, HttpError> {
    extract_required_string_field(submitted_body, "parent_folder_name")
}

/// Read the `subfolder_name` field from the request body.
fn extract_proposed_subfolder_name_field(submitted_body: &Value) -> Result<String, HttpError> {
    extract_required_string_field(submitted_body, "subfolder_name")
}

/// Shared reader for a required, non-null string field. Returns a malformed-body
/// error when the field is missing or is not a JSON string.
fn extract_required_string_field(
    submitted_body: &Value,
    field_name: &str,
) -> Result<String, HttpError> {
    match submitted_body.get(field_name) {
        Some(Value::String(field_value)) => Ok(field_value.to_string()),
        Some(_) => Err(HttpError::RequestBodyWasMalformed {
            explanation: format!("field `{field_name}` must be a JSON string"),
        }),
        None => Err(HttpError::RequestBodyWasMalformed {
            explanation: format!("field `{field_name}` is required"),
        }),
    }
}

/// Trim and parse the proposed subfolder name into a `NonEmptyText`.
fn validate_proposed_subfolder_name(
    raw_subfolder_name: String,
) -> Result<NonEmptyText, HttpError> {
    let trimmed_subfolder_name = raw_subfolder_name.trim().to_string();
    NonEmptyText::parse(trimmed_subfolder_name).map_err(|domain_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: domain_error.to_string(),
        }
    })
}

/// Reject names that collide with reserved directory names (case-insensitive).
fn reject_reserved_subfolder_name(candidate_subfolder_name: &str) -> Result<(), HttpError> {
    let normalized_candidate = candidate_subfolder_name.trim().to_ascii_lowercase();
    if RESERVED_SUBFOLDER_NAMES
        .iter()
        .any(|reserved| *reserved == normalized_candidate)
    {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "the subfolder name `{candidate_subfolder_name}` is reserved and cannot be used"
            ),
        });
    }
    Ok(())
}

/// Reject any name containing path separators or parent-directory tokens that
/// could be used to escape the intended folder hierarchy.
fn reject_path_traversal_in_subfolder_name(
    candidate_subfolder_name: &str,
) -> Result<(), HttpError> {
    let contains_forbidden_token = candidate_subfolder_name.contains('/')
        || candidate_subfolder_name.contains('\\')
        || candidate_subfolder_name.contains("..");
    if contains_forbidden_token {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "the subfolder name `{candidate_subfolder_name}` may not contain path separators or `..`"
            ),
        });
    }
    Ok(())
}

/// Join the parent folder path and the validated subfolder name into a single
/// slash-delimited path. A blank parent yields just the subfolder name.
fn compose_qualified_subfolder_path(
    parent_folder_name: &str,
    validated_subfolder_name: &NonEmptyText,
) -> String {
    let trimmed_parent = parent_folder_name.trim().trim_matches('/');
    if trimmed_parent.is_empty() {
        validated_subfolder_name.as_str().to_string()
    } else {
        format!("{}/{}", trimmed_parent, validated_subfolder_name.as_str())
    }
}

/// Generate a fresh unique identifier for the subfolder document.
fn generate_subfolder_identifier() -> String {
    Uuid::new_v4().to_string()
}

/// Build the JSON document body describing the subfolder to persist.
fn assemble_subfolder_document_body(
    parent_project_identifier: &str,
    qualified_subfolder_path: &str,
    validated_subfolder_name: &NonEmptyText,
) -> Value {
    json!({
        "parent_project_identifier": parent_project_identifier,
        "subfolder_name": validated_subfolder_name.as_str(),
        "qualified_subfolder_path": qualified_subfolder_path,
        "resource_kind": "subfolder",
        "created_at": stamp_subfolder_created_timestamp(),
    })
}

/// Wrap the generated identifier, owner, and body into a `StoredDocument`.
fn build_subfolder_stored_document(
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

/// Persist the subfolder document into the project-folders collection.
fn insert_subfolder_document<'a, TransactionalUnitOfWork: UnitOfWork>(
    application_state: &'a ApplicationState<TransactionalUnitOfWork>,
    document_to_insert: StoredDocument,
) -> impl std::future::Future<Output = Result<(), HttpError>> + 'a {
    async move {
        application_state
            .document_collection
            .insert_document(PROJECT_FOLDERS_COLLECTION_NAME, document_to_insert)
            .await
            .map_err(map_document_collection_failure_to_http_error)
    }
}

/// Produce a monotonic-ish creation timestamp string. We avoid pulling a clock
/// dependency and instead emit an opaque token derived from a fresh UUID so the
/// stored document always carries a creation marker.
fn stamp_subfolder_created_timestamp() -> String {
    format!("created-{}", Uuid::new_v4())
}

/// Build the JSON acknowledgement returned to the caller on success.
fn build_subfolder_creation_acknowledgement(
    generated_identifier: &str,
    qualified_subfolder_path: &str,
) -> Value {
    json!({
        "document_identifier": generated_identifier,
        "qualified_subfolder_path": qualified_subfolder_path,
        "acknowledgement": "subfolder created",
    })
}

/// Map a document-collection-related application error onto the appropriate
/// HTTP error. Kept for explicit, well-typed error translation at call sites
/// that surface `ApplicationError` directly.
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
        other_failure => HttpError::UpstreamApplicationFailure {
            explanation: other_failure.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_body() -> Value {
        json!({
            "parent_project_identifier": "project-123",
            "parent_folder_name": "documents",
            "subfolder_name": "invoices"
        })
    }

    #[test]
    fn extract_parent_project_identifier_field_reads_present_string() {
        let body = sample_body();
        let extracted = extract_parent_project_identifier_field(&body).unwrap();
        assert_eq!(extracted, "project-123");
    }

    #[test]
    fn extract_parent_project_identifier_field_rejects_missing() {
        let body = json!({ "parent_folder_name": "x", "subfolder_name": "y" });
        assert!(extract_parent_project_identifier_field(&body).is_err());
    }

    #[test]
    fn extract_parent_folder_name_field_reads_present_string() {
        let body = sample_body();
        assert_eq!(
            extract_parent_folder_name_field(&body).unwrap(),
            "documents"
        );
    }

    #[test]
    fn extract_parent_folder_name_field_rejects_non_string() {
        let body = json!({
            "parent_project_identifier": "p",
            "parent_folder_name": 42,
            "subfolder_name": "y"
        });
        assert!(extract_parent_folder_name_field(&body).is_err());
    }

    #[test]
    fn extract_proposed_subfolder_name_field_reads_present_string() {
        let body = sample_body();
        assert_eq!(
            extract_proposed_subfolder_name_field(&body).unwrap(),
            "invoices"
        );
    }

    #[test]
    fn extract_proposed_subfolder_name_field_rejects_missing() {
        let body = json!({ "parent_project_identifier": "p", "parent_folder_name": "f" });
        assert!(extract_proposed_subfolder_name_field(&body).is_err());
    }

    #[test]
    fn validate_proposed_subfolder_name_accepts_trimmed_value() {
        let validated = validate_proposed_subfolder_name("  reports  ".to_string()).unwrap();
        assert_eq!(validated.as_str(), "reports");
    }

    #[test]
    fn validate_proposed_subfolder_name_rejects_blank() {
        assert!(validate_proposed_subfolder_name("    ".to_string()).is_err());
    }

    #[test]
    fn reject_reserved_subfolder_name_blocks_reserved() {
        assert!(reject_reserved_subfolder_name("Root").is_err());
        assert!(reject_reserved_subfolder_name("..").is_err());
    }

    #[test]
    fn reject_reserved_subfolder_name_allows_ordinary() {
        assert!(reject_reserved_subfolder_name("invoices").is_ok());
    }

    #[test]
    fn reject_path_traversal_in_subfolder_name_blocks_separators() {
        assert!(reject_path_traversal_in_subfolder_name("a/b").is_err());
        assert!(reject_path_traversal_in_subfolder_name("a\\b").is_err());
        assert!(reject_path_traversal_in_subfolder_name("..secret").is_err());
    }

    #[test]
    fn reject_path_traversal_in_subfolder_name_allows_clean() {
        assert!(reject_path_traversal_in_subfolder_name("invoices").is_ok());
    }

    #[test]
    fn compose_qualified_subfolder_path_joins_parent_and_child() {
        let name = NonEmptyText::parse("invoices".to_string()).unwrap();
        assert_eq!(
            compose_qualified_subfolder_path("documents", &name),
            "documents/invoices"
        );
    }

    #[test]
    fn compose_qualified_subfolder_path_handles_blank_parent() {
        let name = NonEmptyText::parse("invoices".to_string()).unwrap();
        assert_eq!(compose_qualified_subfolder_path("   ", &name), "invoices");
    }

    #[test]
    fn compose_qualified_subfolder_path_strips_surrounding_slashes() {
        let name = NonEmptyText::parse("invoices".to_string()).unwrap();
        assert_eq!(
            compose_qualified_subfolder_path("/documents/", &name),
            "documents/invoices"
        );
    }

    #[test]
    fn generate_subfolder_identifier_produces_unique_values() {
        assert_ne!(
            generate_subfolder_identifier(),
            generate_subfolder_identifier()
        );
    }

    #[test]
    fn assemble_subfolder_document_body_contains_expected_fields() {
        let name = NonEmptyText::parse("invoices".to_string()).unwrap();
        let body = assemble_subfolder_document_body("project-1", "documents/invoices", &name);
        assert_eq!(body["parent_project_identifier"], "project-1");
        assert_eq!(body["qualified_subfolder_path"], "documents/invoices");
        assert_eq!(body["subfolder_name"], "invoices");
        assert_eq!(body["resource_kind"], "subfolder");
        assert!(body["created_at"].is_string());
    }

    #[test]
    fn build_subfolder_stored_document_wraps_all_parts() {
        let document = build_subfolder_stored_document(
            "id-9".to_string(),
            "owner@example.com".to_string(),
            json!({ "k": "v" }),
        );
        assert_eq!(document.document_identifier, "id-9");
        assert_eq!(
            document.owning_account,
            Some("owner@example.com".to_string())
        );
        assert_eq!(document.document_body["k"], "v");
    }

    #[test]
    fn stamp_subfolder_created_timestamp_is_prefixed() {
        assert!(stamp_subfolder_created_timestamp().starts_with("created-"));
    }

    #[test]
    fn build_subfolder_creation_acknowledgement_reports_success() {
        let ack = build_subfolder_creation_acknowledgement("id-42", "documents/invoices");
        assert_eq!(ack["document_identifier"], "id-42");
        assert_eq!(ack["qualified_subfolder_path"], "documents/invoices");
        assert_eq!(ack["acknowledgement"], "subfolder created");
    }

    #[test]
    fn map_document_collection_failure_maps_not_found() {
        let mapped = map_document_collection_failure_to_http_error(
            ApplicationError::RequestedResourceCouldNotBeLocated,
        );
        assert!(matches!(
            mapped,
            HttpError::RequestedResourceWasNotFound { .. }
        ));
    }

    #[test]
    fn map_document_collection_failure_maps_generic_to_upstream() {
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
