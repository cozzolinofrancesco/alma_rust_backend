use crate::categories::projects_files::collections::SAVED_PROJECTS_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::error::ApplicationError;
use alma_application::ports::document_collection::StoredDocument;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::{Email, ProjectName};
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};
use uuid::Uuid;

/// POST /api/create-project
///
/// Creates a new saved-project document owned by the authenticated principal.
/// The request body is expected to carry at least a `project_name`; an optional
/// `project_description` and an optional `collaborators` list of e-mail addresses
/// may also be supplied. The handler validates each field, assembles a canonical
/// document body (including a default folder scaffold and a creation timestamp),
/// persists it and returns an acknowledgement.
#[route(method = "POST", path = "/api/create-project")]
pub async fn create_project_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let owning_account = extract_owning_account_from_authorized_request(&authorized_request);

    let raw_project_name = extract_proposed_project_name_field(&submitted_body)?;
    let validated_name = validate_proposed_project_name(raw_project_name)?;

    let _optional_description = extract_project_description_field(&submitted_body);

    let raw_collaborator_emails = extract_initial_collaborator_email_list(&submitted_body);
    let validated_collaborators = validate_each_collaborator_email(raw_collaborator_emails)?;

    let scaffold_folders = build_canonical_folder_scaffold_names();

    let generated_identifier = generate_project_identifier();

    let document_body = assemble_new_project_document_body(
        &validated_name,
        &owning_account,
        &validated_collaborators,
        &scaffold_folders,
    );

    let document_to_insert = build_new_project_stored_document(
        generated_identifier.clone(),
        owning_account,
        document_body,
    );

    insert_new_project_document(&application_state, document_to_insert).await?;

    let acknowledgement =
        build_project_creation_acknowledgement(&generated_identifier, &validated_name);

    Ok(Json(acknowledgement))
}

/// (1) Read the authenticated principal e-mail off the authorized request and
/// return it as an owned `String` suitable for stamping onto the document.
fn extract_owning_account_from_authorized_request(
    authorized_request: &HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> String {
    authorized_request
        .authorized_principal()
        .as_str()
        .to_string()
}

/// (2) Pull the `project_name` field out of the submitted JSON body. The field
/// must be present and must be a JSON string, otherwise the body is malformed.
fn extract_proposed_project_name_field(submitted_body: &Value) -> Result<String, HttpError> {
    match submitted_body.get("project_name") {
        Some(Value::String(raw_project_name)) => Ok(raw_project_name.clone()),
        Some(_) => Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from("the `project_name` field must be a string"),
        }),
        None => Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from("the `project_name` field is required"),
        }),
    }
}

/// (3) Turn a raw project-name string into a validated `ProjectName` domain
/// value object, translating any domain error into a malformed-body response.
fn validate_proposed_project_name(raw_project_name: String) -> Result<ProjectName, HttpError> {
    ProjectName::parse(raw_project_name).map_err(|domain_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: domain_error.to_string(),
        }
    })
}

/// (4) Read the optional `project_description` field. Only a JSON string is
/// treated as a description; anything else (missing or wrong type) yields `None`.
fn extract_project_description_field(submitted_body: &Value) -> Option<String> {
    submitted_body
        .get("project_description")
        .and_then(Value::as_str)
        .map(|description| description.trim().to_string())
        .filter(|description| !description.is_empty())
}

/// (5) Extract the raw list of collaborator e-mail strings from the body. The
/// `collaborators` field, when present, must be a JSON array; each string entry
/// is collected. Non-string entries are ignored. A missing field yields an empty
/// list.
fn extract_initial_collaborator_email_list(submitted_body: &Value) -> Vec<String> {
    match submitted_body.get("collaborators") {
        Some(Value::Array(entries)) => entries
            .iter()
            .filter_map(Value::as_str)
            .map(|entry| entry.trim().to_string())
            .filter(|entry| !entry.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

/// (6) Validate every raw collaborator e-mail into an `Email` value object,
/// short-circuiting on the first malformed address.
fn validate_each_collaborator_email(
    raw_collaborator_emails: Vec<String>,
) -> Result<Vec<Email>, HttpError> {
    let mut validated_collaborators = Vec::with_capacity(raw_collaborator_emails.len());
    for raw_collaborator_email in raw_collaborator_emails {
        let validated_email = Email::parse(raw_collaborator_email).map_err(|domain_error| {
            HttpError::RequestBodyWasMalformed {
                explanation: domain_error.to_string(),
            }
        })?;
        validated_collaborators.push(validated_email);
    }
    Ok(validated_collaborators)
}

/// (7) Generate a fresh, unique project identifier.
fn generate_project_identifier() -> String {
    Uuid::new_v4().to_string()
}

/// (8) The canonical set of folders every new project is scaffolded with.
fn build_canonical_folder_scaffold_names() -> Vec<&'static str> {
    vec!["Documents", "Literature", "Figures", "Drafts", "Exports"]
}

/// (9) Assemble the full JSON body that will be stored for the new project,
/// combining the validated name, owning account, collaborators and folder
/// scaffold together with a creation timestamp.
fn assemble_new_project_document_body(
    validated_name: &ProjectName,
    owning_account: &str,
    validated_collaborators: &[Email],
    scaffold_folders: &[&str],
) -> Value {
    let rendered_collaborators = render_collaborator_emails_as_json(validated_collaborators);
    let rendered_folders: Vec<Value> = scaffold_folders
        .iter()
        .map(|folder_name| json!({ "folder_name": folder_name }))
        .collect();

    json!({
        "project_name": validated_name.as_str(),
        "owning_account": owning_account,
        "collaborators": rendered_collaborators,
        "folders": rendered_folders,
        "created_at": stamp_project_created_timestamp(),
    })
}

/// (10) Wrap an already-assembled document body into a `StoredDocument`,
/// attaching its identifier and owning account.
fn build_new_project_stored_document(
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

/// (11) Persist the new project document into the saved-projects collection,
/// mapping any document-collection failure onto an HTTP error.
fn insert_new_project_document<'a, TransactionalUnitOfWork: UnitOfWork>(
    application_state: &'a ApplicationState<TransactionalUnitOfWork>,
    document_to_insert: StoredDocument,
) -> impl std::future::Future<Output = Result<(), HttpError>> + 'a {
    async move {
        application_state
            .document_collection
            .insert_document(SAVED_PROJECTS_COLLECTION_NAME, document_to_insert)
            .await
            .map_err(map_document_collection_failure_to_http_error)
    }
}

/// (12) Produce a stable RFC-3339-style creation timestamp. The value is derived
/// from the system clock expressed as seconds since the Unix epoch; a fixed
/// epoch marker is emitted if the clock predates the epoch (never expected).
fn stamp_project_created_timestamp() -> String {
    let seconds_since_epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    format!("{seconds_since_epoch}Z")
}

/// (13) Render the validated collaborator e-mails into JSON objects for
/// inclusion in the stored document body.
fn render_collaborator_emails_as_json(validated_collaborators: &[Email]) -> Vec<Value> {
    validated_collaborators
        .iter()
        .map(|collaborator| json!({ "collaborator_email": collaborator.as_str() }))
        .collect()
}

/// (14) Build the acknowledgement JSON returned to the caller after a
/// successful project creation.
fn build_project_creation_acknowledgement(
    generated_identifier: &str,
    validated_name: &ProjectName,
) -> Value {
    json!({
        "document_identifier": generated_identifier,
        "project_name": validated_name.as_str(),
        "acknowledgement": "project created",
    })
}

/// (15) Translate an `ApplicationError` originating from the document collection
/// into the appropriate `HttpError` variant.
fn map_document_collection_failure_to_http_error(originating_error: ApplicationError) -> HttpError {
    match originating_error {
        ApplicationError::DomainInvariantViolated(domain_error) => {
            HttpError::RequestBodyWasMalformed {
                explanation: domain_error.to_string(),
            }
        }
        ApplicationError::AuthorizationWasDenied => HttpError::AuthorizationWasDenied {
            explanation: String::from(
                "the authenticated principal is not authorized to create this project",
            ),
        },
        ApplicationError::RequestedProjectCouldNotBeLocated
        | ApplicationError::RequestedResourceCouldNotBeLocated => {
            HttpError::RequestedResourceWasNotFound {
                explanation: originating_error.to_string(),
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
    fn extract_proposed_project_name_field_returns_string_when_present() {
        let body = json!({ "project_name": "My Thesis" });
        let extracted = extract_proposed_project_name_field(&body).expect("field present");
        assert_eq!(extracted, "My Thesis");
    }

    #[test]
    fn extract_proposed_project_name_field_rejects_missing_field() {
        let body = json!({ "unrelated": true });
        let outcome = extract_proposed_project_name_field(&body);
        assert!(matches!(
            outcome,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn extract_proposed_project_name_field_rejects_non_string() {
        let body = json!({ "project_name": 42 });
        let outcome = extract_proposed_project_name_field(&body);
        assert!(matches!(
            outcome,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn validate_proposed_project_name_accepts_reasonable_name() {
        let validated = validate_proposed_project_name(String::from("Research Plan"))
            .expect("name should be valid");
        assert_eq!(validated.as_str(), "Research Plan");
    }

    #[test]
    fn validate_proposed_project_name_rejects_blank_name() {
        let outcome = validate_proposed_project_name(String::from("   "));
        assert!(matches!(
            outcome,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn extract_project_description_field_reads_present_description() {
        let body = json!({ "project_description": "  a study  " });
        assert_eq!(
            extract_project_description_field(&body),
            Some(String::from("a study"))
        );
    }

    #[test]
    fn extract_project_description_field_returns_none_when_absent_or_blank() {
        assert_eq!(extract_project_description_field(&json!({})), None);
        assert_eq!(
            extract_project_description_field(&json!({ "project_description": "   " })),
            None
        );
        assert_eq!(
            extract_project_description_field(&json!({ "project_description": 7 })),
            None
        );
    }

    #[test]
    fn extract_initial_collaborator_email_list_collects_strings() {
        let body = json!({ "collaborators": ["a@x.com", " b@y.com ", 5, ""] });
        let extracted = extract_initial_collaborator_email_list(&body);
        assert_eq!(extracted, vec!["a@x.com".to_string(), "b@y.com".to_string()]);
    }

    #[test]
    fn extract_initial_collaborator_email_list_empty_when_missing_or_wrong_type() {
        assert!(extract_initial_collaborator_email_list(&json!({})).is_empty());
        assert!(
            extract_initial_collaborator_email_list(&json!({ "collaborators": "nope" })).is_empty()
        );
    }

    #[test]
    fn validate_each_collaborator_email_accepts_valid_addresses() {
        let raw = vec![String::from("alice@example.com"), String::from("bob@sample.org")];
        let validated = validate_each_collaborator_email(raw).expect("all valid");
        assert_eq!(validated.len(), 2);
        assert_eq!(validated[0].as_str(), "alice@example.com");
    }

    #[test]
    fn validate_each_collaborator_email_rejects_malformed_address() {
        let raw = vec![String::from("alice@example.com"), String::from("not-an-email")];
        let outcome = validate_each_collaborator_email(raw);
        assert!(matches!(
            outcome,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn generate_project_identifier_produces_distinct_values() {
        let first = generate_project_identifier();
        let second = generate_project_identifier();
        assert_ne!(first, second);
        assert!(!first.is_empty());
    }

    #[test]
    fn build_canonical_folder_scaffold_names_is_non_empty_and_stable() {
        let folders = build_canonical_folder_scaffold_names();
        assert!(folders.contains(&"Documents"));
        assert!(folders.contains(&"Literature"));
        assert_eq!(folders.len(), 5);
    }

    #[test]
    fn assemble_new_project_document_body_includes_expected_fields() {
        let name = ProjectName::parse(String::from("Demo")).expect("valid name");
        let collaborator = Email::parse(String::from("c@d.com")).expect("valid email");
        let folders = build_canonical_folder_scaffold_names();
        let body =
            assemble_new_project_document_body(&name, "owner@x.com", &[collaborator], &folders);
        assert_eq!(body["project_name"], json!("Demo"));
        assert_eq!(body["owning_account"], json!("owner@x.com"));
        assert_eq!(body["collaborators"].as_array().unwrap().len(), 1);
        assert_eq!(body["folders"].as_array().unwrap().len(), 5);
        assert!(body["created_at"].is_string());
    }

    #[test]
    fn build_new_project_stored_document_wires_fields() {
        let document = build_new_project_stored_document(
            String::from("abc"),
            String::from("owner@x.com"),
            json!({ "k": "v" }),
        );
        assert_eq!(document.document_identifier, "abc");
        assert_eq!(document.owning_account, Some(String::from("owner@x.com")));
        assert_eq!(document.document_body, json!({ "k": "v" }));
    }

    #[test]
    fn stamp_project_created_timestamp_ends_with_zulu_marker() {
        let stamped = stamp_project_created_timestamp();
        assert!(stamped.ends_with('Z'));
        assert!(stamped.len() > 1);
    }

    #[test]
    fn render_collaborator_emails_as_json_maps_each_entry() {
        let collaborators = vec![
            Email::parse(String::from("a@b.com")).unwrap(),
            Email::parse(String::from("c@d.com")).unwrap(),
        ];
        let rendered = render_collaborator_emails_as_json(&collaborators);
        assert_eq!(rendered.len(), 2);
        assert_eq!(rendered[0], json!({ "collaborator_email": "a@b.com" }));
    }

    #[test]
    fn render_collaborator_emails_as_json_handles_empty_slice() {
        let rendered = render_collaborator_emails_as_json(&[]);
        assert!(rendered.is_empty());
    }

    #[test]
    fn build_project_creation_acknowledgement_carries_identifier_and_name() {
        let name = ProjectName::parse(String::from("Alpha")).unwrap();
        let acknowledgement = build_project_creation_acknowledgement("id-1", &name);
        assert_eq!(acknowledgement["document_identifier"], json!("id-1"));
        assert_eq!(acknowledgement["project_name"], json!("Alpha"));
        assert_eq!(acknowledgement["acknowledgement"], json!("project created"));
    }

    #[test]
    fn map_document_collection_failure_maps_auth_to_denied() {
        let mapped =
            map_document_collection_failure_to_http_error(ApplicationError::AuthorizationWasDenied);
        assert!(matches!(mapped, HttpError::AuthorizationWasDenied { .. }));
    }

    #[test]
    fn map_document_collection_failure_maps_missing_project_to_not_found() {
        let mapped = map_document_collection_failure_to_http_error(
            ApplicationError::RequestedProjectCouldNotBeLocated,
        );
        assert!(matches!(
            mapped,
            HttpError::RequestedResourceWasNotFound { .. }
        ));
    }

    #[test]
    fn map_document_collection_failure_maps_storage_to_upstream() {
        let mapped =
            map_document_collection_failure_to_http_error(ApplicationError::DocumentCollectionFailure {
                failure_description: String::from("disk full"),
            });
        assert!(matches!(mapped, HttpError::UpstreamApplicationFailure { .. }));
    }
}
