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
use axum::extract::State;
use serde_json::{Value, json};

/// Lists the saved projects that the authorized principal either owns directly
/// or that have been shared with them as a collaborator.
///
/// The handler fetches two disjoint sets of documents from the saved-projects
/// collection: those owned by the caller, and (by scanning the whole collection)
/// those where the caller appears as a collaborator. Each document is rendered
/// into a stable listing entry, the two sets are merged and deduplicated,
/// sorted newest-first, and returned inside a small summary envelope.
#[route(method = "GET", path = "/api/list-projects")]
pub async fn list_projects_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let owning_account = extract_owning_account_from_authorized_request(&authorized_request);

    let owned_documents =
        list_saved_project_documents_owned_by_account(&application_state, &owning_account).await?;
    let shared_documents =
        list_saved_project_documents_shared_with_account(&application_state, &owning_account)
            .await?;

    let owned_entries: Vec<Value> = owned_documents
        .iter()
        .map(|stored_document| {
            render_owned_project_document_as_listing_entry(stored_document, &owning_account)
        })
        .collect();
    let shared_entries: Vec<Value> = shared_documents
        .iter()
        .map(|stored_document| {
            render_shared_project_document_as_listing_entry(stored_document, &owning_account)
        })
        .collect();

    let mut merged_entries = merge_owned_and_shared_project_entries(owned_entries, shared_entries);
    sort_project_entries_by_modified_time_descending(&mut merged_entries);

    let payload = build_projects_listing_payload(merged_entries);
    Ok(Json(payload))
}

/// 1 — Pull the caller's email out of the authorized request as an owned String.
fn extract_owning_account_from_authorized_request(
    authorized_request: &HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> String {
    authorized_request
        .authorized_principal()
        .as_str()
        .to_string()
}

/// 2 — Fetch the documents owned directly by the account.
fn list_saved_project_documents_owned_by_account<'a, TransactionalUnitOfWork: UnitOfWork>(
    application_state: &'a ApplicationState<TransactionalUnitOfWork>,
    owning_account: &'a str,
) -> impl std::future::Future<Output = Result<Vec<StoredDocument>, HttpError>> + 'a {
    async move {
        application_state
            .document_collection
            .list_documents_owned_by(SAVED_PROJECTS_COLLECTION_NAME, owning_account)
            .await
            .map_err(map_document_collection_failure_to_http_error)
    }
}

/// 3 — Fetch every saved project and keep only the ones where the account is
/// listed as a collaborator (and is not itself the owner, to avoid double-counting).
fn list_saved_project_documents_shared_with_account<'a, TransactionalUnitOfWork: UnitOfWork>(
    application_state: &'a ApplicationState<TransactionalUnitOfWork>,
    owning_account: &'a str,
) -> impl std::future::Future<Output = Result<Vec<StoredDocument>, HttpError>> + 'a {
    async move {
        let all_documents = application_state
            .document_collection
            .list_documents(SAVED_PROJECTS_COLLECTION_NAME)
            .await
            .map_err(map_document_collection_failure_to_http_error)?;

        let shared_documents = all_documents
            .into_iter()
            .filter(|candidate_document| {
                !determine_project_ownership_flag(candidate_document, owning_account)
                    && document_lists_account_as_collaborator(candidate_document, owning_account)
            })
            .collect();
        Ok(shared_documents)
    }
}

/// 4 — Decide whether the account appears in a document's collaborator list.
fn document_lists_account_as_collaborator(
    candidate_document: &StoredDocument,
    owning_account: &str,
) -> bool {
    let collaborator_emails = extract_project_collaborator_emails(candidate_document);
    collaborator_emails
        .iter()
        .any(|collaborator_email| collaborator_email.eq_ignore_ascii_case(owning_account))
}

/// 5 — Derive a human-friendly display name from a stored document, falling back
/// to the raw name, the identifier, and finally a placeholder.
fn extract_project_display_name_from_document(stored_document: &StoredDocument) -> String {
    let body = &stored_document.document_body;
    if let Some(display_name) = body.get("displayName").and_then(Value::as_str) {
        if !display_name.trim().is_empty() {
            return display_name.to_string();
        }
    }
    if let Some(name) = body.get("name").and_then(Value::as_str) {
        if !name.trim().is_empty() {
            return name.to_string();
        }
    }
    if !stored_document.document_identifier.trim().is_empty() {
        return stored_document.document_identifier.clone();
    }
    "Untitled Project".to_string()
}

/// 6 — Collect collaborator emails from either a list of plain strings or a list
/// of objects carrying an `emailAddress` field.
fn extract_project_collaborator_emails(stored_document: &StoredDocument) -> Vec<String> {
    let mut emails = Vec::new();
    let Some(raw_collaborators) = stored_document
        .document_body
        .get("collaborators")
        .and_then(Value::as_array)
    else {
        return emails;
    };

    for collaborator in raw_collaborators {
        if let Some(email_text) = collaborator.as_str() {
            let trimmed = email_text.trim();
            if !trimmed.is_empty() {
                emails.push(trimmed.to_string());
            }
        } else if let Some(email_text) = collaborator
            .get("emailAddress")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            emails.push(email_text.trim().to_string());
        }
    }
    emails
}

/// 7 — True when the account owns the document (by owning_account field, or by an
/// `owners[].emailAddress` entry in the body).
fn determine_project_ownership_flag(stored_document: &StoredDocument, owning_account: &str) -> bool {
    if let Some(account) = &stored_document.owning_account {
        if account.eq_ignore_ascii_case(owning_account) {
            return true;
        }
    }
    if let Some(owners) = stored_document
        .document_body
        .get("owners")
        .and_then(Value::as_array)
    {
        return owners.iter().any(|owner| {
            owner
                .get("emailAddress")
                .and_then(Value::as_str)
                .map(|email| email.eq_ignore_ascii_case(owning_account))
                .unwrap_or(false)
        });
    }
    false
}

/// Shared building block for both owned and shared listing entries.
fn render_project_document_as_listing_entry(
    stored_document: &StoredDocument,
    owning_account: &str,
    force_shared: bool,
) -> Value {
    let body = &stored_document.document_body;
    let display_name = extract_project_display_name_from_document(stored_document);
    let collaborator_emails = extract_project_collaborator_emails(stored_document);
    let is_owned = determine_project_ownership_flag(stored_document, owning_account);
    let is_shared = force_shared || !is_owned || !collaborator_emails.is_empty();

    let created_time = body
        .get("createdTime")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let modified_time = body
        .get("modifiedTime")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let alma_root_name = body
        .get("almaRootName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let alma_root_owner = body
        .get("almaRootOwner")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    json!({
        "id": stored_document.document_identifier,
        "name": display_name,
        "displayName": display_name,
        "createdTime": created_time,
        "modifiedTime": modified_time,
        "collaborators": collaborator_emails,
        "almaRootName": alma_root_name,
        "almaRootOwner": alma_root_owner,
        "isOwnedByCurrentUser": is_owned,
        "hasUserAccess": true,
        "shared": is_shared
    })
}

/// 8 — Render an owned document into a listing entry.
fn render_owned_project_document_as_listing_entry(
    stored_document: &StoredDocument,
    owning_account: &str,
) -> Value {
    render_project_document_as_listing_entry(stored_document, owning_account, false)
}

/// 9 — Render a shared document into a listing entry (always flagged shared).
fn render_shared_project_document_as_listing_entry(
    stored_document: &StoredDocument,
    owning_account: &str,
) -> Value {
    render_project_document_as_listing_entry(stored_document, owning_account, true)
}

/// 10 — Drop duplicate entries that share the same `id`, keeping the first seen.
fn deduplicate_project_entries_by_identifier(project_entries: Vec<Value>) -> Vec<Value> {
    let mut seen_identifiers: Vec<String> = Vec::new();
    let mut unique_entries: Vec<Value> = Vec::new();
    for entry in project_entries {
        let identifier = entry
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if identifier.is_empty() {
            unique_entries.push(entry);
            continue;
        }
        if seen_identifiers.iter().any(|seen| seen == &identifier) {
            continue;
        }
        seen_identifiers.push(identifier);
        unique_entries.push(entry);
    }
    unique_entries
}

/// 11 — Concatenate owned entries first, then shared, then deduplicate.
fn merge_owned_and_shared_project_entries(
    owned_entries: Vec<Value>,
    shared_entries: Vec<Value>,
) -> Vec<Value> {
    let mut combined = Vec::with_capacity(owned_entries.len() + shared_entries.len());
    combined.extend(owned_entries);
    combined.extend(shared_entries);
    deduplicate_project_entries_by_identifier(combined)
}

/// 12 — Sort listing entries by their `modifiedTime` string, newest first.
fn sort_project_entries_by_modified_time_descending(project_entries: &mut Vec<Value>) {
    project_entries.sort_by(|left, right| {
        let left_time = left.get("modifiedTime").and_then(Value::as_str).unwrap_or("");
        let right_time = right
            .get("modifiedTime")
            .and_then(Value::as_str)
            .unwrap_or("");
        right_time.cmp(left_time)
    });
}

/// 13 — Count how many entries the account owns versus has shared access to.
fn count_owned_versus_shared_projects(
    project_entries: &[Value],
    _owning_account: &str,
) -> (usize, usize) {
    let mut owned_count = 0usize;
    let mut shared_count = 0usize;
    for entry in project_entries {
        let is_owned = entry
            .get("isOwnedByCurrentUser")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if is_owned {
            owned_count += 1;
        } else {
            shared_count += 1;
        }
    }
    (owned_count, shared_count)
}

/// 14 — Wrap the entries in the response envelope with a small summary.
fn build_projects_listing_payload(project_entries: Vec<Value>) -> Value {
    let total_count = project_entries.len();
    let (owned_count, shared_count) =
        count_owned_versus_shared_projects(&project_entries, "");
    json!({
        "projects": project_entries,
        "summary": {
            "totalCount": total_count,
            "ownedCount": owned_count,
            "sharedCount": shared_count
        }
    })
}

/// 15 — Translate an ApplicationError from the document collection into an HttpError.
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
        other_error => HttpError::UpstreamApplicationFailure {
            explanation: other_error.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document_with_body(identifier: &str, owner: Option<&str>, body: Value) -> StoredDocument {
        StoredDocument {
            document_identifier: identifier.to_string(),
            owning_account: owner.map(|value| value.to_string()),
            document_body: body,
        }
    }

    #[test]
    fn document_lists_account_as_collaborator_matches_string_and_object_forms() {
        let string_form = document_with_body(
            "p1",
            None,
            json!({ "collaborators": ["alice@example.com", "bob@example.com"] }),
        );
        let object_form = document_with_body(
            "p2",
            None,
            json!({ "collaborators": [{ "emailAddress": "carol@example.com" }] }),
        );

        assert!(document_lists_account_as_collaborator(
            &string_form,
            "BOB@example.com"
        ));
        assert!(document_lists_account_as_collaborator(
            &object_form,
            "carol@example.com"
        ));
        assert!(!document_lists_account_as_collaborator(
            &string_form,
            "nobody@example.com"
        ));
    }

    #[test]
    fn extract_project_display_name_prefers_display_name_then_name_then_id() {
        let with_display = document_with_body(
            "id-1",
            None,
            json!({ "displayName": "Aurora", "name": "aurora-raw" }),
        );
        assert_eq!(
            extract_project_display_name_from_document(&with_display),
            "Aurora"
        );

        let with_name = document_with_body("id-2", None, json!({ "name": "Borealis" }));
        assert_eq!(
            extract_project_display_name_from_document(&with_name),
            "Borealis"
        );

        let with_only_id = document_with_body("id-3", None, json!({}));
        assert_eq!(
            extract_project_display_name_from_document(&with_only_id),
            "id-3"
        );

        let empty = document_with_body("", None, json!({ "displayName": "   " }));
        assert_eq!(
            extract_project_display_name_from_document(&empty),
            "Untitled Project"
        );
    }

    #[test]
    fn extract_project_collaborator_emails_handles_mixed_and_missing() {
        let mixed = document_with_body(
            "p",
            None,
            json!({
                "collaborators": [
                    "  a@example.com  ",
                    { "emailAddress": "b@example.com" },
                    { "emailAddress": "  " },
                    "",
                    42
                ]
            }),
        );
        let emails = extract_project_collaborator_emails(&mixed);
        assert_eq!(emails, vec!["a@example.com", "b@example.com"]);

        let none = document_with_body("p", None, json!({}));
        assert!(extract_project_collaborator_emails(&none).is_empty());
    }

    #[test]
    fn determine_project_ownership_flag_uses_owning_account_and_owners_field() {
        let by_owning_account =
            document_with_body("p", Some("me@example.com"), json!({}));
        assert!(determine_project_ownership_flag(
            &by_owning_account,
            "ME@example.com"
        ));

        let by_owners_field = document_with_body(
            "p",
            None,
            json!({ "owners": [{ "emailAddress": "me@example.com" }] }),
        );
        assert!(determine_project_ownership_flag(
            &by_owners_field,
            "me@example.com"
        ));

        let not_owner = document_with_body(
            "p",
            Some("someone@example.com"),
            json!({ "owners": [{ "emailAddress": "other@example.com" }] }),
        );
        assert!(!determine_project_ownership_flag(&not_owner, "me@example.com"));
    }

    #[test]
    fn render_owned_project_document_produces_expected_fields() {
        let document = document_with_body(
            "proj-1",
            Some("me@example.com"),
            json!({
                "displayName": "My Project",
                "createdTime": "2026-01-01T00:00:00.000Z",
                "modifiedTime": "2026-02-01T00:00:00.000Z",
                "almaRootName": "Root",
                "almaRootOwner": "me@example.com"
            }),
        );
        let entry = render_owned_project_document_as_listing_entry(&document, "me@example.com");
        assert_eq!(entry.get("id").unwrap(), "proj-1");
        assert_eq!(entry.get("displayName").unwrap(), "My Project");
        assert_eq!(entry.get("isOwnedByCurrentUser").unwrap(), true);
        assert_eq!(entry.get("hasUserAccess").unwrap(), true);
    }

    #[test]
    fn render_shared_project_document_forces_shared_flag() {
        let document = document_with_body(
            "proj-2",
            Some("owner@example.com"),
            json!({ "displayName": "Shared" }),
        );
        let entry = render_shared_project_document_as_listing_entry(&document, "me@example.com");
        assert_eq!(entry.get("shared").unwrap(), true);
        assert_eq!(entry.get("isOwnedByCurrentUser").unwrap(), false);
    }

    #[test]
    fn deduplicate_project_entries_keeps_first_and_drops_repeats() {
        let entries = vec![
            json!({ "id": "a", "name": "first" }),
            json!({ "id": "b", "name": "second" }),
            json!({ "id": "a", "name": "duplicate" }),
            json!({ "name": "no-id" }),
        ];
        let deduped = deduplicate_project_entries_by_identifier(entries);
        assert_eq!(deduped.len(), 3);
        assert_eq!(deduped[0].get("name").unwrap(), "first");
    }

    #[test]
    fn merge_owned_and_shared_orders_owned_first_and_dedupes() {
        let owned = vec![json!({ "id": "x", "name": "owned" })];
        let shared = vec![
            json!({ "id": "x", "name": "shared-dup" }),
            json!({ "id": "y", "name": "shared" }),
        ];
        let merged = merge_owned_and_shared_project_entries(owned, shared);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].get("name").unwrap(), "owned");
        assert_eq!(merged[1].get("id").unwrap(), "y");
    }

    #[test]
    fn sort_project_entries_by_modified_time_is_descending() {
        let mut entries = vec![
            json!({ "id": "a", "modifiedTime": "2026-01-01T00:00:00.000Z" }),
            json!({ "id": "b", "modifiedTime": "2026-06-01T00:00:00.000Z" }),
            json!({ "id": "c", "modifiedTime": "2026-03-01T00:00:00.000Z" }),
        ];
        sort_project_entries_by_modified_time_descending(&mut entries);
        assert_eq!(entries[0].get("id").unwrap(), "b");
        assert_eq!(entries[1].get("id").unwrap(), "c");
        assert_eq!(entries[2].get("id").unwrap(), "a");
    }

    #[test]
    fn count_owned_versus_shared_projects_tallies_by_flag() {
        let entries = vec![
            json!({ "isOwnedByCurrentUser": true }),
            json!({ "isOwnedByCurrentUser": false }),
            json!({ "isOwnedByCurrentUser": true }),
            json!({}),
        ];
        let (owned, shared) = count_owned_versus_shared_projects(&entries, "me@example.com");
        assert_eq!(owned, 2);
        assert_eq!(shared, 2);
    }

    #[test]
    fn build_projects_listing_payload_includes_summary() {
        let entries = vec![
            json!({ "id": "a", "isOwnedByCurrentUser": true }),
            json!({ "id": "b", "isOwnedByCurrentUser": false }),
        ];
        let payload = build_projects_listing_payload(entries);
        assert_eq!(payload.get("summary").unwrap().get("totalCount").unwrap(), 2);
        assert_eq!(payload.get("summary").unwrap().get("ownedCount").unwrap(), 1);
        assert_eq!(
            payload.get("summary").unwrap().get("sharedCount").unwrap(),
            1
        );
        assert!(payload.get("projects").unwrap().is_array());
    }

    #[test]
    fn map_document_collection_failure_maps_variants() {
        let not_found = map_document_collection_failure_to_http_error(
            ApplicationError::RequestedResourceCouldNotBeLocated,
        );
        assert!(matches!(
            not_found,
            HttpError::RequestedResourceWasNotFound { .. }
        ));

        let denied = map_document_collection_failure_to_http_error(
            ApplicationError::AuthorizationWasDenied,
        );
        assert!(matches!(denied, HttpError::AuthorizationWasDenied { .. }));

        let upstream = map_document_collection_failure_to_http_error(
            ApplicationError::DocumentCollectionFailure {
                failure_description: "boom".to_string(),
            },
        );
        assert!(matches!(
            upstream,
            HttpError::UpstreamApplicationFailure { .. }
        ));
    }
}
