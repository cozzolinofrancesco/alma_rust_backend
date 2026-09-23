use crate::categories::templates_policy::collections::DRAFTING_TEMPLATES_COLLECTION_NAME;
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

/// Lists every drafting template document stored in the drafting-templates
/// collection, projected into compact summaries. When the authorized request
/// carries a `name` search filter, the listing is narrowed to templates whose
/// name contains the filter substring (case-insensitively).
#[route(method = "GET", path = "/api/templates/drafting-templates")]
pub async fn list_drafting_templates_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // The requesting account is resolved purely for correlation / auditing; the
    // drafting templates collection is shared across accounts so no ownership
    // filtering is applied here.
    let _requesting_account =
        resolve_requesting_account_from_principal(authorized_request.authorized_principal());

    let optional_name_filter = extract_optional_name_search_filter(&authorized_request);

    let all_template_documents =
        fetch_all_drafting_template_documents(application_state.document_collection.as_ref()).await?;

    let selected_template_documents = match optional_name_filter.as_deref() {
        Some(name_filter) if !name_filter.trim().is_empty() => {
            filter_drafting_templates_by_name_substring(all_template_documents, name_filter)
        }
        _ => all_template_documents,
    };

    let rendered_summaries = render_drafting_template_documents_into_summaries(selected_template_documents);
    let total_count = count_returned_drafting_templates(&rendered_summaries);
    let response_body = build_drafting_template_listing_response(rendered_summaries, total_count);

    Ok(Json(response_body))
}

/// (1) Reads an optional `name` search filter from the correlation identifier
/// carried by the authorized request. The pipeline stores request-scoped hints
/// on the correlation identifier in the form `key=value;key=value`; here we look
/// for a `name=` fragment. Returns `None` when no such fragment is present.
fn extract_optional_name_search_filter(
    authorized_request: &HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> Option<String> {
    let correlation_identifier = authorized_request.correlation_identifier();
    for fragment in correlation_identifier.split(';') {
        let trimmed_fragment = fragment.trim();
        if let Some(raw_value) = trimmed_fragment.strip_prefix("name=") {
            let cleaned_value = raw_value.trim();
            if cleaned_value.is_empty() {
                return None;
            }
            return Some(cleaned_value.to_string());
        }
    }
    None
}

/// (2) Resolves the account string for the requesting principal. The document
/// store keys ownership on the principal's email address in lowercase form so
/// that lookups are stable regardless of the casing supplied at authentication.
fn resolve_requesting_account_from_principal(authorized_principal: &Email) -> String {
    authorized_principal.as_str().trim().to_lowercase()
}

/// (3) Fetches every stored drafting template document from the collection.
/// Any port failure is mapped into an `HttpError` so the handler can propagate
/// it with `?`.
async fn fetch_all_drafting_template_documents<C: DocumentCollectionPort + ?Sized>(
    collection: &C,
) -> Result<Vec<StoredDocument>, HttpError> {
    collection
        .list_documents(DRAFTING_TEMPLATES_COLLECTION_NAME)
        .await
        .map_err(map_application_error_to_http_error)
}

/// (4) Translates an `ApplicationError` into the appropriate `HttpError`
/// variant. Resource-not-found conditions map to a 404-shaped error, while all
/// other failures are surfaced as upstream application failures.
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
        other_failure => HttpError::UpstreamApplicationFailure {
            explanation: other_failure.to_string(),
        },
    }
}

/// (5) Extracts a human-readable template name from a stored document body.
/// Accepts either a `name` or a `template_name` string field. Returns `None`
/// when neither field is a non-empty string.
fn extract_template_name_from_body(document_body: &Value) -> Option<String> {
    for candidate_key in ["name", "template_name"] {
        if let Some(field_value) = document_body.get(candidate_key).and_then(Value::as_str) {
            let trimmed_value = field_value.trim();
            if !trimmed_value.is_empty() {
                return Some(trimmed_value.to_string());
            }
        }
    }
    None
}

/// (6) Retains only the documents whose template name contains the supplied
/// filter as a case-insensitive substring. Documents without a resolvable name
/// are excluded from a filtered listing.
fn filter_drafting_templates_by_name_substring(
    stored_documents: Vec<StoredDocument>,
    name_filter: &str,
) -> Vec<StoredDocument> {
    let normalized_filter = name_filter.trim().to_lowercase();
    if normalized_filter.is_empty() {
        return stored_documents;
    }
    stored_documents
        .into_iter()
        .filter(|stored_document| {
            extract_template_name_from_body(&stored_document.document_body)
                .map(|template_name| template_name.to_lowercase().contains(&normalized_filter))
                .unwrap_or(false)
        })
        .collect()
}

/// (7) Extracts placeholder tokens from a template body. Placeholders are
/// wrapped in double curly braces, e.g. `{{ author_name }}`. Tokens are
/// returned trimmed, in order of first appearance, without duplicates.
fn extract_placeholder_tokens_from_body(document_body: &Value) -> Vec<String> {
    let template_text = document_body
        .get("body")
        .and_then(Value::as_str)
        .or_else(|| document_body.get("content").and_then(Value::as_str))
        .unwrap_or("");

    let mut discovered_tokens: Vec<String> = Vec::new();
    let mut remaining = template_text;
    while let Some(open_index) = remaining.find("{{") {
        let after_open = &remaining[open_index + 2..];
        if let Some(close_offset) = after_open.find("}}") {
            let raw_token = &after_open[..close_offset];
            let cleaned_token = raw_token.trim().to_string();
            if !cleaned_token.is_empty() && !discovered_tokens.contains(&cleaned_token) {
                discovered_tokens.push(cleaned_token);
            }
            remaining = &after_open[close_offset + 2..];
        } else {
            break;
        }
    }
    discovered_tokens
}

/// (8) Counts the distinct placeholder tokens present in a template body.
fn count_placeholder_tokens_in_body(document_body: &Value) -> usize {
    extract_placeholder_tokens_from_body(document_body).len()
}

/// (10) Produces a short preview of a template's description. Reads a
/// `description` string field and truncates it to `preview_length` characters.
/// Returns an empty string when no description is present.
fn extract_template_description_preview_from_body(
    document_body: &Value,
    preview_length: usize,
) -> String {
    let description_text = document_body
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("");
    truncate_text_to_preview_length(description_text, preview_length)
}

/// (9) Projects a single stored document into a compact summary value that is
/// safe to expose over the API: identifier, resolved name, owning account,
/// placeholder count, and a short description preview.
fn project_stored_document_to_drafting_template_summary(stored_document: &StoredDocument) -> Value {
    let resolved_name = extract_template_name_from_body(&stored_document.document_body)
        .unwrap_or_else(|| stored_document.document_identifier.clone());
    let placeholder_count = count_placeholder_tokens_in_body(&stored_document.document_body);
    let description_preview =
        extract_template_description_preview_from_body(&stored_document.document_body, 160);
    let placeholder_tokens = extract_placeholder_tokens_from_body(&stored_document.document_body);

    json!({
        "template_identifier": stored_document.document_identifier,
        "template_name": resolved_name,
        "owning_account": stored_document.owning_account,
        "placeholder_count": placeholder_count,
        "placeholder_tokens": placeholder_tokens,
        "description_preview": description_preview,
    })
}

/// (11) Sorts an array of rendered summaries by their `template_name` field in
/// ascending, case-insensitive order. Summaries without a name sort last.
fn sort_drafting_template_summaries_by_name_ascending(template_summaries: &mut [Value]) {
    template_summaries.sort_by(|left_summary, right_summary| {
        let left_name = left_summary
            .get("template_name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        let right_name = right_summary
            .get("template_name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        left_name.cmp(&right_name)
    });
}

/// (12) Renders a collection of stored documents into sorted summary values.
fn render_drafting_template_documents_into_summaries(
    stored_documents: Vec<StoredDocument>,
) -> Vec<Value> {
    let mut rendered_summaries: Vec<Value> = stored_documents
        .iter()
        .map(project_stored_document_to_drafting_template_summary)
        .collect();
    sort_drafting_template_summaries_by_name_ascending(&mut rendered_summaries);
    rendered_summaries
}

/// (13) Counts how many summaries will be returned to the caller.
fn count_returned_drafting_templates(rendered_summaries: &[Value]) -> usize {
    rendered_summaries.len()
}

/// (14) Assembles the final JSON response body for the listing endpoint.
fn build_drafting_template_listing_response(
    rendered_summaries: Vec<Value>,
    total_count: usize,
) -> Value {
    json!({
        "drafting_templates": rendered_summaries,
        "total_count": total_count,
    })
}

/// (15) Truncates `source_text` to at most `preview_length` characters,
/// appending an ellipsis when truncation actually removed content. Operates on
/// character boundaries so multi-byte text is never split mid-codepoint.
fn truncate_text_to_preview_length(source_text: &str, preview_length: usize) -> String {
    let trimmed_source = source_text.trim();
    if preview_length == 0 {
        return String::new();
    }
    let character_count = trimmed_source.chars().count();
    if character_count <= preview_length {
        return trimmed_source.to_string();
    }
    let truncated: String = trimmed_source.chars().take(preview_length).collect();
    format!("{}…", truncated.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored_document_with_body(identifier: &str, body: Value) -> StoredDocument {
        StoredDocument {
            document_identifier: identifier.to_string(),
            owning_account: Some("researcher@example.org".to_string()),
            document_body: body,
        }
    }

    #[test]
    fn resolve_requesting_account_lowercases_and_trims() {
        let principal = Email::parse("  Researcher@Example.ORG ".to_string())
            .expect("valid email should parse");
        assert_eq!(
            resolve_requesting_account_from_principal(&principal),
            "researcher@example.org"
        );
    }

    #[test]
    fn extract_template_name_prefers_name_then_template_name() {
        let body = json!({ "name": " Systematic Review ", "template_name": "Other" });
        assert_eq!(
            extract_template_name_from_body(&body),
            Some("Systematic Review".to_string())
        );

        let fallback_body = json!({ "template_name": "Meta Analysis" });
        assert_eq!(
            extract_template_name_from_body(&fallback_body),
            Some("Meta Analysis".to_string())
        );
    }

    #[test]
    fn extract_template_name_returns_none_when_absent_or_empty() {
        assert_eq!(extract_template_name_from_body(&json!({})), None);
        assert_eq!(
            extract_template_name_from_body(&json!({ "name": "   " })),
            None
        );
    }

    #[test]
    fn filter_by_name_substring_matches_case_insensitively() {
        let documents = vec![
            stored_document_with_body("a", json!({ "name": "Systematic Review" })),
            stored_document_with_body("b", json!({ "name": "Case Report" })),
            stored_document_with_body("c", json!({})),
        ];
        let filtered = filter_drafting_templates_by_name_substring(documents, "review");
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].document_identifier, "a");
    }

    #[test]
    fn filter_by_name_substring_returns_all_for_blank_filter() {
        let documents = vec![
            stored_document_with_body("a", json!({ "name": "Alpha" })),
            stored_document_with_body("b", json!({ "name": "Beta" })),
        ];
        let filtered = filter_drafting_templates_by_name_substring(documents, "   ");
        assert_eq!(filtered.len(), 2);
    }

    #[test]
    fn extract_placeholder_tokens_dedupes_in_order() {
        let body = json!({
            "body": "Dear {{ author_name }}, your {{ study_type }} on {{ author_name }} is ready."
        });
        assert_eq!(
            extract_placeholder_tokens_from_body(&body),
            vec!["author_name".to_string(), "study_type".to_string()]
        );
    }

    #[test]
    fn extract_placeholder_tokens_handles_unterminated_and_empty() {
        assert_eq!(
            extract_placeholder_tokens_from_body(&json!({ "body": "no placeholders here" })),
            Vec::<String>::new()
        );
        assert_eq!(
            extract_placeholder_tokens_from_body(&json!({ "body": "broken {{ token " })),
            Vec::<String>::new()
        );
        assert_eq!(
            extract_placeholder_tokens_from_body(&json!({ "content": "{{}} {{ real }}" })),
            vec!["real".to_string()]
        );
    }

    #[test]
    fn count_placeholder_tokens_counts_distinct() {
        let body = json!({ "content": "{{ a }} {{ b }} {{ a }}" });
        assert_eq!(count_placeholder_tokens_in_body(&body), 2);
        assert_eq!(count_placeholder_tokens_in_body(&json!({})), 0);
    }

    #[test]
    fn truncate_text_appends_ellipsis_only_when_shortened() {
        assert_eq!(truncate_text_to_preview_length("short", 10), "short");
        assert_eq!(truncate_text_to_preview_length("abcdefghij", 5), "abcde…");
        assert_eq!(truncate_text_to_preview_length("anything", 0), "");
        assert_eq!(truncate_text_to_preview_length("  padded  ", 20), "padded");
    }

    #[test]
    fn extract_description_preview_truncates() {
        let body = json!({ "description": "A very long description that exceeds the limit" });
        let preview = extract_template_description_preview_from_body(&body, 10);
        assert!(preview.ends_with('…'));
        assert!(preview.chars().count() <= 11);
        assert_eq!(
            extract_template_description_preview_from_body(&json!({}), 10),
            ""
        );
    }

    #[test]
    fn project_summary_contains_expected_fields() {
        let document = stored_document_with_body(
            "tmpl-1",
            json!({
                "name": "Systematic Review",
                "description": "A structured review template",
                "body": "Hello {{ author }}"
            }),
        );
        let summary = project_stored_document_to_drafting_template_summary(&document);
        assert_eq!(summary["template_identifier"], json!("tmpl-1"));
        assert_eq!(summary["template_name"], json!("Systematic Review"));
        assert_eq!(summary["placeholder_count"], json!(1));
        assert_eq!(summary["placeholder_tokens"], json!(["author"]));
    }

    #[test]
    fn project_summary_falls_back_to_identifier_for_name() {
        let document = stored_document_with_body("fallback-id", json!({}));
        let summary = project_stored_document_to_drafting_template_summary(&document);
        assert_eq!(summary["template_name"], json!("fallback-id"));
    }

    #[test]
    fn sort_summaries_ascending_case_insensitive() {
        let mut summaries = vec![
            json!({ "template_name": "banana" }),
            json!({ "template_name": "Apple" }),
            json!({ "template_name": "cherry" }),
        ];
        sort_drafting_template_summaries_by_name_ascending(&mut summaries);
        assert_eq!(summaries[0]["template_name"], json!("Apple"));
        assert_eq!(summaries[1]["template_name"], json!("banana"));
        assert_eq!(summaries[2]["template_name"], json!("cherry"));
    }

    #[test]
    fn render_documents_into_summaries_sorts_output() {
        let documents = vec![
            stored_document_with_body("z", json!({ "name": "Zeta" })),
            stored_document_with_body("a", json!({ "name": "Alpha" })),
        ];
        let rendered = render_drafting_template_documents_into_summaries(documents);
        assert_eq!(rendered.len(), 2);
        assert_eq!(rendered[0]["template_name"], json!("Alpha"));
        assert_eq!(rendered[1]["template_name"], json!("Zeta"));
    }

    #[test]
    fn count_returned_templates_matches_length() {
        let summaries = vec![json!({}), json!({})];
        assert_eq!(count_returned_drafting_templates(&summaries), 2);
        assert_eq!(count_returned_drafting_templates(&[]), 0);
    }

    #[test]
    fn build_listing_response_shape() {
        let summaries = vec![json!({ "template_name": "Alpha" })];
        let response = build_drafting_template_listing_response(summaries, 1);
        assert_eq!(response["total_count"], json!(1));
        assert!(response["drafting_templates"].is_array());
        assert_eq!(response["drafting_templates"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn map_application_error_maps_variants() {
        let not_found =
            map_application_error_to_http_error(ApplicationError::RequestedResourceCouldNotBeLocated);
        assert!(matches!(
            not_found,
            HttpError::RequestedResourceWasNotFound { .. }
        ));

        let denied =
            map_application_error_to_http_error(ApplicationError::AuthorizationWasDenied);
        assert!(matches!(denied, HttpError::AuthorizationWasDenied { .. }));

        let upstream = map_application_error_to_http_error(
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
