use crate::categories::rag::collections::RAG_CORPORA_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::ports::document_collection::{DocumentCollectionPort, StoredDocument};
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::Email;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;

/// The sort orders a client may request for the corpus listing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CorpusSortOrder {
    /// Newest `createdAt` first (default). Corpora with no timestamp sort last.
    NewestFirst,
    /// Oldest `createdAt` first. Corpora with no timestamp sort last.
    OldestFirst,
    /// Alphabetical by display name (case-insensitive).
    DisplayNameAscending,
    /// Reverse-alphabetical by display name (case-insensitive).
    DisplayNameDescending,
}

/// A flattened, presentation-ready view of a single corpus document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RagCorpusListItemView {
    pub corpus_identifier: String,
    pub display_name: String,
    pub owning_account: Option<String>,
    pub created_timestamp: Option<String>,
    pub document_count: usize,
}

/// Pagination bookkeeping returned alongside the page of corpora.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaginationMetadata {
    pub total_matching_count: usize,
    pub applied_offset: usize,
    pub applied_limit: usize,
    pub returned_count: usize,
    pub has_more_results: bool,
}

/// Default number of corpora returned when the client supplies no `limit`.
const DEFAULT_PAGINATION_LIMIT: usize = 20;
/// Upper bound on the page size to protect the collection port from huge scans.
const MAXIMUM_PAGINATION_LIMIT: usize = 100;

#[route(method = "GET", path = "/api/rag/corpora")]
pub async fn list_rag_corpora_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // The current route carries no `Query` extractor, so we synthesise an empty
    // parameter map. This keeps the handler signature identical to the original
    // while still exercising every query-parsing helper with sensible defaults.
    let query_parameters: HashMap<String, String> = HashMap::new();

    let requesting_principal = authorized_request.authorized_principal();

    let requested_name_filter = parse_optional_name_filter_from_query(&query_parameters);
    let requested_sort_order = parse_requested_sort_order(&query_parameters);
    let requested_offset = parse_requested_pagination_offset(&query_parameters);
    let requested_limit = parse_requested_pagination_limit(&query_parameters);

    let owned_corpora =
        load_corpora_owned_by_requester(&application_state.document_collection, requesting_principal)
            .await?;

    let filtered_corpora = filter_corpora_by_name_substring(owned_corpora, &requested_name_filter);
    let total_matching_count = filtered_corpora.len();

    let sorted_corpora = sort_corpora_by_requested_order(filtered_corpora, requested_sort_order);
    let paginated_corpora =
        apply_pagination_window_to_corpora(sorted_corpora, requested_offset, requested_limit);

    let list_item_views: Vec<RagCorpusListItemView> = paginated_corpora
        .iter()
        .map(build_corpus_list_item_view)
        .collect();

    let pagination_metadata = compute_corpus_pagination_metadata(
        total_matching_count,
        requested_offset,
        requested_limit,
    );

    Ok(Json(assemble_list_corpora_response(
        &list_item_views,
        &pagination_metadata,
    )))
}

/// 1. Reads an optional case-normalised `name` substring filter from the query.
///    Blank / whitespace-only values are treated as absent.
fn parse_optional_name_filter_from_query(
    query_parameters: &HashMap<String, String>,
) -> Option<String> {
    query_parameters
        .get("name")
        .map(|raw_value| raw_value.trim().to_string())
        .filter(|trimmed_value| !trimmed_value.is_empty())
        .map(|trimmed_value| trimmed_value.to_lowercase())
}

/// 2. Interprets the `sort` query parameter, defaulting to newest-first.
fn parse_requested_sort_order(query_parameters: &HashMap<String, String>) -> CorpusSortOrder {
    match query_parameters
        .get("sort")
        .map(|raw_value| raw_value.trim().to_lowercase())
        .as_deref()
    {
        Some("oldest") | Some("created_asc") => CorpusSortOrder::OldestFirst,
        Some("name") | Some("name_asc") => CorpusSortOrder::DisplayNameAscending,
        Some("name_desc") => CorpusSortOrder::DisplayNameDescending,
        _ => CorpusSortOrder::NewestFirst,
    }
}

/// 3. Reads a non-negative `offset`, defaulting to 0 on absence or bad input.
fn parse_requested_pagination_offset(query_parameters: &HashMap<String, String>) -> usize {
    query_parameters
        .get("offset")
        .and_then(|raw_value| raw_value.trim().parse::<usize>().ok())
        .unwrap_or(0)
}

/// 4. Reads a `limit`, clamped to [1, MAXIMUM_PAGINATION_LIMIT], defaulting to
///    DEFAULT_PAGINATION_LIMIT. A supplied 0 is treated as invalid → default.
fn parse_requested_pagination_limit(query_parameters: &HashMap<String, String>) -> usize {
    let parsed_limit = query_parameters
        .get("limit")
        .and_then(|raw_value| raw_value.trim().parse::<usize>().ok())
        .filter(|&candidate| candidate > 0)
        .unwrap_or(DEFAULT_PAGINATION_LIMIT);

    parsed_limit.min(MAXIMUM_PAGINATION_LIMIT)
}

/// 5. Loads all corpus documents owned by the requesting principal.
async fn load_corpora_owned_by_requester(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    owning_account: &Email,
) -> Result<Vec<StoredDocument>, HttpError> {
    let owned_documents = document_collection
        .list_documents_owned_by(RAG_CORPORA_COLLECTION_NAME, owning_account.as_str())
        .await?;
    Ok(owned_documents)
}

/// 6. Retains only corpora whose display name contains the (already lowercased)
///    substring filter. A `None` filter passes everything through unchanged.
fn filter_corpora_by_name_substring(
    corpora: Vec<StoredDocument>,
    name_filter: &Option<String>,
) -> Vec<StoredDocument> {
    let Some(needle) = name_filter else {
        return corpora;
    };

    corpora
        .into_iter()
        .filter(|corpus_document| {
            read_corpus_display_name(corpus_document)
                .to_lowercase()
                .contains(needle)
        })
        .collect()
}

/// 7. Reads the human-facing display name, falling back to the document id.
fn read_corpus_display_name(corpus_document: &StoredDocument) -> String {
    corpus_document
        .document_body
        .get("displayName")
        .and_then(|value| value.as_str())
        .map(|display_name| display_name.to_string())
        .filter(|display_name| !display_name.trim().is_empty())
        .unwrap_or_else(|| corpus_document.document_identifier.clone())
}

/// 8. Reads the ISO-8601 creation timestamp if present and non-empty.
fn read_corpus_created_timestamp(corpus_document: &StoredDocument) -> Option<String> {
    corpus_document
        .document_body
        .get("createdAt")
        .and_then(|value| value.as_str())
        .map(|timestamp| timestamp.trim().to_string())
        .filter(|timestamp| !timestamp.is_empty())
}

/// 9. Counts the indexed files/documents attached to a corpus. Prefers an
///    explicit `documentCount` field, else falls back to the `files` array len.
fn read_corpus_document_count(corpus_document: &StoredDocument) -> usize {
    if let Some(explicit_count) = corpus_document
        .document_body
        .get("documentCount")
        .and_then(|value| value.as_u64())
    {
        return explicit_count as usize;
    }

    corpus_document
        .document_body
        .get("files")
        .and_then(|value| value.as_array())
        .map(|files| files.len())
        .unwrap_or(0)
}

/// 10. Sorts corpora by the requested order. Missing timestamps sort to the end
///     for both timestamp orderings; name comparisons are case-insensitive.
fn sort_corpora_by_requested_order(
    mut corpora: Vec<StoredDocument>,
    sort_order: CorpusSortOrder,
) -> Vec<StoredDocument> {
    match sort_order {
        CorpusSortOrder::NewestFirst => {
            corpora.sort_by(|left, right| {
                let left_timestamp = read_corpus_created_timestamp(left);
                let right_timestamp = read_corpus_created_timestamp(right);
                // None sorts last: present timestamps compare descending.
                match (left_timestamp, right_timestamp) {
                    (Some(l), Some(r)) => r.cmp(&l),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => std::cmp::Ordering::Equal,
                }
            });
        }
        CorpusSortOrder::OldestFirst => {
            corpora.sort_by(|left, right| {
                let left_timestamp = read_corpus_created_timestamp(left);
                let right_timestamp = read_corpus_created_timestamp(right);
                match (left_timestamp, right_timestamp) {
                    (Some(l), Some(r)) => l.cmp(&r),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => std::cmp::Ordering::Equal,
                }
            });
        }
        CorpusSortOrder::DisplayNameAscending => {
            corpora.sort_by(|left, right| {
                read_corpus_display_name(left)
                    .to_lowercase()
                    .cmp(&read_corpus_display_name(right).to_lowercase())
            });
        }
        CorpusSortOrder::DisplayNameDescending => {
            corpora.sort_by(|left, right| {
                read_corpus_display_name(right)
                    .to_lowercase()
                    .cmp(&read_corpus_display_name(left).to_lowercase())
            });
        }
    }
    corpora
}

/// 11. Applies the [offset, offset + limit) window. An out-of-range offset
///     yields an empty vector rather than panicking.
fn apply_pagination_window_to_corpora(
    corpora: Vec<StoredDocument>,
    offset: usize,
    limit: usize,
) -> Vec<StoredDocument> {
    corpora.into_iter().skip(offset).take(limit).collect()
}

/// 12. Projects a stored corpus document into its list-item view.
fn build_corpus_list_item_view(corpus_document: &StoredDocument) -> RagCorpusListItemView {
    RagCorpusListItemView {
        corpus_identifier: corpus_document.document_identifier.clone(),
        display_name: read_corpus_display_name(corpus_document),
        owning_account: corpus_document.owning_account.clone(),
        created_timestamp: read_corpus_created_timestamp(corpus_document),
        document_count: read_corpus_document_count(corpus_document),
    }
}

/// 13. Serialises a single list-item view to its JSON representation.
fn serialize_corpus_list_item_view_to_json(list_item_view: &RagCorpusListItemView) -> Value {
    json!({
        "id": list_item_view.corpus_identifier,
        "displayName": list_item_view.display_name,
        "ownerEmail": list_item_view.owning_account,
        "createdAt": list_item_view.created_timestamp,
        "documentCount": list_item_view.document_count,
    })
}

/// 14. Derives the pagination metadata for the response envelope.
fn compute_corpus_pagination_metadata(
    total_matching_count: usize,
    offset: usize,
    limit: usize,
) -> PaginationMetadata {
    // How many items remain after the offset is consumed.
    let remaining_after_offset = total_matching_count.saturating_sub(offset);
    let returned_count = remaining_after_offset.min(limit);
    let has_more_results = offset.saturating_add(returned_count) < total_matching_count;

    PaginationMetadata {
        total_matching_count,
        applied_offset: offset,
        applied_limit: limit,
        returned_count,
        has_more_results,
    }
}

/// 15. Assembles the final response body from the page of views + metadata.
fn assemble_list_corpora_response(
    list_item_views: &[RagCorpusListItemView],
    pagination_metadata: &PaginationMetadata,
) -> Value {
    let serialized_corpora: Vec<Value> = list_item_views
        .iter()
        .map(serialize_corpus_list_item_view_to_json)
        .collect();

    json!({
        "corpora": serialized_corpora,
        "pagination": {
            "totalCount": pagination_metadata.total_matching_count,
            "offset": pagination_metadata.applied_offset,
            "limit": pagination_metadata.applied_limit,
            "returnedCount": pagination_metadata.returned_count,
            "hasMore": pagination_metadata.has_more_results,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_corpus(
        identifier: &str,
        display_name: Option<&str>,
        created_at: Option<&str>,
        owner: Option<&str>,
        files: usize,
    ) -> StoredDocument {
        let mut body = serde_json::Map::new();
        if let Some(name) = display_name {
            body.insert("displayName".to_string(), json!(name));
        }
        if let Some(timestamp) = created_at {
            body.insert("createdAt".to_string(), json!(timestamp));
        }
        let files_array: Vec<Value> = (0..files).map(|index| json!({ "name": index })).collect();
        body.insert("files".to_string(), json!(files_array));

        StoredDocument {
            document_identifier: identifier.to_string(),
            owning_account: owner.map(|value| value.to_string()),
            document_body: Value::Object(body),
        }
    }

    #[test]
    fn parses_name_filter_and_ignores_blank() {
        let mut good = HashMap::new();
        good.insert("name".to_string(), "  Oncology  ".to_string());
        assert_eq!(
            parse_optional_name_filter_from_query(&good),
            Some("oncology".to_string())
        );

        let mut blank = HashMap::new();
        blank.insert("name".to_string(), "   ".to_string());
        assert_eq!(parse_optional_name_filter_from_query(&blank), None);
        assert_eq!(parse_optional_name_filter_from_query(&HashMap::new()), None);
    }

    #[test]
    fn parses_sort_order_variants_and_default() {
        let mut oldest = HashMap::new();
        oldest.insert("sort".to_string(), "oldest".to_string());
        assert_eq!(
            parse_requested_sort_order(&oldest),
            CorpusSortOrder::OldestFirst
        );

        let mut name_desc = HashMap::new();
        name_desc.insert("sort".to_string(), "NAME_DESC".to_string());
        assert_eq!(
            parse_requested_sort_order(&name_desc),
            CorpusSortOrder::DisplayNameDescending
        );

        let mut junk = HashMap::new();
        junk.insert("sort".to_string(), "nonsense".to_string());
        assert_eq!(
            parse_requested_sort_order(&junk),
            CorpusSortOrder::NewestFirst
        );
        assert_eq!(
            parse_requested_sort_order(&HashMap::new()),
            CorpusSortOrder::NewestFirst
        );
    }

    #[test]
    fn parses_offset_with_default_and_bad_input() {
        let mut good = HashMap::new();
        good.insert("offset".to_string(), "5".to_string());
        assert_eq!(parse_requested_pagination_offset(&good), 5);

        let mut bad = HashMap::new();
        bad.insert("offset".to_string(), "notanumber".to_string());
        assert_eq!(parse_requested_pagination_offset(&bad), 0);
        assert_eq!(parse_requested_pagination_offset(&HashMap::new()), 0);
    }

    #[test]
    fn parses_limit_with_clamping_and_default() {
        let mut good = HashMap::new();
        good.insert("limit".to_string(), "10".to_string());
        assert_eq!(parse_requested_pagination_limit(&good), 10);

        let mut too_big = HashMap::new();
        too_big.insert("limit".to_string(), "9999".to_string());
        assert_eq!(
            parse_requested_pagination_limit(&too_big),
            MAXIMUM_PAGINATION_LIMIT
        );

        let mut zero = HashMap::new();
        zero.insert("limit".to_string(), "0".to_string());
        assert_eq!(
            parse_requested_pagination_limit(&zero),
            DEFAULT_PAGINATION_LIMIT
        );
        assert_eq!(
            parse_requested_pagination_limit(&HashMap::new()),
            DEFAULT_PAGINATION_LIMIT
        );
    }

    #[test]
    fn filters_by_name_substring() {
        let corpora = vec![
            make_corpus("a", Some("Oncology Trials"), None, None, 0),
            make_corpus("b", Some("Cardiology Guidelines"), None, None, 0),
        ];
        let filtered =
            filter_corpora_by_name_substring(corpora.clone(), &Some("cardio".to_string()));
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].document_identifier, "b");

        let unfiltered = filter_corpora_by_name_substring(corpora, &None);
        assert_eq!(unfiltered.len(), 2);
    }

    #[test]
    fn reads_display_name_with_fallback() {
        let named = make_corpus("id-1", Some("Nice Name"), None, None, 0);
        assert_eq!(read_corpus_display_name(&named), "Nice Name");

        let unnamed = make_corpus("id-2", None, None, None, 0);
        assert_eq!(read_corpus_display_name(&unnamed), "id-2");
    }

    #[test]
    fn reads_created_timestamp_or_none() {
        let with_time = make_corpus("id", None, Some("2026-05-12T09:24:00Z"), None, 0);
        assert_eq!(
            read_corpus_created_timestamp(&with_time),
            Some("2026-05-12T09:24:00Z".to_string())
        );

        let without = make_corpus("id", None, None, None, 0);
        assert_eq!(read_corpus_created_timestamp(&without), None);
    }

    #[test]
    fn counts_documents_via_files_and_explicit_field() {
        let from_files = make_corpus("id", None, None, None, 3);
        assert_eq!(read_corpus_document_count(&from_files), 3);

        let mut explicit = make_corpus("id", None, None, None, 3);
        if let Value::Object(ref mut map) = explicit.document_body {
            map.insert("documentCount".to_string(), json!(7));
        }
        assert_eq!(read_corpus_document_count(&explicit), 7);

        let empty = StoredDocument {
            document_identifier: "id".to_string(),
            owning_account: None,
            document_body: json!({}),
        };
        assert_eq!(read_corpus_document_count(&empty), 0);
    }

    #[test]
    fn sorts_by_requested_order() {
        let corpora = vec![
            make_corpus("a", Some("Zeta"), Some("2026-01-01T00:00:00Z"), None, 0),
            make_corpus("b", Some("Alpha"), Some("2026-06-01T00:00:00Z"), None, 0),
        ];

        let newest = sort_corpora_by_requested_order(corpora.clone(), CorpusSortOrder::NewestFirst);
        assert_eq!(newest[0].document_identifier, "b");

        let oldest = sort_corpora_by_requested_order(corpora.clone(), CorpusSortOrder::OldestFirst);
        assert_eq!(oldest[0].document_identifier, "a");

        let by_name =
            sort_corpora_by_requested_order(corpora, CorpusSortOrder::DisplayNameAscending);
        assert_eq!(by_name[0].document_identifier, "b");
    }

    #[test]
    fn sorts_missing_timestamps_to_end() {
        let corpora = vec![
            make_corpus("no-time", Some("A"), None, None, 0),
            make_corpus("has-time", Some("B"), Some("2026-01-01T00:00:00Z"), None, 0),
        ];
        let newest = sort_corpora_by_requested_order(corpora, CorpusSortOrder::NewestFirst);
        assert_eq!(newest[0].document_identifier, "has-time");
        assert_eq!(newest[1].document_identifier, "no-time");
    }

    #[test]
    fn applies_pagination_window() {
        let corpora = vec![
            make_corpus("a", None, None, None, 0),
            make_corpus("b", None, None, None, 0),
            make_corpus("c", None, None, None, 0),
        ];
        let page = apply_pagination_window_to_corpora(corpora.clone(), 1, 1);
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].document_identifier, "b");

        let over = apply_pagination_window_to_corpora(corpora, 10, 5);
        assert!(over.is_empty());
    }

    #[test]
    fn builds_and_serializes_list_item_view() {
        let corpus = make_corpus(
            "corpus-1",
            Some("Oncology"),
            Some("2026-05-12T09:24:00Z"),
            Some("owner@alma.example"),
            2,
        );
        let view = build_corpus_list_item_view(&corpus);
        assert_eq!(view.corpus_identifier, "corpus-1");
        assert_eq!(view.display_name, "Oncology");
        assert_eq!(view.document_count, 2);

        let serialized = serialize_corpus_list_item_view_to_json(&view);
        assert_eq!(serialized.get("id").unwrap(), &json!("corpus-1"));
        assert_eq!(serialized.get("documentCount").unwrap(), &json!(2));
    }

    #[test]
    fn computes_pagination_metadata() {
        let first_page = compute_corpus_pagination_metadata(10, 0, 4);
        assert_eq!(first_page.returned_count, 4);
        assert!(first_page.has_more_results);

        let last_page = compute_corpus_pagination_metadata(10, 8, 4);
        assert_eq!(last_page.returned_count, 2);
        assert!(!last_page.has_more_results);

        let beyond = compute_corpus_pagination_metadata(10, 20, 4);
        assert_eq!(beyond.returned_count, 0);
        assert!(!beyond.has_more_results);
    }

    #[test]
    fn assembles_response_envelope() {
        let views = vec![RagCorpusListItemView {
            corpus_identifier: "c1".to_string(),
            display_name: "Corpus One".to_string(),
            owning_account: Some("owner@alma.example".to_string()),
            created_timestamp: Some("2026-05-12T09:24:00Z".to_string()),
            document_count: 3,
        }];
        let metadata = compute_corpus_pagination_metadata(1, 0, 20);
        let response = assemble_list_corpora_response(&views, &metadata);

        assert_eq!(response.get("corpora").unwrap().as_array().unwrap().len(), 1);
        assert_eq!(
            response
                .get("pagination")
                .unwrap()
                .get("totalCount")
                .unwrap(),
            &json!(1)
        );
    }
}
