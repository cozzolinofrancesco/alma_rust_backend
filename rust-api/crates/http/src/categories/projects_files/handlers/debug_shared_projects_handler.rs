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

/// Diagnostic endpoint that inspects the saved-projects collection and reports
/// ownership / sharing statistics for the currently authenticated principal.
///
/// This handler is intentionally read-only: it never mutates any document. It
/// exists so operators can debug "why does this account not see the shared
/// project it expects" style questions.
#[route(method = "GET", path = "/api/debug-shared-projects")]
pub async fn debug_shared_projects_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let owning_account = extract_owning_account_from_authorized_request(&authorized_request);

    let total_count = count_all_saved_project_documents(&application_state).await?;
    let all_documents = list_all_saved_project_documents(&application_state).await?;

    let (owned_documents, _other_documents) =
        partition_documents_by_ownership(all_documents.clone(), &owning_account);
    let owned_count = owned_documents.len();

    let shared_with_account_count =
        count_documents_shared_with_account(&all_documents, &owning_account);

    let diagnostic_entries =
        build_shared_projects_diagnostic_entries(&all_documents, &owning_account);

    let documents_missing_owning_account =
        collect_documents_missing_owning_account(&all_documents);
    let orphaned_share_references = detect_orphaned_share_references(&all_documents);

    let payload = assemble_debug_shared_projects_payload(
        total_count,
        owned_count,
        shared_with_account_count,
        diagnostic_entries,
        documents_missing_owning_account,
        orphaned_share_references,
    );

    Ok(Json(payload))
}

/// (1) Pull the owning account (the authenticated principal's email) out of the
/// authorized request context as a plain owned `String`.
fn extract_owning_account_from_authorized_request(
    authorized_request: &HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> String {
    authorized_request.authorized_principal().as_str().to_string()
}

/// (2) Count every document currently held in the saved-projects collection.
fn count_all_saved_project_documents<'a, TransactionalUnitOfWork: UnitOfWork>(
    application_state: &'a ApplicationState<TransactionalUnitOfWork>,
) -> impl std::future::Future<Output = Result<usize, HttpError>> + 'a {
    async move {
        application_state
            .document_collection
            .count_documents(SAVED_PROJECTS_COLLECTION_NAME)
            .await
            .map_err(map_document_collection_failure_to_http_error)
    }
}

/// (3) List every document currently held in the saved-projects collection.
fn list_all_saved_project_documents<'a, TransactionalUnitOfWork: UnitOfWork>(
    application_state: &'a ApplicationState<TransactionalUnitOfWork>,
) -> impl std::future::Future<Output = Result<Vec<StoredDocument>, HttpError>> + 'a {
    async move {
        application_state
            .document_collection
            .list_documents(SAVED_PROJECTS_COLLECTION_NAME)
            .await
            .map_err(map_document_collection_failure_to_http_error)
    }
}

/// (4) Split a set of documents into `(owned_by_account, everything_else)`.
///
/// A document is considered owned by the account when its `owning_account`
/// field matches exactly (case-insensitively) the supplied account.
fn partition_documents_by_ownership(
    all_documents: Vec<StoredDocument>,
    owning_account: &str,
) -> (Vec<StoredDocument>, Vec<StoredDocument>) {
    let normalized_account = owning_account.trim().to_ascii_lowercase();
    let mut owned = Vec::new();
    let mut other = Vec::new();

    for candidate_document in all_documents {
        let is_owned = candidate_document
            .owning_account
            .as_deref()
            .map(|account| account.trim().to_ascii_lowercase() == normalized_account)
            .unwrap_or(false);

        if is_owned {
            owned.push(candidate_document);
        } else {
            other.push(candidate_document);
        }
    }

    (owned, other)
}

/// (5) Decide whether a document declares itself as "shared".
///
/// We look for an explicit boolean `is_shared` / `shared` flag in the body, or
/// the presence of a non-empty collaborators list.
fn document_declares_shared_flag(candidate_document: &StoredDocument) -> bool {
    let body = &candidate_document.document_body;

    let explicit_flag = body
        .get("is_shared")
        .and_then(Value::as_bool)
        .or_else(|| body.get("shared").and_then(Value::as_bool))
        .unwrap_or(false);

    if explicit_flag {
        return true;
    }

    !extract_collaborator_emails_from_document(candidate_document).is_empty()
}

/// (6) Extract every collaborator email declared on a document.
///
/// Collaborators may be stored under `collaborators`, `shared_with`, or
/// `shared_with_emails`. Each may be either an array of strings, or an array of
/// objects carrying an `email` field. All shapes are flattened into a deduped,
/// lowercased list.
fn extract_collaborator_emails_from_document(candidate_document: &StoredDocument) -> Vec<String> {
    let body = &candidate_document.document_body;
    let mut collected: Vec<String> = Vec::new();

    for field_name in ["collaborators", "shared_with", "shared_with_emails"] {
        let Some(array) = body.get(field_name).and_then(Value::as_array) else {
            continue;
        };

        for entry in array {
            let email_candidate = match entry {
                Value::String(raw) => Some(raw.clone()),
                Value::Object(_) => entry
                    .get("email")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                _ => None,
            };

            if let Some(raw_email) = email_candidate {
                let normalized = raw_email.trim().to_ascii_lowercase();
                if !normalized.is_empty() && !collected.contains(&normalized) {
                    collected.push(normalized);
                }
            }
        }
    }

    collected
}

/// (7) Does the given account appear as a collaborator on the document?
fn account_appears_as_collaborator(candidate_document: &StoredDocument, owning_account: &str) -> bool {
    let normalized_account = owning_account.trim().to_ascii_lowercase();
    if normalized_account.is_empty() {
        return false;
    }
    extract_collaborator_emails_from_document(candidate_document)
        .iter()
        .any(|collaborator| collaborator == &normalized_account)
}

/// (8) Count documents that are shared *with* the account (i.e. the account is a
/// collaborator but not the owner).
fn count_documents_shared_with_account(
    all_documents: &[StoredDocument],
    owning_account: &str,
) -> usize {
    let normalized_account = owning_account.trim().to_ascii_lowercase();

    all_documents
        .iter()
        .filter(|candidate_document| {
            let is_owner = candidate_document
                .owning_account
                .as_deref()
                .map(|account| account.trim().to_ascii_lowercase() == normalized_account)
                .unwrap_or(false);

            !is_owner && account_appears_as_collaborator(candidate_document, owning_account)
        })
        .count()
}

/// (9) Produce a compact JSON diagnostic for a single document relative to the
/// supplied account.
fn summarize_document_ownership_diagnostics(
    candidate_document: &StoredDocument,
    owning_account: &str,
) -> Value {
    let normalized_account = owning_account.trim().to_ascii_lowercase();
    let is_owner = candidate_document
        .owning_account
        .as_deref()
        .map(|account| account.trim().to_ascii_lowercase() == normalized_account)
        .unwrap_or(false);

    json!({
        "document_identifier": candidate_document.document_identifier,
        "owning_account": candidate_document.owning_account,
        "is_owned_by_account": is_owner,
        "declares_shared_flag": document_declares_shared_flag(candidate_document),
        "account_is_collaborator": account_appears_as_collaborator(candidate_document, owning_account),
        "collaborator_count": extract_collaborator_emails_from_document(candidate_document).len(),
    })
}

/// (10) Identify documents that carry no owning account at all — a data-hygiene
/// problem worth surfacing to operators.
fn collect_documents_missing_owning_account(all_documents: &[StoredDocument]) -> Vec<String> {
    all_documents
        .iter()
        .filter(|candidate_document| match &candidate_document.owning_account {
            None => true,
            Some(account) => account.trim().is_empty(),
        })
        .map(|candidate_document| candidate_document.document_identifier.clone())
        .collect()
}

/// (11) Detect "orphaned" share references: documents that declare a shared flag
/// but list zero collaborators (so nobody can actually access the share).
fn detect_orphaned_share_references(all_documents: &[StoredDocument]) -> Vec<String> {
    all_documents
        .iter()
        .filter(|candidate_document| {
            let body = &candidate_document.document_body;
            let explicit_flag = body
                .get("is_shared")
                .and_then(Value::as_bool)
                .or_else(|| body.get("shared").and_then(Value::as_bool))
                .unwrap_or(false);

            explicit_flag && extract_collaborator_emails_from_document(candidate_document).is_empty()
        })
        .map(|candidate_document| candidate_document.document_identifier.clone())
        .collect()
}

/// (12) Build the per-document diagnostic entries that the payload exposes. Only
/// documents relevant to the account (owned or shared-with) are included so the
/// output stays focused.
fn build_shared_projects_diagnostic_entries(
    all_documents: &[StoredDocument],
    owning_account: &str,
) -> Vec<Value> {
    let normalized_account = owning_account.trim().to_ascii_lowercase();

    all_documents
        .iter()
        .filter(|candidate_document| {
            let is_owner = candidate_document
                .owning_account
                .as_deref()
                .map(|account| account.trim().to_ascii_lowercase() == normalized_account)
                .unwrap_or(false);

            is_owner || account_appears_as_collaborator(candidate_document, owning_account)
        })
        .map(|candidate_document| {
            summarize_document_ownership_diagnostics(candidate_document, owning_account)
        })
        .collect()
}

/// (13) Compute the ratio of shared documents to the total, guarding against a
/// division by zero when the collection is empty.
fn compute_shared_project_ratio(shared_count: usize, total_count: usize) -> f64 {
    if total_count == 0 {
        return 0.0;
    }
    shared_count as f64 / total_count as f64
}

/// (14) Assemble the final diagnostic payload returned to the caller.
fn assemble_debug_shared_projects_payload(
    total_count: usize,
    owned_count: usize,
    shared_with_account_count: usize,
    diagnostic_entries: Vec<Value>,
    documents_missing_owning_account: Vec<String>,
    orphaned_share_references: Vec<String>,
) -> Value {
    let shared_project_ratio = compute_shared_project_ratio(shared_with_account_count, total_count);

    json!({
        "shared_project_count": shared_with_account_count,
        "total_saved_project_count": total_count,
        "owned_by_account_count": owned_count,
        "shared_with_account_count": shared_with_account_count,
        "shared_project_ratio": shared_project_ratio,
        "diagnostic_entries": diagnostic_entries,
        "documents_missing_owning_account": documents_missing_owning_account,
        "orphaned_share_references": orphaned_share_references,
    })
}

/// (15) Translate a document-collection failure into an `HttpError`. Not-found
/// style failures map to a 404-equivalent; everything else is an upstream
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
        other => HttpError::UpstreamApplicationFailure {
            explanation: other.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document_with_body(identifier: &str, owner: Option<&str>, body: Value) -> StoredDocument {
        StoredDocument {
            document_identifier: identifier.to_string(),
            owning_account: owner.map(str::to_string),
            document_body: body,
        }
    }

    #[test]
    fn partition_documents_by_ownership_splits_correctly() {
        let documents = vec![
            document_with_body("a", Some("Owner@Example.com"), json!({})),
            document_with_body("b", Some("other@example.com"), json!({})),
            document_with_body("c", None, json!({})),
        ];

        let (owned, other) = partition_documents_by_ownership(documents, "owner@example.com");
        assert_eq!(owned.len(), 1);
        assert_eq!(owned[0].document_identifier, "a");
        assert_eq!(other.len(), 2);
    }

    #[test]
    fn partition_documents_by_ownership_handles_empty_input() {
        let (owned, other) = partition_documents_by_ownership(Vec::new(), "someone@example.com");
        assert!(owned.is_empty());
        assert!(other.is_empty());
    }

    #[test]
    fn document_declares_shared_flag_detects_explicit_flag() {
        let shared = document_with_body("a", Some("o@e.com"), json!({ "is_shared": true }));
        let not_shared = document_with_body("b", Some("o@e.com"), json!({ "is_shared": false }));
        assert!(document_declares_shared_flag(&shared));
        assert!(!document_declares_shared_flag(&not_shared));
    }

    #[test]
    fn document_declares_shared_flag_detects_collaborators() {
        let shared = document_with_body(
            "a",
            Some("o@e.com"),
            json!({ "collaborators": ["c@e.com"] }),
        );
        let empty = document_with_body("b", Some("o@e.com"), json!({}));
        assert!(document_declares_shared_flag(&shared));
        assert!(!document_declares_shared_flag(&empty));
    }

    #[test]
    fn extract_collaborator_emails_flattens_and_dedupes() {
        let document = document_with_body(
            "a",
            Some("o@e.com"),
            json!({
                "collaborators": ["Alice@Example.com", { "email": "bob@example.com" }],
                "shared_with": ["alice@example.com"],
            }),
        );
        let emails = extract_collaborator_emails_from_document(&document);
        assert_eq!(emails.len(), 2);
        assert!(emails.contains(&"alice@example.com".to_string()));
        assert!(emails.contains(&"bob@example.com".to_string()));
    }

    #[test]
    fn extract_collaborator_emails_returns_empty_when_absent() {
        let document = document_with_body("a", Some("o@e.com"), json!({ "title": "x" }));
        assert!(extract_collaborator_emails_from_document(&document).is_empty());
    }

    #[test]
    fn account_appears_as_collaborator_matches_case_insensitively() {
        let document = document_with_body(
            "a",
            Some("o@e.com"),
            json!({ "collaborators": ["Person@Example.com"] }),
        );
        assert!(account_appears_as_collaborator(&document, "person@example.com"));
        assert!(!account_appears_as_collaborator(&document, "nobody@example.com"));
    }

    #[test]
    fn account_appears_as_collaborator_rejects_empty_account() {
        let document = document_with_body(
            "a",
            Some("o@e.com"),
            json!({ "collaborators": ["person@example.com"] }),
        );
        assert!(!account_appears_as_collaborator(&document, "   "));
    }

    #[test]
    fn count_documents_shared_with_account_excludes_owned() {
        let documents = vec![
            // owned by account, also lists account as collaborator -> not counted
            document_with_body(
                "a",
                Some("me@example.com"),
                json!({ "collaborators": ["me@example.com"] }),
            ),
            // shared with account -> counted
            document_with_body(
                "b",
                Some("other@example.com"),
                json!({ "collaborators": ["me@example.com"] }),
            ),
            // unrelated -> not counted
            document_with_body("c", Some("other@example.com"), json!({})),
        ];
        assert_eq!(count_documents_shared_with_account(&documents, "me@example.com"), 1);
    }

    #[test]
    fn summarize_document_ownership_diagnostics_reports_fields() {
        let document = document_with_body(
            "a",
            Some("me@example.com"),
            json!({ "collaborators": ["x@example.com"] }),
        );
        let summary = summarize_document_ownership_diagnostics(&document, "me@example.com");
        assert_eq!(summary["document_identifier"], "a");
        assert_eq!(summary["is_owned_by_account"], true);
        assert_eq!(summary["collaborator_count"], 1);
    }

    #[test]
    fn collect_documents_missing_owning_account_finds_gaps() {
        let documents = vec![
            document_with_body("a", Some("me@example.com"), json!({})),
            document_with_body("b", None, json!({})),
            document_with_body("c", Some("   "), json!({})),
        ];
        let missing = collect_documents_missing_owning_account(&documents);
        assert_eq!(missing, vec!["b".to_string(), "c".to_string()]);
    }

    #[test]
    fn collect_documents_missing_owning_account_empty_when_all_present() {
        let documents = vec![document_with_body("a", Some("me@example.com"), json!({}))];
        assert!(collect_documents_missing_owning_account(&documents).is_empty());
    }

    #[test]
    fn detect_orphaned_share_references_finds_flag_without_collaborators() {
        let documents = vec![
            document_with_body("a", Some("o@e.com"), json!({ "is_shared": true })),
            document_with_body(
                "b",
                Some("o@e.com"),
                json!({ "is_shared": true, "collaborators": ["c@e.com"] }),
            ),
            document_with_body("c", Some("o@e.com"), json!({ "is_shared": false })),
        ];
        let orphaned = detect_orphaned_share_references(&documents);
        assert_eq!(orphaned, vec!["a".to_string()]);
    }

    #[test]
    fn build_shared_projects_diagnostic_entries_includes_owned_and_shared() {
        let documents = vec![
            document_with_body("owned", Some("me@example.com"), json!({})),
            document_with_body(
                "shared",
                Some("other@example.com"),
                json!({ "collaborators": ["me@example.com"] }),
            ),
            document_with_body("unrelated", Some("other@example.com"), json!({})),
        ];
        let entries = build_shared_projects_diagnostic_entries(&documents, "me@example.com");
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn compute_shared_project_ratio_guards_zero() {
        assert_eq!(compute_shared_project_ratio(0, 0), 0.0);
        assert_eq!(compute_shared_project_ratio(1, 4), 0.25);
    }

    #[test]
    fn assemble_debug_shared_projects_payload_shapes_output() {
        let payload = assemble_debug_shared_projects_payload(
            10,
            3,
            2,
            vec![json!({ "document_identifier": "a" })],
            vec!["missing".to_string()],
            vec!["orphaned".to_string()],
        );
        assert_eq!(payload["total_saved_project_count"], 10);
        assert_eq!(payload["owned_by_account_count"], 3);
        assert_eq!(payload["shared_project_count"], 2);
        assert_eq!(payload["shared_with_account_count"], 2);
        assert_eq!(payload["shared_project_ratio"], 0.2);
        assert!(payload["diagnostic_entries"].is_array());
        assert_eq!(payload["documents_missing_owning_account"][0], "missing");
        assert_eq!(payload["orphaned_share_references"][0], "orphaned");
    }

    #[test]
    fn map_document_collection_failure_maps_not_found() {
        let error = map_document_collection_failure_to_http_error(
            ApplicationError::RequestedResourceCouldNotBeLocated,
        );
        assert!(matches!(error, HttpError::RequestedResourceWasNotFound { .. }));
    }

    #[test]
    fn map_document_collection_failure_maps_generic() {
        let error = map_document_collection_failure_to_http_error(
            ApplicationError::DocumentCollectionFailure {
                failure_description: "boom".to_string(),
            },
        );
        assert!(matches!(error, HttpError::UpstreamApplicationFailure { .. }));
    }
}
