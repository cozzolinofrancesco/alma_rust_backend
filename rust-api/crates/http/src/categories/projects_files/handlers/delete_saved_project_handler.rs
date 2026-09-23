use crate::categories::projects_files::collections::{
    PROJECT_FILES_COLLECTION_NAME, SAVED_PROJECTS_COLLECTION_NAME,
};
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

#[route(method = "DELETE", path = "/api/list-saved-projects")]
pub async fn delete_saved_project_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Query(query_parameters): Query<HashMap<String, String>>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // Resolve who is asking and what they want removed.
    let owning_account = extract_owning_account_from_authorized_request(&authorized_request);
    let requested_identifier = extract_requested_identifier_from_query(&query_parameters)?;
    validate_requested_identifier_is_non_empty(&requested_identifier)?;

    // Confirm the saved project exists and belongs to the caller before deleting.
    let optionally_located =
        fetch_saved_project_before_deletion(&application_state, &requested_identifier).await?;
    let located_document = require_located_saved_project(optionally_located)?;
    assert_account_owns_saved_project(&located_document, &owning_account)?;

    // Capture receipt details from the document prior to removal.
    let project_display_name = extract_project_display_name_for_receipt(&located_document);
    let _deletion_timestamp = stamp_project_deletion_timestamp();

    // Optionally cascade-delete the child files owned under this project.
    let cascade_requested = extract_cascade_deletion_flag(&query_parameters);
    let cascaded_file_count = if cascade_requested {
        delete_project_files_owned_under_project(&application_state, &requested_identifier).await?
    } else {
        0
    };

    // Delete the saved project document itself.
    let deletion_succeeded =
        delete_saved_project_document(&application_state, &requested_identifier).await?;
    interpret_deletion_outcome(deletion_succeeded, &requested_identifier)?;

    let mut acknowledgement_payload =
        build_deletion_acknowledgement_payload(&requested_identifier, cascaded_file_count);
    if let Value::Object(ref mut fields) = acknowledgement_payload {
        fields.insert(
            String::from("project_display_name"),
            Value::String(project_display_name),
        );
        fields.insert(
            String::from("deleted_at"),
            Value::String(_deletion_timestamp),
        );
        fields.insert(
            String::from("cascade_requested"),
            Value::Bool(cascade_requested),
        );
    }

    Ok(Json(acknowledgement_payload))
}

/// (1) Derive the owning account string from the authorized principal's email.
fn extract_owning_account_from_authorized_request(
    authorized_request: &HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> String {
    authorized_request.authorized_principal().as_str().to_owned()
}

/// (2) Pull the required `identifier` query parameter out of the query map.
fn extract_requested_identifier_from_query(
    query_parameters: &HashMap<String, String>,
) -> Result<String, HttpError> {
    query_parameters
        .get("identifier")
        .map(|value| value.trim().to_owned())
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: String::from("the 'identifier' query parameter is required"),
        })
}

/// (3) Reject blank identifiers before touching the collection.
fn validate_requested_identifier_is_non_empty(raw_identifier: &str) -> Result<(), HttpError> {
    if raw_identifier.trim().is_empty() {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from("the 'identifier' query parameter must not be empty"),
        });
    }
    Ok(())
}

/// (4) Fetch the saved project document (if any) prior to deletion.
fn fetch_saved_project_before_deletion<'a, TransactionalUnitOfWork: UnitOfWork>(
    application_state: &'a ApplicationState<TransactionalUnitOfWork>,
    requested_identifier: &'a str,
) -> impl std::future::Future<Output = Result<Option<StoredDocument>, HttpError>> + 'a {
    async move {
        let located = application_state
            .document_collection
            .fetch_document(SAVED_PROJECTS_COLLECTION_NAME, requested_identifier)
            .await
            .map_err(map_document_collection_failure_to_http_error)?;
        Ok(located)
    }
}

/// (5) Turn an optional lookup into a hard not-found error when absent.
fn require_located_saved_project(
    optionally_located: Option<StoredDocument>,
) -> Result<StoredDocument, HttpError> {
    optionally_located.ok_or_else(|| HttpError::RequestedResourceWasNotFound {
        explanation: String::from("no saved project exists under the supplied identifier"),
    })
}

/// (6) Enforce that the caller owns the located document before mutating it.
fn assert_account_owns_saved_project(
    located_document: &StoredDocument,
    owning_account: &str,
) -> Result<(), HttpError> {
    match located_document.owning_account.as_deref() {
        Some(recorded_owner) if recorded_owner == owning_account => Ok(()),
        Some(_) => Err(HttpError::AuthorizationWasDenied {
            explanation: String::from(
                "the authenticated principal does not own this saved project",
            ),
        }),
        None => Err(HttpError::AuthorizationWasDenied {
            explanation: String::from(
                "the saved project has no recorded owner and cannot be deleted",
            ),
        }),
    }
}

/// (7) Delete the saved project document, translating collection errors.
fn delete_saved_project_document<'a, TransactionalUnitOfWork: UnitOfWork>(
    application_state: &'a ApplicationState<TransactionalUnitOfWork>,
    requested_identifier: &'a str,
) -> impl std::future::Future<Output = Result<bool, HttpError>> + 'a {
    async move {
        let removed = application_state
            .document_collection
            .delete_document(SAVED_PROJECTS_COLLECTION_NAME, requested_identifier)
            .await
            .map_err(map_document_collection_failure_to_http_error)?;
        Ok(removed)
    }
}

/// (8) Convert the boolean delete outcome into success or not-found.
fn interpret_deletion_outcome(
    deletion_succeeded: bool,
    requested_identifier: &str,
) -> Result<(), HttpError> {
    if deletion_succeeded {
        Ok(())
    } else {
        Err(HttpError::RequestedResourceWasNotFound {
            explanation: format!(
                "the saved project '{requested_identifier}' vanished before it could be deleted"
            ),
        })
    }
}

/// (9) Interpret the optional `cascade` query flag as a boolean.
fn extract_cascade_deletion_flag(query_parameters: &HashMap<String, String>) -> bool {
    query_parameters
        .get("cascade")
        .map(|raw| {
            let normalized = raw.trim().to_ascii_lowercase();
            matches!(normalized.as_str(), "true" | "1" | "yes" | "on")
        })
        .unwrap_or(false)
}

/// (10) Delete every project file owned under the given project, returning the count.
fn delete_project_files_owned_under_project<'a, TransactionalUnitOfWork: UnitOfWork>(
    application_state: &'a ApplicationState<TransactionalUnitOfWork>,
    project_identifier: &'a str,
) -> impl std::future::Future<Output = Result<usize, HttpError>> + 'a {
    async move {
        let all_project_files = application_state
            .document_collection
            .list_documents(PROJECT_FILES_COLLECTION_NAME)
            .await
            .map_err(map_document_collection_failure_to_http_error)?;
        let child_identifiers =
            collect_child_file_identifiers_for_project(&all_project_files, project_identifier);

        let mut removed_count = 0usize;
        for child_identifier in child_identifiers {
            let removed = application_state
                .document_collection
                .delete_document(PROJECT_FILES_COLLECTION_NAME, &child_identifier)
                .await?;
            if removed {
                removed_count += 1;
            }
        }
        Ok(removed_count)
    }
}

/// (11) Collect identifiers of project files whose body references this project.
fn collect_child_file_identifiers_for_project(
    project_files: &[StoredDocument],
    project_identifier: &str,
) -> Vec<String> {
    project_files
        .iter()
        .filter(|candidate| document_belongs_to_project(candidate, project_identifier))
        .map(|candidate| candidate.document_identifier.clone())
        .collect()
}

/// Helper for (11): decide whether a stored file document belongs to a project.
fn document_belongs_to_project(candidate: &StoredDocument, project_identifier: &str) -> bool {
    candidate
        .document_body
        .get("project_identifier")
        .and_then(|value| value.as_str())
        .map(|referenced| referenced == project_identifier)
        .unwrap_or(false)
}

/// (12) Produce an ISO-8601-ish deletion timestamp for the receipt.
fn stamp_project_deletion_timestamp() -> String {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    format!("{elapsed}Z")
}

/// (13) Extract a human-friendly display name for the receipt, falling back safely.
fn extract_project_display_name_for_receipt(located_document: &StoredDocument) -> String {
    located_document
        .document_body
        .get("project_name")
        .or_else(|| located_document.document_body.get("display_name"))
        .or_else(|| located_document.document_body.get("title"))
        .and_then(|value| value.as_str())
        .filter(|name| !name.trim().is_empty())
        .map(|name| name.trim().to_owned())
        .unwrap_or_else(|| located_document.document_identifier.clone())
}

/// (14) Build the acknowledgement JSON payload returned to the client.
fn build_deletion_acknowledgement_payload(
    requested_identifier: &str,
    cascaded_file_count: usize,
) -> Value {
    json!({
        "acknowledgement": "saved project deleted",
        "document_identifier": requested_identifier,
        "cascaded_file_count": cascaded_file_count,
    })
}

/// (15) Map a raw document-collection ApplicationError into an HttpError.
fn map_document_collection_failure_to_http_error(originating_error: ApplicationError) -> HttpError {
    match originating_error {
        ApplicationError::RequestedResourceCouldNotBeLocated
        | ApplicationError::RequestedProjectCouldNotBeLocated => {
            HttpError::RequestedResourceWasNotFound {
                explanation: String::from(
                    "the requested saved project could not be located in the collection",
                ),
            }
        }
        ApplicationError::AuthorizationWasDenied => HttpError::AuthorizationWasDenied {
            explanation: String::from(
                "the document collection denied authorization for this operation",
            ),
        },
        other => HttpError::UpstreamApplicationFailure {
            explanation: other.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored(identifier: &str, owner: Option<&str>, body: Value) -> StoredDocument {
        StoredDocument {
            document_identifier: identifier.to_owned(),
            owning_account: owner.map(|value| value.to_owned()),
            document_body: body,
        }
    }

    #[test]
    fn extract_requested_identifier_from_query_returns_trimmed_value() {
        let mut query = HashMap::new();
        query.insert(String::from("identifier"), String::from("  proj-1  "));
        let extracted = extract_requested_identifier_from_query(&query).expect("should extract");
        assert_eq!(extracted, "proj-1");
    }

    #[test]
    fn extract_requested_identifier_from_query_errors_when_missing() {
        let query = HashMap::new();
        assert!(extract_requested_identifier_from_query(&query).is_err());
    }

    #[test]
    fn validate_requested_identifier_is_non_empty_accepts_real_id() {
        assert!(validate_requested_identifier_is_non_empty("proj-9").is_ok());
    }

    #[test]
    fn validate_requested_identifier_is_non_empty_rejects_blank() {
        assert!(validate_requested_identifier_is_non_empty("   ").is_err());
    }

    #[test]
    fn require_located_saved_project_passes_through_some() {
        let document = stored("proj-1", Some("a@b.c"), json!({}));
        let result = require_located_saved_project(Some(document));
        assert!(result.is_ok());
    }

    #[test]
    fn require_located_saved_project_errors_on_none() {
        assert!(require_located_saved_project(None).is_err());
    }

    #[test]
    fn assert_account_owns_saved_project_allows_matching_owner() {
        let document = stored("proj-1", Some("owner@example.com"), json!({}));
        assert!(assert_account_owns_saved_project(&document, "owner@example.com").is_ok());
    }

    #[test]
    fn assert_account_owns_saved_project_denies_other_owner() {
        let document = stored("proj-1", Some("someone@else.com"), json!({}));
        assert!(assert_account_owns_saved_project(&document, "owner@example.com").is_err());
    }

    #[test]
    fn assert_account_owns_saved_project_denies_missing_owner() {
        let document = stored("proj-1", None, json!({}));
        assert!(assert_account_owns_saved_project(&document, "owner@example.com").is_err());
    }

    #[test]
    fn interpret_deletion_outcome_maps_true_to_ok() {
        assert!(interpret_deletion_outcome(true, "proj-1").is_ok());
    }

    #[test]
    fn interpret_deletion_outcome_maps_false_to_not_found() {
        assert!(interpret_deletion_outcome(false, "proj-1").is_err());
    }

    #[test]
    fn extract_cascade_deletion_flag_reads_truthy_variants() {
        for truthy in ["true", "1", "YES", " on "] {
            let mut query = HashMap::new();
            query.insert(String::from("cascade"), String::from(truthy));
            assert!(
                extract_cascade_deletion_flag(&query),
                "expected '{truthy}' to be truthy"
            );
        }
    }

    #[test]
    fn extract_cascade_deletion_flag_defaults_to_false() {
        let query = HashMap::new();
        assert!(!extract_cascade_deletion_flag(&query));
        let mut falsy = HashMap::new();
        falsy.insert(String::from("cascade"), String::from("false"));
        assert!(!extract_cascade_deletion_flag(&falsy));
    }

    #[test]
    fn collect_child_file_identifiers_for_project_filters_by_reference() {
        let files = vec![
            stored("f1", Some("a"), json!({ "project_identifier": "proj-1" })),
            stored("f2", Some("a"), json!({ "project_identifier": "proj-2" })),
            stored("f3", Some("a"), json!({ "project_identifier": "proj-1" })),
            stored("f4", Some("a"), json!({ "unrelated": true })),
        ];
        let collected = collect_child_file_identifiers_for_project(&files, "proj-1");
        assert_eq!(collected, vec![String::from("f1"), String::from("f3")]);
    }

    #[test]
    fn collect_child_file_identifiers_for_project_returns_empty_when_none_match() {
        let files = vec![stored(
            "f1",
            Some("a"),
            json!({ "project_identifier": "other" }),
        )];
        assert!(collect_child_file_identifiers_for_project(&files, "proj-1").is_empty());
    }

    #[test]
    fn document_belongs_to_project_handles_missing_field() {
        let document = stored("f1", Some("a"), json!({ "no_project": true }));
        assert!(!document_belongs_to_project(&document, "proj-1"));
    }

    #[test]
    fn stamp_project_deletion_timestamp_is_non_empty() {
        let stamp = stamp_project_deletion_timestamp();
        assert!(stamp.ends_with('Z'));
        assert!(stamp.len() > 1);
    }

    #[test]
    fn extract_project_display_name_prefers_project_name() {
        let document = stored("proj-1", Some("a"), json!({ "project_name": "My Thesis" }));
        assert_eq!(extract_project_display_name_for_receipt(&document), "My Thesis");
    }

    #[test]
    fn extract_project_display_name_falls_back_to_identifier() {
        let document = stored("proj-1", Some("a"), json!({ "other": "x" }));
        assert_eq!(extract_project_display_name_for_receipt(&document), "proj-1");
    }

    #[test]
    fn extract_project_display_name_ignores_blank_name() {
        let document = stored("proj-1", Some("a"), json!({ "project_name": "   " }));
        assert_eq!(extract_project_display_name_for_receipt(&document), "proj-1");
    }

    #[test]
    fn build_deletion_acknowledgement_payload_contains_expected_fields() {
        let payload = build_deletion_acknowledgement_payload("proj-1", 3);
        assert_eq!(payload["acknowledgement"], "saved project deleted");
        assert_eq!(payload["document_identifier"], "proj-1");
        assert_eq!(payload["cascaded_file_count"], 3);
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
    fn map_document_collection_failure_maps_authorization_denied() {
        let mapped =
            map_document_collection_failure_to_http_error(ApplicationError::AuthorizationWasDenied);
        assert!(matches!(mapped, HttpError::AuthorizationWasDenied { .. }));
    }

    #[test]
    fn map_document_collection_failure_maps_other_to_upstream() {
        let mapped = map_document_collection_failure_to_http_error(
            ApplicationError::DocumentCollectionFailure {
                failure_description: String::from("boom"),
            },
        );
        assert!(matches!(
            mapped,
            HttpError::UpstreamApplicationFailure { .. }
        ));
    }
}
