use crate::categories::projects_files::collections::SAVED_PROJECTS_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::error::ApplicationError;
use alma_application::ports::document_collection::StoredDocument;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_macros::route;
use axum::Json;
use axum::extract::{Query, State};
use serde_json::{Value, json};
use std::collections::HashMap;

/// Loads a previously persisted AI 3D-generation project by its identifier.
///
/// The stored document body carries the free-form project payload as written by
/// the browser canvas. This handler reads that document, defensively normalizes
/// the pieces the frontend depends on (name, version, canvas settings, and the
/// ordered list of generation entries) and returns a stable success envelope.
#[route(method = "GET", path = "/api/load-ai3d-project")]
pub async fn load_ai3d_project_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Query(query_parameters): Query<HashMap<String, String>>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let requested_identifier = extract_requested_identifier_from_query(&query_parameters)?;
    validate_ai3d_project_identifier(&requested_identifier)?;

    let optionally_located_document =
        fetch_ai3d_project_document(&application_state, &requested_identifier).await?;
    let located_document = require_located_ai3d_project(optionally_located_document)?;

    let project_name = extract_ai3d_project_name(&located_document);
    let current_version = extract_ai3d_current_version(&located_document);
    let created_timestamp = extract_ai3d_created_timestamp(&located_document);
    let canvas_settings = extract_ai3d_canvas_settings_object(&located_document);
    let generation_entries = extract_ai3d_generation_entries_array(&located_document);

    let project_data = assemble_ai3d_project_data_object(
        &project_name,
        &current_version,
        &created_timestamp,
        canvas_settings,
        generation_entries,
    );
    let success_payload = build_ai3d_load_success_payload(project_data);
    Ok(Json(success_payload))
}

/// (1) Pulls the mandatory `identifier` query parameter, trimming surrounding
/// whitespace. A missing or blank value is a malformed request.
fn extract_requested_identifier_from_query(
    query_parameters: &HashMap<String, String>,
) -> Result<String, HttpError> {
    match query_parameters.get("identifier") {
        Some(raw_identifier) => {
            let trimmed = raw_identifier.trim();
            if trimmed.is_empty() {
                Err(HttpError::RequestBodyWasMalformed {
                    explanation: String::from(
                        "the 'identifier' query parameter must not be empty",
                    ),
                })
            } else {
                Ok(trimmed.to_string())
            }
        }
        None => Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from("the 'identifier' query parameter is required"),
        }),
    }
}

/// (2) Guards against identifiers that could not correspond to a real stored
/// document: they must be a bounded length and free of path/control characters.
fn validate_ai3d_project_identifier(raw_identifier: &str) -> Result<(), HttpError> {
    const MAXIMUM_IDENTIFIER_LENGTH: usize = 256;

    if raw_identifier.is_empty() {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from("the project identifier must not be empty"),
        });
    }
    if raw_identifier.len() > MAXIMUM_IDENTIFIER_LENGTH {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "the project identifier must not exceed {MAXIMUM_IDENTIFIER_LENGTH} characters"
            ),
        });
    }
    let contains_forbidden_character = raw_identifier
        .chars()
        .any(|candidate| candidate.is_control() || candidate == '/' || candidate == '\\');
    if contains_forbidden_character {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from(
                "the project identifier must not contain path separators or control characters",
            ),
        });
    }
    Ok(())
}

/// (3) Fetches the raw stored document from the saved-projects collection.
/// Any document-collection failure is translated into an HTTP error.
fn fetch_ai3d_project_document<'a, TransactionalUnitOfWork: UnitOfWork>(
    application_state: &'a ApplicationState<TransactionalUnitOfWork>,
    requested_identifier: &'a str,
) -> impl std::future::Future<Output = Result<Option<StoredDocument>, HttpError>> + 'a {
    async move {
        application_state
            .document_collection
            .fetch_document(SAVED_PROJECTS_COLLECTION_NAME, requested_identifier)
            .await
            .map_err(map_document_collection_failure_to_http_error)
    }
}

/// (4) Turns an absent lookup result into a not-found HTTP error.
fn require_located_ai3d_project(
    optionally_located: Option<StoredDocument>,
) -> Result<StoredDocument, HttpError> {
    optionally_located.ok_or_else(|| HttpError::RequestedResourceWasNotFound {
        explanation: String::from("the requested AI 3D project could not be located"),
    })
}

/// (5) Reads the human-readable project name, falling back to a stable default
/// when the stored body omits or malforms it.
fn extract_ai3d_project_name(located_document: &StoredDocument) -> String {
    read_string_field_or(&located_document.document_body, "projectName", "Untitled 3D Project")
}

/// (6) Reads the semantic version string tracked with the project.
fn extract_ai3d_current_version(located_document: &StoredDocument) -> String {
    read_string_field_or(&located_document.document_body, "currentVersion", "1.0.0.0")
}

/// (7) Reads the canvas settings object, normalizing it against the default
/// shape so every known key is always present with the correct type.
fn extract_ai3d_canvas_settings_object(located_document: &StoredDocument) -> Value {
    let raw_settings = located_document.document_body.get("settings");
    normalize_ai3d_canvas_settings(raw_settings)
}

/// (8) Reads the ordered generation-entry list and normalizes each element.
/// A missing or non-array field yields an empty list rather than an error.
fn extract_ai3d_generation_entries_array(located_document: &StoredDocument) -> Vec<Value> {
    match located_document.document_body.get("entries") {
        Some(Value::Array(raw_entries)) => raw_entries
            .iter()
            .map(normalize_ai3d_generation_entry)
            .collect(),
        _ => Vec::new(),
    }
}

/// (9) Coerces a single raw generation entry into the canonical shape the
/// frontend expects: a prompt string, a chat-response string, and a normalized
/// settings object.
fn normalize_ai3d_generation_entry(raw_entry: &Value) -> Value {
    let prompt = read_string_field_or(raw_entry, "prompt", "");
    let chat_response = read_string_field_or(raw_entry, "chatResponse", "");
    let settings = normalize_ai3d_canvas_settings(raw_entry.get("settings"));
    json!({
        "prompt": prompt,
        "chatResponse": chat_response,
        "settings": settings,
    })
}

/// (10) The canonical default canvas settings used whenever the stored value is
/// missing or partially malformed.
fn build_default_ai3d_canvas_settings() -> Value {
    json!({
        "width": 512,
        "height": 512,
        "zoom": 1,
        "color": "#ffffff",
        "includeSettings": false,
    })
}

/// (11) Counts the normalized generation entries. Kept as a discrete helper so
/// the count returned to the client stays consistent with the entries emitted.
fn count_ai3d_generation_entries(generation_entries: &[Value]) -> usize {
    generation_entries.len()
}

/// (12) Reads the creation timestamp, falling back to a fixed epoch marker so
/// downstream date parsing never receives a null.
fn extract_ai3d_created_timestamp(located_document: &StoredDocument) -> String {
    read_string_field_or(
        &located_document.document_body,
        "createdAt",
        "1970-01-01T00:00:00.000Z",
    )
}

/// (13) Assembles the outward-facing `projectData` object from the already
/// normalized pieces, embedding the derived entry count.
fn assemble_ai3d_project_data_object(
    project_name: &str,
    current_version: &str,
    created_timestamp: &str,
    canvas_settings: Value,
    generation_entries: Vec<Value>,
) -> Value {
    let entry_count = count_ai3d_generation_entries(&generation_entries);
    json!({
        "projectName": project_name,
        "currentVersion": current_version,
        "createdAt": created_timestamp,
        "settings": canvas_settings,
        "entries": generation_entries,
        "entryCount": entry_count,
    })
}

/// (14) Wraps the project data in the standard success envelope.
fn build_ai3d_load_success_payload(project_data: Value) -> Value {
    json!({
        "success": true,
        "projectData": project_data,
    })
}

/// (15) Maps a document-collection ApplicationError onto an HttpError. Not-found
/// style failures become 404s; everything else is an upstream failure.
fn map_document_collection_failure_to_http_error(originating_error: ApplicationError) -> HttpError {
    match originating_error {
        ApplicationError::RequestedProjectCouldNotBeLocated
        | ApplicationError::RequestedResourceCouldNotBeLocated => {
            HttpError::RequestedResourceWasNotFound {
                explanation: originating_error.to_string(),
            }
        }
        ApplicationError::AuthorizationWasDenied => HttpError::AuthorizationWasDenied {
            explanation: originating_error.to_string(),
        },
        other_error => HttpError::UpstreamApplicationFailure {
            explanation: other_error.to_string(),
        },
    }
}

// ---------------------------------------------------------------------------
// Internal pure utilities (shared by several extractors above).
// ---------------------------------------------------------------------------

/// Reads a string field from a JSON object, falling back to a default when the
/// field is absent or is not a JSON string.
fn read_string_field_or(source: &Value, field_name: &str, default_value: &str) -> String {
    source
        .get(field_name)
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| default_value.to_string())
}

/// Normalizes a raw canvas-settings value against the default shape. Each known
/// key is taken from the raw object when present with a sensible type, otherwise
/// the default is used.
fn normalize_ai3d_canvas_settings(raw_settings: Option<&Value>) -> Value {
    let default_settings = build_default_ai3d_canvas_settings();
    let raw_object = match raw_settings {
        Some(Value::Object(map)) => map,
        _ => return default_settings,
    };

    let width = read_number_field_or(raw_object.get("width"), 512);
    let height = read_number_field_or(raw_object.get("height"), 512);
    let zoom = read_number_field_or(raw_object.get("zoom"), 1);
    let color = raw_object
        .get("color")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| String::from("#ffffff"));
    let include_settings = raw_object
        .get("includeSettings")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    json!({
        "width": width,
        "height": height,
        "zoom": zoom,
        "color": color,
        "includeSettings": include_settings,
    })
}

/// Reads an integer-valued number field, tolerating both integer and float JSON
/// numbers, falling back to a default otherwise.
fn read_number_field_or(raw_field: Option<&Value>, default_value: i64) -> i64 {
    match raw_field {
        Some(value) => value
            .as_i64()
            .or_else(|| value.as_f64().map(|floating| floating as i64))
            .unwrap_or(default_value),
        None => default_value,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document_from_body(body: Value) -> StoredDocument {
        StoredDocument {
            document_identifier: String::from("ai3d-1"),
            owning_account: Some(String::from("owner@example.com")),
            document_body: body,
        }
    }

    #[test]
    fn extract_requested_identifier_from_query_reads_and_trims_value() {
        let mut parameters = HashMap::new();
        parameters.insert(String::from("identifier"), String::from("  proj-42  "));
        let extracted = extract_requested_identifier_from_query(&parameters).unwrap();
        assert_eq!(extracted, "proj-42");
    }

    #[test]
    fn extract_requested_identifier_from_query_rejects_missing_and_blank() {
        let empty_parameters: HashMap<String, String> = HashMap::new();
        assert!(extract_requested_identifier_from_query(&empty_parameters).is_err());

        let mut blank_parameters = HashMap::new();
        blank_parameters.insert(String::from("identifier"), String::from("   "));
        assert!(extract_requested_identifier_from_query(&blank_parameters).is_err());
    }

    #[test]
    fn validate_ai3d_project_identifier_accepts_reasonable_values() {
        assert!(validate_ai3d_project_identifier("bracket-v3").is_ok());
        assert!(validate_ai3d_project_identifier("abc_123-XYZ").is_ok());
    }

    #[test]
    fn validate_ai3d_project_identifier_rejects_bad_values() {
        assert!(validate_ai3d_project_identifier("").is_err());
        assert!(validate_ai3d_project_identifier("has/slash").is_err());
        assert!(validate_ai3d_project_identifier("back\\slash").is_err());
        assert!(validate_ai3d_project_identifier("line\nbreak").is_err());
        let overly_long = "x".repeat(257);
        assert!(validate_ai3d_project_identifier(&overly_long).is_err());
    }

    #[test]
    fn require_located_ai3d_project_maps_presence_and_absence() {
        let present = document_from_body(json!({}));
        assert!(require_located_ai3d_project(Some(present)).is_ok());
        assert!(require_located_ai3d_project(None).is_err());
    }

    #[test]
    fn extract_ai3d_project_name_reads_value_or_default() {
        let named = document_from_body(json!({ "projectName": "Lattice Bracket" }));
        assert_eq!(extract_ai3d_project_name(&named), "Lattice Bracket");

        let unnamed = document_from_body(json!({ "projectName": 42 }));
        assert_eq!(extract_ai3d_project_name(&unnamed), "Untitled 3D Project");
    }

    #[test]
    fn extract_ai3d_current_version_reads_value_or_default() {
        let versioned = document_from_body(json!({ "currentVersion": "1.2.3.4" }));
        assert_eq!(extract_ai3d_current_version(&versioned), "1.2.3.4");

        let missing = document_from_body(json!({}));
        assert_eq!(extract_ai3d_current_version(&missing), "1.0.0.0");
    }

    #[test]
    fn extract_ai3d_canvas_settings_object_normalizes_and_defaults() {
        let custom = document_from_body(json!({
            "settings": { "width": 1024, "height": 768, "zoom": 2, "color": "#000000", "includeSettings": true }
        }));
        let normalized = extract_ai3d_canvas_settings_object(&custom);
        assert_eq!(normalized["width"], json!(1024));
        assert_eq!(normalized["color"], json!("#000000"));
        assert_eq!(normalized["includeSettings"], json!(true));

        let missing = document_from_body(json!({}));
        let defaulted = extract_ai3d_canvas_settings_object(&missing);
        assert_eq!(defaulted, build_default_ai3d_canvas_settings());
    }

    #[test]
    fn extract_ai3d_generation_entries_array_normalizes_each_and_handles_missing() {
        let with_entries = document_from_body(json!({
            "entries": [
                { "prompt": "make a bracket", "chatResponse": "done", "settings": { "zoom": 3 } },
                { "prompt": "reinforce" }
            ]
        }));
        let entries = extract_ai3d_generation_entries_array(&with_entries);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["prompt"], json!("make a bracket"));
        assert_eq!(entries[0]["chatResponse"], json!("done"));
        assert_eq!(entries[0]["settings"]["zoom"], json!(3));
        assert_eq!(entries[1]["prompt"], json!("reinforce"));
        assert_eq!(entries[1]["chatResponse"], json!(""));

        let missing = document_from_body(json!({ "entries": "not-an-array" }));
        assert!(extract_ai3d_generation_entries_array(&missing).is_empty());
    }

    #[test]
    fn normalize_ai3d_generation_entry_fills_defaults() {
        let normalized = normalize_ai3d_generation_entry(&json!({}));
        assert_eq!(normalized["prompt"], json!(""));
        assert_eq!(normalized["chatResponse"], json!(""));
        assert_eq!(normalized["settings"], build_default_ai3d_canvas_settings());

        let bad = normalize_ai3d_generation_entry(&json!({ "prompt": 5, "chatResponse": true }));
        assert_eq!(bad["prompt"], json!(""));
        assert_eq!(bad["chatResponse"], json!(""));
    }

    #[test]
    fn build_default_ai3d_canvas_settings_has_expected_shape() {
        let defaults = build_default_ai3d_canvas_settings();
        assert_eq!(defaults["width"], json!(512));
        assert_eq!(defaults["height"], json!(512));
        assert_eq!(defaults["zoom"], json!(1));
        assert_eq!(defaults["color"], json!("#ffffff"));
        assert_eq!(defaults["includeSettings"], json!(false));
    }

    #[test]
    fn count_ai3d_generation_entries_counts_correctly() {
        assert_eq!(count_ai3d_generation_entries(&[]), 0);
        assert_eq!(
            count_ai3d_generation_entries(&[json!({}), json!({}), json!({})]),
            3
        );
    }

    #[test]
    fn extract_ai3d_created_timestamp_reads_value_or_default() {
        let stamped = document_from_body(json!({ "createdAt": "2026-05-01T10:00:00.000Z" }));
        assert_eq!(
            extract_ai3d_created_timestamp(&stamped),
            "2026-05-01T10:00:00.000Z"
        );

        let missing = document_from_body(json!({}));
        assert_eq!(
            extract_ai3d_created_timestamp(&missing),
            "1970-01-01T00:00:00.000Z"
        );
    }

    #[test]
    fn assemble_ai3d_project_data_object_embeds_all_pieces() {
        let entries = vec![json!({ "prompt": "a" }), json!({ "prompt": "b" })];
        let settings = build_default_ai3d_canvas_settings();
        let assembled = assemble_ai3d_project_data_object(
            "My Project",
            "1.0.0.5",
            "2026-05-01T10:00:00.000Z",
            settings,
            entries,
        );
        assert_eq!(assembled["projectName"], json!("My Project"));
        assert_eq!(assembled["currentVersion"], json!("1.0.0.5"));
        assert_eq!(assembled["createdAt"], json!("2026-05-01T10:00:00.000Z"));
        assert_eq!(assembled["entryCount"], json!(2));
        assert_eq!(assembled["entries"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn build_ai3d_load_success_payload_wraps_project_data() {
        let payload = build_ai3d_load_success_payload(json!({ "projectName": "X" }));
        assert_eq!(payload["success"], json!(true));
        assert_eq!(payload["projectData"]["projectName"], json!("X"));
    }

    #[test]
    fn map_document_collection_failure_to_http_error_distinguishes_variants() {
        let not_found = map_document_collection_failure_to_http_error(
            ApplicationError::RequestedResourceCouldNotBeLocated,
        );
        assert!(matches!(
            not_found,
            HttpError::RequestedResourceWasNotFound { .. }
        ));

        let denied = map_document_collection_failure_to_http_error(
            ApplicationError::AuthorizationWasDenied,
        );
        assert!(matches!(denied, HttpError::AuthorizationWasDenied { .. }));

        let upstream = map_document_collection_failure_to_http_error(
            ApplicationError::DocumentCollectionFailure {
                failure_description: String::from("boom"),
            },
        );
        assert!(matches!(
            upstream,
            HttpError::UpstreamApplicationFailure { .. }
        ));
    }

    #[test]
    fn read_number_field_or_tolerates_integers_floats_and_missing() {
        assert_eq!(read_number_field_or(Some(&json!(1024)), 512), 1024);
        assert_eq!(read_number_field_or(Some(&json!(2.9)), 512), 2);
        assert_eq!(read_number_field_or(Some(&json!("bad")), 512), 512);
        assert_eq!(read_number_field_or(None, 512), 512);
    }
}
