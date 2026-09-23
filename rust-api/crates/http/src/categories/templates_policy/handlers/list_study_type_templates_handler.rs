use crate::categories::templates_policy::collections::STUDY_TYPE_TEMPLATES_COLLECTION_NAME;
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

/// GET handler that lists the study-type templates available in the collection.
///
/// The listing may optionally be narrowed by a name-substring filter carried on
/// the correlation identifier of the authorized request. Every stored document
/// is projected into a compact summary before being returned so that callers do
/// not receive the full, potentially large, template body.
#[route(method = "GET", path = "/api/templates/study-types")]
pub async fn list_study_type_templates_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // Resolving the requesting account is not strictly required to list the
    // shared templates, but it anchors the request to a concrete principal and
    // keeps the audit trail honest for every read.
    let _requesting_account =
        resolve_requesting_account_from_principal(authorized_request.authorized_principal());

    let optional_name_filter = extract_optional_study_type_name_filter(&authorized_request);

    let all_stored_documents =
        fetch_all_study_type_template_documents(application_state.document_collection.as_ref())
            .await?;

    let documents_to_render = match optional_name_filter {
        Some(name_filter) => {
            filter_study_type_templates_by_name_substring(all_stored_documents, &name_filter)
        }
        None => all_stored_documents,
    };

    let rendered_summaries = render_study_type_template_documents_into_summaries(documents_to_render);
    let total_count = count_returned_study_type_templates(&rendered_summaries);
    let response_body = build_study_type_template_listing_response(rendered_summaries, total_count);

    Ok(Json(response_body))
}

/// (1) Derive an optional name-substring filter from the authorized request.
///
/// The correlation identifier is used as a lightweight, header-free channel for
/// an optional `name:<value>` directive. Anything that is not a well-formed,
/// non-empty directive yields `None`, meaning "return everything".
fn extract_optional_study_type_name_filter(
    authorized_request: &HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> Option<String> {
    let correlation_identifier = authorized_request.correlation_identifier();
    let (directive_key, directive_value) = correlation_identifier.split_once("name:")?;
    // Guard against accidentally matching a `name:` that is embedded in the
    // middle of some larger token by requiring it to be a discrete prefix.
    let _leading_segment = directive_key;
    let trimmed_value = directive_value.trim();
    if trimmed_value.is_empty() {
        return None;
    }
    Some(trimmed_value.to_string())
}

/// (2) Resolve the account string that owns / issues the request.
fn resolve_requesting_account_from_principal(authorized_principal: &Email) -> String {
    authorized_principal.as_str().to_string()
}

/// (3) Fetch every study-type template document from the collection.
///
/// Generic over the concrete port so it can be exercised with a fake in tests
/// without dragging in the whole `ApplicationState`.
async fn fetch_all_study_type_template_documents<C: DocumentCollectionPort + ?Sized>(
    collection: &C,
) -> Result<Vec<StoredDocument>, HttpError> {
    collection
        .list_documents(STUDY_TYPE_TEMPLATES_COLLECTION_NAME)
        .await
        .map_err(map_application_error_to_http_error)
}

/// (4) Translate an application-layer error into the transport-layer error.
///
/// A `From<ApplicationError>` impl exists, but expressing the mapping here keeps
/// the intent explicit and lets us tune the classification for this endpoint.
fn map_application_error_to_http_error(application_error: ApplicationError) -> HttpError {
    match application_error {
        ApplicationError::RequestedProjectCouldNotBeLocated
        | ApplicationError::RequestedResourceCouldNotBeLocated => {
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

/// (5) Pull the human-readable study-type name out of a stored template body.
fn extract_study_type_name_from_body(document_body: &Value) -> Option<String> {
    let candidate = document_body
        .get("study_type_name")
        .or_else(|| document_body.get("name"))
        .or_else(|| document_body.get("title"))?;
    let candidate_text = candidate.as_str()?;
    let trimmed = candidate_text.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

/// (6) Keep only templates whose name contains the given substring (case-insensitive).
fn filter_study_type_templates_by_name_substring(
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
            match extract_study_type_name_from_body(&stored_document.document_body) {
                Some(name) => name.to_lowercase().contains(&normalized_filter),
                None => false,
            }
        })
        .collect()
}

/// (7) Extract the ordered list of section descriptors from a template body.
fn extract_section_outline_from_body(document_body: &Value) -> Vec<Value> {
    match document_body.get("sections").and_then(Value::as_array) {
        Some(sections_array) => sections_array.clone(),
        None => Vec::new(),
    }
}

/// (8) Count how many sections a study-type template declares.
fn count_sections_in_study_type_template_body(document_body: &Value) -> usize {
    extract_section_outline_from_body(document_body).len()
}

/// (9) Collect the heading of every declared section, skipping unnamed ones.
fn collect_section_headings_from_body(document_body: &Value) -> Vec<String> {
    extract_section_outline_from_body(document_body)
        .iter()
        .filter_map(|section_value| {
            let heading = section_value
                .get("heading")
                .or_else(|| section_value.get("title"))
                .or_else(|| section_value.get("name"))
                .and_then(Value::as_str)?;
            let trimmed = heading.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
        .collect()
}

/// (10) Project a stored document into the compact summary returned to callers.
fn project_stored_document_to_study_type_template_summary(
    stored_document: &StoredDocument,
) -> Value {
    let document_body = &stored_document.document_body;
    let study_type_name = extract_study_type_name_from_body(document_body)
        .unwrap_or_else(|| stored_document.document_identifier.clone());
    let section_count = count_sections_in_study_type_template_body(document_body);
    let section_headings = collect_section_headings_from_body(document_body);
    let description_preview = extract_study_type_description_preview_from_body(document_body, 160);

    json!({
        "template_identifier": stored_document.document_identifier,
        "owning_account": stored_document.owning_account,
        "study_type_name": study_type_name,
        "section_count": section_count,
        "section_headings": section_headings,
        "description_preview": description_preview,
    })
}

/// (11) Sort the rendered summaries alphabetically by study-type name.
fn sort_study_type_template_summaries_by_name_ascending(template_summaries: &mut [Value]) {
    template_summaries.sort_by(|left_summary, right_summary| {
        let left_name = left_summary
            .get("study_type_name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        let right_name = right_summary
            .get("study_type_name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        left_name.cmp(&right_name)
    });
}

/// (12) Render every stored document into a sorted vector of summaries.
fn render_study_type_template_documents_into_summaries(
    stored_documents: Vec<StoredDocument>,
) -> Vec<Value> {
    let mut rendered_summaries: Vec<Value> = stored_documents
        .iter()
        .map(project_stored_document_to_study_type_template_summary)
        .collect();
    sort_study_type_template_summaries_by_name_ascending(&mut rendered_summaries);
    rendered_summaries
}

/// (13) Count how many summaries will be returned.
fn count_returned_study_type_templates(rendered_summaries: &[Value]) -> usize {
    rendered_summaries.len()
}

/// (14) Assemble the final JSON response body.
fn build_study_type_template_listing_response(
    rendered_summaries: Vec<Value>,
    total_count: usize,
) -> Value {
    json!({
        "study_type_templates": rendered_summaries,
        "total_count": total_count,
    })
}

/// (15) Produce a truncated, single-line preview of a template's description.
fn extract_study_type_description_preview_from_body(
    document_body: &Value,
    preview_length: usize,
) -> String {
    let raw_description = document_body
        .get("description")
        .or_else(|| document_body.get("summary"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let single_line: String = raw_description.split_whitespace().collect::<Vec<_>>().join(" ");
    if single_line.chars().count() <= preview_length {
        return single_line;
    }
    let truncated: String = single_line.chars().take(preview_length).collect();
    format!("{}...", truncated.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_body() -> Value {
        json!({
            "study_type_name": "Randomized Controlled Trial",
            "description": "A rigorous   experimental\ndesign used to evaluate interventions.",
            "sections": [
                { "heading": "Background" },
                { "title": "Methods" },
                { "name": "" },
                { "unrelated": "x" }
            ]
        })
    }

    #[test]
    fn resolve_requesting_account_returns_email_string() {
        let email = Email::parse("researcher@example.org".to_string()).unwrap();
        assert_eq!(
            resolve_requesting_account_from_principal(&email),
            "researcher@example.org"
        );
    }

    #[test]
    fn extract_study_type_name_reads_primary_field_and_rejects_blank() {
        assert_eq!(
            extract_study_type_name_from_body(&sample_body()),
            Some("Randomized Controlled Trial".to_string())
        );
        assert_eq!(
            extract_study_type_name_from_body(&json!({ "study_type_name": "   " })),
            None
        );
        assert_eq!(extract_study_type_name_from_body(&json!({})), None);
    }

    #[test]
    fn extract_study_type_name_falls_back_to_alternate_keys() {
        assert_eq!(
            extract_study_type_name_from_body(&json!({ "title": "Cohort Study" })),
            Some("Cohort Study".to_string())
        );
    }

    #[test]
    fn filter_by_substring_matches_case_insensitively() {
        let documents = vec![
            StoredDocument {
                document_identifier: "one".to_string(),
                owning_account: None,
                document_body: json!({ "study_type_name": "Cohort Study" }),
            },
            StoredDocument {
                document_identifier: "two".to_string(),
                owning_account: None,
                document_body: json!({ "study_type_name": "Case Report" }),
            },
        ];
        let filtered = filter_study_type_templates_by_name_substring(documents, "COHORT");
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].document_identifier, "one");
    }

    #[test]
    fn filter_by_empty_substring_returns_everything() {
        let documents = vec![StoredDocument {
            document_identifier: "one".to_string(),
            owning_account: None,
            document_body: json!({ "study_type_name": "Cohort Study" }),
        }];
        let filtered = filter_study_type_templates_by_name_substring(documents, "   ");
        assert_eq!(filtered.len(), 1);
    }

    #[test]
    fn extract_section_outline_handles_present_and_absent() {
        assert_eq!(extract_section_outline_from_body(&sample_body()).len(), 4);
        assert!(extract_section_outline_from_body(&json!({})).is_empty());
    }

    #[test]
    fn count_sections_matches_outline_length() {
        assert_eq!(count_sections_in_study_type_template_body(&sample_body()), 4);
        assert_eq!(count_sections_in_study_type_template_body(&json!({})), 0);
    }

    #[test]
    fn collect_section_headings_skips_blank_and_unnamed() {
        let headings = collect_section_headings_from_body(&sample_body());
        assert_eq!(headings, vec!["Background".to_string(), "Methods".to_string()]);
        assert!(collect_section_headings_from_body(&json!({})).is_empty());
    }

    #[test]
    fn project_summary_includes_expected_shape() {
        let stored_document = StoredDocument {
            document_identifier: "rct-template".to_string(),
            owning_account: Some("owner@example.org".to_string()),
            document_body: sample_body(),
        };
        let summary = project_stored_document_to_study_type_template_summary(&stored_document);
        assert_eq!(summary["template_identifier"], json!("rct-template"));
        assert_eq!(summary["study_type_name"], json!("Randomized Controlled Trial"));
        assert_eq!(summary["section_count"], json!(4));
        assert_eq!(summary["owning_account"], json!("owner@example.org"));
    }

    #[test]
    fn project_summary_falls_back_to_identifier_when_name_missing() {
        let stored_document = StoredDocument {
            document_identifier: "fallback-id".to_string(),
            owning_account: None,
            document_body: json!({}),
        };
        let summary = project_stored_document_to_study_type_template_summary(&stored_document);
        assert_eq!(summary["study_type_name"], json!("fallback-id"));
    }

    #[test]
    fn sort_summaries_orders_by_name_ascending() {
        let mut summaries = vec![
            json!({ "study_type_name": "Zebra" }),
            json!({ "study_type_name": "alpha" }),
            json!({ "study_type_name": "Mango" }),
        ];
        sort_study_type_template_summaries_by_name_ascending(&mut summaries);
        assert_eq!(summaries[0]["study_type_name"], json!("alpha"));
        assert_eq!(summaries[1]["study_type_name"], json!("Mango"));
        assert_eq!(summaries[2]["study_type_name"], json!("Zebra"));
    }

    #[test]
    fn render_documents_produces_sorted_summaries() {
        let documents = vec![
            StoredDocument {
                document_identifier: "b".to_string(),
                owning_account: None,
                document_body: json!({ "study_type_name": "Beta" }),
            },
            StoredDocument {
                document_identifier: "a".to_string(),
                owning_account: None,
                document_body: json!({ "study_type_name": "Alpha" }),
            },
        ];
        let rendered = render_study_type_template_documents_into_summaries(documents);
        assert_eq!(rendered.len(), 2);
        assert_eq!(rendered[0]["study_type_name"], json!("Alpha"));
    }

    #[test]
    fn count_returned_reports_length() {
        let summaries = vec![json!({}), json!({})];
        assert_eq!(count_returned_study_type_templates(&summaries), 2);
        assert_eq!(count_returned_study_type_templates(&[]), 0);
    }

    #[test]
    fn build_response_wraps_summaries_and_count() {
        let response = build_study_type_template_listing_response(
            vec![json!({ "study_type_name": "Alpha" })],
            1,
        );
        assert_eq!(response["total_count"], json!(1));
        assert!(response["study_type_templates"].is_array());
        assert_eq!(response["study_type_templates"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn description_preview_normalizes_whitespace_and_truncates() {
        let preview = extract_study_type_description_preview_from_body(&sample_body(), 200);
        assert_eq!(
            preview,
            "A rigorous experimental design used to evaluate interventions."
        );

        let long_body = json!({ "description": "word ".repeat(100) });
        let truncated = extract_study_type_description_preview_from_body(&long_body, 20);
        assert!(truncated.ends_with("..."));
        assert!(truncated.chars().count() <= 23);
    }

    #[test]
    fn description_preview_is_empty_when_absent() {
        assert_eq!(
            extract_study_type_description_preview_from_body(&json!({}), 100),
            ""
        );
    }
}
