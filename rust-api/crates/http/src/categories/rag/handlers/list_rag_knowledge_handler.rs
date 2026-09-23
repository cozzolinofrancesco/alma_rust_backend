use crate::categories::rag::collections::RAG_KNOWLEDGE_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::ports::document_collection::{DocumentCollectionPort, StoredDocument};
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::{Email, NonEmptyText};
use alma_macros::route;
use axum::Json;
use axum::extract::{Query, State};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;

/// The classification of where a piece of knowledge originally came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KnowledgeSourceKind {
    /// Uploaded file (PDF, DOCX, plain text, …).
    UploadedDocument,
    /// A web page fetched by a crawler.
    WebPage,
    /// Text pasted directly by the user.
    ManualEntry,
    /// Origin could not be determined from the stored body.
    Unknown,
}

impl KnowledgeSourceKind {
    /// Stable machine-readable identifier used in JSON responses.
    fn as_wire_identifier(self) -> &'static str {
        match self {
            KnowledgeSourceKind::UploadedDocument => "uploaded_document",
            KnowledgeSourceKind::WebPage => "web_page",
            KnowledgeSourceKind::ManualEntry => "manual_entry",
            KnowledgeSourceKind::Unknown => "unknown",
        }
    }
}

/// A flattened, presentation-ready view of a single knowledge entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RagKnowledgeListItemView {
    pub knowledge_identifier: String,
    pub title: String,
    pub parent_corpus_identifier: Option<String>,
    pub source_kind: KnowledgeSourceKind,
    pub owning_account: Option<String>,
}

const DEFAULT_KNOWLEDGE_PAGINATION_LIMIT: usize = 50;
const MAXIMUM_KNOWLEDGE_PAGINATION_LIMIT: usize = 500;

#[route(method = "GET", path = "/api/rag-knowledge/list")]
pub async fn list_rag_knowledge_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Query(query_parameters): Query<HashMap<String, String>>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let corpus_scope_filter = parse_optional_corpus_scope_filter(&query_parameters);
    let knowledge_search_term = parse_optional_knowledge_search_term(&query_parameters);
    let requested_pagination_limit = parse_requested_knowledge_pagination_limit(&query_parameters);

    let owning_account = authorized_request.authorized_principal();
    let owned_knowledge_entries =
        load_knowledge_entries_owned_by_requester(&application_state.document_collection, owning_account)
            .await?;

    let scoped_entries =
        filter_knowledge_entries_by_corpus_scope(owned_knowledge_entries, &corpus_scope_filter);
    let searched_entries =
        filter_knowledge_entries_by_search_term(scoped_entries, &knowledge_search_term);

    let total_matching_count = searched_entries.len();

    let sorted_entries = sort_knowledge_entries_by_title_ascending(searched_entries);
    let paginated_entries =
        apply_knowledge_pagination_limit(sorted_entries, requested_pagination_limit);

    let list_item_views: Vec<RagKnowledgeListItemView> = paginated_entries
        .iter()
        .map(build_knowledge_list_item_view)
        .collect();

    let response_body = assemble_list_knowledge_response(&list_item_views, total_matching_count);
    Ok(Json(response_body))
}

/// (1) Extract an optional corpus-scope filter from the query string.
///
/// Accepts either `corpus` or `parent_corpus` as the parameter key. Blank
/// values are treated as "no filter".
fn parse_optional_corpus_scope_filter(query_parameters: &HashMap<String, String>) -> Option<String> {
    query_parameters
        .get("corpus")
        .or_else(|| query_parameters.get("parent_corpus"))
        .map(|raw_value| raw_value.trim().to_string())
        .filter(|trimmed_value| !trimmed_value.is_empty())
}

/// (2) Extract an optional free-text search term from the query string.
///
/// Accepts `search` or `q`. Returns `None` when the term is absent or blank,
/// since an empty search must not be parsed into a `NonEmptyText`.
fn parse_optional_knowledge_search_term(
    query_parameters: &HashMap<String, String>,
) -> Option<NonEmptyText> {
    let raw_term = query_parameters
        .get("search")
        .or_else(|| query_parameters.get("q"))?;
    NonEmptyText::parse(raw_term.trim().to_string()).ok()
}

/// (3) Determine the requested pagination limit, clamped to sane bounds.
///
/// Falls back to [`DEFAULT_KNOWLEDGE_PAGINATION_LIMIT`] when absent or
/// unparseable, and never exceeds [`MAXIMUM_KNOWLEDGE_PAGINATION_LIMIT`].
/// A requested value of zero also falls back to the default.
fn parse_requested_knowledge_pagination_limit(query_parameters: &HashMap<String, String>) -> usize {
    let requested_limit = query_parameters
        .get("limit")
        .and_then(|raw_value| raw_value.trim().parse::<usize>().ok())
        .filter(|parsed_value| *parsed_value > 0)
        .unwrap_or(DEFAULT_KNOWLEDGE_PAGINATION_LIMIT);
    requested_limit.min(MAXIMUM_KNOWLEDGE_PAGINATION_LIMIT)
}

/// (4) Load every knowledge entry owned by the requesting account.
async fn load_knowledge_entries_owned_by_requester(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    owning_account: &Email,
) -> Result<Vec<StoredDocument>, HttpError> {
    let owned_documents = document_collection
        .list_documents_owned_by(RAG_KNOWLEDGE_COLLECTION_NAME, owning_account.as_str())
        .await?;
    Ok(owned_documents)
}

/// (5) Read the human-readable title of a knowledge entry.
///
/// Prefers an explicit `title`, then `name`, then the document identifier as a
/// last resort so the UI always has something to show.
fn read_knowledge_entry_title(knowledge_document: &StoredDocument) -> String {
    read_first_non_empty_string_field(&knowledge_document.document_body, &["title", "name"])
        .unwrap_or_else(|| knowledge_document.document_identifier.clone())
}

/// (6) Read the parent-corpus identifier a knowledge entry belongs to, if any.
fn read_knowledge_entry_parent_corpus_identifier(
    knowledge_document: &StoredDocument,
) -> Option<String> {
    read_first_non_empty_string_field(
        &knowledge_document.document_body,
        &["parent_corpus_identifier", "corpus_identifier", "corpus"],
    )
}

/// (7) Classify where a knowledge entry originated from.
fn read_knowledge_entry_source_kind(knowledge_document: &StoredDocument) -> KnowledgeSourceKind {
    match read_first_non_empty_string_field(&knowledge_document.document_body, &["source_kind", "source_type"])
    {
        Some(raw_kind) => match raw_kind.to_ascii_lowercase().as_str() {
            "uploaded_document" | "upload" | "file" | "document" => {
                KnowledgeSourceKind::UploadedDocument
            }
            "web_page" | "web" | "url" | "crawl" => KnowledgeSourceKind::WebPage,
            "manual_entry" | "manual" | "paste" | "text" => KnowledgeSourceKind::ManualEntry,
            _ => KnowledgeSourceKind::Unknown,
        },
        None => {
            // Fall back to structural inference when no explicit marker exists.
            if knowledge_document.document_body.get("source_url").is_some() {
                KnowledgeSourceKind::WebPage
            } else if knowledge_document.document_body.get("file_name").is_some() {
                KnowledgeSourceKind::UploadedDocument
            } else {
                KnowledgeSourceKind::Unknown
            }
        }
    }
}

/// (8) Keep only entries belonging to the requested corpus scope.
///
/// A `None` scope is a pass-through: every entry is retained.
fn filter_knowledge_entries_by_corpus_scope(
    knowledge_documents: Vec<StoredDocument>,
    corpus_scope: &Option<String>,
) -> Vec<StoredDocument> {
    match corpus_scope {
        None => knowledge_documents,
        Some(expected_corpus) => knowledge_documents
            .into_iter()
            .filter(|knowledge_document| {
                read_knowledge_entry_parent_corpus_identifier(knowledge_document)
                    .as_deref()
                    == Some(expected_corpus.as_str())
            })
            .collect(),
    }
}

/// (9) Keep only entries matching the requested search term.
///
/// A `None` term is a pass-through.
fn filter_knowledge_entries_by_search_term(
    knowledge_documents: Vec<StoredDocument>,
    search_term: &Option<NonEmptyText>,
) -> Vec<StoredDocument> {
    match search_term {
        None => knowledge_documents,
        Some(term) => knowledge_documents
            .into_iter()
            .filter(|knowledge_document| does_knowledge_entry_match_search_term(knowledge_document, term))
            .collect(),
    }
}

/// (10) Case-insensitive substring match against the title and body text.
fn does_knowledge_entry_match_search_term(
    knowledge_document: &StoredDocument,
    search_term: &NonEmptyText,
) -> bool {
    let needle = search_term.as_str().to_ascii_lowercase();

    if read_knowledge_entry_title(knowledge_document)
        .to_ascii_lowercase()
        .contains(&needle)
    {
        return true;
    }

    if let Some(body_text) =
        read_first_non_empty_string_field(&knowledge_document.document_body, &["content", "body", "text"])
    {
        if body_text.to_ascii_lowercase().contains(&needle) {
            return true;
        }
    }

    knowledge_document
        .document_identifier
        .to_ascii_lowercase()
        .contains(&needle)
}

/// (11) Sort entries by title, case-insensitively, ascending.
///
/// Ties are broken by document identifier to keep ordering deterministic.
fn sort_knowledge_entries_by_title_ascending(
    mut knowledge_documents: Vec<StoredDocument>,
) -> Vec<StoredDocument> {
    knowledge_documents.sort_by(|left, right| {
        let left_title = read_knowledge_entry_title(left).to_ascii_lowercase();
        let right_title = read_knowledge_entry_title(right).to_ascii_lowercase();
        left_title
            .cmp(&right_title)
            .then_with(|| left.document_identifier.cmp(&right.document_identifier))
    });
    knowledge_documents
}

/// (12) Truncate the entry list to at most `limit` items.
fn apply_knowledge_pagination_limit(
    mut knowledge_documents: Vec<StoredDocument>,
    limit: usize,
) -> Vec<StoredDocument> {
    if knowledge_documents.len() > limit {
        knowledge_documents.truncate(limit);
    }
    knowledge_documents
}

/// (13) Build a flattened presentation view for a single knowledge entry.
fn build_knowledge_list_item_view(knowledge_document: &StoredDocument) -> RagKnowledgeListItemView {
    RagKnowledgeListItemView {
        knowledge_identifier: knowledge_document.document_identifier.clone(),
        title: read_knowledge_entry_title(knowledge_document),
        parent_corpus_identifier: read_knowledge_entry_parent_corpus_identifier(knowledge_document),
        source_kind: read_knowledge_entry_source_kind(knowledge_document),
        owning_account: knowledge_document.owning_account.clone(),
    }
}

/// (14) Serialize a single list-item view into its JSON representation.
fn serialize_knowledge_list_item_view_to_json(list_item_view: &RagKnowledgeListItemView) -> Value {
    json!({
        "knowledge_identifier": list_item_view.knowledge_identifier,
        "title": list_item_view.title,
        "parent_corpus_identifier": list_item_view.parent_corpus_identifier,
        "source_kind": list_item_view.source_kind.as_wire_identifier(),
        "owning_account": list_item_view.owning_account,
    })
}

/// (15) Assemble the final response envelope for the list endpoint.
fn assemble_list_knowledge_response(
    list_item_views: &[RagKnowledgeListItemView],
    total_matching_count: usize,
) -> Value {
    let serialized_entries: Vec<Value> = list_item_views
        .iter()
        .map(serialize_knowledge_list_item_view_to_json)
        .collect();
    json!({
        "knowledge_entries": serialized_entries,
        "returned_count": serialized_entries.len(),
        "total_matching_count": total_matching_count,
    })
}

/// Shared helper: read the first non-empty string among `candidate_keys`.
///
/// Kept private and non-generic so it is trivially testable and does not leak
/// into the public surface. Not part of the numbered plan — a small internal
/// utility reused by several readers above.
fn read_first_non_empty_string_field(document_body: &Value, candidate_keys: &[&str]) -> Option<String> {
    for candidate_key in candidate_keys {
        if let Some(field_value) = document_body.get(candidate_key).and_then(Value::as_str) {
            let trimmed = field_value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_document(identifier: &str, owner: Option<&str>, body: Value) -> StoredDocument {
        StoredDocument {
            document_identifier: identifier.to_string(),
            owning_account: owner.map(str::to_string),
            document_body: body,
        }
    }

    #[test]
    fn parse_optional_corpus_scope_filter_reads_value() {
        let mut params = HashMap::new();
        params.insert("corpus".to_string(), "  physics  ".to_string());
        assert_eq!(
            parse_optional_corpus_scope_filter(&params),
            Some("physics".to_string())
        );
    }

    #[test]
    fn parse_optional_corpus_scope_filter_handles_missing_and_blank() {
        let empty: HashMap<String, String> = HashMap::new();
        assert_eq!(parse_optional_corpus_scope_filter(&empty), None);

        let mut blank = HashMap::new();
        blank.insert("corpus".to_string(), "   ".to_string());
        assert_eq!(parse_optional_corpus_scope_filter(&blank), None);
    }

    #[test]
    fn parse_optional_knowledge_search_term_parses_and_rejects_blank() {
        let mut good = HashMap::new();
        good.insert("search".to_string(), " neurons ".to_string());
        let parsed = parse_optional_knowledge_search_term(&good).expect("term should parse");
        assert_eq!(parsed.as_str(), "neurons");

        let mut blank = HashMap::new();
        blank.insert("q".to_string(), "   ".to_string());
        assert!(parse_optional_knowledge_search_term(&blank).is_none());
    }

    #[test]
    fn parse_requested_knowledge_pagination_limit_defaults_and_clamps() {
        let empty: HashMap<String, String> = HashMap::new();
        assert_eq!(
            parse_requested_knowledge_pagination_limit(&empty),
            DEFAULT_KNOWLEDGE_PAGINATION_LIMIT
        );

        let mut over = HashMap::new();
        over.insert("limit".to_string(), "100000".to_string());
        assert_eq!(
            parse_requested_knowledge_pagination_limit(&over),
            MAXIMUM_KNOWLEDGE_PAGINATION_LIMIT
        );

        let mut zero = HashMap::new();
        zero.insert("limit".to_string(), "0".to_string());
        assert_eq!(
            parse_requested_knowledge_pagination_limit(&zero),
            DEFAULT_KNOWLEDGE_PAGINATION_LIMIT
        );

        let mut valid = HashMap::new();
        valid.insert("limit".to_string(), "12".to_string());
        assert_eq!(parse_requested_knowledge_pagination_limit(&valid), 12);
    }

    #[test]
    fn read_knowledge_entry_title_prefers_title_then_falls_back() {
        let with_title = make_document("id-1", None, json!({ "title": "Quantum Notes" }));
        assert_eq!(read_knowledge_entry_title(&with_title), "Quantum Notes");

        let with_name = make_document("id-2", None, json!({ "name": "Fallback Name" }));
        assert_eq!(read_knowledge_entry_title(&with_name), "Fallback Name");

        let without = make_document("id-3", None, json!({}));
        assert_eq!(read_knowledge_entry_title(&without), "id-3");
    }

    #[test]
    fn read_knowledge_entry_parent_corpus_identifier_reads_variants() {
        let with_corpus = make_document("id", None, json!({ "corpus_identifier": "bio" }));
        assert_eq!(
            read_knowledge_entry_parent_corpus_identifier(&with_corpus),
            Some("bio".to_string())
        );

        let without = make_document("id", None, json!({ "other": "x" }));
        assert_eq!(read_knowledge_entry_parent_corpus_identifier(&without), None);
    }

    #[test]
    fn read_knowledge_entry_source_kind_classifies_explicit_and_inferred() {
        let explicit = make_document("id", None, json!({ "source_kind": "web" }));
        assert_eq!(
            read_knowledge_entry_source_kind(&explicit),
            KnowledgeSourceKind::WebPage
        );

        let inferred_upload = make_document("id", None, json!({ "file_name": "paper.pdf" }));
        assert_eq!(
            read_knowledge_entry_source_kind(&inferred_upload),
            KnowledgeSourceKind::UploadedDocument
        );

        let unknown = make_document("id", None, json!({}));
        assert_eq!(
            read_knowledge_entry_source_kind(&unknown),
            KnowledgeSourceKind::Unknown
        );
    }

    #[test]
    fn filter_knowledge_entries_by_corpus_scope_filters_and_passes_through() {
        let documents = vec![
            make_document("a", None, json!({ "corpus": "x" })),
            make_document("b", None, json!({ "corpus": "y" })),
        ];

        let filtered =
            filter_knowledge_entries_by_corpus_scope(documents.clone(), &Some("x".to_string()));
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].document_identifier, "a");

        let all = filter_knowledge_entries_by_corpus_scope(documents, &None);
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn filter_knowledge_entries_by_search_term_filters_and_passes_through() {
        let documents = vec![
            make_document("a", None, json!({ "title": "Alpha topic" })),
            make_document("b", None, json!({ "title": "Beta topic" })),
        ];
        let term = NonEmptyText::parse("alpha".to_string()).unwrap();

        let filtered = filter_knowledge_entries_by_search_term(documents.clone(), &Some(term));
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].document_identifier, "a");

        let all = filter_knowledge_entries_by_search_term(documents, &None);
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn does_knowledge_entry_match_search_term_checks_title_body_and_id() {
        let term = NonEmptyText::parse("dna".to_string()).unwrap();

        let by_title = make_document("x", None, json!({ "title": "DNA replication" }));
        assert!(does_knowledge_entry_match_search_term(&by_title, &term));

        let by_body = make_document("x", None, json!({ "content": "notes about dna strands" }));
        assert!(does_knowledge_entry_match_search_term(&by_body, &term));

        let no_match = make_document("y", None, json!({ "title": "unrelated" }));
        assert!(!does_knowledge_entry_match_search_term(&no_match, &term));
    }

    #[test]
    fn sort_knowledge_entries_by_title_ascending_orders_case_insensitively() {
        let documents = vec![
            make_document("1", None, json!({ "title": "zebra" })),
            make_document("2", None, json!({ "title": "Apple" })),
            make_document("3", None, json!({ "title": "mango" })),
        ];
        let sorted = sort_knowledge_entries_by_title_ascending(documents);
        let titles: Vec<String> = sorted.iter().map(read_knowledge_entry_title).collect();
        assert_eq!(titles, vec!["Apple", "mango", "zebra"]);
    }

    #[test]
    fn apply_knowledge_pagination_limit_truncates_and_preserves() {
        let documents = vec![
            make_document("1", None, json!({})),
            make_document("2", None, json!({})),
            make_document("3", None, json!({})),
        ];

        let limited = apply_knowledge_pagination_limit(documents.clone(), 2);
        assert_eq!(limited.len(), 2);

        let untouched = apply_knowledge_pagination_limit(documents, 10);
        assert_eq!(untouched.len(), 3);
    }

    #[test]
    fn build_knowledge_list_item_view_maps_all_fields() {
        let document = make_document(
            "kid",
            Some("owner@example.com"),
            json!({ "title": "Cells", "corpus": "bio", "source_kind": "manual" }),
        );
        let view = build_knowledge_list_item_view(&document);
        assert_eq!(view.knowledge_identifier, "kid");
        assert_eq!(view.title, "Cells");
        assert_eq!(view.parent_corpus_identifier, Some("bio".to_string()));
        assert_eq!(view.source_kind, KnowledgeSourceKind::ManualEntry);
        assert_eq!(view.owning_account, Some("owner@example.com".to_string()));
    }

    #[test]
    fn serialize_knowledge_list_item_view_to_json_produces_expected_shape() {
        let view = RagKnowledgeListItemView {
            knowledge_identifier: "kid".to_string(),
            title: "Cells".to_string(),
            parent_corpus_identifier: Some("bio".to_string()),
            source_kind: KnowledgeSourceKind::WebPage,
            owning_account: None,
        };
        let serialized = serialize_knowledge_list_item_view_to_json(&view);
        assert_eq!(serialized["knowledge_identifier"], "kid");
        assert_eq!(serialized["title"], "Cells");
        assert_eq!(serialized["parent_corpus_identifier"], "bio");
        assert_eq!(serialized["source_kind"], "web_page");
        assert!(serialized["owning_account"].is_null());
    }

    #[test]
    fn assemble_list_knowledge_response_reports_counts() {
        let views = vec![
            RagKnowledgeListItemView {
                knowledge_identifier: "a".to_string(),
                title: "A".to_string(),
                parent_corpus_identifier: None,
                source_kind: KnowledgeSourceKind::Unknown,
                owning_account: None,
            },
            RagKnowledgeListItemView {
                knowledge_identifier: "b".to_string(),
                title: "B".to_string(),
                parent_corpus_identifier: None,
                source_kind: KnowledgeSourceKind::Unknown,
                owning_account: None,
            },
        ];
        let response = assemble_list_knowledge_response(&views, 7);
        assert_eq!(response["returned_count"], 2);
        assert_eq!(response["total_matching_count"], 7);
        assert_eq!(
            response["knowledge_entries"].as_array().unwrap().len(),
            2
        );
    }

    #[test]
    fn read_first_non_empty_string_field_skips_blank_values() {
        let body = json!({ "title": "   ", "name": "Real Name" });
        assert_eq!(
            read_first_non_empty_string_field(&body, &["title", "name"]),
            Some("Real Name".to_string())
        );
        assert_eq!(read_first_non_empty_string_field(&body, &["missing"]), None);
    }
}
