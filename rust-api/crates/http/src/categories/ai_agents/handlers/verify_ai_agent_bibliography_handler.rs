use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::error::ApplicationError;
use alma_application::ports::literature::PublicationSummary;
use alma_application::ports::storage::StorageObjectIdentifier;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::NonEmptyText;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};

/// Verify that each bibliography entry declared by the client can actually be
/// located — either as a stored blob (google-drive / storage backed path) or as
/// a publication discoverable through the literature adapter.
///
/// The request body is expected to carry a `bibliography` (or `entries`) array;
/// every element is an object describing a single reference with a declared
/// path and a declared name. For each entry we determine whether it exists and
/// assemble a per-entry verification result, then summarise the whole batch.
#[route(method = "POST", path = "/api/ai-agents/verify-bibliography")]
pub async fn verify_ai_agent_bibliography_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let bibliography_entry_array = extract_bibliography_entry_array(&submitted_body)?;
    ensure_bibliography_entry_array_is_not_empty(&bibliography_entry_array)?;

    let mut per_entry_verification_results: Vec<Value> =
        Vec::with_capacity(bibliography_entry_array.len());

    for bibliography_entry in &bibliography_entry_array {
        let entry_declared_path = extract_entry_declared_path(bibliography_entry)?;
        let entry_declared_name = extract_entry_declared_name(bibliography_entry)?;
        let entry_path_type = classify_bibliography_entry_path_type(&entry_declared_path);

        let (entry_was_located, web_view_link) = match entry_path_type.as_str() {
            "storage" | "gdrive" => {
                let object_identifier =
                    build_storage_object_identifier_from_entry_path(&entry_declared_path);
                let fetched_blob_result =
                    application_state.storage_adapter.fetch_blob(&object_identifier).await;
                let located = interpret_storage_fetch_result_as_existence(fetched_blob_result)?;
                let link = if located {
                    Some(build_web_view_link_for_located_entry(
                        &entry_declared_path,
                        &entry_path_type,
                    ))
                } else {
                    None
                };
                (located, link)
            }
            _ => {
                // No storage-backed path: fall back to a literature search using
                // the declared name so that well-known publications still verify.
                let parsed_name =
                    parse_entry_declared_name_into_non_empty_text(entry_declared_name.clone())?;
                let lookup_expression =
                    build_literature_lookup_expression_from_entry_name(&parsed_name);
                let candidate_publications = application_state
                    .literature_adapter
                    .search_publications(&lookup_expression)
                    .await
                    .map_err(map_verification_lookup_failure_to_http_error)?;
                match select_best_matching_publication_summary(
                    &entry_declared_name,
                    candidate_publications,
                ) {
                    Some(matched) => {
                        let link = matched
                            .digital_object_identifier
                            .map(|doi| format!("https://doi.org/{doi}"));
                        (true, link)
                    }
                    None => (false, None),
                }
            }
        };

        per_entry_verification_results.push(assemble_single_entry_verification_result(
            &entry_declared_name,
            &entry_path_type,
            entry_was_located,
            web_view_link,
        ));
    }

    let (located_entry_count, missing_entry_count) =
        summarize_bibliography_verification_outcomes(&per_entry_verification_results);

    Ok(Json(assemble_bibliography_verification_response_payload(
        per_entry_verification_results,
        located_entry_count,
        missing_entry_count,
    )))
}

/// (1) Pull the array of bibliography entries out of the request body. The
/// client may deliver it under `bibliography`, `entries`, or as a bare array.
fn extract_bibliography_entry_array(submitted_body: &Value) -> Result<Vec<Value>, HttpError> {
    if let Some(array) = submitted_body.as_array() {
        return Ok(array.clone());
    }

    for candidate_key in ["bibliography", "entries", "references"] {
        if let Some(field) = submitted_body.get(candidate_key) {
            match field.as_array() {
                Some(array) => return Ok(array.clone()),
                None => {
                    return Err(HttpError::RequestBodyWasMalformed {
                        explanation: format!("the '{candidate_key}' field must be an array"),
                    });
                }
            }
        }
    }

    Err(HttpError::RequestBodyWasMalformed {
        explanation:
            "expected a 'bibliography' array (or 'entries'/'references', or a bare array)"
                .to_string(),
    })
}

/// (2) Guard against an empty batch — verifying nothing is a client error.
fn ensure_bibliography_entry_array_is_not_empty(
    bibliography_entry_array: &[Value],
) -> Result<(), HttpError> {
    if bibliography_entry_array.is_empty() {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: "the bibliography must contain at least one entry".to_string(),
        });
    }
    Ok(())
}

/// (3) Read the declared path (a storage reference or an external URL) from a
/// single entry. Accepts several common key spellings.
fn extract_entry_declared_path(bibliography_entry: &Value) -> Result<String, HttpError> {
    for candidate_key in ["path", "filePath", "file_path", "url", "reference"] {
        if let Some(raw) = bibliography_entry.get(candidate_key).and_then(Value::as_str) {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_string());
            }
        }
    }
    Err(HttpError::RequestBodyWasMalformed {
        explanation: "each bibliography entry must declare a non-empty 'path'".to_string(),
    })
}

/// (4) Read the human-readable declared name (title) from a single entry.
fn extract_entry_declared_name(bibliography_entry: &Value) -> Result<String, HttpError> {
    for candidate_key in ["name", "title", "fileName", "file_name", "label"] {
        if let Some(raw) = bibliography_entry.get(candidate_key).and_then(Value::as_str) {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_string());
            }
        }
    }
    Err(HttpError::RequestBodyWasMalformed {
        explanation: "each bibliography entry must declare a non-empty 'name'".to_string(),
    })
}

/// (5) Decide how the declared path should be interpreted so the handler can
/// route it to the right existence check.
fn classify_bibliography_entry_path_type(entry_declared_path: &str) -> String {
    let normalized = entry_declared_path.trim().to_ascii_lowercase();
    if normalized.starts_with("gdrive:")
        || normalized.contains("drive.google.com")
        || normalized.contains("docs.google.com")
    {
        return "gdrive".to_string();
    }
    if normalized.starts_with("storage:")
        || normalized.starts_with("blob:")
        || normalized.starts_with("s3://")
    {
        return "storage".to_string();
    }
    if normalized.starts_with("http://") || normalized.starts_with("https://") {
        return "external".to_string();
    }
    if normalized.starts_with("doi:") || normalized.starts_with("10.") {
        return "doi".to_string();
    }
    "citation".to_string()
}

/// (6) Turn a raw declared name into a validated domain `NonEmptyText`, mapping
/// domain validation failures to a malformed-body error.
fn parse_entry_declared_name_into_non_empty_text(
    raw_entry_declared_name: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(raw_entry_declared_name).map_err(|domain_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: domain_error.to_string(),
        }
    })
}

/// (7) Convert a declared storage/gdrive path into the opaque object identifier
/// the storage port expects, stripping any recognised scheme prefix.
fn build_storage_object_identifier_from_entry_path(
    entry_declared_path: &str,
) -> StorageObjectIdentifier {
    let trimmed = entry_declared_path.trim();
    let opaque_reference = trimmed
        .strip_prefix("gdrive:")
        .or_else(|| trimmed.strip_prefix("storage:"))
        .or_else(|| trimmed.strip_prefix("blob:"))
        .unwrap_or(trimmed)
        .trim()
        .to_string();
    StorageObjectIdentifier { opaque_reference }
}

/// (8) Translate a storage fetch outcome into a boolean "does it exist". A
/// successful fetch means present; a not-found means absent; any other adapter
/// failure is surfaced as an upstream error.
fn interpret_storage_fetch_result_as_existence(
    fetched_blob_result: Result<Vec<u8>, ApplicationError>,
) -> Result<bool, HttpError> {
    match fetched_blob_result {
        Ok(_bytes) => Ok(true),
        Err(ApplicationError::RequestedResourceCouldNotBeLocated) => Ok(false),
        Err(other) => Err(map_verification_lookup_failure_to_http_error(other)),
    }
}

/// (9) Build the literature search expression from a validated entry name. The
/// name itself is a sensible query; we reuse it verbatim as a `NonEmptyText`.
fn build_literature_lookup_expression_from_entry_name(
    entry_declared_name: &NonEmptyText,
) -> NonEmptyText {
    entry_declared_name.clone()
}

/// (10) Choose the publication whose title best matches the declared name. We
/// prefer an exact (case-insensitive) title match, then a substring match, then
/// fall back to the first candidate only when the names overlap meaningfully.
fn select_best_matching_publication_summary(
    entry_declared_name: &str,
    candidate_publications: Vec<PublicationSummary>,
) -> Option<PublicationSummary> {
    let needle = entry_declared_name.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return None;
    }

    let mut substring_match: Option<PublicationSummary> = None;
    for candidate in candidate_publications {
        let haystack = candidate.publication_title.trim().to_ascii_lowercase();
        if haystack == needle {
            return Some(candidate);
        }
        if substring_match.is_none()
            && (haystack.contains(&needle) || needle.contains(&haystack))
            && !haystack.is_empty()
        {
            substring_match = Some(candidate);
        }
    }
    substring_match
}

/// (11) Produce a viewable link for an entry we managed to locate. For
/// google-drive paths we normalise into a canonical `view` URL; for other
/// storage paths we echo the declared path.
fn build_web_view_link_for_located_entry(
    entry_declared_path: &str,
    entry_path_type: &str,
) -> String {
    let trimmed = entry_declared_path.trim();
    if entry_path_type == "gdrive" {
        if let Some(file_identifier) = trimmed.strip_prefix("gdrive:") {
            let cleaned = file_identifier.trim();
            if !cleaned.is_empty() {
                return format!("https://drive.google.com/file/d/{cleaned}/view");
            }
        }
        if trimmed.contains("drive.google.com") || trimmed.contains("docs.google.com") {
            return trimmed.to_string();
        }
    }
    trimmed.to_string()
}

/// (12) Assemble the JSON result describing verification of one entry.
fn assemble_single_entry_verification_result(
    entry_declared_name: &str,
    entry_path_type: &str,
    entry_was_located: bool,
    web_view_link: Option<String>,
) -> Value {
    let message = if entry_was_located {
        "entry was successfully located"
    } else {
        "entry could not be located"
    };
    json!({
        "name": entry_declared_name,
        "pathType": entry_path_type,
        "found": entry_was_located,
        "webViewLink": web_view_link,
        "message": message,
    })
}

/// (13) Count how many entries were located versus missing across the batch.
fn summarize_bibliography_verification_outcomes(
    per_entry_verification_results: &[Value],
) -> (usize, usize) {
    let located = per_entry_verification_results
        .iter()
        .filter(|result| result.get("found").and_then(Value::as_bool).unwrap_or(false))
        .count();
    let missing = per_entry_verification_results.len() - located;
    (located, missing)
}

/// (14) Map an application-layer lookup failure onto the appropriate HTTP error.
fn map_verification_lookup_failure_to_http_error(
    originating_application_error: ApplicationError,
) -> HttpError {
    match originating_application_error {
        ApplicationError::RequestedResourceCouldNotBeLocated
        | ApplicationError::RequestedProjectCouldNotBeLocated => {
            HttpError::RequestedResourceWasNotFound {
                explanation: originating_application_error.to_string(),
            }
        }
        ApplicationError::AuthorizationWasDenied => HttpError::AuthorizationWasDenied {
            explanation: originating_application_error.to_string(),
        },
        ApplicationError::DomainInvariantViolated(domain_error) => {
            HttpError::RequestBodyWasMalformed {
                explanation: domain_error.to_string(),
            }
        }
        other => HttpError::UpstreamApplicationFailure {
            explanation: other.to_string(),
        },
    }
}

/// (15) Build the final response payload combining every per-entry result with
/// the batch summary and an overall all-located flag.
fn assemble_bibliography_verification_response_payload(
    per_entry_verification_results: Vec<Value>,
    located_entry_count: usize,
    missing_entry_count: usize,
) -> Value {
    let total_entry_count = located_entry_count + missing_entry_count;
    json!({
        "found": missing_entry_count == 0,
        "totalEntries": total_entry_count,
        "locatedEntries": located_entry_count,
        "missingEntries": missing_entry_count,
        "results": per_entry_verification_results,
        "message": if missing_entry_count == 0 {
            "all bibliography entries were verified"
        } else {
            "some bibliography entries could not be verified"
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_bibliography_entry_array_reads_named_field() {
        let body = json!({ "bibliography": [{ "name": "a" }, { "name": "b" }] });
        let array = extract_bibliography_entry_array(&body).expect("should read array");
        assert_eq!(array.len(), 2);
    }

    #[test]
    fn extract_bibliography_entry_array_accepts_bare_array() {
        let body = json!([{ "name": "a" }]);
        let array = extract_bibliography_entry_array(&body).expect("should read bare array");
        assert_eq!(array.len(), 1);
    }

    #[test]
    fn extract_bibliography_entry_array_rejects_missing() {
        let body = json!({ "unrelated": 1 });
        assert!(extract_bibliography_entry_array(&body).is_err());
    }

    #[test]
    fn ensure_bibliography_entry_array_is_not_empty_flags_empty() {
        assert!(ensure_bibliography_entry_array_is_not_empty(&[]).is_err());
        assert!(ensure_bibliography_entry_array_is_not_empty(&[json!({})]).is_ok());
    }

    #[test]
    fn extract_entry_declared_path_reads_various_keys() {
        assert_eq!(
            extract_entry_declared_path(&json!({ "path": " gdrive:xyz " })).unwrap(),
            "gdrive:xyz"
        );
        assert_eq!(
            extract_entry_declared_path(&json!({ "url": "https://x" })).unwrap(),
            "https://x"
        );
    }

    #[test]
    fn extract_entry_declared_path_rejects_blank() {
        assert!(extract_entry_declared_path(&json!({ "path": "   " })).is_err());
        assert!(extract_entry_declared_path(&json!({})).is_err());
    }

    #[test]
    fn extract_entry_declared_name_reads_various_keys() {
        assert_eq!(
            extract_entry_declared_name(&json!({ "title": "A Paper" })).unwrap(),
            "A Paper"
        );
        assert_eq!(
            extract_entry_declared_name(&json!({ "name": " Ref " })).unwrap(),
            "Ref"
        );
    }

    #[test]
    fn extract_entry_declared_name_rejects_missing() {
        assert!(extract_entry_declared_name(&json!({ "path": "x" })).is_err());
    }

    #[test]
    fn classify_bibliography_entry_path_type_covers_schemes() {
        assert_eq!(classify_bibliography_entry_path_type("gdrive:abc"), "gdrive");
        assert_eq!(
            classify_bibliography_entry_path_type("https://drive.google.com/file/d/1/view"),
            "gdrive"
        );
        assert_eq!(classify_bibliography_entry_path_type("storage:blob1"), "storage");
        assert_eq!(classify_bibliography_entry_path_type("s3://bucket/key"), "storage");
        assert_eq!(classify_bibliography_entry_path_type("https://example.com"), "external");
        assert_eq!(classify_bibliography_entry_path_type("10.1000/xyz"), "doi");
        assert_eq!(classify_bibliography_entry_path_type("Smith et al 2020"), "citation");
    }

    #[test]
    fn parse_entry_declared_name_into_non_empty_text_handles_good_and_bad() {
        assert!(parse_entry_declared_name_into_non_empty_text("Valid".to_string()).is_ok());
        assert!(parse_entry_declared_name_into_non_empty_text("   ".to_string()).is_err());
    }

    #[test]
    fn build_storage_object_identifier_from_entry_path_strips_prefixes() {
        assert_eq!(
            build_storage_object_identifier_from_entry_path("gdrive: file-1 ").opaque_reference,
            "file-1"
        );
        assert_eq!(
            build_storage_object_identifier_from_entry_path("storage:blob-9").opaque_reference,
            "blob-9"
        );
        assert_eq!(
            build_storage_object_identifier_from_entry_path("raw-ref").opaque_reference,
            "raw-ref"
        );
    }

    #[test]
    fn interpret_storage_fetch_result_as_existence_maps_outcomes() {
        assert_eq!(
            interpret_storage_fetch_result_as_existence(Ok(vec![1, 2, 3])).unwrap(),
            true
        );
        assert_eq!(
            interpret_storage_fetch_result_as_existence(Err(
                ApplicationError::RequestedResourceCouldNotBeLocated
            ))
            .unwrap(),
            false
        );
        assert!(interpret_storage_fetch_result_as_existence(Err(
            ApplicationError::StorageAdapterFailure {
                failure_description: "boom".to_string(),
            }
        ))
        .is_err());
    }

    #[test]
    fn build_literature_lookup_expression_from_entry_name_echoes_name() {
        let name = NonEmptyText::parse("Deep Learning".to_string()).unwrap();
        let expr = build_literature_lookup_expression_from_entry_name(&name);
        assert_eq!(expr.as_str(), "Deep Learning");
    }

    fn make_summary(title: &str, doi: Option<&str>) -> PublicationSummary {
        PublicationSummary {
            publication_title: title.to_string(),
            digital_object_identifier: doi.map(str::to_string),
            originating_source: "test-source".to_string(),
        }
    }

    #[test]
    fn select_best_matching_publication_summary_prefers_exact() {
        let candidates = vec![
            make_summary("Something Else", None),
            make_summary("Attention Is All You Need", Some("10.1/x")),
        ];
        let chosen =
            select_best_matching_publication_summary("attention is all you need", candidates)
                .expect("exact match expected");
        assert_eq!(chosen.digital_object_identifier.as_deref(), Some("10.1/x"));
    }

    #[test]
    fn select_best_matching_publication_summary_falls_back_to_substring() {
        let candidates = vec![make_summary("A Study of Transformers in NLP", None)];
        let chosen = select_best_matching_publication_summary("transformers", candidates);
        assert!(chosen.is_some());
    }

    #[test]
    fn select_best_matching_publication_summary_returns_none_when_no_overlap() {
        let candidates = vec![make_summary("Unrelated Work", None)];
        assert!(select_best_matching_publication_summary("quantum gravity", candidates).is_none());
        assert!(select_best_matching_publication_summary("   ", vec![]).is_none());
    }

    #[test]
    fn build_web_view_link_for_located_entry_normalises_gdrive() {
        assert_eq!(
            build_web_view_link_for_located_entry("gdrive:abc123", "gdrive"),
            "https://drive.google.com/file/d/abc123/view"
        );
        assert_eq!(
            build_web_view_link_for_located_entry("storage:blob", "storage"),
            "storage:blob"
        );
    }

    #[test]
    fn assemble_single_entry_verification_result_reflects_state() {
        let located = assemble_single_entry_verification_result(
            "Ref",
            "gdrive",
            true,
            Some("https://link".to_string()),
        );
        assert_eq!(located.get("found").and_then(Value::as_bool), Some(true));
        assert_eq!(
            located.get("webViewLink").and_then(Value::as_str),
            Some("https://link")
        );

        let missing = assemble_single_entry_verification_result("Ref", "citation", false, None);
        assert_eq!(missing.get("found").and_then(Value::as_bool), Some(false));
        assert!(missing.get("webViewLink").unwrap().is_null());
    }

    #[test]
    fn summarize_bibliography_verification_outcomes_counts_correctly() {
        let results = vec![
            json!({ "found": true }),
            json!({ "found": false }),
            json!({ "found": true }),
        ];
        assert_eq!(summarize_bibliography_verification_outcomes(&results), (2, 1));
        assert_eq!(summarize_bibliography_verification_outcomes(&[]), (0, 0));
    }

    #[test]
    fn map_verification_lookup_failure_to_http_error_maps_variants() {
        assert!(matches!(
            map_verification_lookup_failure_to_http_error(
                ApplicationError::RequestedResourceCouldNotBeLocated
            ),
            HttpError::RequestedResourceWasNotFound { .. }
        ));
        assert!(matches!(
            map_verification_lookup_failure_to_http_error(ApplicationError::AuthorizationWasDenied),
            HttpError::AuthorizationWasDenied { .. }
        ));
        assert!(matches!(
            map_verification_lookup_failure_to_http_error(
                ApplicationError::LiteratureAdapterFailure {
                    failure_description: "x".to_string(),
                }
            ),
            HttpError::UpstreamApplicationFailure { .. }
        ));
    }

    #[test]
    fn assemble_bibliography_verification_response_payload_sets_found_flag() {
        let all_ok = assemble_bibliography_verification_response_payload(
            vec![json!({ "found": true })],
            1,
            0,
        );
        assert_eq!(all_ok.get("found").and_then(Value::as_bool), Some(true));
        assert_eq!(all_ok.get("totalEntries").and_then(Value::as_u64), Some(1));

        let with_missing = assemble_bibliography_verification_response_payload(
            vec![json!({ "found": false })],
            0,
            1,
        );
        assert_eq!(with_missing.get("found").and_then(Value::as_bool), Some(false));
        assert_eq!(
            with_missing.get("missingEntries").and_then(Value::as_u64),
            Some(1)
        );
    }
}
