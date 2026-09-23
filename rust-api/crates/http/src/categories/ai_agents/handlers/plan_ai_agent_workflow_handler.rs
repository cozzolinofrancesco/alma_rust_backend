use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};

/// Default large-language-model identifier assigned to planned steps when the
/// generated plan does not specify one of its own.
const DEFAULT_PLANNING_MODEL_NAME: &str = "claude-sonnet-4-5";

#[route(method = "POST", path = "/api/ai-agents/plan")]
pub async fn plan_ai_agent_workflow_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // 1. Pull the free-text description of the workflow the caller wants planned.
    let raw_planning_text = extract_planning_text_field(&submitted_body)?;
    let planning_text = parse_planning_text_into_non_empty_text(raw_planning_text)?;

    // 2. Collect any document paths the caller pre-selected so we can wire them
    //    into the plan deterministically instead of trusting the model for that.
    let provided_document_paths = extract_optional_provided_document_paths(&submitted_body);
    let inferred_document_types = infer_document_types_from_document_paths(&provided_document_paths);

    // 3. Ask the AI adapter to produce a structured plan.
    let planning_prompt = build_workflow_planning_prompt(&planning_text, &provided_document_paths);
    let generated_completion = application_state
        .artificial_intelligence_adapter
        .generate_completion(&planning_prompt)
        .await
        .map_err(map_planning_completion_failure_to_http_error)?;

    // 4. Parse the model output into a plan object we can validate and normalize.
    let produced_plan_text = extract_produced_plan_text_from_completion(generated_completion);
    let workflow_plan = parse_workflow_plan_from_completion_text(&produced_plan_text)?;

    // 5. Validate the structure of the plan and normalize its step data.
    let planned_step_names = extract_planned_step_names_array(&workflow_plan)?;
    let planned_step_tasks = extract_planned_step_tasks_array(&workflow_plan)?;
    let planned_step_count =
        ensure_step_names_and_step_tasks_have_equal_length(&planned_step_names, &planned_step_tasks)?;

    // 6. Resolve model + document assignments deterministically.
    let default_model_name = resolve_default_model_name_for_planned_steps(&workflow_plan);
    let per_step_model_assignments =
        build_per_step_model_assignments(planned_step_count, &default_model_name);
    let document_assignments =
        build_linear_document_assignments_for_steps(planned_step_count, &provided_document_paths);

    // 7. Assemble the final response payload.
    let response_payload = assemble_workflow_plan_response_payload(
        planned_step_names,
        planned_step_tasks,
        per_step_model_assignments,
        document_assignments,
        provided_document_paths,
        inferred_document_types,
    );

    Ok(Json(response_payload))
}

/// (1) Extract the required `text` field describing the workflow to plan.
fn extract_planning_text_field(submitted_body: &Value) -> Result<String, HttpError> {
    submitted_body
        .get("text")
        .and_then(|candidate_value| candidate_value.as_str())
        .map(|value| value.to_string())
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: String::from("the 'text' field is required and must be a string"),
        })
}

/// (2) Parse the raw planning text into a validated `NonEmptyText`.
fn parse_planning_text_into_non_empty_text(
    raw_planning_text: String,
) -> Result<alma_domain::value_objects::NonEmptyText, HttpError> {
    alma_domain::value_objects::NonEmptyText::parse(raw_planning_text).map_err(|parsing_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: parsing_error.to_string(),
        }
    })
}

/// (3) Extract the optional `documentPaths` array; missing/invalid entries are
/// simply ignored, yielding an empty vector.
fn extract_optional_provided_document_paths(submitted_body: &Value) -> Vec<String> {
    submitted_body
        .get("documentPaths")
        .and_then(|candidate_value| candidate_value.as_array())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.as_str())
                .map(|entry| entry.trim())
                .filter(|entry| !entry.is_empty())
                .map(|entry| entry.to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// (4) Infer a coarse type label ("folder" or "file") for each supplied path.
fn infer_document_types_from_document_paths(provided_document_paths: &[String]) -> Vec<String> {
    provided_document_paths
        .iter()
        .map(|document_path| {
            let has_extension = document_path
                .rsplit('/')
                .next()
                .map(|last_segment| last_segment.contains('.'))
                .unwrap_or(false);
            if document_path.ends_with('/') || !has_extension {
                String::from("folder")
            } else {
                String::from("file")
            }
        })
        .collect()
}

/// (5) Build the prompt sent to the AI adapter, embedding the planning text and
/// any pre-selected document paths, and instructing the model to reply as JSON.
fn build_workflow_planning_prompt(
    planning_text: &alma_domain::value_objects::NonEmptyText,
    provided_document_paths: &[String],
) -> alma_domain::value_objects::NonEmptyText {
    let mut prompt_body = String::new();
    prompt_body.push_str(
        "You are planning a multi-step AI agent workflow. Respond with a single JSON object \
         and nothing else. The JSON object must contain a \"stepNames\" array of short step \
         titles and a \"stepTasks\" array of matching step instructions (same length as \
         stepNames). It may optionally contain a \"defaultModel\" string.\n\n",
    );
    prompt_body.push_str("Workflow description:\n");
    prompt_body.push_str(planning_text.as_str());

    if !provided_document_paths.is_empty() {
        prompt_body.push_str("\n\nThe following documents are available to the workflow:\n");
        for document_path in provided_document_paths {
            prompt_body.push_str("- ");
            prompt_body.push_str(document_path);
            prompt_body.push('\n');
        }
    }

    // The prompt is assembled from a non-empty literal, so parsing cannot fail;
    // fall back to the planning text itself if it somehow does.
    alma_domain::value_objects::NonEmptyText::parse(prompt_body)
        .unwrap_or_else(|_| planning_text.clone())
}

/// (6) Pull the produced text out of the AI completion.
fn extract_produced_plan_text_from_completion(
    generated_completion: alma_application::ports::ai::GeneratedCompletion,
) -> String {
    generated_completion.produced_text
}

/// (7) Parse the model's produced text into a JSON plan object. The model may
/// wrap the JSON in prose or code fences, so isolate the outermost object first.
fn parse_workflow_plan_from_completion_text(produced_plan_text: &str) -> Result<Value, HttpError> {
    let candidate_json = isolate_outermost_json_object(produced_plan_text).ok_or_else(|| {
        HttpError::UpstreamApplicationFailure {
            explanation: String::from(
                "the planning model did not return a recognizable JSON object",
            ),
        }
    })?;

    let parsed: Value =
        serde_json::from_str(candidate_json).map_err(|parsing_error| {
            HttpError::UpstreamApplicationFailure {
                explanation: format!("the planning model returned invalid JSON: {parsing_error}"),
            }
        })?;

    if !parsed.is_object() {
        return Err(HttpError::UpstreamApplicationFailure {
            explanation: String::from("the planning model returned JSON that was not an object"),
        });
    }
    Ok(parsed)
}

/// Helper: return the substring spanning the first `{` to its matching `}`.
fn isolate_outermost_json_object(candidate_text: &str) -> Option<&str> {
    let start_index = candidate_text.find('{')?;
    let mut depth: usize = 0;
    for (offset, character) in candidate_text[start_index..].char_indices() {
        match character {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    let end_index = start_index + offset + character.len_utf8();
                    return Some(&candidate_text[start_index..end_index]);
                }
            }
            _ => {}
        }
    }
    None
}

/// (8) Extract the `stepNames` array from the plan, requiring at least one entry.
fn extract_planned_step_names_array(workflow_plan: &Value) -> Result<Vec<String>, HttpError> {
    let names = extract_string_array_field(workflow_plan, "stepNames")?;
    if names.is_empty() {
        return Err(HttpError::UpstreamApplicationFailure {
            explanation: String::from("the planning model returned an empty 'stepNames' array"),
        });
    }
    Ok(names)
}

/// (9) Extract the `stepTasks` array from the plan, requiring at least one entry.
fn extract_planned_step_tasks_array(workflow_plan: &Value) -> Result<Vec<String>, HttpError> {
    let tasks = extract_string_array_field(workflow_plan, "stepTasks")?;
    if tasks.is_empty() {
        return Err(HttpError::UpstreamApplicationFailure {
            explanation: String::from("the planning model returned an empty 'stepTasks' array"),
        });
    }
    Ok(tasks)
}

/// Helper shared by (8) and (9): read a required array-of-strings field.
fn extract_string_array_field(
    workflow_plan: &Value,
    field_name: &str,
) -> Result<Vec<String>, HttpError> {
    let array = workflow_plan
        .get(field_name)
        .and_then(|candidate_value| candidate_value.as_array())
        .ok_or_else(|| HttpError::UpstreamApplicationFailure {
            explanation: format!("the planning model output is missing the '{field_name}' array"),
        })?;

    let mut collected = Vec::with_capacity(array.len());
    for entry in array {
        let entry_text = entry
            .as_str()
            .ok_or_else(|| HttpError::UpstreamApplicationFailure {
                explanation: format!("every entry in '{field_name}' must be a string"),
            })?;
        collected.push(entry_text.to_string());
    }
    Ok(collected)
}

/// (10) Ensure the two parallel arrays line up, returning the shared step count.
fn ensure_step_names_and_step_tasks_have_equal_length(
    planned_step_names: &[String],
    planned_step_tasks: &[String],
) -> Result<usize, HttpError> {
    if planned_step_names.len() != planned_step_tasks.len() {
        return Err(HttpError::UpstreamApplicationFailure {
            explanation: format!(
                "the planning model returned {} step names but {} step tasks",
                planned_step_names.len(),
                planned_step_tasks.len()
            ),
        });
    }
    Ok(planned_step_names.len())
}

/// (11) Resolve the default model name to assign to steps, falling back to the
/// crate default when the plan does not specify a non-empty one.
fn resolve_default_model_name_for_planned_steps(workflow_plan: &Value) -> String {
    workflow_plan
        .get("defaultModel")
        .and_then(|candidate_value| candidate_value.as_str())
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .unwrap_or_else(|| DEFAULT_PLANNING_MODEL_NAME.to_string())
}

/// (12) Produce one model assignment per step using the resolved default.
fn build_per_step_model_assignments(
    planned_step_count: usize,
    default_model_name: &str,
) -> Vec<String> {
    (0..planned_step_count)
        .map(|_| default_model_name.to_string())
        .collect()
}

/// (13) Build a linear document-assignment map. Each step is keyed by its
/// 1-based index. When documents are available, all provided document indices
/// are attached to the first step; remaining steps receive empty arrays.
fn build_linear_document_assignments_for_steps(
    planned_step_count: usize,
    provided_document_paths: &[String],
) -> serde_json::Map<String, Value> {
    let mut assignments = serde_json::Map::new();
    let first_step_document_indices: Vec<Value> = (0..provided_document_paths.len())
        .map(|index| Value::from(index as u64))
        .collect();

    for step_ordinal in 1..=planned_step_count {
        let step_key = step_ordinal.to_string();
        if step_ordinal == 1 && !first_step_document_indices.is_empty() {
            assignments.insert(step_key, Value::Array(first_step_document_indices.clone()));
        } else {
            assignments.insert(step_key, Value::Array(Vec::new()));
        }
    }
    assignments
}

/// (14) Translate an application-layer failure from the AI adapter into the
/// appropriate transport-level error.
fn map_planning_completion_failure_to_http_error(
    originating_application_error: alma_application::error::ApplicationError,
) -> HttpError {
    match originating_application_error {
        alma_application::error::ApplicationError::AuthorizationWasDenied => {
            HttpError::AuthorizationWasDenied {
                explanation: String::from(
                    "the principal is not authorized to plan an agent workflow",
                ),
            }
        }
        alma_application::error::ApplicationError::RequestedResourceCouldNotBeLocated
        | alma_application::error::ApplicationError::RequestedProjectCouldNotBeLocated => {
            HttpError::RequestedResourceWasNotFound {
                explanation: String::from(
                    "a resource required to plan the workflow could not be located",
                ),
            }
        }
        other_failure => HttpError::UpstreamApplicationFailure {
            explanation: other_failure.to_string(),
        },
    }
}

/// (15) Assemble the final response payload consumed by the frontend planner.
fn assemble_workflow_plan_response_payload(
    planned_step_names: Vec<String>,
    planned_step_tasks: Vec<String>,
    per_step_model_assignments: Vec<String>,
    document_assignments: serde_json::Map<String, Value>,
    provided_document_paths: Vec<String>,
    inferred_document_types: Vec<String>,
) -> Value {
    let step_count = planned_step_names.len();
    let uses_documents = !provided_document_paths.is_empty();
    json!({
        "plan": {
            "stepCount": step_count,
            "stepNames": planned_step_names,
            "stepTasks": planned_step_tasks,
            "stepModels": per_step_model_assignments,
            "documentAssignments": Value::Object(document_assignments),
            "documentPaths": provided_document_paths,
            "documentTypes": inferred_document_types,
            "usesDocuments": uses_documents,
            "dependencyStyle": "linear",
            "customDependenciesText": "",
            "defaultModel": DEFAULT_PLANNING_MODEL_NAME
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_planning_text_field_reads_present_string() {
        let body = json!({ "text": "plan a review workflow" });
        let extracted = extract_planning_text_field(&body).expect("field should be present");
        assert_eq!(extracted, "plan a review workflow");
    }

    #[test]
    fn extract_planning_text_field_rejects_missing_field() {
        let body = json!({ "other": 1 });
        assert!(extract_planning_text_field(&body).is_err());
    }

    #[test]
    fn parse_planning_text_into_non_empty_text_accepts_content() {
        let parsed = parse_planning_text_into_non_empty_text("do something".to_string())
            .expect("non-empty text should parse");
        assert_eq!(parsed.as_str(), "do something");
    }

    #[test]
    fn parse_planning_text_into_non_empty_text_rejects_blank() {
        assert!(parse_planning_text_into_non_empty_text("   ".to_string()).is_err());
    }

    #[test]
    fn extract_optional_provided_document_paths_collects_and_trims() {
        let body = json!({ "documentPaths": ["  a/b.pdf ", "", "c/d.txt"] });
        let paths = extract_optional_provided_document_paths(&body);
        assert_eq!(paths, vec!["a/b.pdf".to_string(), "c/d.txt".to_string()]);
    }

    #[test]
    fn extract_optional_provided_document_paths_defaults_to_empty() {
        let body = json!({});
        assert!(extract_optional_provided_document_paths(&body).is_empty());
    }

    #[test]
    fn infer_document_types_distinguishes_files_and_folders() {
        let paths = vec![
            "AF/sources/study.pdf".to_string(),
            "AF/sources/".to_string(),
            "AF/collection".to_string(),
        ];
        let types = infer_document_types_from_document_paths(&paths);
        assert_eq!(
            types,
            vec![
                "file".to_string(),
                "folder".to_string(),
                "folder".to_string()
            ]
        );
    }

    #[test]
    fn build_workflow_planning_prompt_embeds_text_and_paths() {
        let planning_text =
            alma_domain::value_objects::NonEmptyText::parse("analyze studies".to_string()).unwrap();
        let paths = vec!["AF/one.pdf".to_string()];
        let prompt = build_workflow_planning_prompt(&planning_text, &paths);
        assert!(prompt.as_str().contains("analyze studies"));
        assert!(prompt.as_str().contains("AF/one.pdf"));
    }

    #[test]
    fn extract_produced_plan_text_from_completion_returns_inner_text() {
        let completion = alma_application::ports::ai::GeneratedCompletion {
            produced_text: "hello".to_string(),
        };
        assert_eq!(extract_produced_plan_text_from_completion(completion), "hello");
    }

    #[test]
    fn parse_workflow_plan_from_completion_text_handles_fenced_json() {
        let text = "Here is your plan:\n```json\n{\"stepNames\":[\"A\"],\"stepTasks\":[\"do A\"]}\n```";
        let plan = parse_workflow_plan_from_completion_text(text).expect("should parse");
        assert!(plan.get("stepNames").is_some());
    }

    #[test]
    fn parse_workflow_plan_from_completion_text_rejects_non_json() {
        let text = "there is no json here";
        assert!(parse_workflow_plan_from_completion_text(text).is_err());
    }

    #[test]
    fn extract_planned_step_names_array_reads_strings() {
        let plan = json!({ "stepNames": ["First", "Second"] });
        let names = extract_planned_step_names_array(&plan).unwrap();
        assert_eq!(names, vec!["First".to_string(), "Second".to_string()]);
    }

    #[test]
    fn extract_planned_step_names_array_rejects_empty() {
        let plan = json!({ "stepNames": [] });
        assert!(extract_planned_step_names_array(&plan).is_err());
    }

    #[test]
    fn extract_planned_step_tasks_array_reads_strings() {
        let plan = json!({ "stepTasks": ["do first", "do second"] });
        let tasks = extract_planned_step_tasks_array(&plan).unwrap();
        assert_eq!(tasks.len(), 2);
    }

    #[test]
    fn extract_planned_step_tasks_array_rejects_missing() {
        let plan = json!({ "other": 1 });
        assert!(extract_planned_step_tasks_array(&plan).is_err());
    }

    #[test]
    fn ensure_equal_length_accepts_matching() {
        let names = vec!["a".to_string(), "b".to_string()];
        let tasks = vec!["x".to_string(), "y".to_string()];
        assert_eq!(
            ensure_step_names_and_step_tasks_have_equal_length(&names, &tasks).unwrap(),
            2
        );
    }

    #[test]
    fn ensure_equal_length_rejects_mismatch() {
        let names = vec!["a".to_string()];
        let tasks = vec!["x".to_string(), "y".to_string()];
        assert!(ensure_step_names_and_step_tasks_have_equal_length(&names, &tasks).is_err());
    }

    #[test]
    fn resolve_default_model_name_uses_plan_value() {
        let plan = json!({ "defaultModel": "claude-opus-4" });
        assert_eq!(
            resolve_default_model_name_for_planned_steps(&plan),
            "claude-opus-4"
        );
    }

    #[test]
    fn resolve_default_model_name_falls_back() {
        let plan = json!({ "defaultModel": "   " });
        assert_eq!(
            resolve_default_model_name_for_planned_steps(&plan),
            DEFAULT_PLANNING_MODEL_NAME
        );
    }

    #[test]
    fn build_per_step_model_assignments_fills_each_step() {
        let assignments = build_per_step_model_assignments(3, "m");
        assert_eq!(assignments, vec!["m".to_string(); 3]);
    }

    #[test]
    fn build_per_step_model_assignments_zero_steps_is_empty() {
        assert!(build_per_step_model_assignments(0, "m").is_empty());
    }

    #[test]
    fn build_linear_document_assignments_attaches_to_first_step() {
        let paths = vec!["a.pdf".to_string(), "b.pdf".to_string()];
        let assignments = build_linear_document_assignments_for_steps(2, &paths);
        assert_eq!(
            assignments.get("1").unwrap(),
            &json!([0, 1])
        );
        assert_eq!(assignments.get("2").unwrap(), &json!([]));
    }

    #[test]
    fn build_linear_document_assignments_without_documents_is_all_empty() {
        let assignments = build_linear_document_assignments_for_steps(2, &[]);
        assert_eq!(assignments.get("1").unwrap(), &json!([]));
        assert_eq!(assignments.get("2").unwrap(), &json!([]));
    }

    #[test]
    fn map_planning_completion_failure_maps_authorization() {
        let error = alma_application::error::ApplicationError::AuthorizationWasDenied;
        assert!(matches!(
            map_planning_completion_failure_to_http_error(error),
            HttpError::AuthorizationWasDenied { .. }
        ));
    }

    #[test]
    fn map_planning_completion_failure_maps_upstream() {
        let error = alma_application::error::ApplicationError::ArtificialIntelligenceAdapterFailure {
            failure_description: "boom".to_string(),
        };
        assert!(matches!(
            map_planning_completion_failure_to_http_error(error),
            HttpError::UpstreamApplicationFailure { .. }
        ));
    }

    #[test]
    fn assemble_workflow_plan_response_payload_shapes_output() {
        let names = vec!["A".to_string(), "B".to_string()];
        let tasks = vec!["do A".to_string(), "do B".to_string()];
        let models = vec!["m".to_string(), "m".to_string()];
        let mut assignments = serde_json::Map::new();
        assignments.insert("1".to_string(), json!([0]));
        assignments.insert("2".to_string(), json!([]));
        let paths = vec!["a.pdf".to_string()];
        let types = vec!["file".to_string()];

        let payload = assemble_workflow_plan_response_payload(
            names, tasks, models, assignments, paths, types,
        );
        let plan = payload.get("plan").expect("plan key present");
        assert_eq!(plan.get("stepCount").unwrap(), &json!(2));
        assert_eq!(plan.get("usesDocuments").unwrap(), &json!(true));
        assert_eq!(plan.get("dependencyStyle").unwrap(), &json!("linear"));
    }

    #[test]
    fn isolate_outermost_json_object_finds_balanced_object() {
        let text = "prefix {\"a\": {\"b\": 1}} suffix";
        assert_eq!(
            isolate_outermost_json_object(text),
            Some("{\"a\": {\"b\": 1}}")
        );
    }
}
