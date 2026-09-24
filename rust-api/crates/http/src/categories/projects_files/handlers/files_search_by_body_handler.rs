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
use axum::extract::State;
use serde_json::{Value, json};

/// POST /api/files-search
///
/// Searches the stored project-file documents whose serialized body contains the
/// caller-supplied query term. The request body is JSON of the shape:
/// ```json
/// { "query": "protein", "folderPath": "AF", "mimeType": "application/json", "limit": 25 }
/// ```
/// Only `query` is required; the remaining fields are optional refinements.
#[route(method = "POST", path = "/api/files-search")]
pub async fn files_search_by_body_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // RUST-IDOR-002: the search is scoped to the caller's own files so it cannot
    // read or probe other tenants' documents.
    let owning_account = extract_owning_account_from_authorized_request(&authorized_request);

    let raw_query = extract_search_query_field_from_body(&submitted_body)?;
    let validated_query = validate_search_query_expression(raw_query)?;

    let folder_path_filter = extract_folder_path_filter_from_body(&submitted_body);
    let mime_type_filter = extract_mime_type_filter_from_body(&submitted_body);
    let result_limit = extract_result_limit_from_body(&submitted_body);

    let all_documents = list_project_file_documents_owned_by(&application_state, &owning_account).await?;

    let mut matched_documents = filter_documents_by_body_search_criteria(
        all_documents,
        &validated_query,
        &folder_path_filter,
        &mime_type_filter,
    );

    // Order the matches by descending relevance so the most useful hits come first.
    matched_documents.sort_by(|left_document, right_document| {
        let left_score = score_document_relevance_for_query(left_document, validated_query.as_str());
        let right_score =
            score_document_relevance_for_query(right_document, validated_query.as_str());
        right_score
            .cmp(&left_score)
            .then_with(|| left_document.document_identifier.cmp(&right_document.document_identifier))
    });

    let matched_entries: Vec<Value> = matched_documents
        .into_iter()
        .take(result_limit)
        .map(|matched_document| render_matched_document_as_file_entry(&matched_document))
        .collect();

    let response_payload = build_body_search_result_payload(matched_entries, &validated_query);
    Ok(Json(response_payload))
}

/// 1. Resolves the e-mail of the authorized principal into an owned string.
fn extract_owning_account_from_authorized_request(
    authorized_request: &HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> String {
    authorized_request.authorized_principal().as_str().to_string()
}

/// 2. Pulls the mandatory `query` string field out of the request body.
fn extract_search_query_field_from_body(submitted_body: &Value) -> Result<String, HttpError> {
    match submitted_body.get("query") {
        Some(Value::String(query_text)) => Ok(query_text.to_string()),
        Some(_other) => Err(HttpError::RequestBodyWasMalformed {
            explanation: "the 'query' field must be a string".to_string(),
        }),
        None => Err(HttpError::RequestBodyWasMalformed {
            explanation: "the request body is missing the required 'query' field".to_string(),
        }),
    }
}

/// 3. Validates the raw query into a `NonEmptyText`, rejecting blank searches.
fn validate_search_query_expression(raw_query: String) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(raw_query).map_err(|domain_error| HttpError::RequestBodyWasMalformed {
        explanation: domain_error.to_string(),
    })
}

/// 4. Reads the optional `folderPath` refinement, dropping blank values.
fn extract_folder_path_filter_from_body(submitted_body: &Value) -> Option<String> {
    submitted_body
        .get("folderPath")
        .and_then(|folder_value| folder_value.as_str())
        .map(|folder_text| folder_text.trim().to_string())
        .filter(|folder_text| !folder_text.is_empty())
}

/// 5. Reads the optional `mimeType` refinement, dropping blank values.
fn extract_mime_type_filter_from_body(submitted_body: &Value) -> Option<String> {
    submitted_body
        .get("mimeType")
        .and_then(|mime_value| mime_value.as_str())
        .map(|mime_text| mime_text.trim().to_string())
        .filter(|mime_text| !mime_text.is_empty())
}

/// 6. Reads the optional `limit` field, clamping it to a sane range.
fn extract_result_limit_from_body(submitted_body: &Value) -> usize {
    const DEFAULT_RESULT_LIMIT: usize = 25;
    const MAXIMUM_RESULT_LIMIT: usize = 200;

    let requested_limit = submitted_body
        .get("limit")
        .and_then(|limit_value| limit_value.as_u64())
        .map(|limit_number| limit_number as usize)
        .unwrap_or(DEFAULT_RESULT_LIMIT);

    if requested_limit == 0 {
        DEFAULT_RESULT_LIMIT
    } else {
        requested_limit.min(MAXIMUM_RESULT_LIMIT)
    }
}

/// 7. Lists the caller's own documents in the project-files collection
/// (RUST-IDOR-002: owner-scoped, never all tenants).
fn list_project_file_documents_owned_by<'a, TransactionalUnitOfWork: UnitOfWork>(
    application_state: &'a ApplicationState<TransactionalUnitOfWork>,
    owning_account: &'a str,
) -> impl std::future::Future<Output = Result<Vec<StoredDocument>, HttpError>> + 'a {
    async move {
        application_state
            .document_collection
            .list_documents_owned_by(PROJECT_FILES_COLLECTION_NAME, owning_account)
            .await
            .map_err(map_document_collection_failure_to_http_error)
    }
}

/// 8. Case-insensitive containment test against the document's serialized body.
fn document_body_contains_query_term(candidate_document: &StoredDocument, query_term: &str) -> bool {
    let serialized_body = candidate_document.document_body.to_string().to_lowercase();
    serialized_body.contains(&query_term.to_lowercase())
}

/// 9. Confirms the document's `folderPath` matches the optional folder filter.
fn document_matches_folder_path_filter(
    candidate_document: &StoredDocument,
    folder_path_filter: &Option<String>,
) -> bool {
    match folder_path_filter {
        None => true,
        Some(expected_folder) => candidate_document
            .document_body
            .get("folderPath")
            .and_then(|folder_value| folder_value.as_str())
            .map(|actual_folder| actual_folder.eq_ignore_ascii_case(expected_folder))
            .unwrap_or(false),
    }
}

/// 10. Confirms the document's `mimeType` matches the optional MIME filter.
fn document_matches_mime_type_filter(
    candidate_document: &StoredDocument,
    mime_type_filter: &Option<String>,
) -> bool {
    match mime_type_filter {
        None => true,
        Some(expected_mime) => candidate_document
            .document_body
            .get("mimeType")
            .and_then(|mime_value| mime_value.as_str())
            .map(|actual_mime| actual_mime.eq_ignore_ascii_case(expected_mime))
            .unwrap_or(false),
    }
}

/// 11. Applies the query term plus the optional folder and MIME refinements.
fn filter_documents_by_body_search_criteria(
    all_documents: Vec<StoredDocument>,
    query_term: &NonEmptyText,
    folder_path_filter: &Option<String>,
    mime_type_filter: &Option<String>,
) -> Vec<StoredDocument> {
    all_documents
        .into_iter()
        .filter(|candidate_document| {
            document_body_contains_query_term(candidate_document, query_term.as_str())
                && document_matches_folder_path_filter(candidate_document, folder_path_filter)
                && document_matches_mime_type_filter(candidate_document, mime_type_filter)
        })
        .collect()
}

/// 12. Scores relevance by counting non-overlapping occurrences of the query term.
fn score_document_relevance_for_query(
    candidate_document: &StoredDocument,
    query_term: &str,
) -> usize {
    let normalized_term = query_term.to_lowercase();
    if normalized_term.is_empty() {
        return 0;
    }
    let serialized_body = candidate_document.document_body.to_string().to_lowercase();
    serialized_body.matches(&normalized_term).count()
}

/// 13. Projects a stored document into the file-entry shape the client expects.
fn render_matched_document_as_file_entry(matched_document: &StoredDocument) -> Value {
    let body = &matched_document.document_body;

    let string_field = |field_name: &str, fallback: &str| -> String {
        body.get(field_name)
            .and_then(|field_value| field_value.as_str())
            .unwrap_or(fallback)
            .to_string()
    };

    let size_in_bytes = body
        .get("size")
        .and_then(|size_value| size_value.as_u64())
        .unwrap_or(0);

    json!({
        "id": matched_document.document_identifier,
        "name": string_field("name", "untitled"),
        "mimeType": string_field("mimeType", "application/octet-stream"),
        "size": size_in_bytes,
        "createdTime": string_field("createdTime", ""),
        "modifiedTime": string_field("modifiedTime", ""),
        "folderPath": string_field("folderPath", ""),
        "webViewLink": string_field("webViewLink", ""),
        "owningAccount": matched_document.owning_account,
        "type": "File"
    })
}

/// 14. Wraps the matched entries into the final response envelope.
fn build_body_search_result_payload(matched_entries: Vec<Value>, query_term: &NonEmptyText) -> Value {
    let match_count = matched_entries.len();
    json!({
        "files": matched_entries,
        "count": match_count,
        "query": query_term.as_str(),
        "cached": false
    })
}

/// 15. Translates a document-collection application error into the HTTP layer error.
fn map_document_collection_failure_to_http_error(originating_error: ApplicationError) -> HttpError {
    match originating_error {
        ApplicationError::RequestedResourceCouldNotBeLocated
        | ApplicationError::RequestedProjectCouldNotBeLocated => {
            HttpError::RequestedResourceWasNotFound {
                explanation: "the project-files collection could not be located".to_string(),
            }
        }
        ApplicationError::AuthorizationWasDenied => HttpError::AuthorizationWasDenied {
            explanation: "the principal may not search the project-files collection".to_string(),
        },
        ApplicationError::DomainInvariantViolated(domain_error) => {
            HttpError::RequestBodyWasMalformed {
                explanation: domain_error.to_string(),
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

    fn document_with_body(identifier: &str, owner: Option<&str>, body: Value) -> StoredDocument {
        StoredDocument {
            document_identifier: identifier.to_string(),
            owning_account: owner.map(|owner_text| owner_text.to_string()),
            document_body: body,
        }
    }

    #[test]
    fn extract_search_query_field_reads_valid_string() {
        let body = json!({ "query": "protein" });
        let extracted = extract_search_query_field_from_body(&body).expect("query present");
        assert_eq!(extracted, "protein");
    }

    #[test]
    fn extract_search_query_field_rejects_missing_and_non_string() {
        assert!(extract_search_query_field_from_body(&json!({})).is_err());
        assert!(extract_search_query_field_from_body(&json!({ "query": 42 })).is_err());
    }

    #[test]
    fn validate_search_query_expression_accepts_content_rejects_blank() {
        assert!(validate_search_query_expression("valid".to_string()).is_ok());
        assert!(validate_search_query_expression("   ".to_string()).is_err());
    }

    #[test]
    fn extract_folder_path_filter_handles_present_absent_and_blank() {
        assert_eq!(
            extract_folder_path_filter_from_body(&json!({ "folderPath": " AF " })),
            Some("AF".to_string())
        );
        assert_eq!(extract_folder_path_filter_from_body(&json!({})), None);
        assert_eq!(
            extract_folder_path_filter_from_body(&json!({ "folderPath": "   " })),
            None
        );
    }

    #[test]
    fn extract_mime_type_filter_handles_present_and_absent() {
        assert_eq!(
            extract_mime_type_filter_from_body(&json!({ "mimeType": "application/pdf" })),
            Some("application/pdf".to_string())
        );
        assert_eq!(extract_mime_type_filter_from_body(&json!({})), None);
    }

    #[test]
    fn extract_result_limit_applies_default_clamp_and_ceiling() {
        assert_eq!(extract_result_limit_from_body(&json!({})), 25);
        assert_eq!(extract_result_limit_from_body(&json!({ "limit": 0 })), 25);
        assert_eq!(extract_result_limit_from_body(&json!({ "limit": 10 })), 10);
        assert_eq!(extract_result_limit_from_body(&json!({ "limit": 9999 })), 200);
    }

    #[test]
    fn document_body_contains_query_term_is_case_insensitive() {
        let document = document_with_body("d1", None, json!({ "name": "Protein_Analysis" }));
        assert!(document_body_contains_query_term(&document, "protein"));
        assert!(!document_body_contains_query_term(&document, "genome"));
    }

    #[test]
    fn document_matches_folder_path_filter_respects_optionality() {
        let document = document_with_body("d1", None, json!({ "folderPath": "AF" }));
        assert!(document_matches_folder_path_filter(&document, &None));
        assert!(document_matches_folder_path_filter(&document, &Some("af".to_string())));
        assert!(!document_matches_folder_path_filter(&document, &Some("PDFs".to_string())));
    }

    #[test]
    fn document_matches_mime_type_filter_respects_optionality() {
        let document = document_with_body("d1", None, json!({ "mimeType": "application/pdf" }));
        assert!(document_matches_mime_type_filter(&document, &None));
        assert!(document_matches_mime_type_filter(
            &document,
            &Some("APPLICATION/PDF".to_string())
        ));
        assert!(!document_matches_mime_type_filter(
            &document,
            &Some("application/json".to_string())
        ));
    }

    #[test]
    fn filter_documents_by_body_search_criteria_combines_all_conditions() {
        let query = NonEmptyText::parse("report".to_string()).unwrap();
        let documents = vec![
            document_with_body(
                "match",
                None,
                json!({ "name": "quarterly_report", "folderPath": "PDFs", "mimeType": "application/pdf" }),
            ),
            document_with_body(
                "wrong_folder",
                None,
                json!({ "name": "report", "folderPath": "AF", "mimeType": "application/pdf" }),
            ),
            document_with_body(
                "no_term",
                None,
                json!({ "name": "summary", "folderPath": "PDFs", "mimeType": "application/pdf" }),
            ),
        ];
        let folder = Some("PDFs".to_string());
        let mime = Some("application/pdf".to_string());
        let filtered = filter_documents_by_body_search_criteria(documents, &query, &folder, &mime);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].document_identifier, "match");
    }

    #[test]
    fn score_document_relevance_counts_occurrences() {
        let document =
            document_with_body("d1", None, json!({ "a": "gene", "b": "gene", "c": "GENE" }));
        assert_eq!(score_document_relevance_for_query(&document, "gene"), 3);
        assert_eq!(score_document_relevance_for_query(&document, ""), 0);
        assert_eq!(score_document_relevance_for_query(&document, "absent"), 0);
    }

    #[test]
    fn render_matched_document_projects_expected_shape() {
        let document = document_with_body(
            "file-1",
            Some("scientist@example.com"),
            json!({
                "name": "agent.json",
                "mimeType": "application/json",
                "size": 4096,
                "folderPath": "AF"
            }),
        );
        let entry = render_matched_document_as_file_entry(&document);
        assert_eq!(entry.get("id").and_then(|value| value.as_str()), Some("file-1"));
        assert_eq!(entry.get("name").and_then(|value| value.as_str()), Some("agent.json"));
        assert_eq!(entry.get("size").and_then(|value| value.as_u64()), Some(4096));
        assert_eq!(entry.get("type").and_then(|value| value.as_str()), Some("File"));
    }

    #[test]
    fn render_matched_document_falls_back_when_fields_missing() {
        let document = document_with_body("file-2", None, json!({}));
        let entry = render_matched_document_as_file_entry(&document);
        assert_eq!(entry.get("name").and_then(|value| value.as_str()), Some("untitled"));
        assert_eq!(entry.get("size").and_then(|value| value.as_u64()), Some(0));
        assert_eq!(
            entry.get("mimeType").and_then(|value| value.as_str()),
            Some("application/octet-stream")
        );
    }

    #[test]
    fn build_body_search_result_payload_reports_count_and_query() {
        let query = NonEmptyText::parse("protein".to_string()).unwrap();
        let entries = vec![json!({ "id": "a" }), json!({ "id": "b" })];
        let payload = build_body_search_result_payload(entries, &query);
        assert_eq!(payload.get("count").and_then(|value| value.as_u64()), Some(2));
        assert_eq!(payload.get("query").and_then(|value| value.as_str()), Some("protein"));
        assert_eq!(payload.get("cached").and_then(|value| value.as_bool()), Some(false));
        assert_eq!(
            payload.get("files").and_then(|value| value.as_array()).map(|arr| arr.len()),
            Some(2)
        );
    }

    #[test]
    fn map_document_collection_failure_maps_not_found_and_generic() {
        let not_found = map_document_collection_failure_to_http_error(
            ApplicationError::RequestedResourceCouldNotBeLocated,
        );
        assert!(matches!(not_found, HttpError::RequestedResourceWasNotFound { .. }));

        let generic = map_document_collection_failure_to_http_error(
            ApplicationError::DocumentCollectionFailure {
                failure_description: "disk offline".to_string(),
            },
        );
        assert!(matches!(generic, HttpError::UpstreamApplicationFailure { .. }));
    }
}
