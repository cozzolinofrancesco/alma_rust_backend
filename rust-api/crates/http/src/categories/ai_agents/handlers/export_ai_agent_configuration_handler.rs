use crate::categories::ai_agents::collections::AI_AGENT_EXPORTS_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::error::ApplicationError;
use alma_application::ports::document_collection::StoredDocument;
use alma_application::ports::storage::{StorageBlob, StorageObjectIdentifier};
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::ProjectName;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};
use uuid::Uuid;

/// Persists an AI agent configuration as a rendered Markdown export.
///
/// The request body is expected to carry a `configuration` object describing the
/// agent, together with a target `fileName` and `folderName`. The configuration
/// is rendered to Markdown, uploaded to the storage adapter as a blob, and a
/// pointer document is recorded in the exports collection so the export can be
/// located again later.
#[route(method = "POST", path = "/api/ai-agents/export")]
pub async fn export_ai_agent_configuration_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let agent_configuration_object = extract_agent_configuration_object_to_export(&submitted_body)?;
    let raw_export_file_name = extract_requested_export_file_name(&submitted_body)?;
    let raw_export_folder_name = extract_requested_export_folder_name(&submitted_body)?;

    let export_folder_name = parse_export_folder_name_into_project_name(raw_export_folder_name)?;
    let sanitized_export_file_name =
        sanitize_export_file_name_and_ensure_markdown_extension(raw_export_file_name);

    let serialized_markdown_document =
        serialize_agent_configuration_to_markdown_document(agent_configuration_object);
    let encoded_markdown_bytes =
        encode_markdown_document_into_storage_bytes(&serialized_markdown_document);

    let export_storage_blob = assemble_export_storage_blob(
        &export_folder_name,
        &sanitized_export_file_name,
        encoded_markdown_bytes,
    );

    let persisted_storage_identifier = application_state
        .storage_adapter
        .persist_blob(export_storage_blob)
        .await
        .map_err(map_storage_or_collection_failure_to_http_error)?;
    let persisted_storage_reference =
        extract_persisted_storage_reference(persisted_storage_identifier);

    let export_document_identifier = generate_export_document_identifier();
    let owning_account =
        resolve_owning_account_from_authorized_principal(authorized_request.authorized_principal().as_str());
    let export_persistence_body = assemble_export_persistence_body(
        &sanitized_export_file_name,
        &export_folder_name,
        &persisted_storage_reference,
    );
    let stored_export_document = assemble_stored_export_document(
        export_document_identifier.clone(),
        owning_account,
        export_persistence_body,
    );

    application_state
        .document_collection
        .insert_document(AI_AGENT_EXPORTS_COLLECTION_NAME, stored_export_document)
        .await
        .map_err(map_storage_or_collection_failure_to_http_error)?;

    let success_response_payload = assemble_export_success_response_payload(
        &export_document_identifier,
        &sanitized_export_file_name,
        &export_folder_name,
    );
    Ok(Json(success_response_payload))
}

/// (1) Borrow the `configuration` object that must be exported.
///
/// Accepts either an explicit `configuration` field or, as a convenience for
/// callers that submit the configuration directly at the top level, falls back
/// to the whole body when it is a JSON object.
fn extract_agent_configuration_object_to_export(
    submitted_body: &Value,
) -> Result<&Value, HttpError> {
    if let Some(configuration_value) = submitted_body.get("configuration") {
        if configuration_value.is_object() {
            return Ok(configuration_value);
        }
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: "field 'configuration' must be a JSON object".to_string(),
        });
    }
    if submitted_body.is_object() {
        return Ok(submitted_body);
    }
    Err(HttpError::RequestBodyWasMalformed {
        explanation: "request body must contain a 'configuration' object".to_string(),
    })
}

/// (2) Read the requested export file name from the body.
fn extract_requested_export_file_name(submitted_body: &Value) -> Result<String, HttpError> {
    let raw_value = submitted_body.get("fileName").and_then(Value::as_str).ok_or(
        HttpError::RequestBodyWasMalformed {
            explanation: "field 'fileName' is required and must be a string".to_string(),
        },
    )?;
    let trimmed_value = raw_value.trim();
    if trimmed_value.is_empty() {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: "field 'fileName' must not be blank".to_string(),
        });
    }
    Ok(trimmed_value.to_string())
}

/// (3) Read the requested export folder name from the body.
fn extract_requested_export_folder_name(submitted_body: &Value) -> Result<String, HttpError> {
    let raw_value = submitted_body
        .get("folderName")
        .and_then(Value::as_str)
        .ok_or(HttpError::RequestBodyWasMalformed {
            explanation: "field 'folderName' is required and must be a string".to_string(),
        })?;
    let trimmed_value = raw_value.trim();
    if trimmed_value.is_empty() {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: "field 'folderName' must not be blank".to_string(),
        });
    }
    Ok(trimmed_value.to_string())
}

/// (4) Validate the folder name as a domain `ProjectName`.
fn parse_export_folder_name_into_project_name(
    raw_export_folder_name: String,
) -> Result<ProjectName, HttpError> {
    ProjectName::parse(raw_export_folder_name).map_err(|domain_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: domain_error.to_string(),
        }
    })
}

/// (5) Normalize a file name to a filesystem-safe value with a `.md` extension.
///
/// Whitespace runs collapse to single underscores, characters outside a small
/// safe set are dropped, and a Markdown extension is appended when absent.
fn sanitize_export_file_name_and_ensure_markdown_extension(raw_export_file_name: String) -> String {
    let mut sanitized_characters = String::with_capacity(raw_export_file_name.len());
    let mut previous_was_underscore = false;
    for candidate_character in raw_export_file_name.trim().chars() {
        if candidate_character.is_ascii_alphanumeric()
            || candidate_character == '.'
            || candidate_character == '-'
        {
            sanitized_characters.push(candidate_character);
            previous_was_underscore = false;
        } else if candidate_character.is_whitespace()
            || candidate_character == '_'
            || candidate_character == '/'
            || candidate_character == '\\'
        {
            if !previous_was_underscore {
                sanitized_characters.push('_');
                previous_was_underscore = true;
            }
        }
    }

    let trimmed_core = sanitized_characters.trim_matches('_').to_string();
    let base_name = if trimmed_core.is_empty() {
        "export".to_string()
    } else {
        trimmed_core
    };

    if base_name.to_ascii_lowercase().ends_with(".md") {
        base_name
    } else {
        format!("{base_name}.md")
    }
}

/// (6) Render the configuration object into a human-readable Markdown document.
fn serialize_agent_configuration_to_markdown_document(agent_configuration_object: &Value) -> String {
    let mut rendered_document = String::new();
    rendered_document.push_str("# AI Agent Configuration Export\n\n");

    if let Some(configuration_fields) = agent_configuration_object.as_object() {
        if configuration_fields.is_empty() {
            rendered_document.push_str("_No configuration fields were provided._\n");
            return rendered_document;
        }
        for (field_key, field_value) in configuration_fields {
            rendered_document.push_str("## ");
            rendered_document.push_str(field_key);
            rendered_document.push_str("\n\n");
            rendered_document.push_str(&render_configuration_value_as_markdown(field_value));
            rendered_document.push_str("\n\n");
        }
    } else {
        rendered_document.push_str(&render_configuration_value_as_markdown(
            agent_configuration_object,
        ));
        rendered_document.push('\n');
    }

    rendered_document
}

/// Helper for (6): render a single JSON value as a Markdown fragment.
fn render_configuration_value_as_markdown(field_value: &Value) -> String {
    match field_value {
        Value::String(text_value) => text_value.clone(),
        Value::Bool(boolean_value) => boolean_value.to_string(),
        Value::Number(numeric_value) => numeric_value.to_string(),
        Value::Null => "_null_".to_string(),
        Value::Array(array_items) => {
            if array_items.is_empty() {
                return "_empty list_".to_string();
            }
            let mut rendered_list = String::new();
            for array_item in array_items {
                rendered_list.push_str("- ");
                rendered_list.push_str(&render_scalar_value_inline(array_item));
                rendered_list.push('\n');
            }
            rendered_list.trim_end().to_string()
        }
        Value::Object(_) => {
            let pretty_printed = serde_json::to_string_pretty(field_value)
                .unwrap_or_else(|_| field_value.to_string());
            format!("```json\n{pretty_printed}\n```")
        }
    }
}

/// Helper for (6): render a scalar (or compact) value for inline list usage.
fn render_scalar_value_inline(field_value: &Value) -> String {
    match field_value {
        Value::String(text_value) => text_value.clone(),
        Value::Bool(boolean_value) => boolean_value.to_string(),
        Value::Number(numeric_value) => numeric_value.to_string(),
        Value::Null => "_null_".to_string(),
        other_value => other_value.to_string(),
    }
}

/// (7) Encode a rendered Markdown document into raw storage bytes.
fn encode_markdown_document_into_storage_bytes(serialized_markdown_document: &str) -> Vec<u8> {
    serialized_markdown_document.as_bytes().to_vec()
}

/// (8) Assemble the blob descriptor that will be handed to the storage adapter.
fn assemble_export_storage_blob(
    export_folder_name: &ProjectName,
    sanitized_export_file_name: &str,
    encoded_markdown_bytes: Vec<u8>,
) -> StorageBlob {
    StorageBlob {
        containing_folder: export_folder_name.as_str().to_string(),
        declared_name: sanitized_export_file_name.to_string(),
        raw_bytes: encoded_markdown_bytes,
    }
}

/// (9) Unwrap the opaque storage reference produced by a successful upload.
fn extract_persisted_storage_reference(
    storage_object_identifier: StorageObjectIdentifier,
) -> String {
    storage_object_identifier.opaque_reference
}

/// (10) Generate a fresh identifier for the export pointer document.
fn generate_export_document_identifier() -> String {
    Uuid::new_v4().to_string()
}

/// (11) Derive the owning account string from the authorized principal.
fn resolve_owning_account_from_authorized_principal(authorized_principal: &str) -> String {
    authorized_principal.trim().to_string()
}

/// (12) Build the JSON body persisted alongside the export pointer document.
fn assemble_export_persistence_body(
    sanitized_export_file_name: &str,
    export_folder_name: &ProjectName,
    persisted_storage_reference: &str,
) -> Value {
    json!({
        "fileName": sanitized_export_file_name,
        "folderName": export_folder_name.as_str(),
        "storageReference": persisted_storage_reference,
    })
}

/// (13) Wrap the export pointer body into a `StoredDocument` for the collection.
fn assemble_stored_export_document(
    export_document_identifier: String,
    owning_account: String,
    export_persistence_body: Value,
) -> StoredDocument {
    StoredDocument {
        document_identifier: export_document_identifier,
        owning_account: Some(owning_account),
        document_body: export_persistence_body,
    }
}

/// (14) Translate an application-layer failure into an HTTP error.
fn map_storage_or_collection_failure_to_http_error(
    originating_application_error: ApplicationError,
) -> HttpError {
    match originating_application_error {
        ApplicationError::RequestedProjectCouldNotBeLocated
        | ApplicationError::RequestedResourceCouldNotBeLocated => {
            HttpError::RequestedResourceWasNotFound {
                explanation: "the requested export resource could not be located".to_string(),
            }
        }
        ApplicationError::AuthorizationWasDenied => HttpError::AuthorizationWasDenied {
            explanation: "the export operation was not authorized".to_string(),
        },
        ApplicationError::DomainInvariantViolated(domain_error) => {
            HttpError::RequestBodyWasMalformed {
                explanation: domain_error.to_string(),
            }
        }
        other_failure => HttpError::UpstreamApplicationFailure {
            explanation: other_failure.to_string(),
        },
    }
}

/// (15) Build the JSON payload returned to the client on a successful export.
fn assemble_export_success_response_payload(
    export_document_identifier: &str,
    sanitized_export_file_name: &str,
    export_folder_name: &ProjectName,
) -> Value {
    json!({
        "success": true,
        "documentId": export_document_identifier,
        "fileName": sanitized_export_file_name,
        "folderName": export_folder_name.as_str(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_agent_configuration_object_accepts_explicit_field() {
        let body = json!({ "configuration": { "name": "Researcher" } });
        let extracted = extract_agent_configuration_object_to_export(&body).unwrap();
        assert_eq!(extracted, &json!({ "name": "Researcher" }));
    }

    #[test]
    fn extract_agent_configuration_object_falls_back_to_body() {
        let body = json!({ "name": "Researcher", "role": "analysis" });
        let extracted = extract_agent_configuration_object_to_export(&body).unwrap();
        assert_eq!(extracted, &body);
    }

    #[test]
    fn extract_agent_configuration_object_rejects_non_object_configuration() {
        let body = json!({ "configuration": "not-an-object" });
        assert!(extract_agent_configuration_object_to_export(&body).is_err());
    }

    #[test]
    fn extract_agent_configuration_object_rejects_scalar_body() {
        let body = json!("plain string");
        assert!(extract_agent_configuration_object_to_export(&body).is_err());
    }

    #[test]
    fn extract_requested_export_file_name_reads_and_trims() {
        let body = json!({ "fileName": "  Analysis.md  " });
        assert_eq!(
            extract_requested_export_file_name(&body).unwrap(),
            "Analysis.md"
        );
    }

    #[test]
    fn extract_requested_export_file_name_rejects_missing_and_blank() {
        assert!(extract_requested_export_file_name(&json!({})).is_err());
        assert!(extract_requested_export_file_name(&json!({ "fileName": "   " })).is_err());
    }

    #[test]
    fn extract_requested_export_folder_name_reads_and_trims() {
        let body = json!({ "folderName": " Analysis " });
        assert_eq!(
            extract_requested_export_folder_name(&body).unwrap(),
            "Analysis"
        );
    }

    #[test]
    fn extract_requested_export_folder_name_rejects_missing_and_blank() {
        assert!(extract_requested_export_folder_name(&json!({})).is_err());
        assert!(extract_requested_export_folder_name(&json!({ "folderName": "" })).is_err());
    }

    #[test]
    fn parse_export_folder_name_accepts_valid_and_rejects_empty() {
        let parsed = parse_export_folder_name_into_project_name("Analysis".to_string()).unwrap();
        assert_eq!(parsed.as_str(), "Analysis");
        assert!(parse_export_folder_name_into_project_name("   ".to_string()).is_err());
    }

    #[test]
    fn sanitize_export_file_name_ensures_markdown_and_replaces_whitespace() {
        assert_eq!(
            sanitize_export_file_name_and_ensure_markdown_extension("My Report".to_string()),
            "My_Report.md"
        );
        assert_eq!(
            sanitize_export_file_name_and_ensure_markdown_extension("already.md".to_string()),
            "already.md"
        );
    }

    #[test]
    fn sanitize_export_file_name_strips_unsafe_characters_and_defaults() {
        assert_eq!(
            sanitize_export_file_name_and_ensure_markdown_extension("a/b\\c!!.md".to_string()),
            "a_b_c.md"
        );
        assert_eq!(
            sanitize_export_file_name_and_ensure_markdown_extension("***".to_string()),
            "export.md"
        );
    }

    #[test]
    fn serialize_agent_configuration_renders_fields_as_sections() {
        let configuration = json!({
            "name": "Researcher",
            "enabled": true,
            "tags": ["a", "b"],
        });
        let rendered = serialize_agent_configuration_to_markdown_document(&configuration);
        assert!(rendered.contains("# AI Agent Configuration Export"));
        assert!(rendered.contains("## name"));
        assert!(rendered.contains("Researcher"));
        assert!(rendered.contains("## enabled"));
        assert!(rendered.contains("true"));
        assert!(rendered.contains("- a"));
    }

    #[test]
    fn serialize_agent_configuration_handles_empty_object() {
        let rendered = serialize_agent_configuration_to_markdown_document(&json!({}));
        assert!(rendered.contains("_No configuration fields were provided._"));
    }

    #[test]
    fn serialize_agent_configuration_handles_nested_object_as_json_block() {
        let configuration = json!({ "nested": { "inner": 1 } });
        let rendered = serialize_agent_configuration_to_markdown_document(&configuration);
        assert!(rendered.contains("```json"));
        assert!(rendered.contains("\"inner\": 1"));
    }

    #[test]
    fn encode_markdown_document_into_storage_bytes_round_trips() {
        let document = "# Title\ncontent";
        let encoded = encode_markdown_document_into_storage_bytes(document);
        assert_eq!(String::from_utf8(encoded).unwrap(), document);
    }

    #[test]
    fn assemble_export_storage_blob_sets_expected_fields() {
        let folder = ProjectName::parse("Analysis".to_string()).unwrap();
        let blob = assemble_export_storage_blob(&folder, "report.md", vec![1, 2, 3]);
        assert_eq!(blob.containing_folder, "Analysis");
        assert_eq!(blob.declared_name, "report.md");
        assert_eq!(blob.raw_bytes, vec![1, 2, 3]);
    }

    #[test]
    fn extract_persisted_storage_reference_unwraps_opaque_value() {
        let identifier = StorageObjectIdentifier {
            opaque_reference: "abc-123".to_string(),
        };
        assert_eq!(extract_persisted_storage_reference(identifier), "abc-123");
    }

    #[test]
    fn generate_export_document_identifier_produces_unique_values() {
        let first = generate_export_document_identifier();
        let second = generate_export_document_identifier();
        assert_ne!(first, second);
        assert!(!first.is_empty());
    }

    #[test]
    fn resolve_owning_account_trims_principal() {
        assert_eq!(
            resolve_owning_account_from_authorized_principal("  user@example.com  "),
            "user@example.com"
        );
    }

    #[test]
    fn assemble_export_persistence_body_carries_all_fields() {
        let folder = ProjectName::parse("Analysis".to_string()).unwrap();
        let body = assemble_export_persistence_body("report.md", &folder, "ref-1");
        assert_eq!(body["fileName"], json!("report.md"));
        assert_eq!(body["folderName"], json!("Analysis"));
        assert_eq!(body["storageReference"], json!("ref-1"));
    }

    #[test]
    fn assemble_stored_export_document_wraps_body_with_owner() {
        let document = assemble_stored_export_document(
            "doc-1".to_string(),
            "user@example.com".to_string(),
            json!({ "k": "v" }),
        );
        assert_eq!(document.document_identifier, "doc-1");
        assert_eq!(document.owning_account, Some("user@example.com".to_string()));
        assert_eq!(document.document_body, json!({ "k": "v" }));
    }

    #[test]
    fn map_storage_or_collection_failure_maps_not_found() {
        let mapped = map_storage_or_collection_failure_to_http_error(
            ApplicationError::RequestedResourceCouldNotBeLocated,
        );
        assert!(matches!(
            mapped,
            HttpError::RequestedResourceWasNotFound { .. }
        ));
    }

    #[test]
    fn map_storage_or_collection_failure_maps_denied_and_upstream() {
        let denied = map_storage_or_collection_failure_to_http_error(
            ApplicationError::AuthorizationWasDenied,
        );
        assert!(matches!(denied, HttpError::AuthorizationWasDenied { .. }));

        let upstream = map_storage_or_collection_failure_to_http_error(
            ApplicationError::StorageAdapterFailure {
                failure_description: "disk full".to_string(),
            },
        );
        assert!(matches!(
            upstream,
            HttpError::UpstreamApplicationFailure { .. }
        ));
    }

    #[test]
    fn assemble_export_success_response_payload_includes_fields() {
        let folder = ProjectName::parse("Analysis".to_string()).unwrap();
        let payload = assemble_export_success_response_payload("doc-1", "report.md", &folder);
        assert_eq!(payload["success"], json!(true));
        assert_eq!(payload["documentId"], json!("doc-1"));
        assert_eq!(payload["fileName"], json!("report.md"));
        assert_eq!(payload["folderName"], json!("Analysis"));
    }
}
