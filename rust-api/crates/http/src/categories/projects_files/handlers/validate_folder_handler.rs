use crate::categories::projects_files::collections::PROJECT_FOLDERS_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::error::ApplicationError;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};

/// The maximum number of characters a folder name may contain once it has been
/// trimmed and normalized. Chosen to remain comfortably within the limits of the
/// underlying storage systems while still permitting descriptive names.
const MAXIMUM_FOLDER_NAME_LENGTH: usize = 128;

/// Characters that are forbidden inside a folder name because they would either
/// break filesystem-style path handling or confuse downstream tooling.
const FORBIDDEN_FOLDER_NAME_CHARACTERS: &[char] =
    &['/', '\\', ':', '*', '?', '"', '<', '>', '|', '\0'];

#[route(method = "POST", path = "/api/validate-folder")]
pub async fn validate_folder_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let proposed_folder_name = extract_proposed_folder_name_field(&submitted_body)?;
    let parent_project_identifier = extract_parent_project_identifier_field(&submitted_body);

    let normalized_folder_name = trim_and_normalize_proposed_folder_name(&proposed_folder_name);

    // Collect the synchronous, self-contained violations first.
    let mut violations = collect_folder_validation_violations(&normalized_folder_name);

    // Only bother querying the collection for uniqueness when the name is
    // otherwise well-formed; querying with a garbage name wastes a round trip.
    if violations.is_empty() {
        let name_is_unique = check_folder_name_uniqueness_within_project(
            &application_state,
            &parent_project_identifier,
            &normalized_folder_name,
        )
        .await?;

        if !name_is_unique {
            violations.push(
                "a folder with this name already exists within the target project".to_string(),
            );
        }
    }

    let is_valid = determine_folder_name_overall_validity(&violations);
    let sanitized_suggestion = suggest_sanitized_folder_name(&normalized_folder_name);
    let payload = build_folder_validation_payload(is_valid, violations, sanitized_suggestion);

    Ok(Json(payload))
}

/// 1. Pull the mandatory `folder_name` field out of the request body.
///
/// The field must be present and must be a JSON string; anything else is treated
/// as a malformed request body rather than silently defaulting to an empty name.
fn extract_proposed_folder_name_field(submitted_body: &Value) -> Result<String, HttpError> {
    match submitted_body.get("folder_name") {
        Some(Value::String(folder_name_text)) => Ok(folder_name_text.clone()),
        Some(_) => Err(HttpError::RequestBodyWasMalformed {
            explanation: "the 'folder_name' field must be a string".to_string(),
        }),
        None => Err(HttpError::RequestBodyWasMalformed {
            explanation: "the request body must contain a 'folder_name' field".to_string(),
        }),
    }
}

/// 2. Pull the optional `parent_project_identifier` field out of the request body.
///
/// When present and a non-empty string, uniqueness is scoped to that project.
/// When absent (or empty / not a string) uniqueness is checked across the whole
/// folders collection.
fn extract_parent_project_identifier_field(submitted_body: &Value) -> Option<String> {
    submitted_body
        .get("parent_project_identifier")
        .and_then(|identifier_value| identifier_value.as_str())
        .map(|identifier_text| identifier_text.trim().to_string())
        .filter(|identifier_text| !identifier_text.is_empty())
}

/// 3. Trim surrounding whitespace and collapse internal runs of whitespace into a
///    single space so that "  My   Folder  " becomes "My Folder".
fn trim_and_normalize_proposed_folder_name(raw_folder_name: &str) -> String {
    raw_folder_name
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ")
}

/// 4. A normalized name is empty when it contains no characters at all.
fn detect_proposed_folder_name_is_empty(normalized_folder_name: &str) -> bool {
    normalized_folder_name.is_empty()
}

/// 5. A name is too long when its character count exceeds the configured maximum.
///
/// Counting is done over Unicode scalar values (`chars`) rather than raw bytes so
/// that multi-byte names are measured as a human would perceive them.
fn detect_folder_name_exceeds_maximum_length(normalized_folder_name: &str) -> bool {
    normalized_folder_name.chars().count() > MAXIMUM_FOLDER_NAME_LENGTH
}

/// 6. A name contains forbidden characters when any of the reserved punctuation
///    marks (or control characters) appears in it.
fn detect_folder_name_contains_forbidden_characters(normalized_folder_name: &str) -> bool {
    normalized_folder_name.chars().any(|candidate_character| {
        FORBIDDEN_FOLDER_NAME_CHARACTERS.contains(&candidate_character)
            || candidate_character.is_control()
    })
}

/// 7. Detect attempts to walk the directory tree via `.`, `..`, or embedded
///    parent-directory tokens.
fn detect_folder_name_contains_path_traversal(normalized_folder_name: &str) -> bool {
    let trimmed = normalized_folder_name.trim();
    trimmed == "." || trimmed == ".." || trimmed.contains("..")
}

/// 8. Detect names that collide (case-insensitively) with one of the canonical
///    reserved folder names the platform manages internally.
fn detect_folder_name_collides_with_canonical_folder(normalized_folder_name: &str) -> bool {
    let lowered = normalized_folder_name.to_lowercase();
    build_canonical_reserved_folder_names()
        .iter()
        .any(|reserved_name| reserved_name.to_lowercase() == lowered)
}

/// 9. The set of folder names that the platform reserves for its own use and
///    therefore may not be created by users.
fn build_canonical_reserved_folder_names() -> Vec<&'static str> {
    vec![
        "root",
        "trash",
        "shared",
        "system",
        "recent",
        "archive",
        "__proto__",
    ]
}

/// 10. Verify that no existing folder in the (optionally project-scoped)
///     collection already carries the proposed normalized name.
///
/// Returns `Ok(true)` when the name is unique and available, `Ok(false)` when a
/// collision exists. The lookup is case-insensitive to avoid confusing
/// near-duplicates such as "Reports" and "reports".
fn check_folder_name_uniqueness_within_project<'a, TransactionalUnitOfWork: UnitOfWork>(
    application_state: &'a ApplicationState<TransactionalUnitOfWork>,
    parent_project_identifier: &'a Option<String>,
    normalized_folder_name: &'a str,
) -> impl std::future::Future<Output = Result<bool, HttpError>> + 'a {
    async move {
        let existing_folders = application_state
            .document_collection
            .list_documents(PROJECT_FOLDERS_COLLECTION_NAME)
            .await
            .map_err(map_document_collection_failure_to_http_error)?;

        let lowered_candidate = normalized_folder_name.to_lowercase();

        let a_collision_exists = existing_folders.iter().any(|stored_folder| {
            // When a project scope was supplied, ignore folders that belong to a
            // different project.
            if let Some(target_project) = parent_project_identifier {
                let folder_project = stored_folder
                    .document_body
                    .get("parent_project_identifier")
                    .and_then(|project_value| project_value.as_str());
                if folder_project != Some(target_project.as_str()) {
                    return false;
                }
            }

            stored_folder
                .document_body
                .get("folder_name")
                .and_then(|name_value| name_value.as_str())
                .map(|existing_name| {
                    trim_and_normalize_proposed_folder_name(existing_name).to_lowercase()
                        == lowered_candidate
                })
                .unwrap_or(false)
        });

        Ok(!a_collision_exists)
    }
}

/// 11. Run every synchronous validation rule against the normalized name and
///     accumulate a human-readable explanation for each rule that fails.
fn collect_folder_validation_violations(normalized_folder_name: &str) -> Vec<String> {
    let mut violations = Vec::new();

    if detect_proposed_folder_name_is_empty(normalized_folder_name) {
        violations.push("the folder name must not be empty".to_string());
        // An empty name makes the remaining checks meaningless; return early.
        return violations;
    }

    if detect_folder_name_exceeds_maximum_length(normalized_folder_name) {
        violations.push(format!(
            "the folder name must not exceed {MAXIMUM_FOLDER_NAME_LENGTH} characters"
        ));
    }

    if detect_folder_name_contains_forbidden_characters(normalized_folder_name) {
        violations
            .push("the folder name contains one or more forbidden characters".to_string());
    }

    if detect_folder_name_contains_path_traversal(normalized_folder_name) {
        violations.push("the folder name must not reference parent directories".to_string());
    }

    if detect_folder_name_collides_with_canonical_folder(normalized_folder_name) {
        violations.push("the folder name is reserved by the platform".to_string());
    }

    violations
}

/// 12. The overall name is valid precisely when no violations were recorded.
fn determine_folder_name_overall_validity(violations: &[String]) -> bool {
    violations.is_empty()
}

/// 13. Produce a best-effort sanitized version of the name that a client could
///     offer to the user as a replacement suggestion.
///
/// Forbidden characters, path-traversal dots, and control characters are dropped,
/// whitespace is re-normalized, and the result is truncated to the maximum length.
/// If nothing survives sanitization a stable fallback name is returned.
fn suggest_sanitized_folder_name(normalized_folder_name: &str) -> String {
    let stripped: String = normalized_folder_name
        .chars()
        .filter(|candidate_character| {
            !FORBIDDEN_FOLDER_NAME_CHARACTERS.contains(candidate_character)
                && !candidate_character.is_control()
                && *candidate_character != '.'
        })
        .collect();

    let renormalized = trim_and_normalize_proposed_folder_name(&stripped);

    let truncated: String = renormalized
        .chars()
        .take(MAXIMUM_FOLDER_NAME_LENGTH)
        .collect();

    let final_candidate = truncated.trim().to_string();

    if final_candidate.is_empty() || detect_folder_name_collides_with_canonical_folder(&final_candidate) {
        "untitled folder".to_string()
    } else {
        final_candidate
    }
}

/// 14. Assemble the JSON response body returned to the client.
fn build_folder_validation_payload(
    is_valid: bool,
    violations: Vec<String>,
    sanitized_suggestion: String,
) -> Value {
    json!({
        "valid": is_valid,
        "violations": violations,
        "sanitized_suggestion": sanitized_suggestion,
    })
}

/// 15. Translate a failure originating from the document collection into the
///     appropriate transport-level error.
fn map_document_collection_failure_to_http_error(originating_error: ApplicationError) -> HttpError {
    match originating_error {
        ApplicationError::AuthorizationWasDenied => HttpError::AuthorizationWasDenied {
            explanation: "the principal is not authorized to inspect this project's folders"
                .to_string(),
        },
        ApplicationError::RequestedResourceCouldNotBeLocated
        | ApplicationError::RequestedProjectCouldNotBeLocated => {
            HttpError::RequestedResourceWasNotFound {
                explanation: "the referenced project or folder could not be located".to_string(),
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

    #[test]
    fn extract_proposed_folder_name_field_reads_a_string() {
        let body = json!({ "folder_name": "Reports" });
        let extracted = extract_proposed_folder_name_field(&body).expect("string is valid");
        assert_eq!(extracted, "Reports");
    }

    #[test]
    fn extract_proposed_folder_name_field_rejects_missing_field() {
        let body = json!({ "other": 1 });
        assert!(extract_proposed_folder_name_field(&body).is_err());
    }

    #[test]
    fn extract_proposed_folder_name_field_rejects_non_string() {
        let body = json!({ "folder_name": 42 });
        assert!(extract_proposed_folder_name_field(&body).is_err());
    }

    #[test]
    fn extract_parent_project_identifier_field_reads_present_value() {
        let body = json!({ "parent_project_identifier": "  proj-1 " });
        assert_eq!(
            extract_parent_project_identifier_field(&body),
            Some("proj-1".to_string())
        );
    }

    #[test]
    fn extract_parent_project_identifier_field_ignores_missing_and_empty() {
        assert_eq!(extract_parent_project_identifier_field(&json!({})), None);
        let empty_body = json!({ "parent_project_identifier": "   " });
        assert_eq!(extract_parent_project_identifier_field(&empty_body), None);
    }

    #[test]
    fn trim_and_normalize_collapses_whitespace() {
        assert_eq!(
            trim_and_normalize_proposed_folder_name("  My   Folder  "),
            "My Folder"
        );
        assert_eq!(trim_and_normalize_proposed_folder_name("   "), "");
    }

    #[test]
    fn detect_proposed_folder_name_is_empty_distinguishes_cases() {
        assert!(detect_proposed_folder_name_is_empty(""));
        assert!(!detect_proposed_folder_name_is_empty("x"));
    }

    #[test]
    fn detect_folder_name_exceeds_maximum_length_checks_boundary() {
        let at_limit = "a".repeat(MAXIMUM_FOLDER_NAME_LENGTH);
        let over_limit = "a".repeat(MAXIMUM_FOLDER_NAME_LENGTH + 1);
        assert!(!detect_folder_name_exceeds_maximum_length(&at_limit));
        assert!(detect_folder_name_exceeds_maximum_length(&over_limit));
    }

    #[test]
    fn detect_folder_name_contains_forbidden_characters_flags_slash_and_control() {
        assert!(detect_folder_name_contains_forbidden_characters("a/b"));
        assert!(detect_folder_name_contains_forbidden_characters("a\tb"));
        assert!(!detect_folder_name_contains_forbidden_characters("Clean Name"));
    }

    #[test]
    fn detect_folder_name_contains_path_traversal_flags_dots() {
        assert!(detect_folder_name_contains_path_traversal(".."));
        assert!(detect_folder_name_contains_path_traversal("."));
        assert!(detect_folder_name_contains_path_traversal("a..b"));
        assert!(!detect_folder_name_contains_path_traversal("normal"));
    }

    #[test]
    fn detect_folder_name_collides_with_canonical_folder_is_case_insensitive() {
        assert!(detect_folder_name_collides_with_canonical_folder("Trash"));
        assert!(detect_folder_name_collides_with_canonical_folder("ROOT"));
        assert!(!detect_folder_name_collides_with_canonical_folder("Reports"));
    }

    #[test]
    fn build_canonical_reserved_folder_names_contains_expected_entries() {
        let reserved = build_canonical_reserved_folder_names();
        assert!(reserved.contains(&"root"));
        assert!(reserved.contains(&"trash"));
    }

    #[test]
    fn collect_folder_validation_violations_accumulates_multiple_problems() {
        let violations = collect_folder_validation_violations("a/b..");
        assert!(!violations.is_empty());
        assert!(violations.iter().any(|v| v.contains("forbidden")));
        assert!(violations.iter().any(|v| v.contains("parent directories")));
    }

    #[test]
    fn collect_folder_validation_violations_is_empty_for_clean_name() {
        let violations = collect_folder_validation_violations("Quarterly Reports");
        assert!(violations.is_empty());
    }

    #[test]
    fn collect_folder_validation_violations_short_circuits_on_empty() {
        let violations = collect_folder_validation_violations("");
        assert_eq!(violations.len(), 1);
    }

    #[test]
    fn determine_folder_name_overall_validity_matches_violation_presence() {
        assert!(determine_folder_name_overall_validity(&[]));
        assert!(!determine_folder_name_overall_validity(&["problem".to_string()]));
    }

    #[test]
    fn suggest_sanitized_folder_name_strips_bad_characters() {
        assert_eq!(suggest_sanitized_folder_name("a/b:c"), "abc");
        assert_eq!(suggest_sanitized_folder_name("../secret"), "secret");
    }

    #[test]
    fn suggest_sanitized_folder_name_falls_back_when_empty_or_reserved() {
        assert_eq!(suggest_sanitized_folder_name("////"), "untitled folder");
        assert_eq!(suggest_sanitized_folder_name("trash"), "untitled folder");
    }

    #[test]
    fn build_folder_validation_payload_produces_expected_shape() {
        let payload = build_folder_validation_payload(
            false,
            vec!["problem".to_string()],
            "suggestion".to_string(),
        );
        assert_eq!(payload["valid"], json!(false));
        assert_eq!(payload["violations"], json!(["problem"]));
        assert_eq!(payload["sanitized_suggestion"], json!("suggestion"));
    }

    #[test]
    fn map_document_collection_failure_to_http_error_maps_variants() {
        let denied = map_document_collection_failure_to_http_error(
            ApplicationError::AuthorizationWasDenied,
        );
        assert!(matches!(denied, HttpError::AuthorizationWasDenied { .. }));

        let missing = map_document_collection_failure_to_http_error(
            ApplicationError::RequestedResourceCouldNotBeLocated,
        );
        assert!(matches!(missing, HttpError::RequestedResourceWasNotFound { .. }));

        let generic = map_document_collection_failure_to_http_error(
            ApplicationError::DocumentCollectionFailure {
                failure_description: "boom".to_string(),
            },
        );
        assert!(matches!(generic, HttpError::UpstreamApplicationFailure { .. }));
    }
}
