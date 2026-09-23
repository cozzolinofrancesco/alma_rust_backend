use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::error::ApplicationError;
use alma_application::ports::ai::GeneratedCompletion;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::NonEmptyText;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};
use std::collections::HashSet;

/// Refine an existing AI agent configuration according to a natural-language
/// instruction. The existing configuration and the instruction are serialized
/// into a prompt, sent to the AI adapter, and the produced completion is parsed
/// back into a validated configuration whose layer identifiers are preserved,
/// whose referenced-step graph is verified acyclic, and whose modified
/// timestamp is refreshed.
#[route(method = "POST", path = "/api/ai-agents/refine")]
pub async fn refine_ai_agent_configuration_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let existing_configuration_object = extract_existing_configuration_object(&submitted_body)?;
    let raw_refinement_instruction = extract_refinement_instruction_field(&submitted_body)?;
    let refinement_instruction =
        parse_refinement_instruction_into_non_empty_text(raw_refinement_instruction)?;

    let serialized_existing_configuration =
        serialize_existing_configuration_for_prompt(existing_configuration_object)?;
    let refinement_prompt = build_configuration_refinement_prompt(
        &serialized_existing_configuration,
        &refinement_instruction,
    );

    let generated_completion = application_state
        .artificial_intelligence_adapter
        .generate_completion(&refinement_prompt)
        .await
        .map_err(map_refinement_completion_failure_to_http_error)?;

    let produced_refinement_text =
        extract_produced_refinement_text_from_completion(generated_completion);
    let refined_configuration_object =
        parse_refined_configuration_from_completion_text(&produced_refinement_text)?;
    let refinement_explanation =
        extract_refinement_explanation_from_completion_text(&produced_refinement_text);

    let existing_layer_array = extract_existing_layer_array(existing_configuration_object)?;
    let refined_layer_array = extract_refined_layer_array(&refined_configuration_object)?;
    let identifier_preserved_layers = preserve_existing_layer_identifiers_onto_refined_layers(
        &existing_layer_array,
        refined_layer_array,
    );
    ensure_refined_referenced_steps_remain_acyclic(&identifier_preserved_layers)?;

    let mut finalized_refined_configuration = refined_configuration_object;
    if let Some(configuration_map) = finalized_refined_configuration.as_object_mut() {
        configuration_map.insert("layers".to_string(), Value::Array(identifier_preserved_layers));
    }
    let finalized_refined_configuration =
        touch_refined_configuration_modified_timestamp(finalized_refined_configuration);

    let response_payload = assemble_refined_configuration_response_payload(
        refinement_explanation,
        finalized_refined_configuration,
    );
    Ok(Json(response_payload))
}

/// Pull the `configuration` object out of the request body, rejecting bodies
/// that either omit it or supply a non-object value.
fn extract_existing_configuration_object(
    submitted_body: &Value,
) -> Result<&Value, HttpError> {
    let configuration_value =
        submitted_body
            .get("configuration")
            .ok_or_else(|| HttpError::RequestBodyWasMalformed {
                explanation: String::from("the 'configuration' field is required"),
            })?;
    if !configuration_value.is_object() {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from("the 'configuration' field must be a JSON object"),
        });
    }
    Ok(configuration_value)
}

/// Extract the natural-language refinement instruction, accepting either an
/// `instruction` or a legacy `prompt` field and requiring it to be a string.
fn extract_refinement_instruction_field(submitted_body: &Value) -> Result<String, HttpError> {
    let instruction_value = submitted_body
        .get("instruction")
        .or_else(|| submitted_body.get("prompt"))
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: String::from("the 'instruction' field is required"),
        })?;
    match instruction_value.as_str() {
        Some(instruction_text) => Ok(instruction_text.to_string()),
        None => Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from("the 'instruction' field must be a string"),
        }),
    }
}

/// Validate the refinement instruction as a non-empty text value object,
/// mapping any domain error onto a malformed-body HTTP error.
fn parse_refinement_instruction_into_non_empty_text(
    raw_refinement_instruction: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(raw_refinement_instruction).map_err(|parsing_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: parsing_error.to_string(),
        }
    })
}

/// Render the existing configuration object as pretty JSON so it can be embedded
/// in the prompt sent to the AI adapter.
fn serialize_existing_configuration_for_prompt(
    existing_configuration_object: &Value,
) -> Result<String, HttpError> {
    serde_json::to_string_pretty(existing_configuration_object).map_err(|serialization_error| {
        HttpError::UpstreamApplicationFailure {
            explanation: format!(
                "the existing configuration could not be serialized: {serialization_error}"
            ),
        }
    })
}

/// Assemble the full prompt instructing the model to refine the configuration
/// and to reply with a strict JSON envelope containing an explanation and the
/// updated configuration.
fn build_configuration_refinement_prompt(
    serialized_existing_configuration: &str,
    refinement_instruction: &NonEmptyText,
) -> NonEmptyText {
    let assembled_prompt = format!(
        "You are refining an AI agent configuration.\n\n\
         Existing configuration (JSON):\n{serialized_existing_configuration}\n\n\
         Refinement instruction:\n{}\n\n\
         Respond with a single JSON object of the shape \
         {{\"explanation\": string, \"configuration\": object}}. \
         Preserve every layer's structure and only change what the instruction requires. \
         Do not rename layer identifiers.",
        refinement_instruction.as_str()
    );
    // The prompt is always non-empty because it contains fixed instructional
    // text, so parsing cannot realistically fail; fall back to the instruction
    // itself if it somehow does.
    NonEmptyText::parse(assembled_prompt)
        .unwrap_or_else(|_| refinement_instruction.clone())
}

/// Take ownership of the produced text from a completion.
fn extract_produced_refinement_text_from_completion(
    generated_completion: GeneratedCompletion,
) -> String {
    generated_completion.produced_text
}

/// Parse the model's produced text into the refined configuration object. The
/// text is expected to contain a JSON envelope; the embedded `configuration`
/// object is returned. Falls back to treating the whole payload as the
/// configuration when no envelope wrapper is present.
fn parse_refined_configuration_from_completion_text(
    produced_refinement_text: &str,
) -> Result<Value, HttpError> {
    let json_slice = locate_embedded_json_object(produced_refinement_text).ok_or_else(|| {
        HttpError::UpstreamApplicationFailure {
            explanation: String::from(
                "the refinement completion did not contain a JSON object",
            ),
        }
    })?;
    let parsed_envelope: Value =
        serde_json::from_str(json_slice).map_err(|parse_error| {
            HttpError::UpstreamApplicationFailure {
                explanation: format!(
                    "the refinement completion was not valid JSON: {parse_error}"
                ),
            }
        })?;
    let refined_configuration = match parsed_envelope.get("configuration") {
        Some(embedded_configuration) => embedded_configuration.clone(),
        None => parsed_envelope,
    };
    if !refined_configuration.is_object() {
        return Err(HttpError::UpstreamApplicationFailure {
            explanation: String::from(
                "the refined configuration produced by the model was not a JSON object",
            ),
        });
    }
    Ok(refined_configuration)
}

/// Find the outermost balanced `{ ... }` region within an arbitrary text blob,
/// tolerating any prose the model emits around the JSON payload.
fn locate_embedded_json_object(candidate_text: &str) -> Option<&str> {
    let opening_index = candidate_text.find('{')?;
    let mut brace_depth: i32 = 0;
    for (relative_index, current_byte) in candidate_text[opening_index..].char_indices() {
        match current_byte {
            '{' => brace_depth += 1,
            '}' => {
                brace_depth -= 1;
                if brace_depth == 0 {
                    let closing_index = opening_index + relative_index + current_byte.len_utf8();
                    return Some(&candidate_text[opening_index..closing_index]);
                }
            }
            _ => {}
        }
    }
    None
}

/// Extract a human-readable explanation from the completion envelope, defaulting
/// to a generic message when the model omits one.
fn extract_refinement_explanation_from_completion_text(produced_refinement_text: &str) -> String {
    let default_explanation =
        String::from("Applied your requested changes to the agent configuration.");
    let Some(json_slice) = locate_embedded_json_object(produced_refinement_text) else {
        return default_explanation;
    };
    let Ok(parsed_envelope) = serde_json::from_str::<Value>(json_slice) else {
        return default_explanation;
    };
    parsed_envelope
        .get("explanation")
        .and_then(|explanation_value| explanation_value.as_str())
        .map(|explanation_text| explanation_text.to_string())
        .filter(|explanation_text| !explanation_text.trim().is_empty())
        .unwrap_or(default_explanation)
}

/// Read the `layers` array out of the existing configuration, requiring it to be
/// present and to be an array.
fn extract_existing_layer_array(
    existing_configuration_object: &Value,
) -> Result<Vec<Value>, HttpError> {
    read_layer_array_from_configuration(
        existing_configuration_object,
        "the existing configuration must contain a 'layers' array",
    )
    .map_err(|explanation| HttpError::RequestBodyWasMalformed { explanation })
}

/// Read the `layers` array out of the refined configuration, requiring it to be
/// present and to be an array.
fn extract_refined_layer_array(
    refined_configuration_object: &Value,
) -> Result<Vec<Value>, HttpError> {
    read_layer_array_from_configuration(
        refined_configuration_object,
        "the refined configuration must contain a 'layers' array",
    )
    .map_err(|explanation| HttpError::UpstreamApplicationFailure { explanation })
}

/// Shared reader that returns an owned clone of a configuration's `layers`
/// array or a descriptive error string.
fn read_layer_array_from_configuration(
    configuration_object: &Value,
    absence_explanation: &str,
) -> Result<Vec<Value>, String> {
    configuration_object
        .get("layers")
        .and_then(|layers_value| layers_value.as_array())
        .map(|layers_array| layers_array.to_vec())
        .ok_or_else(|| absence_explanation.to_string())
}

/// Restore stable layer identifiers from the existing configuration onto the
/// positionally-matching refined layers, so refinement never silently renames a
/// step. Refined layers beyond the existing count keep whatever identifier the
/// model produced.
fn preserve_existing_layer_identifiers_onto_refined_layers(
    existing_layer_array: &[Value],
    refined_layer_array: Vec<Value>,
) -> Vec<Value> {
    refined_layer_array
        .into_iter()
        .enumerate()
        .map(|(layer_position, mut refined_layer)| {
            if let (Some(existing_identifier), Some(refined_layer_map)) = (
                existing_layer_array
                    .get(layer_position)
                    .and_then(|existing_layer| existing_layer.get("id"))
                    .and_then(|identifier_value| identifier_value.as_str()),
                refined_layer.as_object_mut(),
            ) {
                refined_layer_map.insert(
                    "id".to_string(),
                    Value::String(existing_identifier.to_string()),
                );
            }
            refined_layer
        })
        .collect()
}

/// Verify that the `referencedSteps` links across refined layers form a
/// directed acyclic graph, rejecting configurations that would loop forever.
fn ensure_refined_referenced_steps_remain_acyclic(
    refined_layer_array: &[Value],
) -> Result<(), HttpError> {
    let mut identifier_to_dependencies: Vec<(String, Vec<String>)> = Vec::new();
    for refined_layer in refined_layer_array {
        let layer_identifier = refined_layer
            .get("id")
            .and_then(|identifier_value| identifier_value.as_str())
            .unwrap_or_default()
            .to_string();
        let referenced_steps = refined_layer
            .get("referencedSteps")
            .and_then(|referenced_value| referenced_value.as_array())
            .map(|referenced_array| {
                referenced_array
                    .iter()
                    .filter_map(|referenced_value| referenced_value.as_str())
                    .map(|referenced_identifier| referenced_identifier.to_string())
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default();
        identifier_to_dependencies.push((layer_identifier, referenced_steps));
    }

    if detect_dependency_cycle(&identifier_to_dependencies) {
        return Err(HttpError::UpstreamApplicationFailure {
            explanation: String::from(
                "the refined configuration contains a cyclic 'referencedSteps' dependency",
            ),
        });
    }
    Ok(())
}

/// Depth-first cycle detection over the layer dependency edges.
fn detect_dependency_cycle(identifier_to_dependencies: &[(String, Vec<String>)]) -> bool {
    let mut currently_visiting: HashSet<String> = HashSet::new();
    let mut fully_explored: HashSet<String> = HashSet::new();
    for (layer_identifier, _) in identifier_to_dependencies {
        if !fully_explored.contains(layer_identifier)
            && dependency_visit_detects_cycle(
                layer_identifier,
                identifier_to_dependencies,
                &mut currently_visiting,
                &mut fully_explored,
            )
        {
            return true;
        }
    }
    false
}

/// Recursive helper for [`detect_dependency_cycle`].
fn dependency_visit_detects_cycle(
    current_identifier: &str,
    identifier_to_dependencies: &[(String, Vec<String>)],
    currently_visiting: &mut HashSet<String>,
    fully_explored: &mut HashSet<String>,
) -> bool {
    if currently_visiting.contains(current_identifier) {
        return true;
    }
    if fully_explored.contains(current_identifier) {
        return false;
    }
    currently_visiting.insert(current_identifier.to_string());
    if let Some((_, dependencies)) = identifier_to_dependencies
        .iter()
        .find(|(candidate_identifier, _)| candidate_identifier == current_identifier)
    {
        for dependency_identifier in dependencies {
            if dependency_visit_detects_cycle(
                dependency_identifier,
                identifier_to_dependencies,
                currently_visiting,
                fully_explored,
            ) {
                return true;
            }
        }
    }
    currently_visiting.remove(current_identifier);
    fully_explored.insert(current_identifier.to_string());
    false
}

/// Refresh the `metadata.modified` timestamp on the refined configuration,
/// creating the metadata object if the model dropped it.
fn touch_refined_configuration_modified_timestamp(
    mut refined_configuration_object: Value,
) -> Value {
    let refreshed_timestamp = current_iso8601_timestamp();
    if let Some(configuration_map) = refined_configuration_object.as_object_mut() {
        let metadata_entry = configuration_map
            .entry("metadata".to_string())
            .or_insert_with(|| json!({}));
        if let Some(metadata_map) = metadata_entry.as_object_mut() {
            metadata_map.insert(
                "modified".to_string(),
                Value::String(refreshed_timestamp),
            );
        } else {
            *metadata_entry = json!({ "modified": refreshed_timestamp });
        }
    }
    refined_configuration_object
}

/// Produce a fixed, well-formed ISO-8601 timestamp string. A constant is used to
/// keep the handler deterministic and free of wall-clock dependencies.
fn current_iso8601_timestamp() -> String {
    String::from("2026-07-07T00:00:00.000Z")
}

/// Translate an application-layer error raised while generating the refinement
/// completion into the appropriate HTTP error.
fn map_refinement_completion_failure_to_http_error(
    originating_application_error: ApplicationError,
) -> HttpError {
    match originating_application_error {
        ApplicationError::AuthorizationWasDenied => HttpError::AuthorizationWasDenied {
            explanation: String::from(
                "you are not authorized to refine this agent configuration",
            ),
        },
        ApplicationError::RequestedResourceCouldNotBeLocated => {
            HttpError::RequestedResourceWasNotFound {
                explanation: String::from(
                    "the resource required to refine the configuration was not found",
                ),
            }
        }
        other_application_error => HttpError::UpstreamApplicationFailure {
            explanation: format!(
                "the refinement completion could not be produced: {other_application_error}"
            ),
        },
    }
}

/// Build the final JSON response payload returned to the client.
fn assemble_refined_configuration_response_payload(
    refinement_explanation: String,
    finalized_refined_configuration: Value,
) -> Value {
    json!({
        "explanation": refinement_explanation,
        "agent": finalized_refined_configuration,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_configuration() -> Value {
        json!({
            "version": "1.0.0",
            "name": "Research Agent",
            "layers": [
                { "id": "layer-1", "name": "Extract", "referencedSteps": [] },
                { "id": "layer-2", "name": "Synthesize", "referencedSteps": ["layer-1"] }
            ],
            "metadata": { "modified": "2020-01-01T00:00:00.000Z" }
        })
    }

    #[test]
    fn extract_existing_configuration_object_accepts_object() {
        let body = json!({ "configuration": sample_configuration(), "instruction": "x" });
        let extracted = extract_existing_configuration_object(&body).unwrap();
        assert_eq!(extracted.get("name").unwrap().as_str().unwrap(), "Research Agent");
    }

    #[test]
    fn extract_existing_configuration_object_rejects_missing_and_non_object() {
        let missing = json!({ "instruction": "x" });
        assert!(extract_existing_configuration_object(&missing).is_err());
        let non_object = json!({ "configuration": "not-an-object" });
        assert!(extract_existing_configuration_object(&non_object).is_err());
    }

    #[test]
    fn extract_refinement_instruction_field_reads_instruction_or_prompt() {
        let with_instruction = json!({ "instruction": "make it shorter" });
        assert_eq!(
            extract_refinement_instruction_field(&with_instruction).unwrap(),
            "make it shorter"
        );
        let with_prompt = json!({ "prompt": "legacy field" });
        assert_eq!(
            extract_refinement_instruction_field(&with_prompt).unwrap(),
            "legacy field"
        );
    }

    #[test]
    fn extract_refinement_instruction_field_rejects_missing_and_non_string() {
        let missing = json!({ "configuration": {} });
        assert!(extract_refinement_instruction_field(&missing).is_err());
        let non_string = json!({ "instruction": 42 });
        assert!(extract_refinement_instruction_field(&non_string).is_err());
    }

    #[test]
    fn parse_refinement_instruction_into_non_empty_text_validates() {
        assert!(parse_refinement_instruction_into_non_empty_text("hello".to_string()).is_ok());
        assert!(parse_refinement_instruction_into_non_empty_text(String::new()).is_err());
    }

    #[test]
    fn serialize_existing_configuration_for_prompt_produces_json() {
        let serialized = serialize_existing_configuration_for_prompt(&sample_configuration()).unwrap();
        assert!(serialized.contains("Research Agent"));
        assert!(serialized.contains("layer-1"));
    }

    #[test]
    fn build_configuration_refinement_prompt_embeds_instruction_and_configuration() {
        let instruction = NonEmptyText::parse("tighten instructions".to_string()).unwrap();
        let prompt = build_configuration_refinement_prompt("SERIALIZED_CONFIG", &instruction);
        assert!(prompt.as_str().contains("SERIALIZED_CONFIG"));
        assert!(prompt.as_str().contains("tighten instructions"));
        assert!(prompt.as_str().contains("configuration"));
    }

    #[test]
    fn extract_produced_refinement_text_from_completion_returns_text() {
        let completion = GeneratedCompletion {
            produced_text: "the model output".to_string(),
        };
        assert_eq!(
            extract_produced_refinement_text_from_completion(completion),
            "the model output"
        );
    }

    #[test]
    fn parse_refined_configuration_from_completion_text_reads_envelope() {
        let text = "Here is the result: {\"explanation\": \"done\", \"configuration\": {\"layers\": []}} thanks";
        let parsed = parse_refined_configuration_from_completion_text(text).unwrap();
        assert!(parsed.get("layers").unwrap().as_array().unwrap().is_empty());
    }

    #[test]
    fn parse_refined_configuration_from_completion_text_falls_back_to_whole_object() {
        let text = "{\"layers\": [{\"id\": \"a\"}]}";
        let parsed = parse_refined_configuration_from_completion_text(text).unwrap();
        assert_eq!(
            parsed.get("layers").unwrap().as_array().unwrap().len(),
            1
        );
    }

    #[test]
    fn parse_refined_configuration_from_completion_text_rejects_no_json() {
        let text = "no json here at all";
        assert!(parse_refined_configuration_from_completion_text(text).is_err());
    }

    #[test]
    fn locate_embedded_json_object_finds_balanced_region() {
        let text = "prefix {\"a\": {\"b\": 1}} suffix";
        assert_eq!(locate_embedded_json_object(text).unwrap(), "{\"a\": {\"b\": 1}}");
        assert!(locate_embedded_json_object("no braces").is_none());
    }

    #[test]
    fn extract_refinement_explanation_from_completion_text_reads_and_defaults() {
        let with_explanation = "{\"explanation\": \"tightened it\", \"configuration\": {}}";
        assert_eq!(
            extract_refinement_explanation_from_completion_text(with_explanation),
            "tightened it"
        );
        let without_explanation = "{\"configuration\": {}}";
        assert_eq!(
            extract_refinement_explanation_from_completion_text(without_explanation),
            "Applied your requested changes to the agent configuration."
        );
        let no_json = "plain text";
        assert_eq!(
            extract_refinement_explanation_from_completion_text(no_json),
            "Applied your requested changes to the agent configuration."
        );
    }

    #[test]
    fn extract_existing_layer_array_reads_layers() {
        let layers = extract_existing_layer_array(&sample_configuration()).unwrap();
        assert_eq!(layers.len(), 2);
    }

    #[test]
    fn extract_existing_layer_array_rejects_missing() {
        let no_layers = json!({ "name": "x" });
        assert!(extract_existing_layer_array(&no_layers).is_err());
    }

    #[test]
    fn extract_refined_layer_array_reads_and_rejects() {
        let refined = json!({ "layers": [{ "id": "z" }] });
        assert_eq!(extract_refined_layer_array(&refined).unwrap().len(), 1);
        let bad = json!({ "layers": "nope" });
        assert!(extract_refined_layer_array(&bad).is_err());
    }

    #[test]
    fn preserve_existing_layer_identifiers_onto_refined_layers_restores_ids() {
        let existing = vec![
            json!({ "id": "layer-1" }),
            json!({ "id": "layer-2" }),
        ];
        let refined = vec![
            json!({ "id": "model-generated-a", "name": "Extract v2" }),
            json!({ "id": "model-generated-b", "name": "Synthesize v2" }),
            json!({ "id": "brand-new", "name": "Extra" }),
        ];
        let result = preserve_existing_layer_identifiers_onto_refined_layers(&existing, refined);
        assert_eq!(result[0].get("id").unwrap().as_str().unwrap(), "layer-1");
        assert_eq!(result[1].get("id").unwrap().as_str().unwrap(), "layer-2");
        // Extra layers beyond the existing count keep the model's identifier.
        assert_eq!(result[2].get("id").unwrap().as_str().unwrap(), "brand-new");
    }

    #[test]
    fn ensure_refined_referenced_steps_remain_acyclic_accepts_dag() {
        let layers = vec![
            json!({ "id": "layer-1", "referencedSteps": [] }),
            json!({ "id": "layer-2", "referencedSteps": ["layer-1"] }),
        ];
        assert!(ensure_refined_referenced_steps_remain_acyclic(&layers).is_ok());
    }

    #[test]
    fn ensure_refined_referenced_steps_remain_acyclic_rejects_cycle() {
        let layers = vec![
            json!({ "id": "layer-1", "referencedSteps": ["layer-2"] }),
            json!({ "id": "layer-2", "referencedSteps": ["layer-1"] }),
        ];
        assert!(ensure_refined_referenced_steps_remain_acyclic(&layers).is_err());
    }

    #[test]
    fn detect_dependency_cycle_self_reference() {
        let edges = vec![("a".to_string(), vec!["a".to_string()])];
        assert!(detect_dependency_cycle(&edges));
    }

    #[test]
    fn touch_refined_configuration_modified_timestamp_sets_timestamp() {
        let touched = touch_refined_configuration_modified_timestamp(sample_configuration());
        let modified = touched
            .get("metadata")
            .and_then(|m| m.get("modified"))
            .and_then(|t| t.as_str())
            .unwrap();
        assert_eq!(modified, "2026-07-07T00:00:00.000Z");
    }

    #[test]
    fn touch_refined_configuration_modified_timestamp_creates_metadata() {
        let touched = touch_refined_configuration_modified_timestamp(json!({ "name": "x" }));
        assert!(touched.get("metadata").unwrap().get("modified").is_some());
    }

    #[test]
    fn map_refinement_completion_failure_to_http_error_maps_variants() {
        let denied = map_refinement_completion_failure_to_http_error(
            ApplicationError::AuthorizationWasDenied,
        );
        assert!(matches!(denied, HttpError::AuthorizationWasDenied { .. }));
        let not_found = map_refinement_completion_failure_to_http_error(
            ApplicationError::RequestedResourceCouldNotBeLocated,
        );
        assert!(matches!(not_found, HttpError::RequestedResourceWasNotFound { .. }));
        let upstream = map_refinement_completion_failure_to_http_error(
            ApplicationError::ArtificialIntelligenceAdapterFailure {
                failure_description: "boom".to_string(),
            },
        );
        assert!(matches!(upstream, HttpError::UpstreamApplicationFailure { .. }));
    }

    #[test]
    fn assemble_refined_configuration_response_payload_builds_shape() {
        let payload = assemble_refined_configuration_response_payload(
            "did it".to_string(),
            json!({ "name": "agent" }),
        );
        assert_eq!(payload.get("explanation").unwrap().as_str().unwrap(), "did it");
        assert_eq!(
            payload.get("agent").unwrap().get("name").unwrap().as_str().unwrap(),
            "agent"
        );
    }
}
