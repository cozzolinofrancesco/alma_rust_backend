use crate::categories::projects_files::collections::SAVED_PROJECTS_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::error::ApplicationError;
use alma_application::ports::document_collection::StoredDocument;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::ProjectName;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};
use uuid::Uuid;

/// Persist (create or update) a saved project document for the authenticated
/// principal. When the submitted body carries an `identifier` field the existing
/// document is replaced (after an ownership check); otherwise a brand-new
/// document is inserted under a freshly-minted identifier.
#[route(method = "POST", path = "/api/save-project")]
pub async fn save_project_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let owning_account = extract_owning_account_from_authorized_request(&authorized_request);

    let raw_project_name = extract_project_name_field_for_save(&submitted_body)?;
    let validated_name = validate_project_name_for_save(raw_project_name)?;
    let saved_timestamp = stamp_project_saved_timestamp();

    let enriched_body =
        inject_saved_metadata_into_body(submitted_body.clone(), &validated_name, &saved_timestamp);
    let serialized_size_bytes = compute_saved_project_serialized_size_bytes(&enriched_body);

    match extract_optional_provided_identifier_field(&submitted_body) {
        Some(provided_identifier) => {
            assert_account_owns_existing_saved_project(
                &application_state,
                &provided_identifier,
                &owning_account,
            )
            .await?;

            let document_to_replace = build_saved_project_stored_document(
                provided_identifier.clone(),
                owning_account,
                enriched_body,
            );

            let replacement_succeeded =
                replace_existing_saved_project_document(&application_state, document_to_replace)
                    .await?;

            if !replacement_succeeded {
                return Err(HttpError::RequestedResourceWasNotFound {
                    explanation: format!(
                        "the saved project '{provided_identifier}' could not be located for replacement"
                    ),
                });
            }

            Ok(Json(build_save_acknowledgement_for_replacement(
                &provided_identifier,
                serialized_size_bytes,
            )))
        }
        None => {
            let generated_identifier = generate_project_identifier_for_new_save();

            let document_to_insert = build_saved_project_stored_document(
                generated_identifier.clone(),
                owning_account,
                enriched_body,
            );

            insert_new_saved_project_document(&application_state, document_to_insert).await?;

            Ok(Json(build_save_acknowledgement_for_insertion(
                &generated_identifier,
                serialized_size_bytes,
            )))
        }
    }
}

/// (1) Pull the authenticated principal's e-mail address out of the pipeline
/// request and materialise it as an owned `String` for downstream storage.
fn extract_owning_account_from_authorized_request(
    authorized_request: &HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> String {
    authorized_request
        .authorized_principal()
        .as_str()
        .to_string()
}

/// (2) Read the optional `identifier` field. Only a non-blank string value is
/// treated as a genuine identifier; blank / whitespace-only values behave as if
/// the field were absent so we fall through to the insertion branch.
fn extract_optional_provided_identifier_field(submitted_body: &Value) -> Option<String> {
    submitted_body
        .get("identifier")
        .and_then(|identifier_value| identifier_value.as_str())
        .map(|identifier_string| identifier_string.trim().to_string())
        .filter(|trimmed_identifier| !trimmed_identifier.is_empty())
}

/// (3) Extract the mandatory `name` field. A missing or non-string value is a
/// malformed request body.
fn extract_project_name_field_for_save(submitted_body: &Value) -> Result<String, HttpError> {
    submitted_body
        .get("name")
        .and_then(|name_value| name_value.as_str())
        .map(|name_string| name_string.to_string())
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: "the request body must contain a string 'name' field".to_string(),
        })
}

/// (4) Validate the raw project name against the domain invariants, surfacing a
/// malformed-body error if the value is empty or exceeds the maximum length.
fn validate_project_name_for_save(raw_project_name: String) -> Result<ProjectName, HttpError> {
    ProjectName::parse(raw_project_name).map_err(|domain_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: domain_error.to_string(),
        }
    })
}

/// (5) Mint a fresh identifier for a newly-inserted saved project.
fn generate_project_identifier_for_new_save() -> String {
    Uuid::new_v4().to_string()
}

/// (6) Produce a stable, sortable timestamp string used to stamp the save.
/// Falls back to a zero epoch on the (practically impossible) event that the
/// system clock predates the Unix epoch, keeping this helper pure and total.
fn stamp_project_saved_timestamp() -> String {
    let elapsed_since_epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    format!("{elapsed_since_epoch}")
}

/// (7) Fold the validated name and save timestamp back into the body under a
/// dedicated `saved_metadata` object, without disturbing the caller's payload.
/// If the incoming body is not a JSON object it is wrapped so the metadata still
/// has a home.
fn inject_saved_metadata_into_body(
    submitted_body: Value,
    validated_name: &ProjectName,
    saved_timestamp: &str,
) -> Value {
    let mut body_object = match submitted_body {
        Value::Object(existing_map) => existing_map,
        non_object_value => {
            let mut wrapper = serde_json::Map::new();
            wrapper.insert("original_payload".to_string(), non_object_value);
            wrapper
        }
    };

    body_object.insert(
        "name".to_string(),
        Value::String(validated_name.as_str().to_string()),
    );
    body_object.insert(
        "saved_metadata".to_string(),
        json!({
            "canonical_name": validated_name.as_str(),
            "saved_at_epoch_seconds": saved_timestamp,
        }),
    );

    Value::Object(body_object)
}

/// (8) Assemble the `StoredDocument` persisted into the saved-projects
/// collection, always attaching the owning account.
fn build_saved_project_stored_document(
    document_identifier: String,
    owning_account: String,
    document_body: Value,
) -> StoredDocument {
    StoredDocument {
        document_identifier,
        owning_account: Some(owning_account),
        document_body,
    }
}

/// (9) Replace an existing saved-project document, returning whether a matching
/// document was found and overwritten.
fn replace_existing_saved_project_document<'a, TransactionalUnitOfWork: UnitOfWork>(
    application_state: &'a ApplicationState<TransactionalUnitOfWork>,
    document_to_replace: StoredDocument,
) -> impl std::future::Future<Output = Result<bool, HttpError>> + 'a {
    async move {
        application_state
            .document_collection
            .replace_document(SAVED_PROJECTS_COLLECTION_NAME, document_to_replace)
            .await
            .map_err(map_document_collection_failure_to_http_error)
    }
}

/// (10) Insert a brand-new saved-project document.
fn insert_new_saved_project_document<'a, TransactionalUnitOfWork: UnitOfWork>(
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

/// (11) Guard a replacement against cross-account tampering: the caller may only
/// overwrite a saved project they already own. A missing document surfaces as a
/// not-found error; a document owned by somebody else is a denied authorization.
fn assert_account_owns_existing_saved_project<'a, TransactionalUnitOfWork: UnitOfWork>(
    application_state: &'a ApplicationState<TransactionalUnitOfWork>,
    provided_identifier: &'a str,
    owning_account: &'a str,
) -> impl std::future::Future<Output = Result<(), HttpError>> + 'a {
    async move {
        let optional_existing_document = application_state
            .document_collection
            .fetch_document(SAVED_PROJECTS_COLLECTION_NAME, provided_identifier)
            .await
            .map_err(map_document_collection_failure_to_http_error)?;

        let existing_document =
            optional_existing_document.ok_or_else(|| HttpError::RequestedResourceWasNotFound {
                explanation: format!(
                    "the saved project '{provided_identifier}' could not be located"
                ),
            })?;

        match existing_document.owning_account.as_deref() {
            Some(recorded_owner) if recorded_owner == owning_account => Ok(()),
            _ => Err(HttpError::AuthorizationWasDenied {
                explanation:
                    "the authenticated principal does not own this saved project".to_string(),
            }),
        }
    }
}

/// (12) Compute the serialized byte-size of a project body, useful for quota
/// bookkeeping and diagnostics. A body that cannot be serialized reports zero.
fn compute_saved_project_serialized_size_bytes(document_body: &Value) -> usize {
    serde_json::to_vec(document_body)
        .map(|serialized_bytes| serialized_bytes.len())
        .unwrap_or(0)
}

/// (13) Shape the acknowledgement returned after replacing an existing project.
fn build_save_acknowledgement_for_replacement(
    provided_identifier: &str,
    serialized_size_bytes: usize,
) -> Value {
    json!({
        "document_identifier": provided_identifier,
        "operation": "replaced",
        "serialized_size_bytes": serialized_size_bytes,
        "acknowledgement": "project saved",
    })
}

/// (14) Shape the acknowledgement returned after inserting a new project.
fn build_save_acknowledgement_for_insertion(
    generated_identifier: &str,
    serialized_size_bytes: usize,
) -> Value {
    json!({
        "document_identifier": generated_identifier,
        "operation": "created",
        "serialized_size_bytes": serialized_size_bytes,
        "acknowledgement": "project saved",
    })
}

/// (15) Translate a document-collection `ApplicationError` into the appropriate
/// transport-level `HttpError`.
fn map_document_collection_failure_to_http_error(originating_error: ApplicationError) -> HttpError {
    match originating_error {
        ApplicationError::RequestedProjectCouldNotBeLocated
        | ApplicationError::RequestedResourceCouldNotBeLocated => {
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
    fn extract_optional_provided_identifier_field_returns_value_when_present() {
        let body = json!({ "identifier": "abc-123", "name": "Thesis" });
        assert_eq!(
            extract_optional_provided_identifier_field(&body),
            Some("abc-123".to_string())
        );
    }

    #[test]
    fn extract_optional_provided_identifier_field_returns_none_when_absent_or_blank() {
        let missing = json!({ "name": "Thesis" });
        assert_eq!(extract_optional_provided_identifier_field(&missing), None);

        let blank = json!({ "identifier": "   " });
        assert_eq!(extract_optional_provided_identifier_field(&blank), None);

        let non_string = json!({ "identifier": 42 });
        assert_eq!(extract_optional_provided_identifier_field(&non_string), None);
    }

    #[test]
    fn extract_project_name_field_for_save_reads_string_name() {
        let body = json!({ "name": "My Project" });
        assert_eq!(
            extract_project_name_field_for_save(&body).unwrap(),
            "My Project".to_string()
        );
    }

    #[test]
    fn extract_project_name_field_for_save_rejects_missing_name() {
        let body = json!({ "identifier": "x" });
        assert!(matches!(
            extract_project_name_field_for_save(&body),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn validate_project_name_for_save_accepts_reasonable_name() {
        let validated = validate_project_name_for_save("A Sensible Name".to_string()).unwrap();
        assert_eq!(validated.as_str(), "A Sensible Name");
    }

    #[test]
    fn validate_project_name_for_save_rejects_empty_name() {
        assert!(matches!(
            validate_project_name_for_save("   ".to_string()),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn generate_project_identifier_for_new_save_produces_distinct_values() {
        let first = generate_project_identifier_for_new_save();
        let second = generate_project_identifier_for_new_save();
        assert_ne!(first, second);
        assert!(!first.is_empty());
    }

    #[test]
    fn stamp_project_saved_timestamp_is_numeric_and_nonempty() {
        let stamp = stamp_project_saved_timestamp();
        assert!(!stamp.is_empty());
        assert!(stamp.chars().all(|character| character.is_ascii_digit()));
    }

    #[test]
    fn inject_saved_metadata_into_body_augments_object_body() {
        let name = ProjectName::parse("Alpha".to_string()).unwrap();
        let body = json!({ "existing_field": true });
        let enriched = inject_saved_metadata_into_body(body, &name, "1700000000");

        assert_eq!(enriched.get("existing_field"), Some(&Value::Bool(true)));
        assert_eq!(
            enriched.get("name").and_then(|value| value.as_str()),
            Some("Alpha")
        );
        assert_eq!(
            enriched
                .get("saved_metadata")
                .and_then(|metadata| metadata.get("saved_at_epoch_seconds"))
                .and_then(|value| value.as_str()),
            Some("1700000000")
        );
    }

    #[test]
    fn inject_saved_metadata_into_body_wraps_non_object_body() {
        let name = ProjectName::parse("Beta".to_string()).unwrap();
        let body = json!("just a string");
        let enriched = inject_saved_metadata_into_body(body, &name, "1");

        assert_eq!(
            enriched
                .get("original_payload")
                .and_then(|value| value.as_str()),
            Some("just a string")
        );
        assert_eq!(
            enriched.get("name").and_then(|value| value.as_str()),
            Some("Beta")
        );
    }

    #[test]
    fn build_saved_project_stored_document_attaches_owner() {
        let document = build_saved_project_stored_document(
            "doc-1".to_string(),
            "user@example.com".to_string(),
            json!({ "k": "v" }),
        );
        assert_eq!(document.document_identifier, "doc-1");
        assert_eq!(
            document.owning_account,
            Some("user@example.com".to_string())
        );
        assert_eq!(document.document_body, json!({ "k": "v" }));
    }

    #[test]
    fn compute_saved_project_serialized_size_bytes_matches_serialization() {
        let body = json!({ "a": 1 });
        let expected = serde_json::to_vec(&body).unwrap().len();
        assert_eq!(compute_saved_project_serialized_size_bytes(&body), expected);
        assert!(compute_saved_project_serialized_size_bytes(&body) > 0);
    }

    #[test]
    fn build_save_acknowledgement_for_replacement_reports_replaced() {
        let acknowledgement = build_save_acknowledgement_for_replacement("id-9", 128);
        assert_eq!(
            acknowledgement.get("document_identifier").unwrap(),
            &json!("id-9")
        );
        assert_eq!(acknowledgement.get("operation").unwrap(), &json!("replaced"));
        assert_eq!(
            acknowledgement.get("serialized_size_bytes").unwrap(),
            &json!(128)
        );
    }

    #[test]
    fn build_save_acknowledgement_for_insertion_reports_created() {
        let acknowledgement = build_save_acknowledgement_for_insertion("id-new", 256);
        assert_eq!(
            acknowledgement.get("document_identifier").unwrap(),
            &json!("id-new")
        );
        assert_eq!(acknowledgement.get("operation").unwrap(), &json!("created"));
        assert_eq!(
            acknowledgement.get("serialized_size_bytes").unwrap(),
            &json!(256)
        );
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
    fn map_document_collection_failure_to_http_error_maps_denied_and_generic() {
        let denied =
            map_document_collection_failure_to_http_error(ApplicationError::AuthorizationWasDenied);
        assert!(matches!(denied, HttpError::AuthorizationWasDenied { .. }));

        let generic =
            map_document_collection_failure_to_http_error(ApplicationError::DocumentCollectionFailure {
                failure_description: "boom".to_string(),
            });
        assert!(matches!(generic, HttpError::UpstreamApplicationFailure { .. }));
    }
}
