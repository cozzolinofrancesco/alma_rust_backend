//! `GET /api/rag/drive/search` — full-text search the CALLER'S Google Drive.
//!
//! Authenticated with the caller's `Authorization: Bearer <google-oauth-token>`
//! (extracted as [`GoogleAccessToken`]) and forwarded to the Drive v3 API via
//! [`GoogleDriveObjectPort`]. Results are cross-referenced against the account's
//! ingested corpus knowledge to flag `alreadyIngested`, then ranked by name.

use crate::categories::rag::collections::RAG_KNOWLEDGE_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::google_access_token::GoogleAccessToken;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::ports::document_collection::DocumentCollectionPort;
use alma_application::ports::google_drive::DriveFile;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::{Email, NonEmptyText};
use alma_macros::route;
use axum::Json;
use axum::extract::{Query, State};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// Maximum number of drive search results that may be returned in a single response.
const MAXIMUM_DRIVE_RESULT_LIMIT: usize = 50;
/// Default number of drive search results returned when the caller does not request a limit.
const DEFAULT_DRIVE_RESULT_LIMIT: usize = 10;

/// A single Drive resource surfaced by the search, plus the ingested flag.
#[derive(Debug, Clone, PartialEq, Eq)]
struct DriveSearchResult {
    file_identifier: String,
    declared_name: String,
    mime_type: String,
    parent_folder_identifier: Option<String>,
    byte_size: Option<u64>,
    already_ingested: bool,
}

#[route(method = "GET", path = "/api/rag/drive/search")]
pub async fn search_rag_drive_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    google_access_token: GoogleAccessToken,
    Query(query_parameters): Query<HashMap<String, String>>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let requesting_account = authorized_request.authorized_principal();

    let search_expression = extract_drive_search_expression_from_query(&query_parameters)?;
    let mime_type_filter = parse_optional_drive_mime_type_filter(&query_parameters);
    let result_limit = parse_requested_drive_result_limit(&query_parameters);

    // Real Drive search with the caller's token (mime filter applied server-side).
    let drive_files = application_state
        .google_drive_adapter
        .search_files(
            google_access_token.as_str(),
            search_expression.as_str(),
            mime_type_filter.as_deref(),
            result_limit,
        )
        .await
        .map_err(HttpError::from)?;

    let parsed_results = map_drive_files_to_search_results(drive_files);
    let filtered_results = filter_drive_results_by_mime_type(parsed_results, &mime_type_filter);

    let ingested_identifiers = collect_already_ingested_drive_file_identifiers(
        &application_state.document_collection,
        requesting_account,
    )
    .await?;
    let annotated_results = mark_drive_results_already_ingested(filtered_results, &ingested_identifiers);

    let ranked_results = rank_drive_results_by_name_relevance(annotated_results, &search_expression);
    let limited_results = apply_drive_result_limit(ranked_results, result_limit);

    let response_body = assemble_drive_search_response(&search_expression, &limited_results);
    Ok(Json(response_body))
}

/// (1) Extract and validate the mandatory `query` parameter into a NonEmptyText.
fn extract_drive_search_expression_from_query(
    query_parameters: &HashMap<String, String>,
) -> Result<NonEmptyText, HttpError> {
    let raw_expression = query_parameters
        .get("query")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: "a non-empty 'query' parameter is required".to_string(),
        })?;

    NonEmptyText::parse(raw_expression)
        .map_err(|error| HttpError::RequestBodyWasMalformed { explanation: error.to_string() })
}

/// (2) Read an optional `mimeType` filter, normalised to lowercase; None when absent or blank.
fn parse_optional_drive_mime_type_filter(query_parameters: &HashMap<String, String>) -> Option<String> {
    query_parameters
        .get("mimeType")
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
}

/// (3) Parse the requested `limit`, clamping into the [1, MAXIMUM] range with a sensible default.
fn parse_requested_drive_result_limit(query_parameters: &HashMap<String, String>) -> usize {
    let requested = query_parameters
        .get("limit")
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(DEFAULT_DRIVE_RESULT_LIMIT);

    if requested == 0 {
        DEFAULT_DRIVE_RESULT_LIMIT
    } else {
        requested.min(MAXIMUM_DRIVE_RESULT_LIMIT)
    }
}

/// (4) Map port-level [`DriveFile`]s into the handler's result shape (mime lowercased
/// for the filter, missing mime defaulted).
fn map_drive_files_to_search_results(drive_files: Vec<DriveFile>) -> Vec<DriveSearchResult> {
    drive_files
        .into_iter()
        .map(|drive_file| DriveSearchResult {
            file_identifier: drive_file.id,
            declared_name: if drive_file.name.trim().is_empty() {
                "untitled".to_string()
            } else {
                drive_file.name
            },
            mime_type: drive_file
                .mime_type
                .map(|mime| mime.trim().to_lowercase())
                .filter(|mime| !mime.is_empty())
                .unwrap_or_else(|| "application/octet-stream".to_string()),
            parent_folder_identifier: drive_file.parent_id,
            byte_size: drive_file.size,
            already_ingested: false,
        })
        .collect()
}

/// (5) Keep only results matching an optional mime-type filter.
fn filter_drive_results_by_mime_type(
    search_results: Vec<DriveSearchResult>,
    mime_type_filter: &Option<String>,
) -> Vec<DriveSearchResult> {
    match mime_type_filter {
        None => search_results,
        Some(mime_type) => search_results
            .into_iter()
            .filter(|result| &result.mime_type == mime_type)
            .collect(),
    }
}

/// (6) Truncate the result set to the requested limit.
fn apply_drive_result_limit(
    mut search_results: Vec<DriveSearchResult>,
    result_limit: usize,
) -> Vec<DriveSearchResult> {
    if search_results.len() > result_limit {
        search_results.truncate(result_limit);
    }
    search_results
}

/// (7) Read the declared name of a result (accessor kept pure for testability/reuse).
fn read_drive_search_result_declared_name(search_result: &DriveSearchResult) -> String {
    search_result.declared_name.clone()
}

/// (8) Gather the set of drive file identifiers already ingested by the requesting account.
async fn collect_already_ingested_drive_file_identifiers(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    requesting_account: &Email,
) -> Result<HashSet<String>, HttpError> {
    let owned_documents = document_collection
        .list_documents_owned_by(RAG_KNOWLEDGE_COLLECTION_NAME, requesting_account.as_str())
        .await?;

    let mut ingested_identifiers = HashSet::new();
    for document in owned_documents {
        if let Some(source_file_identifier) = document
            .document_body
            .get("sourceFileId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            ingested_identifiers.insert(source_file_identifier.to_string());
        }
    }
    Ok(ingested_identifiers)
}

/// (9) Flag every result whose identifier appears in the already-ingested set.
fn mark_drive_results_already_ingested(
    search_results: Vec<DriveSearchResult>,
    ingested_identifiers: &HashSet<String>,
) -> Vec<DriveSearchResult> {
    search_results
        .into_iter()
        .map(|mut result| {
            result.already_ingested = ingested_identifiers.contains(&result.file_identifier);
            result
        })
        .collect()
}

/// (10) Rank results by how well their name matches the search expression (best first, stable).
fn rank_drive_results_by_name_relevance(
    search_results: Vec<DriveSearchResult>,
    search_expression: &NonEmptyText,
) -> Vec<DriveSearchResult> {
    let query_tokens: Vec<String> = tokenize_lowercase(search_expression.as_str());

    let mut scored: Vec<(usize, usize, DriveSearchResult)> = search_results
        .into_iter()
        .enumerate()
        .map(|(original_index, result)| {
            let score = score_name_relevance(&result.declared_name, &query_tokens);
            (score, original_index, result)
        })
        .collect();

    // Higher score first; ties preserve original ordering via the original index.
    scored.sort_by(|left, right| right.0.cmp(&left.0).then(left.1.cmp(&right.1)));

    scored.into_iter().map(|(_, _, result)| result).collect()
}

/// Split a phrase into lowercase alphanumeric tokens.
fn tokenize_lowercase(phrase: &str) -> Vec<String> {
    phrase
        .split(|character: char| !character.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(|token| token.to_lowercase())
        .collect()
}

/// Compute a relevance score: number of query tokens that appear in the candidate name.
fn score_name_relevance(candidate_name: &str, query_tokens: &[String]) -> usize {
    let lowercase_name = candidate_name.to_lowercase();
    query_tokens
        .iter()
        .filter(|token| lowercase_name.contains(token.as_str()))
        .count()
}

/// (11) Serialise a single result into the JSON shape returned to the client.
fn serialize_single_drive_search_result_to_json(search_result: &DriveSearchResult) -> Value {
    json!({
        "id": search_result.file_identifier,
        "name": read_drive_search_result_declared_name(search_result),
        "mimeType": search_result.mime_type,
        "parentId": search_result.parent_folder_identifier,
        "size": search_result.byte_size,
        "alreadyIngested": search_result.already_ingested,
    })
}

/// (12) Assemble the full response payload for the handler.
fn assemble_drive_search_response(
    search_expression: &NonEmptyText,
    search_results: &[DriveSearchResult],
) -> Value {
    let serialized_results: Vec<Value> = search_results
        .iter()
        .map(serialize_single_drive_search_result_to_json)
        .collect();

    json!({
        "query": search_expression.as_str(),
        "resultCount": serialized_results.len(),
        "results": serialized_results,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_query(entries: &[(&str, &str)]) -> HashMap<String, String> {
        entries
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    fn sample_result(id: &str, name: &str, mime: &str) -> DriveSearchResult {
        DriveSearchResult {
            file_identifier: id.to_string(),
            declared_name: name.to_string(),
            mime_type: mime.to_string(),
            parent_folder_identifier: None,
            byte_size: Some(1024),
            already_ingested: false,
        }
    }

    #[test]
    fn extract_search_expression_accepts_valid_query() {
        let query = sample_query(&[("query", "  oncology trials ")]);
        let expression = extract_drive_search_expression_from_query(&query).unwrap();
        assert_eq!(expression.as_str(), "oncology trials");
    }

    #[test]
    fn extract_search_expression_rejects_missing_query() {
        let query = sample_query(&[("mimeType", "application/pdf")]);
        assert!(extract_drive_search_expression_from_query(&query).is_err());
    }

    #[test]
    fn extract_search_expression_rejects_blank_query() {
        let query = sample_query(&[("query", "   ")]);
        assert!(extract_drive_search_expression_from_query(&query).is_err());
    }

    #[test]
    fn mime_type_filter_is_parsed_and_normalised() {
        let query = sample_query(&[("mimeType", "  Application/PDF ")]);
        assert_eq!(
            parse_optional_drive_mime_type_filter(&query),
            Some("application/pdf".to_string())
        );
    }

    #[test]
    fn mime_type_filter_absent_returns_none() {
        let query = sample_query(&[("query", "anything")]);
        assert_eq!(parse_optional_drive_mime_type_filter(&query), None);
    }

    #[test]
    fn result_limit_uses_default_when_absent() {
        let query = sample_query(&[("query", "x")]);
        assert_eq!(parse_requested_drive_result_limit(&query), DEFAULT_DRIVE_RESULT_LIMIT);
    }

    #[test]
    fn result_limit_is_clamped_to_maximum() {
        let query = sample_query(&[("limit", "999")]);
        assert_eq!(parse_requested_drive_result_limit(&query), MAXIMUM_DRIVE_RESULT_LIMIT);
    }

    #[test]
    fn result_limit_zero_falls_back_to_default() {
        let query = sample_query(&[("limit", "0")]);
        assert_eq!(parse_requested_drive_result_limit(&query), DEFAULT_DRIVE_RESULT_LIMIT);
    }

    #[test]
    fn map_drive_files_defaults_missing_fields_and_lowercases_mime() {
        let files = vec![
            DriveFile {
                id: "f1".to_string(),
                name: "Protocol".to_string(),
                mime_type: Some("Application/PDF".to_string()),
                parent_id: Some("folder-a".to_string()),
                size: Some(2048),
            },
            DriveFile {
                id: "f2".to_string(),
                name: "  ".to_string(),
                mime_type: None,
                parent_id: None,
                size: None,
            },
        ];
        let results = map_drive_files_to_search_results(files);
        assert_eq!(results[0].file_identifier, "f1");
        assert_eq!(results[0].mime_type, "application/pdf");
        assert_eq!(results[0].parent_folder_identifier, Some("folder-a".to_string()));
        assert_eq!(results[0].byte_size, Some(2048));
        assert_eq!(results[1].declared_name, "untitled");
        assert_eq!(results[1].mime_type, "application/octet-stream");
    }

    #[test]
    fn filter_by_mime_type_keeps_matching_only() {
        let results = vec![
            sample_result("1", "a", "application/pdf"),
            sample_result("2", "b", "application/json"),
        ];
        let filtered =
            filter_drive_results_by_mime_type(results, &Some("application/pdf".to_string()));
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].file_identifier, "1");
    }

    #[test]
    fn filter_by_mime_type_none_keeps_all() {
        let results = vec![
            sample_result("1", "a", "application/pdf"),
            sample_result("2", "b", "application/json"),
        ];
        let filtered = filter_drive_results_by_mime_type(results, &None);
        assert_eq!(filtered.len(), 2);
    }

    #[test]
    fn apply_limit_truncates_excess() {
        let results = vec![
            sample_result("1", "a", "x"),
            sample_result("2", "b", "x"),
            sample_result("3", "c", "x"),
        ];
        let limited = apply_drive_result_limit(results, 2);
        assert_eq!(limited.len(), 2);
    }

    #[test]
    fn apply_limit_leaves_smaller_sets_untouched() {
        let results = vec![sample_result("1", "a", "x")];
        let limited = apply_drive_result_limit(results, 5);
        assert_eq!(limited.len(), 1);
    }

    #[test]
    fn read_declared_name_returns_name() {
        let result = sample_result("1", "MyFile", "x");
        assert_eq!(read_drive_search_result_declared_name(&result), "MyFile");
    }

    #[test]
    fn mark_ingested_flags_matching_identifiers() {
        let results = vec![sample_result("1", "a", "x"), sample_result("2", "b", "x")];
        let mut ingested = HashSet::new();
        ingested.insert("2".to_string());
        let marked = mark_drive_results_already_ingested(results, &ingested);
        assert!(!marked[0].already_ingested);
        assert!(marked[1].already_ingested);
    }

    #[test]
    fn rank_results_places_best_match_first() {
        let expression = NonEmptyText::parse("cardio protocol".to_string()).unwrap();
        let results = vec![
            sample_result("1", "unrelated notes", "x"),
            sample_result("2", "cardio protocol final", "x"),
            sample_result("3", "cardio draft", "x"),
        ];
        let ranked = rank_drive_results_by_name_relevance(results, &expression);
        assert_eq!(ranked[0].file_identifier, "2");
        assert_eq!(ranked[2].file_identifier, "1");
    }

    #[test]
    fn rank_results_preserves_order_on_ties() {
        let expression = NonEmptyText::parse("zzz".to_string()).unwrap();
        let results = vec![
            sample_result("1", "alpha", "x"),
            sample_result("2", "beta", "x"),
        ];
        let ranked = rank_drive_results_by_name_relevance(results, &expression);
        assert_eq!(ranked[0].file_identifier, "1");
        assert_eq!(ranked[1].file_identifier, "2");
    }

    #[test]
    fn serialize_single_result_produces_expected_keys() {
        let result = sample_result("id1", "Name", "application/pdf");
        let value = serialize_single_drive_search_result_to_json(&result);
        assert_eq!(value["id"], "id1");
        assert_eq!(value["name"], "Name");
        assert_eq!(value["mimeType"], "application/pdf");
        assert_eq!(value["alreadyIngested"], false);
    }

    #[test]
    fn assemble_response_reports_count_and_query() {
        let expression = NonEmptyText::parse("oncology".to_string()).unwrap();
        let results = vec![sample_result("1", "a", "x"), sample_result("2", "b", "x")];
        let response = assemble_drive_search_response(&expression, &results);
        assert_eq!(response["query"], "oncology");
        assert_eq!(response["resultCount"], 2);
        assert_eq!(response["results"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn tokenize_splits_on_non_alphanumeric() {
        let tokens = tokenize_lowercase("Cardio-Protocol, v2");
        assert_eq!(tokens, vec!["cardio", "protocol", "v2"]);
    }

    #[test]
    fn score_name_relevance_counts_present_tokens() {
        let tokens = vec!["cardio".to_string(), "protocol".to_string()];
        assert_eq!(score_name_relevance("cardio protocol final", &tokens), 2);
        assert_eq!(score_name_relevance("cardio draft", &tokens), 1);
        assert_eq!(score_name_relevance("unrelated", &tokens), 0);
    }
}
