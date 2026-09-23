use crate::categories::ai_agents::collections::AI_AGENT_REPORTS_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::error::ApplicationError;
use alma_application::ports::ai::GeneratedCompletion;
use alma_application::ports::document_collection::StoredDocument;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::NonEmptyText;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};
use std::collections::HashSet;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
//
// Accepts a report-agent configuration (a display name plus an ordered array of
// "layers", each of which may reference the identifiers of earlier layers),
// validates its internal consistency, asks the AI adapter to produce a report
// markdown body from the configuration, persists the resulting report document,
// and returns a response describing the created report.

#[route(method = "POST", path = "/api/ai-agents/report-creation")]
pub async fn create_ai_agent_report_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // 1. Locate and validate the configuration object.
    let report_configuration_object =
        extract_report_configuration_object_from_submitted_body(&submitted_body)?;

    // 2. Extract & parse the display name.
    let raw_report_display_name = extract_report_display_name_field(report_configuration_object)?;
    let report_display_name =
        parse_report_display_name_into_non_empty_text(raw_report_display_name)?;

    // 3. Extract & validate the layer array.
    let report_layer_array = extract_report_layer_array_from_configuration(report_configuration_object)?;
    ensure_report_layer_array_is_not_empty(report_layer_array)?;

    // 4. Cross-layer referential integrity: every referenced step must exist.
    let referenced_step_identifiers =
        collect_referenced_step_identifiers_across_layers(report_layer_array);
    validate_every_referenced_step_identifier_exists(
        report_layer_array,
        &referenced_step_identifiers,
    )?;

    // 5. Build the completion prompt and ask the AI adapter to produce the report.
    let report_creation_prompt =
        build_report_creation_prompt_from_layers(&report_display_name, report_layer_array);
    let generated_completion = application_state
        .artificial_intelligence_adapter
        .generate_completion(&report_creation_prompt)
        .await?;
    let produced_report_markdown =
        extract_produced_report_markdown_from_completion(generated_completion);

    // 6. Persist the report document.
    let report_document_identifier = generate_report_document_identifier();
    let owning_account =
        resolve_owning_account_from_authorized_principal(authorized_request.authorized_principal().as_str());
    let report_persistence_body = assemble_report_persistence_body(
        &report_document_identifier,
        &report_display_name,
        &produced_report_markdown,
        report_layer_array,
    );
    let stored_report_document = assemble_stored_report_document(
        report_document_identifier.clone(),
        owning_account,
        report_persistence_body,
    );

    application_state
        .document_collection
        .insert_document(AI_AGENT_REPORTS_COLLECTION_NAME, stored_report_document)
        .await
        .map_err(map_document_collection_failure_to_http_error)?;

    // 7. Build the success response payload.
    let response_payload = assemble_created_report_response_payload(
        &report_document_identifier,
        &report_display_name,
        report_layer_array,
    );

    Ok(Json(response_payload))
}

// ---------------------------------------------------------------------------
// 1. Extract the configuration object
// ---------------------------------------------------------------------------
//
// The configuration may be supplied either directly at the top level of the
// request body or nested under a `configuration` key. Either way it must be a
// JSON object.
fn extract_report_configuration_object_from_submitted_body(
    submitted_body: &Value,
) -> Result<&Value, HttpError> {
    let candidate = submitted_body
        .get("configuration")
        .unwrap_or(submitted_body);

    if candidate.is_object() {
        Ok(candidate)
    } else {
        Err(HttpError::RequestBodyWasMalformed {
            explanation: "the report configuration must be a JSON object".to_string(),
        })
    }
}

// ---------------------------------------------------------------------------
// 2. Extract the display name field
// ---------------------------------------------------------------------------
fn extract_report_display_name_field(
    report_configuration_object: &Value,
) -> Result<String, HttpError> {
    report_configuration_object
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: "the report configuration is missing a string `name` field".to_string(),
        })
}

// ---------------------------------------------------------------------------
// 3. Parse the display name into a NonEmptyText
// ---------------------------------------------------------------------------
fn parse_report_display_name_into_non_empty_text(
    raw_report_display_name: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(raw_report_display_name).map_err(|error| {
        HttpError::RequestBodyWasMalformed {
            explanation: format!("the report display name is invalid: {error}"),
        }
    })
}

// ---------------------------------------------------------------------------
// 4. Extract the layer array
// ---------------------------------------------------------------------------
fn extract_report_layer_array_from_configuration(
    report_configuration_object: &Value,
) -> Result<&Vec<Value>, HttpError> {
    report_configuration_object
        .get("layers")
        .and_then(Value::as_array)
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: "the report configuration is missing a `layers` array".to_string(),
        })
}

// ---------------------------------------------------------------------------
// 5. Ensure the layer array is not empty
// ---------------------------------------------------------------------------
fn ensure_report_layer_array_is_not_empty(
    report_layer_array: &[Value],
) -> Result<(), HttpError> {
    if report_layer_array.is_empty() {
        Err(HttpError::RequestBodyWasMalformed {
            explanation: "the report configuration must contain at least one layer".to_string(),
        })
    } else {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// 6. Collect every referenced step identifier across all layers
// ---------------------------------------------------------------------------
//
// Each layer may carry a `referencedSteps` array of layer identifiers it
// depends upon. This gathers the union of all such references.
fn collect_referenced_step_identifiers_across_layers(
    report_layer_array: &[Value],
) -> HashSet<String> {
    let mut referenced_step_identifiers = HashSet::new();

    for report_layer in report_layer_array {
        if let Some(referenced_steps) = report_layer
            .get("referencedSteps")
            .and_then(Value::as_array)
        {
            for referenced_step in referenced_steps {
                if let Some(referenced_step_identifier) = referenced_step.as_str() {
                    if !referenced_step_identifier.is_empty() {
                        referenced_step_identifiers.insert(referenced_step_identifier.to_string());
                    }
                }
            }
        }
    }

    referenced_step_identifiers
}

// ---------------------------------------------------------------------------
// 7. Validate referential integrity of referenced steps
// ---------------------------------------------------------------------------
//
// Every identifier that appears in a `referencedSteps` array must correspond to
// the `id` of some layer actually present in the configuration.
fn validate_every_referenced_step_identifier_exists(
    report_layer_array: &[Value],
    referenced_step_identifiers: &HashSet<String>,
) -> Result<(), HttpError> {
    let declared_layer_identifiers: HashSet<&str> = report_layer_array
        .iter()
        .filter_map(|report_layer| report_layer.get("id").and_then(Value::as_str))
        .collect();

    for referenced_step_identifier in referenced_step_identifiers {
        if !declared_layer_identifiers.contains(referenced_step_identifier.as_str()) {
            return Err(HttpError::RequestBodyWasMalformed {
                explanation: format!(
                    "referenced step `{referenced_step_identifier}` does not correspond to any declared layer"
                ),
            });
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// 8. Build the AI completion prompt from the layers
// ---------------------------------------------------------------------------
fn build_report_creation_prompt_from_layers(
    report_display_name: &NonEmptyText,
    report_layer_array: &[Value],
) -> NonEmptyText {
    let mut prompt_text = String::new();
    prompt_text.push_str("You are an expert report-writing agent. Produce a single, coherent, ");
    prompt_text.push_str("well-structured markdown report titled \"");
    prompt_text.push_str(report_display_name.as_str());
    prompt_text.push_str("\".\n\n");
    prompt_text.push_str("The report is assembled from the following ordered layers. ");
    prompt_text.push_str("Execute each layer's instruction in order, honouring any referenced steps:\n\n");

    for (layer_index, report_layer) in report_layer_array.iter().enumerate() {
        let layer_ordinal = layer_index + 1;
        let layer_name = report_layer
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Untitled layer");
        let layer_instruction = report_layer
            .get("userInstruction")
            .and_then(Value::as_str)
            .unwrap_or("");
        let layer_input = report_layer
            .get("userInput")
            .and_then(Value::as_str)
            .unwrap_or("");

        prompt_text.push_str(&format!("Layer {layer_ordinal}: {layer_name}\n"));

        if !layer_instruction.is_empty() {
            prompt_text.push_str(&format!("  Instruction: {layer_instruction}\n"));
        }
        if !layer_input.is_empty() {
            prompt_text.push_str(&format!("  Input: {layer_input}\n"));
        }

        if let Some(referenced_steps) = report_layer
            .get("referencedSteps")
            .and_then(Value::as_array)
        {
            let referenced_identifiers: Vec<&str> = referenced_steps
                .iter()
                .filter_map(Value::as_str)
                .collect();
            if !referenced_identifiers.is_empty() {
                prompt_text.push_str(&format!(
                    "  Depends on: {}\n",
                    referenced_identifiers.join(", ")
                ));
            }
        }

        prompt_text.push('\n');
    }

    prompt_text.push_str("Return only the final markdown report.");

    // The prompt is always non-empty because we unconditionally push the
    // opening instruction text, but we defensively fall back if parsing fails.
    NonEmptyText::parse(prompt_text).unwrap_or_else(|_| {
        NonEmptyText::parse("Produce a markdown report.".to_string())
            .expect("static fallback prompt is non-empty")
    })
}

// ---------------------------------------------------------------------------
// 9. Extract the produced markdown from the AI completion
// ---------------------------------------------------------------------------
fn extract_produced_report_markdown_from_completion(
    generated_completion: GeneratedCompletion,
) -> String {
    generated_completion.produced_text.trim().to_string()
}

// ---------------------------------------------------------------------------
// 10. Generate a fresh report document identifier
// ---------------------------------------------------------------------------
fn generate_report_document_identifier() -> String {
    Uuid::new_v4().to_string()
}

// ---------------------------------------------------------------------------
// 11. Resolve the owning account from the authorized principal
// ---------------------------------------------------------------------------
fn resolve_owning_account_from_authorized_principal(authorized_principal: &str) -> String {
    authorized_principal.to_string()
}

// ---------------------------------------------------------------------------
// 12. Assemble the persistence body
// ---------------------------------------------------------------------------
fn assemble_report_persistence_body(
    report_document_identifier: &str,
    report_display_name: &NonEmptyText,
    produced_report_markdown: &str,
    report_layer_array: &[Value],
) -> Value {
    json!({
        "id": report_document_identifier,
        "name": report_display_name.as_str(),
        "reportMarkdown": produced_report_markdown,
        "layerCount": report_layer_array.len(),
        "layers": report_layer_array,
        "kind": "ai-agent-report",
    })
}

// ---------------------------------------------------------------------------
// 13. Assemble the stored document
// ---------------------------------------------------------------------------
fn assemble_stored_report_document(
    report_document_identifier: String,
    owning_account: String,
    report_persistence_body: Value,
) -> StoredDocument {
    StoredDocument {
        document_identifier: report_document_identifier,
        owning_account: Some(owning_account),
        document_body: report_persistence_body,
    }
}

// ---------------------------------------------------------------------------
// 14. Map a document-collection failure to an HTTP error
// ---------------------------------------------------------------------------
fn map_document_collection_failure_to_http_error(
    originating_application_error: ApplicationError,
) -> HttpError {
    match originating_application_error {
        ApplicationError::DocumentCollectionFailure {
            failure_description,
        } => HttpError::UpstreamApplicationFailure {
            explanation: format!(
                "the report could not be persisted: {failure_description}"
            ),
        },
        ApplicationError::AuthorizationWasDenied => HttpError::AuthorizationWasDenied {
            explanation: "not authorized to persist this report".to_string(),
        },
        ApplicationError::RequestedResourceCouldNotBeLocated => {
            HttpError::RequestedResourceWasNotFound {
                explanation: "the target report collection could not be located".to_string(),
            }
        }
        other_error => HttpError::UpstreamApplicationFailure {
            explanation: other_error.to_string(),
        },
    }
}

// ---------------------------------------------------------------------------
// 15. Assemble the success response payload
// ---------------------------------------------------------------------------
fn assemble_created_report_response_payload(
    report_document_identifier: &str,
    report_display_name: &NonEmptyText,
    report_layer_array: &[Value],
) -> Value {
    json!({
        "status": "created",
        "reportIdentifier": report_document_identifier,
        "name": report_display_name.as_str(),
        "layerCount": report_layer_array.len(),
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_configuration_accepts_top_level_object() {
        let body = json!({ "name": "R", "layers": [] });
        let configuration =
            extract_report_configuration_object_from_submitted_body(&body).unwrap();
        assert_eq!(configuration.get("name").unwrap().as_str().unwrap(), "R");
    }

    #[test]
    fn extract_configuration_accepts_nested_object() {
        let body = json!({ "configuration": { "name": "R", "layers": [] } });
        let configuration =
            extract_report_configuration_object_from_submitted_body(&body).unwrap();
        assert!(configuration.get("name").is_some());
    }

    #[test]
    fn extract_configuration_rejects_non_object() {
        let body = json!("not an object");
        assert!(extract_report_configuration_object_from_submitted_body(&body).is_err());
    }

    #[test]
    fn extract_display_name_reads_string_field() {
        let configuration = json!({ "name": "My Report" });
        assert_eq!(
            extract_report_display_name_field(&configuration).unwrap(),
            "My Report"
        );
    }

    #[test]
    fn extract_display_name_rejects_missing_field() {
        let configuration = json!({ "layers": [] });
        assert!(extract_report_display_name_field(&configuration).is_err());
    }

    #[test]
    fn parse_display_name_accepts_non_empty() {
        let parsed =
            parse_report_display_name_into_non_empty_text("Report".to_string()).unwrap();
        assert_eq!(parsed.as_str(), "Report");
    }

    #[test]
    fn parse_display_name_rejects_empty() {
        assert!(parse_report_display_name_into_non_empty_text("   ".to_string()).is_err());
    }

    #[test]
    fn extract_layer_array_reads_array() {
        let configuration = json!({ "layers": [ { "id": "a" } ] });
        let layers = extract_report_layer_array_from_configuration(&configuration).unwrap();
        assert_eq!(layers.len(), 1);
    }

    #[test]
    fn extract_layer_array_rejects_missing() {
        let configuration = json!({ "name": "R" });
        assert!(extract_report_layer_array_from_configuration(&configuration).is_err());
    }

    #[test]
    fn ensure_layers_not_empty_passes_for_populated() {
        let layers = vec![json!({ "id": "a" })];
        assert!(ensure_report_layer_array_is_not_empty(&layers).is_ok());
    }

    #[test]
    fn ensure_layers_not_empty_fails_for_empty() {
        let layers: Vec<Value> = vec![];
        assert!(ensure_report_layer_array_is_not_empty(&layers).is_err());
    }

    #[test]
    fn collect_referenced_steps_gathers_union() {
        let layers = vec![
            json!({ "id": "a", "referencedSteps": [] }),
            json!({ "id": "b", "referencedSteps": ["a"] }),
            json!({ "id": "c", "referencedSteps": ["a", "b"] }),
        ];
        let referenced = collect_referenced_step_identifiers_across_layers(&layers);
        assert_eq!(referenced.len(), 2);
        assert!(referenced.contains("a"));
        assert!(referenced.contains("b"));
    }

    #[test]
    fn collect_referenced_steps_ignores_non_string_and_empty() {
        let layers = vec![json!({ "id": "a", "referencedSteps": [123, "", "b"] })];
        let referenced = collect_referenced_step_identifiers_across_layers(&layers);
        assert_eq!(referenced.len(), 1);
        assert!(referenced.contains("b"));
    }

    #[test]
    fn validate_referenced_steps_passes_when_all_exist() {
        let layers = vec![
            json!({ "id": "a" }),
            json!({ "id": "b", "referencedSteps": ["a"] }),
        ];
        let referenced = collect_referenced_step_identifiers_across_layers(&layers);
        assert!(validate_every_referenced_step_identifier_exists(&layers, &referenced).is_ok());
    }

    #[test]
    fn validate_referenced_steps_fails_for_dangling_reference() {
        let layers = vec![json!({ "id": "b", "referencedSteps": ["missing"] })];
        let referenced = collect_referenced_step_identifiers_across_layers(&layers);
        assert!(validate_every_referenced_step_identifier_exists(&layers, &referenced).is_err());
    }

    #[test]
    fn build_prompt_includes_title_and_layer_names() {
        let title = NonEmptyText::parse("Quarterly".to_string()).unwrap();
        let layers = vec![
            json!({ "id": "a", "name": "Intro", "userInstruction": "Write intro" }),
            json!({ "id": "b", "name": "Body", "referencedSteps": ["a"] }),
        ];
        let prompt = build_report_creation_prompt_from_layers(&title, &layers);
        let prompt_text = prompt.as_str();
        assert!(prompt_text.contains("Quarterly"));
        assert!(prompt_text.contains("Intro"));
        assert!(prompt_text.contains("Body"));
        assert!(prompt_text.contains("Write intro"));
        assert!(prompt_text.contains("Depends on: a"));
    }

    #[test]
    fn extract_markdown_trims_whitespace() {
        let completion = GeneratedCompletion {
            produced_text: "  # Report  ".to_string(),
        };
        assert_eq!(
            extract_produced_report_markdown_from_completion(completion),
            "# Report"
        );
    }

    #[test]
    fn generate_identifier_produces_unique_values() {
        let first = generate_report_document_identifier();
        let second = generate_report_document_identifier();
        assert_ne!(first, second);
        assert_eq!(first.len(), 36);
    }

    #[test]
    fn resolve_owning_account_echoes_principal() {
        assert_eq!(
            resolve_owning_account_from_authorized_principal("user@example.com"),
            "user@example.com"
        );
    }

    #[test]
    fn assemble_persistence_body_carries_all_fields() {
        let title = NonEmptyText::parse("Report".to_string()).unwrap();
        let layers = vec![json!({ "id": "a" })];
        let body = assemble_report_persistence_body("id-1", &title, "# Body", &layers);
        assert_eq!(body.get("id").unwrap().as_str().unwrap(), "id-1");
        assert_eq!(body.get("name").unwrap().as_str().unwrap(), "Report");
        assert_eq!(
            body.get("reportMarkdown").unwrap().as_str().unwrap(),
            "# Body"
        );
        assert_eq!(body.get("layerCount").unwrap().as_u64().unwrap(), 1);
    }

    #[test]
    fn assemble_stored_document_wraps_body() {
        let body = json!({ "id": "id-1" });
        let stored = assemble_stored_report_document(
            "id-1".to_string(),
            "owner@example.com".to_string(),
            body,
        );
        assert_eq!(stored.document_identifier, "id-1");
        assert_eq!(stored.owning_account.as_deref(), Some("owner@example.com"));
    }

    #[test]
    fn map_document_collection_failure_maps_variants() {
        let mapped = map_document_collection_failure_to_http_error(
            ApplicationError::DocumentCollectionFailure {
                failure_description: "disk full".to_string(),
            },
        );
        assert!(matches!(
            mapped,
            HttpError::UpstreamApplicationFailure { .. }
        ));

        let denied =
            map_document_collection_failure_to_http_error(ApplicationError::AuthorizationWasDenied);
        assert!(matches!(denied, HttpError::AuthorizationWasDenied { .. }));

        let missing = map_document_collection_failure_to_http_error(
            ApplicationError::RequestedResourceCouldNotBeLocated,
        );
        assert!(matches!(
            missing,
            HttpError::RequestedResourceWasNotFound { .. }
        ));
    }

    #[test]
    fn assemble_response_payload_reports_created_status() {
        let title = NonEmptyText::parse("Report".to_string()).unwrap();
        let layers = vec![json!({ "id": "a" }), json!({ "id": "b" })];
        let payload = assemble_created_report_response_payload("id-9", &title, &layers);
        assert_eq!(payload.get("status").unwrap().as_str().unwrap(), "created");
        assert_eq!(
            payload.get("reportIdentifier").unwrap().as_str().unwrap(),
            "id-9"
        );
        assert_eq!(payload.get("layerCount").unwrap().as_u64().unwrap(), 2);
    }
}
