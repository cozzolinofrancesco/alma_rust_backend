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
use axum::extract::{Query, State};
use serde_json::{Value, json};
use std::collections::HashMap;

/// Default number of matched documents returned per page when the caller does
/// not supply an explicit `limit` query parameter.
const DEFAULT_PAGINATION_LIMIT: usize = 25;

/// Upper bound on the number of matched documents that may be returned in a
/// single page, guarding against unbounded response sizes.
const MAXIMUM_PAGINATION_LIMIT: usize = 200;

#[route(method = "GET", path = "/api/files-search")]
pub async fn files_search_by_query_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Query(query_parameters): Query<HashMap<String, String>>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // Establish the identity of the caller for audit / ownership context.
    let _owning_account = extract_owning_account_from_authorized_request(&authorized_request);

    // Parse and validate the mandatory search query.
    let raw_query = extract_search_query_from_query_parameters(&query_parameters)?;
    let validated_query = validate_query_string_search_expression(raw_query)?;

    // Optional filters and pagination directives.
    let folder_path_filter = extract_folder_path_filter_from_query_parameters(&query_parameters);
    let pagination_offset = extract_pagination_offset_from_query_parameters(&query_parameters);
    let pagination_limit = extract_pagination_limit_from_query_parameters(&query_parameters);

    // Fetch every stored project-file document, then filter it in memory.
    let all_documents = list_all_project_file_documents(&application_state).await?;

    let normalized_query = normalize_query_term_for_case_insensitive_match(validated_query.as_str());
    let matched_documents =
        filter_documents_by_query_expression(all_documents, &normalized_query, &folder_path_filter);

    let total_match_count = count_total_matches_before_pagination(&matched_documents);

    let paginated_documents =
        apply_pagination_window_to_matches(matched_documents, pagination_offset, pagination_limit);

    let paginated_entries: Vec<Value> = paginated_documents
        .iter()
        .map(render_matched_document_as_file_entry)
        .collect();

    let response_payload =
        build_query_search_result_payload(paginated_entries, total_match_count, &validated_query);

    Ok(Json(response_payload))
}

/// (1) Resolve the owning account of the authorized caller as a plain string.
fn extract_owning_account_from_authorized_request(
    authorized_request: &HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> String {
    authorized_request.authorized_principal().as_str().to_string()
}

/// (2) Pull the mandatory `query` parameter out of the query string map.
fn extract_search_query_from_query_parameters(
    query_parameters: &HashMap<String, String>,
) -> Result<String, HttpError> {
    match query_parameters.get("query") {
        Some(raw_query) => Ok(raw_query.clone()),
        None => Err(HttpError::RequestBodyWasMalformed {
            explanation: "the mandatory 'query' search parameter was absent".to_string(),
        }),
    }
}

/// (3) Convert the raw query string into a validated non-empty search expression.
fn validate_query_string_search_expression(raw_query: String) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(raw_query.trim().to_string()).map_err(|domain_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "the search query was not a valid non-empty expression: {domain_error}"
            ),
        }
    })
}

/// (4) Extract an optional folder-path filter, ignoring blank values.
fn extract_folder_path_filter_from_query_parameters(
    query_parameters: &HashMap<String, String>,
) -> Option<String> {
    query_parameters
        .get("folderPath")
        .map(|folder_path| folder_path.trim().to_string())
        .filter(|folder_path| !folder_path.is_empty())
}

/// (5) Determine the pagination offset, defaulting to zero on absence / bad input.
fn extract_pagination_offset_from_query_parameters(
    query_parameters: &HashMap<String, String>,
) -> usize {
    query_parameters
        .get("offset")
        .and_then(|raw_offset| raw_offset.trim().parse::<usize>().ok())
        .unwrap_or(0)
}

/// (6) Determine the pagination limit, clamped between 1 and the maximum.
fn extract_pagination_limit_from_query_parameters(
    query_parameters: &HashMap<String, String>,
) -> usize {
    let requested_limit = query_parameters
        .get("limit")
        .and_then(|raw_limit| raw_limit.trim().parse::<usize>().ok())
        .unwrap_or(DEFAULT_PAGINATION_LIMIT);

    if requested_limit == 0 {
        DEFAULT_PAGINATION_LIMIT
    } else {
        requested_limit.min(MAXIMUM_PAGINATION_LIMIT)
    }
}

/// (7) Load every stored project-file document from the document collection.
fn list_all_project_file_documents<'a, TransactionalUnitOfWork: UnitOfWork>(
    application_state: &'a ApplicationState<TransactionalUnitOfWork>,
) -> impl std::future::Future<Output = Result<Vec<StoredDocument>, HttpError>> + 'a {
    async move {
        application_state
            .document_collection
            .list_documents(PROJECT_FILES_COLLECTION_NAME)
            .await
            .map_err(map_document_collection_failure_to_http_error)
    }
}

/// (8) Normalize a query term into a canonical lower-case, trimmed form.
fn normalize_query_term_for_case_insensitive_match(raw_query_term: &str) -> String {
    raw_query_term.trim().to_lowercase()
}

/// (9) Report whether a document's serialized body contains the normalized term.
fn document_body_contains_normalized_query(
    candidate_document: &StoredDocument,
    normalized_query: &str,
) -> bool {
    if normalized_query.is_empty() {
        return true;
    }
    let serialized_body = candidate_document.document_body.to_string().to_lowercase();
    let serialized_identifier = candidate_document.document_identifier.to_lowercase();
    serialized_body.contains(normalized_query) || serialized_identifier.contains(normalized_query)
}

/// (10) Filter the full document set by the query term and optional folder path.
fn filter_documents_by_query_expression(
    all_documents: Vec<StoredDocument>,
    normalized_query: &str,
    folder_path_filter: &Option<String>,
) -> Vec<StoredDocument> {
    all_documents
        .into_iter()
        .filter(|candidate_document| {
            document_body_contains_normalized_query(candidate_document, normalized_query)
        })
        .filter(|candidate_document| {
            document_matches_folder_path_filter(candidate_document, folder_path_filter)
        })
        .collect()
}

/// Helper for (10): compare a document's `folderPath` body field against the filter.
fn document_matches_folder_path_filter(
    candidate_document: &StoredDocument,
    folder_path_filter: &Option<String>,
) -> bool {
    match folder_path_filter {
        None => true,
        Some(expected_folder_path) => candidate_document
            .document_body
            .get("folderPath")
            .and_then(|folder_path_value| folder_path_value.as_str())
            .map(|folder_path| folder_path.eq_ignore_ascii_case(expected_folder_path))
            .unwrap_or(false),
    }
}

/// (11) Restrict the matched documents to a single pagination window.
fn apply_pagination_window_to_matches(
    matched_documents: Vec<StoredDocument>,
    pagination_offset: usize,
    pagination_limit: usize,
) -> Vec<StoredDocument> {
    matched_documents
        .into_iter()
        .skip(pagination_offset)
        .take(pagination_limit)
        .collect()
}

/// (12) Render a single matched document as a client-facing file entry.
fn render_matched_document_as_file_entry(matched_document: &StoredDocument) -> Value {
    let document_body = &matched_document.document_body;

    let file_name = document_body
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or(matched_document.document_identifier.as_str());

    let mime_type = document_body
        .get("mimeType")
        .and_then(|value| value.as_str())
        .unwrap_or("application/octet-stream");

    let file_size = document_body
        .get("size")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);

    let folder_path = document_body
        .get("folderPath")
        .and_then(|value| value.as_str())
        .unwrap_or("");

    json!({
        "id": matched_document.document_identifier,
        "name": file_name,
        "mimeType": mime_type,
        "size": file_size,
        "folderPath": folder_path,
        "owningAccount": matched_document.owning_account,
        "type": "File"
    })
}

/// (13) Count the matched documents before pagination is applied.
fn count_total_matches_before_pagination(matched_documents: &[StoredDocument]) -> usize {
    matched_documents.len()
}

/// (14) Assemble the final JSON payload returned to the caller.
fn build_query_search_result_payload(
    paginated_entries: Vec<Value>,
    total_match_count: usize,
    query_term: &NonEmptyText,
) -> Value {
    let returned_count = paginated_entries.len();
    json!({
        "files": paginated_entries,
        "count": returned_count,
        "totalMatches": total_match_count,
        "query": query_term.as_str(),
        "cached": false
    })
}

/// (15) Translate a document-collection application failure into an HTTP error.
fn map_document_collection_failure_to_http_error(originating_error: ApplicationError) -> HttpError {
    match originating_error {
        ApplicationError::RequestedResourceCouldNotBeLocated
        | ApplicationError::RequestedProjectCouldNotBeLocated => {
            HttpError::RequestedResourceWasNotFound {
                explanation: "the requested project files could not be located".to_string(),
            }
        }
        ApplicationError::AuthorizationWasDenied => HttpError::AuthorizationWasDenied {
            explanation: "the caller is not authorized to search project files".to_string(),
        },
        other_failure => HttpError::UpstreamApplicationFailure {
            explanation: format!("the document collection reported a failure: {other_failure}"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_document(identifier: &str, owner: Option<&str>, body: Value) -> StoredDocument {
        StoredDocument {
            document_identifier: identifier.to_string(),
            owning_account: owner.map(|value| value.to_string()),
            document_body: body,
        }
    }

    #[test]
    fn extract_search_query_returns_value_when_present() {
        let mut parameters = HashMap::new();
        parameters.insert("query".to_string(), "protein".to_string());
        let extracted = extract_search_query_from_query_parameters(&parameters);
        assert_eq!(extracted.unwrap(), "protein");
    }

    #[test]
    fn extract_search_query_errors_when_absent() {
        let parameters: HashMap<String, String> = HashMap::new();
        assert!(extract_search_query_from_query_parameters(&parameters).is_err());
    }

    #[test]
    fn validate_query_accepts_non_empty_and_trims() {
        let validated = validate_query_string_search_expression("  hello  ".to_string());
        assert_eq!(validated.unwrap().as_str(), "hello");
    }

    #[test]
    fn validate_query_rejects_blank_input() {
        assert!(validate_query_string_search_expression("   ".to_string()).is_err());
    }

    #[test]
    fn extract_folder_path_filter_returns_some_for_non_blank() {
        let mut parameters = HashMap::new();
        parameters.insert("folderPath".to_string(), " PDFs ".to_string());
        assert_eq!(
            extract_folder_path_filter_from_query_parameters(&parameters),
            Some("PDFs".to_string())
        );
    }

    #[test]
    fn extract_folder_path_filter_returns_none_for_blank_or_missing() {
        let mut parameters = HashMap::new();
        parameters.insert("folderPath".to_string(), "   ".to_string());
        assert_eq!(
            extract_folder_path_filter_from_query_parameters(&parameters),
            None
        );
        let empty: HashMap<String, String> = HashMap::new();
        assert_eq!(extract_folder_path_filter_from_query_parameters(&empty), None);
    }

    #[test]
    fn extract_pagination_offset_defaults_to_zero() {
        let empty: HashMap<String, String> = HashMap::new();
        assert_eq!(extract_pagination_offset_from_query_parameters(&empty), 0);
        let mut bad = HashMap::new();
        bad.insert("offset".to_string(), "not-a-number".to_string());
        assert_eq!(extract_pagination_offset_from_query_parameters(&bad), 0);
    }

    #[test]
    fn extract_pagination_offset_parses_valid_value() {
        let mut parameters = HashMap::new();
        parameters.insert("offset".to_string(), "12".to_string());
        assert_eq!(
            extract_pagination_offset_from_query_parameters(&parameters),
            12
        );
    }

    #[test]
    fn extract_pagination_limit_defaults_and_clamps() {
        let empty: HashMap<String, String> = HashMap::new();
        assert_eq!(
            extract_pagination_limit_from_query_parameters(&empty),
            DEFAULT_PAGINATION_LIMIT
        );

        let mut zero = HashMap::new();
        zero.insert("limit".to_string(), "0".to_string());
        assert_eq!(
            extract_pagination_limit_from_query_parameters(&zero),
            DEFAULT_PAGINATION_LIMIT
        );

        let mut huge = HashMap::new();
        huge.insert("limit".to_string(), "100000".to_string());
        assert_eq!(
            extract_pagination_limit_from_query_parameters(&huge),
            MAXIMUM_PAGINATION_LIMIT
        );

        let mut normal = HashMap::new();
        normal.insert("limit".to_string(), "10".to_string());
        assert_eq!(
            extract_pagination_limit_from_query_parameters(&normal),
            10
        );
    }

    #[test]
    fn normalize_query_term_lowercases_and_trims() {
        assert_eq!(
            normalize_query_term_for_case_insensitive_match("  ProTeIn "),
            "protein"
        );
    }

    #[test]
    fn document_body_contains_normalized_query_matches_body_and_identifier() {
        let document = build_document(
            "protein_analysis_agent",
            None,
            json!({ "name": "Alpha Report", "folderPath": "PDFs" }),
        );
        assert!(document_body_contains_normalized_query(&document, "alpha"));
        assert!(document_body_contains_normalized_query(&document, "protein"));
        assert!(!document_body_contains_normalized_query(&document, "zebra"));
    }

    #[test]
    fn document_body_contains_normalized_query_empty_matches_all() {
        let document = build_document("abc", None, json!({}));
        assert!(document_body_contains_normalized_query(&document, ""));
    }

    #[test]
    fn filter_documents_by_query_expression_applies_query_and_folder() {
        let documents = vec![
            build_document(
                "one",
                None,
                json!({ "name": "protein map", "folderPath": "PDFs" }),
            ),
            build_document(
                "two",
                None,
                json!({ "name": "protein chart", "folderPath": "Images" }),
            ),
            build_document(
                "three",
                None,
                json!({ "name": "unrelated", "folderPath": "PDFs" }),
            ),
        ];
        let filtered =
            filter_documents_by_query_expression(documents, "protein", &Some("PDFs".to_string()));
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].document_identifier, "one");
    }

    #[test]
    fn filter_documents_by_query_expression_without_folder_filter() {
        let documents = vec![
            build_document("one", None, json!({ "name": "protein map" })),
            build_document("two", None, json!({ "name": "unrelated" })),
        ];
        let filtered = filter_documents_by_query_expression(documents, "protein", &None);
        assert_eq!(filtered.len(), 1);
    }

    #[test]
    fn apply_pagination_window_slices_correctly() {
        let documents = vec![
            build_document("a", None, json!({})),
            build_document("b", None, json!({})),
            build_document("c", None, json!({})),
            build_document("d", None, json!({})),
        ];
        let windowed = apply_pagination_window_to_matches(documents, 1, 2);
        assert_eq!(windowed.len(), 2);
        assert_eq!(windowed[0].document_identifier, "b");
        assert_eq!(windowed[1].document_identifier, "c");
    }

    #[test]
    fn apply_pagination_window_offset_beyond_length_returns_empty() {
        let documents = vec![build_document("a", None, json!({}))];
        let windowed = apply_pagination_window_to_matches(documents, 10, 5);
        assert!(windowed.is_empty());
    }

    #[test]
    fn render_matched_document_uses_body_fields() {
        let document = build_document(
            "file-1",
            Some("scientist@example.com"),
            json!({
                "name": "report.pdf",
                "mimeType": "application/pdf",
                "size": 4096,
                "folderPath": "PDFs"
            }),
        );
        let entry = render_matched_document_as_file_entry(&document);
        assert_eq!(entry["id"], "file-1");
        assert_eq!(entry["name"], "report.pdf");
        assert_eq!(entry["mimeType"], "application/pdf");
        assert_eq!(entry["size"], 4096);
        assert_eq!(entry["folderPath"], "PDFs");
        assert_eq!(entry["type"], "File");
    }

    #[test]
    fn render_matched_document_falls_back_to_identifier_and_defaults() {
        let document = build_document("bare-id", None, json!({}));
        let entry = render_matched_document_as_file_entry(&document);
        assert_eq!(entry["name"], "bare-id");
        assert_eq!(entry["mimeType"], "application/octet-stream");
        assert_eq!(entry["size"], 0);
    }

    #[test]
    fn count_total_matches_before_pagination_counts_all() {
        let documents = vec![
            build_document("a", None, json!({})),
            build_document("b", None, json!({})),
        ];
        assert_eq!(count_total_matches_before_pagination(&documents), 2);
    }

    #[test]
    fn build_query_search_result_payload_reports_counts() {
        let query_term = NonEmptyText::parse("protein".to_string()).unwrap();
        let entries = vec![json!({ "id": "one" }), json!({ "id": "two" })];
        let payload = build_query_search_result_payload(entries, 7, &query_term);
        assert_eq!(payload["count"], 2);
        assert_eq!(payload["totalMatches"], 7);
        assert_eq!(payload["query"], "protein");
        assert_eq!(payload["cached"], false);
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
    fn map_document_collection_failure_maps_authorization_and_generic() {
        let denied = map_document_collection_failure_to_http_error(
            ApplicationError::AuthorizationWasDenied,
        );
        assert!(matches!(denied, HttpError::AuthorizationWasDenied { .. }));

        let generic = map_document_collection_failure_to_http_error(
            ApplicationError::DocumentCollectionFailure {
                failure_description: "boom".to_string(),
            },
        );
        assert!(matches!(
            generic,
            HttpError::UpstreamApplicationFailure { .. }
        ));
    }
}
