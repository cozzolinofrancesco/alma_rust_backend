use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};

use alma_application::error::ApplicationError;
use alma_application::ports::ai::GeneratedCompletion;
use alma_domain::value_objects::NonEmptyText;

/// HTTP handler that turns a free-form natural language request into a structured,
/// multi-layer research agent definition.
///
/// The flow is deliberately broken into small pure helpers so each transformation
/// (parsing the request, building the prompt, parsing the model output, sequencing
/// the layers, wiring bibliographies, validating step references, and assembling the
/// final payload) can be unit-tested in isolation without any async runtime.
#[route(method = "POST", path = "/api/ai-agents/generate")]
pub async fn generate_ai_agent_structure_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // 1. Pull the mandatory instruction and the optional shaping inputs from the body.
    let raw_generation_instruction = extract_generation_request_instruction_field(&submitted_body)?;
    let generation_instruction =
        parse_generation_request_instruction_into_non_empty_text(raw_generation_instruction)?;
    let available_document_paths = extract_optional_available_document_paths(&submitted_body);
    let default_model_name = extract_optional_requested_default_model_name(&submitted_body);

    // 2. Ask the model for a structured agent definition.
    let generation_prompt =
        build_agent_structure_generation_prompt(&generation_instruction, &available_document_paths);
    let generated_completion = application_state
        .artificial_intelligence_adapter
        .generate_completion(&generation_prompt)
        .await
        .map_err(map_completion_failure_to_http_error)?;

    // 3. Extract and parse the produced text into JSON.
    let produced_structure_text =
        extract_produced_structure_text_from_completion(generated_completion);
    let generated_agent_structure =
        parse_generated_agent_structure_from_completion_text(&produced_structure_text)?;

    // 4. Normalize the layers: sequence ids, validate references, defaults, bibliography.
    let generated_layer_array =
        extract_generated_layer_array_from_structure(&generated_agent_structure)?;
    let sequenced_layer_array = assign_sequential_layer_identifiers(generated_layer_array);
    ensure_referenced_steps_only_point_to_earlier_layers(&sequenced_layer_array)?;
    let layers_with_models =
        apply_default_model_name_to_layers_missing_model(sequenced_layer_array, &default_model_name);
    let finalized_layer_array = attach_available_documents_to_first_layer_bibliography(
        layers_with_models,
        &available_document_paths,
    );

    // 5. Build metadata and assemble the response envelope.
    let generated_agent_metadata = build_generated_agent_metadata_object(&generation_instruction);
    let response_payload =
        assemble_generated_agent_response_payload(finalized_layer_array, generated_agent_metadata);

    Ok(Json(response_payload))
}

/// 1. Extract the required `request` string field from the submitted body.
fn extract_generation_request_instruction_field(
    submitted_body: &Value,
) -> Result<String, HttpError> {
    submitted_body
        .get("request")
        .and_then(|candidate_value| candidate_value.as_str())
        .map(|found_instruction| found_instruction.trim().to_string())
        .filter(|trimmed_instruction| !trimmed_instruction.is_empty())
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: String::from("the 'request' field is required and must be a non-empty string"),
        })
}

/// 2. Validate the raw instruction into a `NonEmptyText` domain value object.
fn parse_generation_request_instruction_into_non_empty_text(
    raw_generation_instruction: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(raw_generation_instruction).map_err(|parsing_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: parsing_error.to_string(),
        }
    })
}

/// 3. Collect the optional `documentPaths` array (any non-string / non-array is ignored).
fn extract_optional_available_document_paths(submitted_body: &Value) -> Vec<String> {
    submitted_body
        .get("documentPaths")
        .and_then(|candidate_value| candidate_value.as_array())
        .map(|path_array| {
            path_array
                .iter()
                .filter_map(|path_entry| path_entry.as_str())
                .map(|path_string| path_string.trim().to_string())
                .filter(|trimmed_path| !trimmed_path.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// 4. Read the optional `defaultModel` field, falling back to a sensible default.
fn extract_optional_requested_default_model_name(submitted_body: &Value) -> String {
    submitted_body
        .get("defaultModel")
        .and_then(|candidate_value| candidate_value.as_str())
        .map(|requested_model| requested_model.trim().to_string())
        .filter(|trimmed_model| !trimmed_model.is_empty())
        .unwrap_or_else(|| String::from("claude-sonnet-4-5"))
}

/// 5. Compose the full prompt sent to the AI adapter. The prompt is always non-empty
/// because it embeds the (already validated) non-empty instruction.
fn build_agent_structure_generation_prompt(
    generation_instruction: &NonEmptyText,
    available_document_paths: &[String],
) -> NonEmptyText {
    let mut prompt_body = String::new();
    prompt_body.push_str(
        "You are an assistant that designs multi-step research agent workflows. \
Respond with ONLY a JSON object of the shape {\"layers\": [ ... ]}. \
Each layer object must contain the fields: name (string), systemInstruction (string), \
userInstruction (string), selectedModel (string, optional), and referencedSteps \
(array of earlier layer ids). Do not include any prose outside of the JSON.\n\n",
    );
    prompt_body.push_str("User request:\n");
    prompt_body.push_str(generation_instruction.as_str());
    prompt_body.push('\n');

    if available_document_paths.is_empty() {
        prompt_body.push_str("\nNo source documents were provided.\n");
    } else {
        prompt_body.push_str("\nAvailable source documents:\n");
        for document_path in available_document_paths {
            prompt_body.push_str("- ");
            prompt_body.push_str(document_path);
            prompt_body.push('\n');
        }
    }

    // Safe: prompt_body always contains the embedded non-empty instruction text.
    NonEmptyText::parse(prompt_body).unwrap_or_else(|_| generation_instruction.clone())
}

/// 6. Pull the raw produced text out of the completion result.
fn extract_produced_structure_text_from_completion(
    generated_completion: GeneratedCompletion,
) -> String {
    generated_completion.produced_text
}

/// 7. Parse the produced text into JSON, tolerating markdown code fences and
/// surrounding prose by isolating the outermost `{ ... }` block.
fn parse_generated_agent_structure_from_completion_text(
    produced_structure_text: &str,
) -> Result<Value, HttpError> {
    let isolated_json_slice = isolate_outermost_json_object(produced_structure_text).ok_or_else(|| {
        HttpError::UpstreamApplicationFailure {
            explanation: String::from(
                "the AI adapter did not return a recognizable JSON object for the agent structure",
            ),
        }
    })?;

    serde_json::from_str::<Value>(isolated_json_slice).map_err(|deserialization_error| {
        HttpError::UpstreamApplicationFailure {
            explanation: format!(
                "the AI adapter returned malformed JSON for the agent structure: {deserialization_error}"
            ),
        }
    })
}

/// Helper for (7): find the substring spanning the first `{` and its matching `}`.
fn isolate_outermost_json_object(raw_text: &str) -> Option<&str> {
    let opening_index = raw_text.find('{')?;
    let closing_index = raw_text.rfind('}')?;
    if closing_index <= opening_index {
        return None;
    }
    Some(&raw_text[opening_index..=closing_index])
}

/// 8. Extract the `layers` array from the parsed structure and require it to be non-empty.
fn extract_generated_layer_array_from_structure(
    generated_agent_structure: &Value,
) -> Result<Vec<Value>, HttpError> {
    let layer_array = generated_agent_structure
        .get("layers")
        .and_then(|candidate_value| candidate_value.as_array())
        .ok_or_else(|| HttpError::UpstreamApplicationFailure {
            explanation: String::from(
                "the generated agent structure is missing a 'layers' array",
            ),
        })?;

    if layer_array.is_empty() {
        return Err(HttpError::UpstreamApplicationFailure {
            explanation: String::from("the generated agent structure contained no layers"),
        });
    }

    Ok(layer_array.clone())
}

/// 9. Reassign deterministic sequential ids (`layer-1`, `layer-2`, ...) while
/// remapping any `referencedSteps` that pointed at the model's original ids.
fn assign_sequential_layer_identifiers(generated_layer_array: Vec<Value>) -> Vec<Value> {
    // Build a mapping from whatever id the model used -> our canonical id.
    let mut original_to_canonical: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    for (layer_position, layer_value) in generated_layer_array.iter().enumerate() {
        let canonical_identifier = format!("layer-{}", layer_position + 1);
        if let Some(original_identifier) = layer_value.get("id").and_then(|v| v.as_str()) {
            original_to_canonical
                .insert(original_identifier.to_string(), canonical_identifier.clone());
        }
        // Also allow references by 1-based index string.
        original_to_canonical.insert((layer_position + 1).to_string(), canonical_identifier);
    }

    generated_layer_array
        .into_iter()
        .enumerate()
        .map(|(layer_position, mut layer_value)| {
            let canonical_identifier = format!("layer-{}", layer_position + 1);
            if let Some(object_map) = layer_value.as_object_mut() {
                object_map.insert("id".to_string(), Value::String(canonical_identifier));

                let remapped_references = object_map
                    .get("referencedSteps")
                    .and_then(|v| v.as_array())
                    .map(|reference_array| {
                        reference_array
                            .iter()
                            .filter_map(|reference_entry| reference_entry.as_str())
                            .map(|reference_string| {
                                original_to_canonical
                                    .get(reference_string)
                                    .cloned()
                                    .unwrap_or_else(|| reference_string.to_string())
                            })
                            .map(Value::String)
                            .collect::<Vec<Value>>()
                    })
                    .unwrap_or_default();
                object_map.insert("referencedSteps".to_string(), Value::Array(remapped_references));
            }
            layer_value
        })
        .collect()
}

/// 10. Validate that every `referencedSteps` entry points at a strictly-earlier layer.
fn ensure_referenced_steps_only_point_to_earlier_layers(
    sequenced_layer_array: &[Value],
) -> Result<(), HttpError> {
    for (layer_position, layer_value) in sequenced_layer_array.iter().enumerate() {
        let current_identifier = format!("layer-{}", layer_position + 1);
        let referenced_steps = layer_value
            .get("referencedSteps")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        for reference_entry in referenced_steps {
            let referenced_identifier =
                reference_entry.as_str().unwrap_or_default().to_string();

            if referenced_identifier == current_identifier {
                return Err(HttpError::UpstreamApplicationFailure {
                    explanation: format!(
                        "layer '{current_identifier}' references itself, which is not allowed"
                    ),
                });
            }

            let referenced_position = referenced_identifier
                .strip_prefix("layer-")
                .and_then(|numeric_suffix| numeric_suffix.parse::<usize>().ok());

            match referenced_position {
                Some(position) if position >= 1 && position <= layer_position => {
                    // Valid: points at an earlier layer.
                }
                _ => {
                    return Err(HttpError::UpstreamApplicationFailure {
                        explanation: format!(
                            "layer '{current_identifier}' references '{referenced_identifier}', \
which is not an earlier layer"
                        ),
                    });
                }
            }
        }
    }
    Ok(())
}

/// 11. Fill in the default model on any layer that lacks a usable `selectedModel`.
fn apply_default_model_name_to_layers_missing_model(
    sequenced_layer_array: Vec<Value>,
    default_model_name: &str,
) -> Vec<Value> {
    sequenced_layer_array
        .into_iter()
        .map(|mut layer_value| {
            if let Some(object_map) = layer_value.as_object_mut() {
                let has_usable_model = object_map
                    .get("selectedModel")
                    .and_then(|v| v.as_str())
                    .map(|model_string| !model_string.trim().is_empty())
                    .unwrap_or(false);
                if !has_usable_model {
                    object_map.insert(
                        "selectedModel".to_string(),
                        Value::String(default_model_name.to_string()),
                    );
                }
            }
            layer_value
        })
        .collect()
}

/// 12. Attach the caller-provided documents to the first layer's bibliography so the
/// generated agent has concrete sources to reason over.
fn attach_available_documents_to_first_layer_bibliography(
    mut sequenced_layer_array: Vec<Value>,
    available_document_paths: &[String],
) -> Vec<Value> {
    if available_document_paths.is_empty() {
        return sequenced_layer_array;
    }

    if let Some(first_layer) = sequenced_layer_array.first_mut() {
        if let Some(object_map) = first_layer.as_object_mut() {
            let mut bibliography_entries = object_map
                .get("bibliography")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();

            for document_path in available_document_paths {
                let derived_name = document_path
                    .rsplit('/')
                    .next()
                    .filter(|segment| !segment.is_empty())
                    .unwrap_or(document_path.as_str())
                    .to_string();
                bibliography_entries.push(json!({
                    "name": derived_name,
                    "path": document_path,
                    "type": "file",
                    "description": "Provided source document"
                }));
            }

            object_map.insert("bibliography".to_string(), Value::Array(bibliography_entries));
        }
    }

    sequenced_layer_array
}

/// 13. Build the metadata block describing the generated agent.
fn build_generated_agent_metadata_object(generation_instruction: &NonEmptyText) -> Value {
    json!({
        "created": "2026-07-07T00:00:00.000Z",
        "modified": "2026-07-07T00:00:00.000Z",
        "description": "Auto-generated agent",
        "sourceRequest": generation_instruction.as_str(),
        "notes": []
    })
}

/// 14. Translate an AI-adapter failure into the appropriate HTTP error.
fn map_completion_failure_to_http_error(
    originating_application_error: ApplicationError,
) -> HttpError {
    match originating_application_error {
        ApplicationError::ArtificialIntelligenceAdapterFailure { failure_description } => {
            HttpError::UpstreamApplicationFailure {
                explanation: format!(
                    "the artificial intelligence adapter failed to generate the agent structure: {failure_description}"
                ),
            }
        }
        ApplicationError::DomainInvariantViolated(domain_error) => {
            HttpError::RequestBodyWasMalformed {
                explanation: domain_error.to_string(),
            }
        }
        ApplicationError::AuthorizationWasDenied => HttpError::AuthorizationWasDenied {
            explanation: String::from(
                "the authenticated principal is not authorized to generate agents",
            ),
        },
        ApplicationError::RequestedResourceCouldNotBeLocated
        | ApplicationError::RequestedProjectCouldNotBeLocated => {
            HttpError::RequestedResourceWasNotFound {
                explanation: String::from("a resource required for generation was not found"),
            }
        }
        other_error => HttpError::UpstreamApplicationFailure {
            explanation: other_error.to_string(),
        },
    }
}

/// 15. Wrap the finalized layers and metadata into the response envelope the frontend expects.
fn assemble_generated_agent_response_payload(
    finalized_layer_array: Vec<Value>,
    generated_agent_metadata: Value,
) -> Value {
    json!({
        "agent": {
            "version": "1.0.0",
            "name": "Generated Research Agent",
            "layers": finalized_layer_array,
            "metadata": generated_agent_metadata
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_generation_request_instruction_field_reads_present_value() {
        let body = json!({ "request": "  build me an agent  " });
        let extracted = extract_generation_request_instruction_field(&body).unwrap();
        assert_eq!(extracted, "build me an agent");
    }

    #[test]
    fn extract_generation_request_instruction_field_rejects_missing_or_empty() {
        assert!(extract_generation_request_instruction_field(&json!({})).is_err());
        assert!(extract_generation_request_instruction_field(&json!({ "request": "   " })).is_err());
        assert!(extract_generation_request_instruction_field(&json!({ "request": 42 })).is_err());
    }

    #[test]
    fn parse_generation_request_instruction_into_non_empty_text_valid_and_invalid() {
        let parsed = parse_generation_request_instruction_into_non_empty_text("hello".to_string());
        assert!(parsed.is_ok());
        let empty = parse_generation_request_instruction_into_non_empty_text(String::new());
        assert!(empty.is_err());
    }

    #[test]
    fn extract_optional_available_document_paths_filters_correctly() {
        let body = json!({ "documentPaths": ["a/b.pdf", "  ", 5, "c.txt"] });
        let paths = extract_optional_available_document_paths(&body);
        assert_eq!(paths, vec!["a/b.pdf".to_string(), "c.txt".to_string()]);
        assert!(extract_optional_available_document_paths(&json!({})).is_empty());
    }

    #[test]
    fn extract_optional_requested_default_model_name_uses_fallback() {
        assert_eq!(
            extract_optional_requested_default_model_name(&json!({ "defaultModel": "gpt-x" })),
            "gpt-x"
        );
        assert_eq!(
            extract_optional_requested_default_model_name(&json!({ "defaultModel": "   " })),
            "claude-sonnet-4-5"
        );
        assert_eq!(
            extract_optional_requested_default_model_name(&json!({})),
            "claude-sonnet-4-5"
        );
    }

    #[test]
    fn build_agent_structure_generation_prompt_embeds_instruction_and_docs() {
        let instruction = NonEmptyText::parse("summarize papers".to_string()).unwrap();
        let prompt = build_agent_structure_generation_prompt(
            &instruction,
            &["src/one.pdf".to_string()],
        );
        assert!(prompt.as_str().contains("summarize papers"));
        assert!(prompt.as_str().contains("src/one.pdf"));

        let no_docs_prompt = build_agent_structure_generation_prompt(&instruction, &[]);
        assert!(no_docs_prompt.as_str().contains("No source documents"));
    }

    #[test]
    fn extract_produced_structure_text_from_completion_returns_body() {
        let completion = GeneratedCompletion {
            produced_text: "the text".to_string(),
        };
        assert_eq!(extract_produced_structure_text_from_completion(completion), "the text");
    }

    #[test]
    fn parse_generated_agent_structure_from_completion_text_handles_fences_and_junk() {
        let fenced = "```json\n{\"layers\": []}\n```";
        let parsed = parse_generated_agent_structure_from_completion_text(fenced).unwrap();
        assert!(parsed.get("layers").is_some());

        let with_prose = "Here you go: {\"layers\": [{\"name\": \"x\"}]} thanks";
        assert!(parse_generated_agent_structure_from_completion_text(with_prose).is_ok());

        assert!(parse_generated_agent_structure_from_completion_text("no json here").is_err());
        assert!(parse_generated_agent_structure_from_completion_text("{not valid}").is_err());
    }

    #[test]
    fn isolate_outermost_json_object_finds_span() {
        assert_eq!(isolate_outermost_json_object("a{b}c"), Some("{b}"));
        assert_eq!(isolate_outermost_json_object("no braces"), None);
        assert_eq!(isolate_outermost_json_object("}{"), None);
    }

    #[test]
    fn extract_generated_layer_array_from_structure_requires_non_empty() {
        let good = json!({ "layers": [{ "name": "a" }] });
        assert_eq!(extract_generated_layer_array_from_structure(&good).unwrap().len(), 1);
        assert!(extract_generated_layer_array_from_structure(&json!({ "layers": [] })).is_err());
        assert!(extract_generated_layer_array_from_structure(&json!({})).is_err());
    }

    #[test]
    fn assign_sequential_layer_identifiers_renumbers_and_remaps() {
        let input = vec![
            json!({ "id": "alpha", "name": "first" }),
            json!({ "id": "beta", "name": "second", "referencedSteps": ["alpha"] }),
        ];
        let sequenced = assign_sequential_layer_identifiers(input);
        assert_eq!(sequenced[0]["id"], json!("layer-1"));
        assert_eq!(sequenced[1]["id"], json!("layer-2"));
        assert_eq!(sequenced[1]["referencedSteps"], json!(["layer-1"]));
    }

    #[test]
    fn ensure_referenced_steps_only_point_to_earlier_layers_accepts_and_rejects() {
        let valid = vec![
            json!({ "id": "layer-1", "referencedSteps": [] }),
            json!({ "id": "layer-2", "referencedSteps": ["layer-1"] }),
        ];
        assert!(ensure_referenced_steps_only_point_to_earlier_layers(&valid).is_ok());

        let forward = vec![
            json!({ "id": "layer-1", "referencedSteps": ["layer-2"] }),
            json!({ "id": "layer-2", "referencedSteps": [] }),
        ];
        assert!(ensure_referenced_steps_only_point_to_earlier_layers(&forward).is_err());

        let self_ref = vec![json!({ "id": "layer-1", "referencedSteps": ["layer-1"] })];
        assert!(ensure_referenced_steps_only_point_to_earlier_layers(&self_ref).is_err());
    }

    #[test]
    fn apply_default_model_name_to_layers_missing_model_fills_gaps() {
        let input = vec![
            json!({ "name": "a" }),
            json!({ "name": "b", "selectedModel": "custom-model" }),
            json!({ "name": "c", "selectedModel": "  " }),
        ];
        let result = apply_default_model_name_to_layers_missing_model(input, "fallback-model");
        assert_eq!(result[0]["selectedModel"], json!("fallback-model"));
        assert_eq!(result[1]["selectedModel"], json!("custom-model"));
        assert_eq!(result[2]["selectedModel"], json!("fallback-model"));
    }

    #[test]
    fn attach_available_documents_to_first_layer_bibliography_adds_entries() {
        let input = vec![json!({ "name": "a" }), json!({ "name": "b" })];
        let result = attach_available_documents_to_first_layer_bibliography(
            input,
            &["folder/report.pdf".to_string()],
        );
        let bibliography = result[0]["bibliography"].as_array().unwrap();
        assert_eq!(bibliography.len(), 1);
        assert_eq!(bibliography[0]["name"], json!("report.pdf"));
        assert_eq!(bibliography[0]["path"], json!("folder/report.pdf"));
        // Second layer untouched.
        assert!(result[1].get("bibliography").is_none());

        let untouched = attach_available_documents_to_first_layer_bibliography(
            vec![json!({ "name": "a" })],
            &[],
        );
        assert!(untouched[0].get("bibliography").is_none());
    }

    #[test]
    fn build_generated_agent_metadata_object_includes_source_request() {
        let instruction = NonEmptyText::parse("do a thing".to_string()).unwrap();
        let metadata = build_generated_agent_metadata_object(&instruction);
        assert_eq!(metadata["sourceRequest"], json!("do a thing"));
        assert_eq!(metadata["notes"], json!([]));
    }

    #[test]
    fn map_completion_failure_to_http_error_maps_variants() {
        let ai_failure = ApplicationError::ArtificialIntelligenceAdapterFailure {
            failure_description: "timeout".to_string(),
        };
        assert!(matches!(
            map_completion_failure_to_http_error(ai_failure),
            HttpError::UpstreamApplicationFailure { .. }
        ));

        let auth = ApplicationError::AuthorizationWasDenied;
        assert!(matches!(
            map_completion_failure_to_http_error(auth),
            HttpError::AuthorizationWasDenied { .. }
        ));

        let not_found = ApplicationError::RequestedResourceCouldNotBeLocated;
        assert!(matches!(
            map_completion_failure_to_http_error(not_found),
            HttpError::RequestedResourceWasNotFound { .. }
        ));
    }

    #[test]
    fn assemble_generated_agent_response_payload_wraps_layers_and_metadata() {
        let layers = vec![json!({ "id": "layer-1" })];
        let metadata = json!({ "description": "meta" });
        let payload = assemble_generated_agent_response_payload(layers, metadata);
        assert_eq!(payload["agent"]["version"], json!("1.0.0"));
        assert_eq!(payload["agent"]["layers"][0]["id"], json!("layer-1"));
        assert_eq!(payload["agent"]["metadata"]["description"], json!("meta"));
    }
}
