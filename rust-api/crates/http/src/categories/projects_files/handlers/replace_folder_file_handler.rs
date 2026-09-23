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

/// Replace the persisted body of a single file that lives inside a named folder
/// of a project. The existing document is located first so that we can enforce
/// ownership and preserve immutable metadata (creation markers, folder binding)
/// while swapping in the caller-supplied content.
#[route(
    method = "PUT",
    path = "/api/projects/:project_identifier/folders/:folder_name/files/:file_identifier"
)]
pub async fn replace_folder_file_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Path(path_parameters): Path<(String, String, String)>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // 1. Destructure and validate the addressing path parameters.
    let (_project_identifier, raw_folder_name, raw_file_identifier) =
        destructure_replace_folder_file_path_parameters(path_parameters);
    let validated_folder_name = validate_replace_folder_name(raw_folder_name)?;
    let validated_file_identifier = validate_replace_file_identifier(raw_file_identifier)?;
    let file_identifier = validated_file_identifier.as_str().to_string();
    let folder_name = validated_folder_name.as_str().to_string();

    // 2. Establish the acting principal.
    let owning_account = extract_owning_account_from_authorized_request(&authorized_request);

    // 3. Extract the replacement payload up front so a malformed body is rejected
    //    before we touch the store.
    let replacement_content = extract_replacement_file_content_field(&submitted_body)?;
    let _declared_mime_type = extract_replacement_declared_mime_type(&submitted_body);

    // 4. Load the existing document and enforce presence + ownership.
    let optionally_located =
        fetch_existing_folder_file_document(&application_state, &file_identifier).await?;
    let existing_document = require_existing_folder_file(optionally_located)?;
    assert_account_owns_existing_folder_file(&existing_document, &owning_account)?;

    // 5. Merge the replacement into the existing body, preserving metadata.
    let merged_body =
        merge_replacement_body_preserving_metadata(&existing_document, replacement_content, &folder_name);
    let document_to_replace =
        build_replacement_stored_document(file_identifier.clone(), owning_account, merged_body);

    // 6. Persist and interpret the outcome.
    let replacement_succeeded =
        replace_folder_file_document(&application_state, document_to_replace).await?;
    interpret_replacement_outcome(replacement_succeeded, &file_identifier)?;

    Ok(Json(build_folder_file_replacement_acknowledgement(
        &file_identifier,
        &folder_name,
    )))
}

/// (1) Unpack the three-tuple axum path capture into named components. Kept as a
/// distinct helper so the ordering of the captured segments is asserted by a test
/// rather than trusted implicitly at the call site.
fn destructure_replace_folder_file_path_parameters(
    path_parameters: (String, String, String),
) -> (String, String, String) {
    let (project_identifier, folder_name, file_identifier) = path_parameters;
    (project_identifier, folder_name, file_identifier)
}

/// (2) Read the authenticated principal's email address as an owning-account string.
fn extract_owning_account_from_authorized_request(
    authorized_request: &HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> String {
    authorized_request
        .authorized_principal()
        .as_str()
        .to_string()
}

/// (3) A folder name must be a non-empty, non-whitespace textual value.
fn validate_replace_folder_name(raw_folder_name: String) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(raw_folder_name).map_err(|parse_failure| {
        HttpError::RequestBodyWasMalformed {
            explanation: format!("the folder name is not valid: {}", parse_failure),
        }
    })
}

/// (4) A file identifier must likewise be a non-empty textual value.
fn validate_replace_file_identifier(
    raw_file_identifier: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(raw_file_identifier).map_err(|parse_failure| {
        HttpError::RequestBodyWasMalformed {
            explanation: format!("the file identifier is not valid: {}", parse_failure),
        }
    })
}

/// (5) Pull the replacement content out of the submitted body. Callers may either
/// wrap the payload under a `"content"` key or send the raw body itself; both are
/// accepted, but a JSON `null` or an empty object with neither shape is rejected.
fn extract_replacement_file_content_field(submitted_body: &Value) -> Result<Value, HttpError> {
    if let Some(explicit_content) = submitted_body.get("content") {
        if explicit_content.is_null() {
            return Err(HttpError::RequestBodyWasMalformed {
                explanation: String::from("the 'content' field must not be null"),
            });
        }
        return Ok(explicit_content.clone());
    }

    if submitted_body.is_null() {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from("a replacement body or 'content' field is required"),
        });
    }

    if let Some(body_object) = submitted_body.as_object() {
        if body_object.is_empty() {
            return Err(HttpError::RequestBodyWasMalformed {
                explanation: String::from("the replacement body must not be empty"),
            });
        }
    }

    Ok(submitted_body.clone())
}

/// (6) Optionally read a declared MIME type from the body. Absence is allowed and
/// yields `None`; a present-but-non-string value is treated as absent rather than
/// an error, since it is advisory metadata only.
fn extract_replacement_declared_mime_type(submitted_body: &Value) -> Option<String> {
    submitted_body
        .get("mime_type")
        .and_then(|candidate| candidate.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// (7) Fetch the existing document from the project-files collection. Errors from
/// the port are surfaced as HTTP errors; a genuine "not found" is represented by
/// `Ok(None)` for the caller to interpret.
fn fetch_existing_folder_file_document<'a, TransactionalUnitOfWork: UnitOfWork>(
    application_state: &'a ApplicationState<TransactionalUnitOfWork>,
    file_identifier: &'a str,
) -> impl std::future::Future<Output = Result<Option<StoredDocument>, HttpError>> + 'a {
    async move {
        let located = application_state
            .document_collection
            .fetch_document(PROJECT_FILES_COLLECTION_NAME, file_identifier)
            .await
            .map_err(map_document_collection_failure_to_http_error)?;
        Ok(located)
    }
}

/// (8) Convert a missing document into a 404-shaped error.
fn require_existing_folder_file(
    optionally_located: Option<StoredDocument>,
) -> Result<StoredDocument, HttpError> {
    optionally_located.ok_or_else(|| HttpError::RequestedResourceWasNotFound {
        explanation: String::from("no folder file exists under the supplied identifier"),
    })
}

/// (9) Enforce that the acting principal owns the document being replaced. A
/// document with no recorded owner is treated as unowned and thus not replaceable
/// by an arbitrary caller.
fn assert_account_owns_existing_folder_file(
    existing_document: &StoredDocument,
    owning_account: &str,
) -> Result<(), HttpError> {
    match existing_document.owning_account.as_deref() {
        Some(recorded_owner) if recorded_owner == owning_account => Ok(()),
        _ => Err(HttpError::AuthorizationWasDenied {
            explanation: String::from(
                "the authenticated principal does not own this folder file",
            ),
        }),
    }
}

/// (10) Produce the merged document body. Immutable metadata carried by the prior
/// document (its creation timestamp, if any) is preserved, the folder binding is
/// re-asserted, and the caller's replacement content is written under `content`.
fn merge_replacement_body_preserving_metadata(
    existing_document: &StoredDocument,
    replacement_content: Value,
    folder_name: &str,
) -> Value {
    let mut merged = serde_json::Map::new();

    if let Some(preserved_created_at) = existing_document
        .document_body
        .get("created_at")
        .filter(|value| !value.is_null())
    {
        merged.insert(String::from("created_at"), preserved_created_at.clone());
    }

    if let Some(preserved_original_name) = existing_document
        .document_body
        .get("original_file_name")
        .filter(|value| !value.is_null())
    {
        merged.insert(
            String::from("original_file_name"),
            preserved_original_name.clone(),
        );
    }

    merged.insert(String::from("folder_name"), json!(folder_name));
    merged.insert(String::from("content"), replacement_content);

    Value::Object(merged)
}

/// (11) Assemble the `StoredDocument` that will overwrite the existing record.
fn build_replacement_stored_document(
    file_identifier: String,
    owning_account: String,
    merged_body: Value,
) -> StoredDocument {
    StoredDocument {
        document_identifier: file_identifier,
        owning_account: Some(owning_account),
        document_body: merged_body,
    }
}

/// (12) Persist the replacement through the document-collection port.
fn replace_folder_file_document<'a, TransactionalUnitOfWork: UnitOfWork>(
    application_state: &'a ApplicationState<TransactionalUnitOfWork>,
    document_to_replace: StoredDocument,
) -> impl std::future::Future<Output = Result<bool, HttpError>> + 'a {
    async move {
        let replacement_succeeded = application_state
            .document_collection
            .replace_document(PROJECT_FILES_COLLECTION_NAME, document_to_replace)
            .await
            .map_err(map_document_collection_failure_to_http_error)?;
        Ok(replacement_succeeded)
    }
}

/// (13) Translate the boolean replace result into a success/failure decision. A
/// `false` here means the record vanished between the fetch and the write.
fn interpret_replacement_outcome(
    replacement_succeeded: bool,
    file_identifier: &str,
) -> Result<(), HttpError> {
    if replacement_succeeded {
        Ok(())
    } else {
        Err(HttpError::RequestedResourceWasNotFound {
            explanation: format!(
                "the folder file '{}' could not be located for replacement",
                file_identifier
            ),
        })
    }
}

/// (14) Build the JSON acknowledgement returned to the caller on success.
fn build_folder_file_replacement_acknowledgement(file_identifier: &str, folder_name: &str) -> Value {
    json!({
        "document_identifier": file_identifier,
        "folder_name": folder_name,
        "acknowledgement": "folder file replaced",
    })
}

/// (15) Explicit mapping from an application-layer error to the HTTP surface. This
/// mirrors the crate's blanket `From` conversion but is kept as a named helper so
/// the intended categorisation is directly testable.
fn map_document_collection_failure_to_http_error(
    originating_error: ApplicationError,
) -> HttpError {
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
    fn destructures_path_parameters_in_declared_order() {
        let (project, folder, file) = destructure_replace_folder_file_path_parameters((
            String::from("proj-1"),
            String::from("drafts"),
            String::from("file-9"),
        ));
        assert_eq!(project, "proj-1");
        assert_eq!(folder, "drafts");
        assert_eq!(file, "file-9");
    }

    #[test]
    fn validates_a_good_folder_name() {
        let validated = validate_replace_folder_name(String::from("references")).unwrap();
        assert_eq!(validated.as_str(), "references");
    }

    #[test]
    fn rejects_a_blank_folder_name() {
        let outcome = validate_replace_folder_name(String::from("   "));
        assert!(matches!(
            outcome,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn validates_a_good_file_identifier() {
        let validated = validate_replace_file_identifier(String::from("file-42")).unwrap();
        assert_eq!(validated.as_str(), "file-42");
    }

    #[test]
    fn rejects_an_empty_file_identifier() {
        let outcome = validate_replace_file_identifier(String::from(""));
        assert!(matches!(
            outcome,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn extracts_explicit_content_field() {
        let body = json!({ "content": { "text": "hello" } });
        let extracted = extract_replacement_file_content_field(&body).unwrap();
        assert_eq!(extracted, json!({ "text": "hello" }));
    }

    #[test]
    fn falls_back_to_whole_body_when_no_content_key() {
        let body = json!({ "text": "raw payload" });
        let extracted = extract_replacement_file_content_field(&body).unwrap();
        assert_eq!(extracted, json!({ "text": "raw payload" }));
    }

    #[test]
    fn rejects_null_content_field() {
        let body = json!({ "content": null });
        let outcome = extract_replacement_file_content_field(&body);
        assert!(matches!(
            outcome,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn rejects_empty_object_body() {
        let body = json!({});
        let outcome = extract_replacement_file_content_field(&body);
        assert!(matches!(
            outcome,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn reads_present_mime_type() {
        let body = json!({ "mime_type": "application/pdf" });
        assert_eq!(
            extract_replacement_declared_mime_type(&body),
            Some(String::from("application/pdf"))
        );
    }

    #[test]
    fn treats_missing_or_blank_mime_type_as_none() {
        assert_eq!(extract_replacement_declared_mime_type(&json!({})), None);
        assert_eq!(
            extract_replacement_declared_mime_type(&json!({ "mime_type": "   " })),
            None
        );
        assert_eq!(
            extract_replacement_declared_mime_type(&json!({ "mime_type": 7 })),
            None
        );
    }

    #[test]
    fn requires_an_existing_folder_file() {
        let present = StoredDocument {
            document_identifier: String::from("f1"),
            owning_account: Some(String::from("a@b.c")),
            document_body: json!({}),
        };
        assert!(require_existing_folder_file(Some(present)).is_ok());
        assert!(matches!(
            require_existing_folder_file(None),
            Err(HttpError::RequestedResourceWasNotFound { .. })
        ));
    }

    #[test]
    fn permits_owner_and_denies_non_owner() {
        let document = StoredDocument {
            document_identifier: String::from("f1"),
            owning_account: Some(String::from("owner@example.com")),
            document_body: json!({}),
        };
        assert!(assert_account_owns_existing_folder_file(&document, "owner@example.com").is_ok());
        assert!(matches!(
            assert_account_owns_existing_folder_file(&document, "intruder@example.com"),
            Err(HttpError::AuthorizationWasDenied { .. })
        ));
    }

    #[test]
    fn denies_replacement_of_unowned_document() {
        let document = StoredDocument {
            document_identifier: String::from("f1"),
            owning_account: None,
            document_body: json!({}),
        };
        assert!(matches!(
            assert_account_owns_existing_folder_file(&document, "someone@example.com"),
            Err(HttpError::AuthorizationWasDenied { .. })
        ));
    }

    #[test]
    fn merge_preserves_metadata_and_rebinds_folder() {
        let existing = StoredDocument {
            document_identifier: String::from("f1"),
            owning_account: Some(String::from("owner@example.com")),
            document_body: json!({
                "created_at": "2026-01-01T00:00:00Z",
                "original_file_name": "notes.txt",
                "folder_name": "old_folder",
                "content": { "text": "old" }
            }),
        };
        let merged = merge_replacement_body_preserving_metadata(
            &existing,
            json!({ "text": "new" }),
            "new_folder",
        );
        assert_eq!(merged["created_at"], json!("2026-01-01T00:00:00Z"));
        assert_eq!(merged["original_file_name"], json!("notes.txt"));
        assert_eq!(merged["folder_name"], json!("new_folder"));
        assert_eq!(merged["content"], json!({ "text": "new" }));
    }

    #[test]
    fn merge_without_prior_metadata_is_minimal() {
        let existing = StoredDocument {
            document_identifier: String::from("f1"),
            owning_account: Some(String::from("owner@example.com")),
            document_body: json!({}),
        };
        let merged =
            merge_replacement_body_preserving_metadata(&existing, json!("body"), "folder");
        assert_eq!(merged["folder_name"], json!("folder"));
        assert_eq!(merged["content"], json!("body"));
        assert!(merged.get("created_at").is_none());
    }

    #[test]
    fn builds_the_replacement_stored_document() {
        let document = build_replacement_stored_document(
            String::from("f1"),
            String::from("owner@example.com"),
            json!({ "content": "x" }),
        );
        assert_eq!(document.document_identifier, "f1");
        assert_eq!(document.owning_account, Some(String::from("owner@example.com")));
        assert_eq!(document.document_body, json!({ "content": "x" }));
    }

    #[test]
    fn interprets_successful_and_failed_outcomes() {
        assert!(interpret_replacement_outcome(true, "f1").is_ok());
        assert!(matches!(
            interpret_replacement_outcome(false, "f1"),
            Err(HttpError::RequestedResourceWasNotFound { .. })
        ));
    }

    #[test]
    fn builds_the_acknowledgement_payload() {
        let acknowledgement = build_folder_file_replacement_acknowledgement("f1", "drafts");
        assert_eq!(acknowledgement["document_identifier"], json!("f1"));
        assert_eq!(acknowledgement["folder_name"], json!("drafts"));
        assert_eq!(acknowledgement["acknowledgement"], json!("folder file replaced"));
    }

    #[test]
    fn maps_not_found_application_errors() {
        let mapped =
            map_document_collection_failure_to_http_error(ApplicationError::RequestedResourceCouldNotBeLocated);
        assert!(matches!(
            mapped,
            HttpError::RequestedResourceWasNotFound { .. }
        ));
    }

    #[test]
    fn maps_authorization_and_generic_failures() {
        let denied =
            map_document_collection_failure_to_http_error(ApplicationError::AuthorizationWasDenied);
        assert!(matches!(denied, HttpError::AuthorizationWasDenied { .. }));

        let generic = map_document_collection_failure_to_http_error(
            ApplicationError::DocumentCollectionFailure {
                failure_description: String::from("boom"),
            },
        );
        assert!(matches!(
            generic,
            HttpError::UpstreamApplicationFailure { .. }
        ));
    }
}
