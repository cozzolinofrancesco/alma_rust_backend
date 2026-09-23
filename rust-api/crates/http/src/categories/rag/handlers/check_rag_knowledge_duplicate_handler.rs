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
use axum::extract::State;
use serde_json::{Value, json};
use std::sync::Arc;

/// The reason a candidate knowledge document was classified as a duplicate of an
/// already-stored document. Callers surface this to the client so the UI can
/// explain *why* an upload was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DuplicateMatchReason {
    /// The candidate's content hash exactly matched a stored document.
    IdenticalContentHash,
    /// The candidate's normalized title fingerprint matched a stored document,
    /// but the content hash differed (or was absent).
    IdenticalTitleFingerprint,
    /// Both the content hash and the title fingerprint matched.
    IdenticalContentAndTitle,
}

impl DuplicateMatchReason {
    /// Stable machine-readable code for the reason, used in JSON responses.
    fn as_response_code(self) -> &'static str {
        match self {
            DuplicateMatchReason::IdenticalContentHash => "identical_content_hash",
            DuplicateMatchReason::IdenticalTitleFingerprint => "identical_title_fingerprint",
            DuplicateMatchReason::IdenticalContentAndTitle => "identical_content_and_title",
        }
    }
}

#[route(method = "POST", path = "/api/rag-knowledge/check-duplicate")]
pub async fn check_rag_knowledge_duplicate_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let owning_account = authorized_request.authorized_principal();

    // Parse and validate the candidate document out of the request body.
    let candidate_title = extract_candidate_document_title_from_body(&submitted_body)?;
    let candidate_content_hash = extract_candidate_content_hash_from_body(&submitted_body);
    let target_corpus_identifier = extract_optional_target_corpus_identifier_from_body(&submitted_body);
    let candidate_fingerprint = compute_normalized_title_fingerprint(&candidate_title);

    // Load the documents this account already owns, then narrow to the target
    // corpus if one was supplied.
    let existing_documents =
        load_existing_knowledge_documents_for_account(&application_state.document_collection, owning_account)
            .await?;
    let scoped_documents =
        filter_stored_documents_to_matching_corpus(existing_documents, &target_corpus_identifier);

    // Look for the first stored document that collides with the candidate.
    let maybe_duplicate = locate_first_duplicate_stored_document(
        &scoped_documents,
        &candidate_fingerprint,
        &candidate_content_hash,
    );

    let response_body = match maybe_duplicate {
        Some(duplicate_document) => {
            let matched_by_hash = candidate_content_hash
                .as_deref()
                .map(|candidate_hash| does_stored_document_match_content_hash(duplicate_document, candidate_hash))
                .unwrap_or(false);
            let matched_by_title =
                does_stored_document_match_title_fingerprint(duplicate_document, &candidate_fingerprint);
            let match_reason = classify_duplicate_match_reason(matched_by_hash, matched_by_title);
            assemble_duplicate_present_response(duplicate_document, match_reason)
        }
        None => assemble_duplicate_absent_response(&candidate_fingerprint),
    };

    Ok(Json(response_body))
}

/// (1) Pull the candidate document title out of the request body. Accepts either
/// `title` or the legacy `fileName` field, and rejects blank/missing values.
fn extract_candidate_document_title_from_body(submitted_body: &Value) -> Result<NonEmptyText, HttpError> {
    let raw_title = submitted_body
        .get("title")
        .or_else(|| submitted_body.get("fileName"))
        .or_else(|| submitted_body.get("documentTitle"))
        .and_then(|title_value| title_value.as_str())
        .unwrap_or_default()
        .to_string();

    NonEmptyText::parse(raw_title)
        .map_err(|parse_error| HttpError::RequestBodyWasMalformed {
            explanation: format!("a non-empty document title is required: {parse_error}"),
        })
}

/// (2) Pull the optional content hash out of the request body, trimming
/// surrounding whitespace. Empty strings collapse to `None`.
fn extract_candidate_content_hash_from_body(submitted_body: &Value) -> Option<String> {
    submitted_body
        .get("content_hash")
        .or_else(|| submitted_body.get("contentHash"))
        .and_then(|hash_value| hash_value.as_str())
        .map(|raw_hash| raw_hash.trim().to_string())
        .filter(|trimmed_hash| !trimmed_hash.is_empty())
}

/// (3) Pull the optional target corpus identifier out of the request body.
fn extract_optional_target_corpus_identifier_from_body(submitted_body: &Value) -> Option<String> {
    submitted_body
        .get("corpus_id")
        .or_else(|| submitted_body.get("corpusId"))
        .or_else(|| submitted_body.get("corpusIdentifier"))
        .and_then(|corpus_value| corpus_value.as_str())
        .map(|raw_corpus| raw_corpus.trim().to_string())
        .filter(|trimmed_corpus| !trimmed_corpus.is_empty())
}

/// (4) Reduce a title to a stable comparison fingerprint: lowercase, collapse
/// internal whitespace runs to a single space, and drop non-alphanumeric noise.
/// Two titles that differ only in casing/spacing/punctuation share a fingerprint.
fn compute_normalized_title_fingerprint(candidate_title: &NonEmptyText) -> String {
    let lowercased = candidate_title.as_str().to_lowercase();
    let mut fingerprint = String::with_capacity(lowercased.len());
    let mut previous_was_separator = false;

    for character in lowercased.chars() {
        if character.is_alphanumeric() {
            fingerprint.push(character);
            previous_was_separator = false;
        } else if !previous_was_separator {
            // Collapse any run of separators/punctuation to one space.
            fingerprint.push(' ');
            previous_was_separator = true;
        }
    }

    fingerprint.trim().to_string()
}

/// (5) Load every knowledge document owned by the given account from the RAG
/// knowledge collection.
async fn load_existing_knowledge_documents_for_account(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    owning_account: &Email,
) -> Result<Vec<StoredDocument>, HttpError> {
    let stored_documents = document_collection
        .list_documents_owned_by(RAG_KNOWLEDGE_COLLECTION_NAME, owning_account.as_str())
        .await?;
    Ok(stored_documents)
}

/// (6) Read the persisted title field of a stored document, if present.
fn read_stored_document_title_field(stored_document: &StoredDocument) -> Option<String> {
    stored_document
        .document_body
        .get("title")
        .or_else(|| stored_document.document_body.get("fileName"))
        .or_else(|| stored_document.document_body.get("documentTitle"))
        .and_then(|title_value| title_value.as_str())
        .map(|raw_title| raw_title.to_string())
}

/// (7) Read the persisted content hash field of a stored document, if present.
fn read_stored_document_content_hash_field(stored_document: &StoredDocument) -> Option<String> {
    stored_document
        .document_body
        .get("content_hash")
        .or_else(|| stored_document.document_body.get("contentHash"))
        .and_then(|hash_value| hash_value.as_str())
        .map(|raw_hash| raw_hash.trim().to_string())
        .filter(|trimmed_hash| !trimmed_hash.is_empty())
}

/// (8) Whether a stored document's content hash equals the candidate hash.
fn does_stored_document_match_content_hash(stored_document: &StoredDocument, candidate_hash: &str) -> bool {
    read_stored_document_content_hash_field(stored_document)
        .map(|existing_hash| existing_hash == candidate_hash)
        .unwrap_or(false)
}

/// (9) Whether a stored document's title fingerprint equals the candidate
/// fingerprint. Recomputes the stored title's fingerprint the same way as the
/// candidate so comparison is symmetric.
fn does_stored_document_match_title_fingerprint(
    stored_document: &StoredDocument,
    candidate_fingerprint: &str,
) -> bool {
    let stored_title = match read_stored_document_title_field(stored_document) {
        Some(title) => title,
        None => return false,
    };
    // Parsing may fail for an empty stored title; treat that as "no match".
    let stored_fingerprint = match NonEmptyText::parse(stored_title) {
        Ok(non_empty) => compute_normalized_title_fingerprint(&non_empty),
        Err(_) => return false,
    };
    !stored_fingerprint.is_empty() && stored_fingerprint == candidate_fingerprint
}

/// (10) Narrow a set of stored documents to those belonging to the target
/// corpus. When no target corpus is supplied, all documents are retained.
fn filter_stored_documents_to_matching_corpus(
    stored_documents: Vec<StoredDocument>,
    target_corpus_identifier: &Option<String>,
) -> Vec<StoredDocument> {
    let target = match target_corpus_identifier {
        Some(target) => target,
        None => return stored_documents,
    };

    stored_documents
        .into_iter()
        .filter(|stored_document| {
            stored_document
                .document_body
                .get("corpus_id")
                .or_else(|| stored_document.document_body.get("corpusId"))
                .and_then(|corpus_value| corpus_value.as_str())
                .map(|existing_corpus| existing_corpus == target)
                .unwrap_or(false)
        })
        .collect()
}

/// (11) Find the first stored document that duplicates the candidate, matching
/// on content hash first (strongest signal) and then on title fingerprint.
fn locate_first_duplicate_stored_document<'candidate>(
    stored_documents: &'candidate [StoredDocument],
    candidate_fingerprint: &str,
    candidate_hash: &Option<String>,
) -> Option<&'candidate StoredDocument> {
    // Prefer an exact content-hash collision when the candidate supplied a hash.
    if let Some(hash) = candidate_hash.as_deref() {
        if let Some(matched) = stored_documents
            .iter()
            .find(|stored_document| does_stored_document_match_content_hash(stored_document, hash))
        {
            return Some(matched);
        }
    }

    // Otherwise fall back to the normalized title fingerprint.
    stored_documents
        .iter()
        .find(|stored_document| does_stored_document_match_title_fingerprint(stored_document, candidate_fingerprint))
}

/// (12) Classify the duplicate match reason from the individual match signals.
fn classify_duplicate_match_reason(matched_by_hash: bool, matched_by_title: bool) -> DuplicateMatchReason {
    match (matched_by_hash, matched_by_title) {
        (true, true) => DuplicateMatchReason::IdenticalContentAndTitle,
        (true, false) => DuplicateMatchReason::IdenticalContentHash,
        // Either title-only, or neither signal was set (defensive fallback to
        // the title reason since a document was still located).
        (false, _) => DuplicateMatchReason::IdenticalTitleFingerprint,
    }
}

/// (13) Best-effort human-facing identifier for a stored document: prefer an
/// explicit body id, then the persisted title, then the storage identifier.
fn extract_stored_document_identifier(stored_document: &StoredDocument) -> String {
    if let Some(body_identifier) = stored_document
        .document_body
        .get("id")
        .or_else(|| stored_document.document_body.get("documentId"))
        .and_then(|id_value| id_value.as_str())
        .map(|raw_id| raw_id.trim())
        .filter(|trimmed| !trimmed.is_empty())
    {
        return body_identifier.to_string();
    }

    if let Some(title) = read_stored_document_title_field(stored_document) {
        let trimmed = title.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    stored_document.document_identifier.clone()
}

/// (14) Build the response body for the case where no duplicate was found.
fn assemble_duplicate_absent_response(candidate_fingerprint: &str) -> Value {
    json!({
        "exists": false,
        "isDuplicate": false,
        "candidateFingerprint": candidate_fingerprint,
    })
}

/// (15) Build the response body describing the located duplicate document.
fn assemble_duplicate_present_response(
    duplicate_document: &StoredDocument,
    match_reason: DuplicateMatchReason,
) -> Value {
    json!({
        "exists": true,
        "isDuplicate": true,
        "matchReason": match_reason.as_response_code(),
        "duplicateDocumentIdentifier": extract_stored_document_identifier(duplicate_document),
        "duplicateOwningAccount": duplicate_document.owning_account,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored_document(body: Value) -> StoredDocument {
        StoredDocument {
            document_identifier: "storage-id-1".to_string(),
            owning_account: Some("owner@example.com".to_string()),
            document_body: body,
        }
    }

    #[test]
    fn extract_title_accepts_title_field() {
        let body = json!({ "title": "Quantum Notes" });
        let parsed = extract_candidate_document_title_from_body(&body).expect("title present");
        assert_eq!(parsed.as_str(), "Quantum Notes");
    }

    #[test]
    fn extract_title_falls_back_to_file_name() {
        let body = json!({ "fileName": "report.pdf" });
        let parsed = extract_candidate_document_title_from_body(&body).expect("filename present");
        assert_eq!(parsed.as_str(), "report.pdf");
    }

    #[test]
    fn extract_title_rejects_missing_and_blank() {
        assert!(extract_candidate_document_title_from_body(&json!({})).is_err());
        assert!(extract_candidate_document_title_from_body(&json!({ "title": "   " })).is_err());
    }

    #[test]
    fn extract_content_hash_reads_present_value_and_trims() {
        let body = json!({ "content_hash": "  abc123  " });
        assert_eq!(extract_candidate_content_hash_from_body(&body), Some("abc123".to_string()));
    }

    #[test]
    fn extract_content_hash_returns_none_for_missing_or_empty() {
        assert_eq!(extract_candidate_content_hash_from_body(&json!({})), None);
        assert_eq!(extract_candidate_content_hash_from_body(&json!({ "content_hash": "   " })), None);
    }

    #[test]
    fn extract_corpus_identifier_reads_variants() {
        assert_eq!(
            extract_optional_target_corpus_identifier_from_body(&json!({ "corpus_id": "c1" })),
            Some("c1".to_string())
        );
        assert_eq!(
            extract_optional_target_corpus_identifier_from_body(&json!({ "corpusId": " c2 " })),
            Some("c2".to_string())
        );
        assert_eq!(extract_optional_target_corpus_identifier_from_body(&json!({})), None);
    }

    #[test]
    fn fingerprint_normalizes_case_spacing_and_punctuation() {
        let title = NonEmptyText::parse("  The   Quick!!  Brown-Fox  ".to_string()).unwrap();
        assert_eq!(compute_normalized_title_fingerprint(&title), "the quick brown fox");
    }

    #[test]
    fn fingerprint_is_equal_for_equivalent_titles() {
        let a = NonEmptyText::parse("Deep Learning".to_string()).unwrap();
        let b = NonEmptyText::parse("deep   learning".to_string()).unwrap();
        assert_eq!(
            compute_normalized_title_fingerprint(&a),
            compute_normalized_title_fingerprint(&b)
        );
    }

    #[test]
    fn read_title_field_reads_variants_and_missing() {
        assert_eq!(
            read_stored_document_title_field(&stored_document(json!({ "title": "T" }))),
            Some("T".to_string())
        );
        assert_eq!(
            read_stored_document_title_field(&stored_document(json!({ "fileName": "F" }))),
            Some("F".to_string())
        );
        assert_eq!(read_stored_document_title_field(&stored_document(json!({}))), None);
    }

    #[test]
    fn read_content_hash_field_trims_and_filters_empty() {
        assert_eq!(
            read_stored_document_content_hash_field(&stored_document(json!({ "content_hash": " h " }))),
            Some("h".to_string())
        );
        assert_eq!(
            read_stored_document_content_hash_field(&stored_document(json!({ "content_hash": "" }))),
            None
        );
        assert_eq!(read_stored_document_content_hash_field(&stored_document(json!({}))), None);
    }

    #[test]
    fn content_hash_match_detects_equal_and_unequal() {
        let doc = stored_document(json!({ "content_hash": "abc" }));
        assert!(does_stored_document_match_content_hash(&doc, "abc"));
        assert!(!does_stored_document_match_content_hash(&doc, "xyz"));
        assert!(!does_stored_document_match_content_hash(&stored_document(json!({})), "abc"));
    }

    #[test]
    fn title_fingerprint_match_is_case_insensitive() {
        let doc = stored_document(json!({ "title": "Neural Nets" }));
        assert!(does_stored_document_match_title_fingerprint(&doc, "neural nets"));
        assert!(!does_stored_document_match_title_fingerprint(&doc, "graph theory"));
        assert!(!does_stored_document_match_title_fingerprint(&stored_document(json!({})), "neural nets"));
    }

    #[test]
    fn filter_by_corpus_retains_all_when_no_target() {
        let documents = vec![
            stored_document(json!({ "corpus_id": "a" })),
            stored_document(json!({ "corpus_id": "b" })),
        ];
        let filtered = filter_stored_documents_to_matching_corpus(documents, &None);
        assert_eq!(filtered.len(), 2);
    }

    #[test]
    fn filter_by_corpus_keeps_only_matching_target() {
        let documents = vec![
            stored_document(json!({ "corpus_id": "a", "title": "A" })),
            stored_document(json!({ "corpus_id": "b", "title": "B" })),
        ];
        let filtered = filter_stored_documents_to_matching_corpus(documents, &Some("a".to_string()));
        assert_eq!(filtered.len(), 1);
        assert_eq!(read_stored_document_title_field(&filtered[0]), Some("A".to_string()));
    }

    #[test]
    fn locate_duplicate_prefers_content_hash() {
        let documents = vec![
            stored_document(json!({ "title": "Other", "content_hash": "match" })),
            stored_document(json!({ "title": "Same Title" })),
        ];
        let located = locate_first_duplicate_stored_document(
            &documents,
            "same title",
            &Some("match".to_string()),
        );
        assert!(located.is_some());
        assert_eq!(
            read_stored_document_content_hash_field(located.unwrap()),
            Some("match".to_string())
        );
    }

    #[test]
    fn locate_duplicate_falls_back_to_title() {
        let documents = vec![stored_document(json!({ "title": "Same Title" }))];
        let located = locate_first_duplicate_stored_document(&documents, "same title", &None);
        assert!(located.is_some());
    }

    #[test]
    fn locate_duplicate_returns_none_when_no_match() {
        let documents = vec![stored_document(json!({ "title": "Unrelated", "content_hash": "zzz" }))];
        let located = locate_first_duplicate_stored_document(
            &documents,
            "some fingerprint",
            &Some("abc".to_string()),
        );
        assert!(located.is_none());
    }

    #[test]
    fn classify_reason_covers_all_combinations() {
        assert_eq!(
            classify_duplicate_match_reason(true, true),
            DuplicateMatchReason::IdenticalContentAndTitle
        );
        assert_eq!(
            classify_duplicate_match_reason(true, false),
            DuplicateMatchReason::IdenticalContentHash
        );
        assert_eq!(
            classify_duplicate_match_reason(false, true),
            DuplicateMatchReason::IdenticalTitleFingerprint
        );
        assert_eq!(
            classify_duplicate_match_reason(false, false),
            DuplicateMatchReason::IdenticalTitleFingerprint
        );
    }

    #[test]
    fn extract_identifier_prefers_body_id_then_title_then_storage() {
        assert_eq!(
            extract_stored_document_identifier(&stored_document(json!({ "id": "body-id" }))),
            "body-id"
        );
        assert_eq!(
            extract_stored_document_identifier(&stored_document(json!({ "title": "A Title" }))),
            "A Title"
        );
        assert_eq!(
            extract_stored_document_identifier(&stored_document(json!({}))),
            "storage-id-1"
        );
    }

    #[test]
    fn absent_response_has_expected_shape() {
        let response = assemble_duplicate_absent_response("some fingerprint");
        assert_eq!(response.get("exists").and_then(|v| v.as_bool()), Some(false));
        assert_eq!(response.get("isDuplicate").and_then(|v| v.as_bool()), Some(false));
        assert_eq!(
            response.get("candidateFingerprint").and_then(|v| v.as_str()),
            Some("some fingerprint")
        );
    }

    #[test]
    fn present_response_reports_match_reason_and_identifier() {
        let doc = stored_document(json!({ "id": "dup-id", "title": "Dup" }));
        let response =
            assemble_duplicate_present_response(&doc, DuplicateMatchReason::IdenticalContentAndTitle);
        assert_eq!(response.get("exists").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(response.get("isDuplicate").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            response.get("matchReason").and_then(|v| v.as_str()),
            Some("identical_content_and_title")
        );
        assert_eq!(
            response.get("duplicateDocumentIdentifier").and_then(|v| v.as_str()),
            Some("dup-id")
        );
    }
}
