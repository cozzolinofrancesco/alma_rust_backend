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
use std::collections::HashMap;

/// The document kind marker this endpoint is responsible for surfacing.
const AI3D_PROJECT_KIND_MARKER: &str = "ai3d-project";

/// The fallback timestamp used when a stored project omits its modification time.
const FALLBACK_MODIFIED_TIMESTAMP: &str = "1970-01-01T00:00:00.000Z";

/// The fallback display name used when a stored project omits a human-readable name.
const FALLBACK_DISPLAY_NAME: &str = "Untitled Project";

/// The default version label reported for projects that never recorded one.
const FALLBACK_VERSION_LABEL: &str = "v1";

#[route(method = "GET", path = "/api/list-saved-projects")]
pub async fn list_saved_projects_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let owning_account = extract_owning_account_from_authorized_request(&authorized_request);

    let stored_documents =
        list_saved_project_documents_for_account(&application_state, &owning_account).await?;

    let ai3d_project_documents = filter_saved_documents_to_ai3d_projects(stored_documents);

    let mut listing_entries: Vec<Value> = ai3d_project_documents
        .iter()
        .map(render_saved_document_as_listing_entry)
        .collect();

    sort_saved_project_entries_by_modified_time_descending(&mut listing_entries);

    // This endpoint carries no query extractor, so the kind filter is always absent;
    // building it from an empty parameter map keeps the filtering path exercised and
    // ready for callers that later pass an explicit `kind` selector.
    let query_parameters: HashMap<String, String> = HashMap::new();
    let kind_filter = extract_optional_kind_filter_from_query(&query_parameters);
    let filtered_entries = apply_kind_filter_to_saved_entries(listing_entries, &kind_filter);

    let payload = build_saved_projects_listing_payload(filtered_entries);

    Ok(Json(payload))
}

/// Pull the authenticated principal's email out of the request pipeline as a plain string.
fn extract_owning_account_from_authorized_request(
    authorized_request: &HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> String {
    authorized_request
        .authorized_principal()
        .as_str()
        .to_string()
}

/// Fetch every saved-project document owned by the supplied account, translating any
/// document-collection failure into an [`HttpError`].
fn list_saved_project_documents_for_account<'a, TransactionalUnitOfWork: UnitOfWork>(
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

/// Determine whether a stored document declares the AI-3D project kind. Accepts either a
/// top-level `kind` field or a nested `metadata.kind` field so older records still match.
fn document_declares_ai3d_project_kind(candidate_document: &StoredDocument) -> bool {
    let body = &candidate_document.document_body;

    let top_level_kind = body.get("kind").and_then(Value::as_str);
    if top_level_kind == Some(AI3D_PROJECT_KIND_MARKER) {
        return true;
    }

    let nested_kind = body
        .get("metadata")
        .and_then(|metadata| metadata.get("kind"))
        .and_then(Value::as_str);

    nested_kind == Some(AI3D_PROJECT_KIND_MARKER)
}

/// Retain only the documents that declare the AI-3D project kind.
fn filter_saved_documents_to_ai3d_projects(all_documents: Vec<StoredDocument>) -> Vec<StoredDocument> {
    all_documents
        .into_iter()
        .filter(document_declares_ai3d_project_kind)
        .collect()
}

/// Extract the human-readable display name, preferring `displayName`, then `name`,
/// then a stored `title`, and finally a stable fallback.
fn extract_saved_project_display_name(stored_document: &StoredDocument) -> String {
    let body = &stored_document.document_body;

    for candidate_key in ["displayName", "name", "title"] {
        if let Some(candidate_value) = body.get(candidate_key).and_then(Value::as_str) {
            let trimmed = candidate_value.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }

    FALLBACK_DISPLAY_NAME.to_string()
}

/// Extract the last-modified timestamp, preferring `modifiedTime`, then `updatedAt`,
/// then `createdAt`, and falling back to the epoch when none are present.
fn extract_saved_project_modified_timestamp(stored_document: &StoredDocument) -> String {
    let body = &stored_document.document_body;

    for candidate_key in ["modifiedTime", "updatedAt", "createdAt"] {
        if let Some(candidate_value) = body.get(candidate_key).and_then(Value::as_str) {
            let trimmed = candidate_value.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }

    FALLBACK_MODIFIED_TIMESTAMP.to_string()
}

/// Compute the serialized byte size of the stored document body. Prefers an explicitly
/// recorded numeric `size` field when present, otherwise measures the serialized JSON.
fn compute_saved_project_serialized_size_bytes(stored_document: &StoredDocument) -> usize {
    if let Some(recorded_size) = stored_document.document_body.get("size").and_then(Value::as_u64) {
        return recorded_size as usize;
    }

    serde_json::to_string(&stored_document.document_body)
        .map(|serialized| serialized.len())
        .unwrap_or(0)
}

/// Extract the version label, accepting a string `version`, a numeric `version`
/// (rendered as `v<n>`), or a nested `metadata.version`. Falls back to `v1`.
fn extract_saved_project_version_label(stored_document: &StoredDocument) -> String {
    let body = &stored_document.document_body;

    if let Some(version_text) = body.get("version").and_then(Value::as_str) {
        let trimmed = version_text.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    if let Some(version_number) = body.get("version").and_then(Value::as_u64) {
        return format!("v{version_number}");
    }

    if let Some(nested_version) = body
        .get("metadata")
        .and_then(|metadata| metadata.get("version"))
        .and_then(Value::as_str)
    {
        let trimmed = nested_version.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    FALLBACK_VERSION_LABEL.to_string()
}

/// Render one stored document into the compact listing entry the frontend expects.
fn render_saved_document_as_listing_entry(stored_document: &StoredDocument) -> Value {
    json!({
        "id": stored_document.document_identifier,
        "owningAccount": stored_document.owning_account,
        "displayName": extract_saved_project_display_name(stored_document),
        "modifiedTime": extract_saved_project_modified_timestamp(stored_document),
        "size": compute_saved_project_serialized_size_bytes(stored_document),
        "version": extract_saved_project_version_label(stored_document),
        "kind": AI3D_PROJECT_KIND_MARKER,
    })
}

/// Sort listing entries so the most-recently-modified projects appear first. Entries
/// missing a comparable timestamp sort to the bottom by treating them as the epoch.
fn sort_saved_project_entries_by_modified_time_descending(saved_entries: &mut Vec<Value>) {
    saved_entries.sort_by(|left_entry, right_entry| {
        let left_timestamp = left_entry
            .get("modifiedTime")
            .and_then(Value::as_str)
            .unwrap_or(FALLBACK_MODIFIED_TIMESTAMP);
        let right_timestamp = right_entry
            .get("modifiedTime")
            .and_then(Value::as_str)
            .unwrap_or(FALLBACK_MODIFIED_TIMESTAMP);

        // ISO-8601 timestamps compare correctly lexicographically; reverse for descending.
        right_timestamp.cmp(left_timestamp)
    });
}

/// Read an optional `kind` filter out of the query parameters, ignoring blank values.
fn extract_optional_kind_filter_from_query(
    query_parameters: &HashMap<String, String>,
) -> Option<String> {
    query_parameters
        .get("kind")
        .map(|raw_value| raw_value.trim().to_string())
        .filter(|trimmed_value| !trimmed_value.is_empty())
}

/// When a kind filter is present, retain only the entries whose `kind` matches it
/// (case-insensitively). When absent, return the entries untouched.
fn apply_kind_filter_to_saved_entries(
    saved_entries: Vec<Value>,
    kind_filter: &Option<String>,
) -> Vec<Value> {
    match kind_filter {
        None => saved_entries,
        Some(requested_kind) => {
            let requested_kind_lowercase = requested_kind.to_ascii_lowercase();
            saved_entries
                .into_iter()
                .filter(|entry| {
                    entry
                        .get("kind")
                        .and_then(Value::as_str)
                        .map(|entry_kind| entry_kind.to_ascii_lowercase() == requested_kind_lowercase)
                        .unwrap_or(false)
                })
                .collect()
        }
    }
}

/// Count the number of listing entries.
fn count_saved_projects(saved_entries: &[Value]) -> usize {
    saved_entries.len()
}

/// Assemble the final response payload including the entry list and a total count.
fn build_saved_projects_listing_payload(saved_entries: Vec<Value>) -> Value {
    let total_count = count_saved_projects(&saved_entries);
    json!({
        "projects": saved_entries,
        "totalCount": total_count,
    })
}

/// Translate a document-collection [`ApplicationError`] into the appropriate [`HttpError`].
fn map_document_collection_failure_to_http_error(originating_error: ApplicationError) -> HttpError {
    match originating_error {
        ApplicationError::AuthorizationWasDenied => HttpError::AuthorizationWasDenied {
            explanation: originating_error.to_string(),
        },
        ApplicationError::RequestedProjectCouldNotBeLocated
        | ApplicationError::RequestedResourceCouldNotBeLocated => {
            HttpError::RequestedResourceWasNotFound {
                explanation: originating_error.to_string(),
            }
        }
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

    fn document_with_body(identifier: &str, body: Value) -> StoredDocument {
        StoredDocument {
            document_identifier: identifier.to_string(),
            owning_account: Some("scientist@example.org".to_string()),
            document_body: body,
        }
    }

    #[test]
    fn document_declares_ai3d_project_kind_detects_top_level_and_nested_markers() {
        let top_level = document_with_body("a", json!({ "kind": AI3D_PROJECT_KIND_MARKER }));
        let nested = document_with_body(
            "b",
            json!({ "metadata": { "kind": AI3D_PROJECT_KIND_MARKER } }),
        );
        assert!(document_declares_ai3d_project_kind(&top_level));
        assert!(document_declares_ai3d_project_kind(&nested));
    }

    #[test]
    fn document_declares_ai3d_project_kind_rejects_other_kinds() {
        let other = document_with_body("c", json!({ "kind": "spreadsheet" }));
        let missing = document_with_body("d", json!({ "displayName": "no kind here" }));
        assert!(!document_declares_ai3d_project_kind(&other));
        assert!(!document_declares_ai3d_project_kind(&missing));
    }

    #[test]
    fn filter_saved_documents_to_ai3d_projects_keeps_only_matching() {
        let documents = vec![
            document_with_body("a", json!({ "kind": AI3D_PROJECT_KIND_MARKER })),
            document_with_body("b", json!({ "kind": "other" })),
            document_with_body("c", json!({ "metadata": { "kind": AI3D_PROJECT_KIND_MARKER } })),
        ];
        let filtered = filter_saved_documents_to_ai3d_projects(documents);
        assert_eq!(filtered.len(), 2);
        assert_eq!(filtered[0].document_identifier, "a");
        assert_eq!(filtered[1].document_identifier, "c");
    }

    #[test]
    fn extract_saved_project_display_name_prefers_display_name_then_falls_back() {
        let named = document_with_body("a", json!({ "displayName": "Bracket v3" }));
        let alt = document_with_body("b", json!({ "name": "Housing" }));
        let blank = document_with_body("c", json!({ "displayName": "   " }));
        assert_eq!(extract_saved_project_display_name(&named), "Bracket v3");
        assert_eq!(extract_saved_project_display_name(&alt), "Housing");
        assert_eq!(extract_saved_project_display_name(&blank), FALLBACK_DISPLAY_NAME);
    }

    #[test]
    fn extract_saved_project_modified_timestamp_prefers_modified_then_falls_back() {
        let with_modified =
            document_with_body("a", json!({ "modifiedTime": "2026-06-25T14:30:00.000Z" }));
        let with_updated =
            document_with_body("b", json!({ "updatedAt": "2026-01-01T00:00:00.000Z" }));
        let empty = document_with_body("c", json!({}));
        assert_eq!(
            extract_saved_project_modified_timestamp(&with_modified),
            "2026-06-25T14:30:00.000Z"
        );
        assert_eq!(
            extract_saved_project_modified_timestamp(&with_updated),
            "2026-01-01T00:00:00.000Z"
        );
        assert_eq!(
            extract_saved_project_modified_timestamp(&empty),
            FALLBACK_MODIFIED_TIMESTAMP
        );
    }

    #[test]
    fn compute_saved_project_serialized_size_bytes_uses_recorded_or_measured() {
        let recorded = document_with_body("a", json!({ "size": 184320 }));
        assert_eq!(compute_saved_project_serialized_size_bytes(&recorded), 184320);

        let measured = document_with_body("b", json!({ "displayName": "abc" }));
        let expected = serde_json::to_string(&measured.document_body).unwrap().len();
        assert_eq!(compute_saved_project_serialized_size_bytes(&measured), expected);
        assert!(expected > 0);
    }

    #[test]
    fn extract_saved_project_version_label_handles_string_number_and_fallback() {
        let string_version = document_with_body("a", json!({ "version": "v7" }));
        let numeric_version = document_with_body("b", json!({ "version": 3 }));
        let nested_version =
            document_with_body("c", json!({ "metadata": { "version": "v9" } }));
        let missing_version = document_with_body("d", json!({}));
        assert_eq!(extract_saved_project_version_label(&string_version), "v7");
        assert_eq!(extract_saved_project_version_label(&numeric_version), "v3");
        assert_eq!(extract_saved_project_version_label(&nested_version), "v9");
        assert_eq!(
            extract_saved_project_version_label(&missing_version),
            FALLBACK_VERSION_LABEL
        );
    }

    #[test]
    fn render_saved_document_as_listing_entry_produces_expected_shape() {
        let document = document_with_body(
            "saved-ai3d-001",
            json!({
                "kind": AI3D_PROJECT_KIND_MARKER,
                "displayName": "Lattice Bracket v3",
                "modifiedTime": "2026-06-25T14:30:00.000Z",
                "size": 184320,
                "version": "v3"
            }),
        );
        let entry = render_saved_document_as_listing_entry(&document);
        assert_eq!(entry.get("id").and_then(Value::as_str), Some("saved-ai3d-001"));
        assert_eq!(
            entry.get("displayName").and_then(Value::as_str),
            Some("Lattice Bracket v3")
        );
        assert_eq!(entry.get("size").and_then(Value::as_u64), Some(184320));
        assert_eq!(entry.get("version").and_then(Value::as_str), Some("v3"));
        assert_eq!(
            entry.get("kind").and_then(Value::as_str),
            Some(AI3D_PROJECT_KIND_MARKER)
        );
    }

    #[test]
    fn sort_saved_project_entries_by_modified_time_descending_orders_newest_first() {
        let mut entries = vec![
            json!({ "id": "old", "modifiedTime": "2026-01-01T00:00:00.000Z" }),
            json!({ "id": "new", "modifiedTime": "2026-06-25T14:30:00.000Z" }),
            json!({ "id": "mid", "modifiedTime": "2026-03-10T08:00:00.000Z" }),
        ];
        sort_saved_project_entries_by_modified_time_descending(&mut entries);
        let ids: Vec<&str> = entries
            .iter()
            .map(|entry| entry.get("id").and_then(Value::as_str).unwrap())
            .collect();
        assert_eq!(ids, vec!["new", "mid", "old"]);
    }

    #[test]
    fn extract_optional_kind_filter_from_query_returns_trimmed_or_none() {
        let mut with_kind = HashMap::new();
        with_kind.insert("kind".to_string(), "  ai3d-project ".to_string());
        assert_eq!(
            extract_optional_kind_filter_from_query(&with_kind),
            Some("ai3d-project".to_string())
        );

        let mut blank = HashMap::new();
        blank.insert("kind".to_string(), "   ".to_string());
        assert_eq!(extract_optional_kind_filter_from_query(&blank), None);

        let empty: HashMap<String, String> = HashMap::new();
        assert_eq!(extract_optional_kind_filter_from_query(&empty), None);
    }

    #[test]
    fn apply_kind_filter_to_saved_entries_filters_case_insensitively() {
        let entries = vec![
            json!({ "id": "a", "kind": "ai3d-project" }),
            json!({ "id": "b", "kind": "sketch" }),
        ];
        let filtered =
            apply_kind_filter_to_saved_entries(entries.clone(), &Some("AI3D-PROJECT".to_string()));
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].get("id").and_then(Value::as_str), Some("a"));

        let unfiltered = apply_kind_filter_to_saved_entries(entries, &None);
        assert_eq!(unfiltered.len(), 2);
    }

    #[test]
    fn count_saved_projects_reports_length() {
        let entries = vec![json!({ "id": "a" }), json!({ "id": "b" })];
        assert_eq!(count_saved_projects(&entries), 2);
        assert_eq!(count_saved_projects(&[]), 0);
    }

    #[test]
    fn build_saved_projects_listing_payload_wraps_entries_with_total() {
        let entries = vec![json!({ "id": "a" }), json!({ "id": "b" })];
        let payload = build_saved_projects_listing_payload(entries);
        assert_eq!(payload.get("totalCount").and_then(Value::as_u64), Some(2));
        assert_eq!(
            payload.get("projects").and_then(Value::as_array).map(Vec::len),
            Some(2)
        );
    }

    #[test]
    fn map_document_collection_failure_to_http_error_maps_variants() {
        let denied = map_document_collection_failure_to_http_error(
            ApplicationError::AuthorizationWasDenied,
        );
        assert!(matches!(denied, HttpError::AuthorizationWasDenied { .. }));

        let not_found = map_document_collection_failure_to_http_error(
            ApplicationError::RequestedResourceCouldNotBeLocated,
        );
        assert!(matches!(not_found, HttpError::RequestedResourceWasNotFound { .. }));

        let upstream = map_document_collection_failure_to_http_error(
            ApplicationError::DocumentCollectionFailure {
                failure_description: "boom".to_string(),
            },
        );
        assert!(matches!(upstream, HttpError::UpstreamApplicationFailure { .. }));
    }
}
