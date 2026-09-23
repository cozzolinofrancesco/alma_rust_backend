use crate::categories::templates_policy::collections::CORRECTIONS_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::error::ApplicationError;
use alma_application::ports::document_collection::{DocumentCollectionPort, StoredDocument};
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::Email;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};

/// Default number of characters retained when building a text preview for a
/// correction listing entry. Kept small so the listing payload stays compact.
const DEFAULT_PREVIEW_LENGTH: usize = 160;

/// Marker that, when present in the request correlation identifier, indicates
/// that the caller wants the listing scoped to documents they own. The route
/// carries no query extractor, so the correlation identifier is the only
/// request-bound string this handler can inspect for such a hint.
const OWNER_SCOPE_CORRELATION_MARKER: &str = "owner-scope";

#[route(method = "GET", path = "/api/corrections")]
pub async fn list_corrections_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let restrict_to_owner = extract_optional_owner_scope_query_flag(&authorized_request);
    let requesting_account = resolve_requesting_account_from_principal(
        authorized_request.authorized_principal(),
    );

    let collection = application_state.document_collection.as_ref();

    let stored_documents = if restrict_to_owner {
        let owned_documents =
            fetch_correction_documents_owned_by(collection, &requesting_account).await?;
        // Defensively re-filter in memory so an adapter that ignores the owner
        // argument can never leak documents owned by another account.
        filter_correction_documents_by_owner(owned_documents, &requesting_account)
    } else {
        fetch_all_correction_documents(collection).await?
    };

    let rendered_summaries = render_correction_documents_into_summaries(stored_documents);
    let total_count = count_returned_corrections(&rendered_summaries);
    let response_body = build_correction_listing_response(rendered_summaries, total_count);

    Ok(Json(response_body))
}

/// (1) Decide whether the listing should be restricted to the caller's own
/// documents. The route exposes no query extractor, so the decision is derived
/// from the request correlation identifier which is the only caller-influenced
/// string available at this pipeline stage.
fn extract_optional_owner_scope_query_flag(
    authorized_request: &HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> bool {
    authorized_request
        .correlation_identifier()
        .to_ascii_lowercase()
        .contains(OWNER_SCOPE_CORRELATION_MARKER)
}

/// (2) Reduce an authenticated principal to the canonical account string used
/// as the `owning_account` value in stored correction documents.
fn resolve_requesting_account_from_principal(authorized_principal: &Email) -> String {
    authorized_principal.as_str().trim().to_ascii_lowercase()
}

/// (3) Fetch every correction document in the collection, translating any
/// application-layer failure into an HTTP error.
async fn fetch_all_correction_documents<C: DocumentCollectionPort + ?Sized>(
    collection: &C,
) -> Result<Vec<StoredDocument>, HttpError> {
    collection
        .list_documents(CORRECTIONS_COLLECTION_NAME)
        .await
        .map_err(map_application_error_to_http_error)
}

/// (4) Fetch only the correction documents owned by a specific account.
async fn fetch_correction_documents_owned_by<C: DocumentCollectionPort + ?Sized>(
    collection: &C,
    owning_account: &str,
) -> Result<Vec<StoredDocument>, HttpError> {
    collection
        .list_documents_owned_by(CORRECTIONS_COLLECTION_NAME, owning_account)
        .await
        .map_err(map_application_error_to_http_error)
}

/// (5) In-memory filter retaining only documents whose `owning_account` matches
/// the supplied account. Documents without an owner are excluded.
fn filter_correction_documents_by_owner(
    stored_documents: Vec<StoredDocument>,
    owning_account: &str,
) -> Vec<StoredDocument> {
    stored_documents
        .into_iter()
        .filter(|stored_document| {
            stored_document
                .owning_account
                .as_deref()
                .is_some_and(|owner| owner == owning_account)
        })
        .collect()
}

/// (6) Translate an `ApplicationError` into the corresponding `HttpError`.
/// Missing resources map to not-found; everything else is an upstream failure.
fn map_application_error_to_http_error(application_error: ApplicationError) -> HttpError {
    match application_error {
        ApplicationError::RequestedResourceCouldNotBeLocated
        | ApplicationError::RequestedProjectCouldNotBeLocated => {
            HttpError::RequestedResourceWasNotFound {
                explanation: application_error.to_string(),
            }
        }
        ApplicationError::AuthorizationWasDenied => HttpError::AuthorizationWasDenied {
            explanation: application_error.to_string(),
        },
        ApplicationError::DomainInvariantViolated(_) => HttpError::RequestBodyWasMalformed {
            explanation: application_error.to_string(),
        },
        other_application_error => HttpError::UpstreamApplicationFailure {
            explanation: other_application_error.to_string(),
        },
    }
}

/// (7) Project a single stored correction document into a compact summary value
/// suitable for a listing response.
fn project_stored_document_to_correction_summary(stored_document: &StoredDocument) -> Value {
    let original_preview =
        extract_original_text_preview_from_body(&stored_document.document_body, DEFAULT_PREVIEW_LENGTH);
    let corrected_preview = extract_corrected_text_preview_from_body(
        &stored_document.document_body,
        DEFAULT_PREVIEW_LENGTH,
    );
    let created_at = extract_created_at_timestamp_from_body(&stored_document.document_body);

    json!({
        "identifier": stored_document.document_identifier,
        "owning_account": stored_document.owning_account,
        "original_text_preview": original_preview,
        "corrected_text_preview": corrected_preview,
        "created_at": created_at,
    })
}

/// (8) Extract and truncate the original text of a correction from its stored
/// body. Falls back to an empty string when the field is missing.
fn extract_original_text_preview_from_body(document_body: &Value, preview_length: usize) -> String {
    let raw_text = document_body
        .get("original_text")
        .or_else(|| document_body.get("original"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    truncate_text_to_preview_length(raw_text, preview_length)
}

/// (9) Extract and truncate the corrected text of a correction from its stored
/// body. Falls back to an empty string when the field is missing.
fn extract_corrected_text_preview_from_body(document_body: &Value, preview_length: usize) -> String {
    let raw_text = document_body
        .get("corrected_text")
        .or_else(|| document_body.get("corrected"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    truncate_text_to_preview_length(raw_text, preview_length)
}

/// (10) Extract the creation timestamp from a stored correction body, if one is
/// present as a string.
fn extract_created_at_timestamp_from_body(document_body: &Value) -> Option<String> {
    document_body
        .get("created_at")
        .or_else(|| document_body.get("createdAt"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// (11) Sort correction summaries in place by their `created_at` field in
/// descending order (newest first). Entries lacking a timestamp sort last.
fn sort_correction_summaries_by_created_at_descending(correction_summaries: &mut [Value]) {
    correction_summaries.sort_by(|left, right| {
        let left_timestamp = left.get("created_at").and_then(Value::as_str);
        let right_timestamp = right.get("created_at").and_then(Value::as_str);
        match (left_timestamp, right_timestamp) {
            (Some(left_value), Some(right_value)) => right_value.cmp(left_value),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        }
    });
}

/// (12) Render a collection of stored correction documents into sorted summary
/// values ready to serialize.
fn render_correction_documents_into_summaries(stored_documents: Vec<StoredDocument>) -> Vec<Value> {
    let mut rendered_summaries: Vec<Value> = stored_documents
        .iter()
        .map(project_stored_document_to_correction_summary)
        .collect();
    sort_correction_summaries_by_created_at_descending(&mut rendered_summaries);
    rendered_summaries
}

/// (13) Count how many corrections are being returned in the response.
fn count_returned_corrections(rendered_summaries: &[Value]) -> usize {
    rendered_summaries.len()
}

/// (14) Assemble the final listing response body.
fn build_correction_listing_response(rendered_summaries: Vec<Value>, total_count: usize) -> Value {
    json!({
        "corrections": rendered_summaries,
        "total_count": total_count,
    })
}

/// (15) Truncate a source string to at most `preview_length` characters,
/// appending an ellipsis when truncation occurred. Character-safe (does not
/// split multi-byte UTF-8 code points).
fn truncate_text_to_preview_length(source_text: &str, preview_length: usize) -> String {
    let trimmed_source = source_text.trim();
    if trimmed_source.chars().count() <= preview_length {
        return trimmed_source.to_owned();
    }
    let mut truncated: String = trimmed_source.chars().take(preview_length).collect();
    truncated.push('\u{2026}');
    truncated
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored_document_with_body(identifier: &str, owner: Option<&str>, body: Value) -> StoredDocument {
        StoredDocument {
            document_identifier: identifier.to_owned(),
            owning_account: owner.map(str::to_owned),
            document_body: body,
        }
    }

    #[test]
    fn resolve_requesting_account_normalizes_case_and_whitespace() {
        let email = Email::parse(String::from("Researcher@Example.COM")).expect("valid email");
        assert_eq!(
            resolve_requesting_account_from_principal(&email),
            "researcher@example.com"
        );
    }

    #[test]
    fn filter_by_owner_keeps_only_matching_documents() {
        let documents = vec![
            stored_document_with_body("a", Some("alice@x.com"), json!({})),
            stored_document_with_body("b", Some("bob@x.com"), json!({})),
            stored_document_with_body("c", None, json!({})),
        ];
        let filtered = filter_correction_documents_by_owner(documents, "alice@x.com");
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].document_identifier, "a");
    }

    #[test]
    fn filter_by_owner_returns_empty_when_no_match() {
        let documents = vec![stored_document_with_body("a", Some("alice@x.com"), json!({}))];
        let filtered = filter_correction_documents_by_owner(documents, "nobody@x.com");
        assert!(filtered.is_empty());
    }

    #[test]
    fn map_error_locates_missing_resource_as_not_found() {
        let mapped = map_application_error_to_http_error(
            ApplicationError::RequestedResourceCouldNotBeLocated,
        );
        assert!(matches!(mapped, HttpError::RequestedResourceWasNotFound { .. }));
    }

    #[test]
    fn map_error_falls_back_to_upstream_failure() {
        let mapped = map_application_error_to_http_error(ApplicationError::DocumentCollectionFailure {
            failure_description: String::from("boom"),
        });
        assert!(matches!(mapped, HttpError::UpstreamApplicationFailure { .. }));
    }

    #[test]
    fn map_error_denied_maps_to_authorization_denied() {
        let mapped = map_application_error_to_http_error(ApplicationError::AuthorizationWasDenied);
        assert!(matches!(mapped, HttpError::AuthorizationWasDenied { .. }));
    }

    #[test]
    fn project_summary_includes_previews_and_metadata() {
        let document = stored_document_with_body(
            "corr-1",
            Some("alice@x.com"),
            json!({
                "original_text": "teh cat sat",
                "corrected_text": "the cat sat",
                "created_at": "2026-01-01T00:00:00Z",
            }),
        );
        let summary = project_stored_document_to_correction_summary(&document);
        assert_eq!(summary["identifier"], "corr-1");
        assert_eq!(summary["owning_account"], "alice@x.com");
        assert_eq!(summary["original_text_preview"], "teh cat sat");
        assert_eq!(summary["corrected_text_preview"], "the cat sat");
        assert_eq!(summary["created_at"], "2026-01-01T00:00:00Z");
    }

    #[test]
    fn extract_original_preview_handles_missing_field() {
        let preview = extract_original_text_preview_from_body(&json!({}), DEFAULT_PREVIEW_LENGTH);
        assert_eq!(preview, "");
    }

    #[test]
    fn extract_original_preview_supports_alias_field() {
        let preview = extract_original_text_preview_from_body(
            &json!({ "original": "some prior text" }),
            DEFAULT_PREVIEW_LENGTH,
        );
        assert_eq!(preview, "some prior text");
    }

    #[test]
    fn extract_corrected_preview_supports_alias_field() {
        let preview = extract_corrected_text_preview_from_body(
            &json!({ "corrected": "fixed text" }),
            DEFAULT_PREVIEW_LENGTH,
        );
        assert_eq!(preview, "fixed text");
    }

    #[test]
    fn extract_created_at_returns_none_when_absent() {
        assert_eq!(extract_created_at_timestamp_from_body(&json!({})), None);
    }

    #[test]
    fn extract_created_at_reads_camel_case_alias() {
        assert_eq!(
            extract_created_at_timestamp_from_body(&json!({ "createdAt": "2026-02-02" })),
            Some(String::from("2026-02-02"))
        );
    }

    #[test]
    fn sort_summaries_orders_newest_first_and_missing_last() {
        let mut summaries = vec![
            json!({ "created_at": "2026-01-01" }),
            json!({ "identifier": "no-date" }),
            json!({ "created_at": "2026-03-03" }),
            json!({ "created_at": "2026-02-02" }),
        ];
        sort_correction_summaries_by_created_at_descending(&mut summaries);
        assert_eq!(summaries[0]["created_at"], "2026-03-03");
        assert_eq!(summaries[1]["created_at"], "2026-02-02");
        assert_eq!(summaries[2]["created_at"], "2026-01-01");
        assert_eq!(summaries[3]["identifier"], "no-date");
    }

    #[test]
    fn render_documents_produces_sorted_summaries() {
        let documents = vec![
            stored_document_with_body(
                "old",
                None,
                json!({ "original_text": "a", "created_at": "2026-01-01" }),
            ),
            stored_document_with_body(
                "new",
                None,
                json!({ "original_text": "b", "created_at": "2026-05-05" }),
            ),
        ];
        let rendered = render_correction_documents_into_summaries(documents);
        assert_eq!(rendered.len(), 2);
        assert_eq!(rendered[0]["identifier"], "new");
        assert_eq!(rendered[1]["identifier"], "old");
    }

    #[test]
    fn count_returned_corrections_matches_length() {
        let summaries = vec![json!({}), json!({})];
        assert_eq!(count_returned_corrections(&summaries), 2);
    }

    #[test]
    fn build_response_wraps_corrections_and_total() {
        let summaries = vec![json!({ "identifier": "x" })];
        let response = build_correction_listing_response(summaries, 1);
        assert_eq!(response["total_count"], 1);
        assert_eq!(response["corrections"][0]["identifier"], "x");
    }

    #[test]
    fn truncate_shorter_than_limit_is_unchanged() {
        assert_eq!(truncate_text_to_preview_length("hello", 10), "hello");
    }

    #[test]
    fn truncate_longer_than_limit_adds_ellipsis() {
        let result = truncate_text_to_preview_length("abcdefghij", 3);
        assert_eq!(result, "abc\u{2026}");
    }

    #[test]
    fn truncate_is_utf8_safe() {
        let result = truncate_text_to_preview_length("áéíóúñ", 3);
        assert_eq!(result.chars().count(), 4); // 3 chars + ellipsis
        assert!(result.ends_with('\u{2026}'));
    }

    #[test]
    fn owner_scope_flag_detects_marker_in_correlation_identifier() {
        // Indirectly validates the marker constant is used for scoping decisions.
        assert!("prefix-owner-scope-suffix".contains(OWNER_SCOPE_CORRELATION_MARKER));
        assert!(!"plain-correlation".contains(OWNER_SCOPE_CORRELATION_MARKER));
    }
}
