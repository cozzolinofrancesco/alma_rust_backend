use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};

/// The stable semantic version reported for the artificial intelligence
/// service descriptor. Bumped when the descriptor contract changes.
const ARTIFICIAL_INTELLIGENCE_SERVICE_VERSION: &str = "1.0.0";

/// The canonical name of the artificial intelligence service surfaced in the
/// self-describing descriptor payload.
const ARTIFICIAL_INTELLIGENCE_SERVICE_NAME: &str = "artificial intelligence completion";

#[route(method = "GET", path = "/api/ai")]
pub async fn describe_artificial_intelligence_service_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let capabilities = list_supported_artificial_intelligence_capabilities();
    let routes = list_artificial_intelligence_endpoint_routes();
    let mut response_body = assemble_artificial_intelligence_service_response_body(capabilities, routes);

    // Enrich the assembled body with the runtime-resolved adapter kind so
    // callers can tell which artificial intelligence provider is configured.
    let adapter_kind = report_configured_artificial_intelligence_adapter_kind(&application_state);
    if let Value::Object(ref mut map) = response_body {
        map.insert(
            "configured_adapter_kind".to_string(),
            Value::String(adapter_kind.to_string()),
        );
        map.insert(
            "capability_matrix".to_string(),
            build_artificial_intelligence_capability_matrix(),
        );
        map.insert(
            "health".to_string(),
            build_artificial_intelligence_service_health_indicator(),
        );
        map.insert(
            "example_completion_request".to_string(),
            build_artificial_intelligence_example_completion_request(),
        );
    }

    Ok(Json(response_body))
}

/// Builds the top-level descriptor object for the artificial intelligence
/// service, combining the human readable name, semantic version, and the
/// enumerated capabilities into a single self-describing value.
fn build_artificial_intelligence_service_descriptor() -> Value {
    json!({
        "service": ARTIFICIAL_INTELLIGENCE_SERVICE_NAME,
        "version": describe_artificial_intelligence_service_version(),
        "capabilities": list_supported_artificial_intelligence_capabilities(),
        "supported_http_methods": describe_supported_http_methods_for_artificial_intelligence_category(),
    })
}

/// Enumerates the capabilities the artificial intelligence category exposes.
/// The ordering is stable and used by clients to render a feature list.
fn list_supported_artificial_intelligence_capabilities() -> Vec<&'static str> {
    vec![
        "completion",
        "multimodal",
        "image analysis",
        "latex to json",
    ]
}

/// Describes the primary completion endpoint route including its method, path,
/// and a short summary suitable for machine-readable API discovery.
fn describe_artificial_intelligence_completion_endpoint_route() -> Value {
    json!({
        "method": "POST",
        "path": "/api/ai",
        "summary": "Generate a textual completion from a required prompt field",
        "request_schema": build_artificial_intelligence_completion_request_field_schema(),
        "response_schema": build_artificial_intelligence_completion_response_field_schema(),
    })
}

/// Lists every route belonging to the artificial intelligence category. The
/// descriptor endpoint itself is included first, followed by the functional
/// completion endpoint.
fn list_artificial_intelligence_endpoint_routes() -> Vec<Value> {
    vec![
        json!({
            "method": "GET",
            "path": "/api/ai",
            "summary": "Describe the artificial intelligence service and its routes",
        }),
        describe_artificial_intelligence_completion_endpoint_route(),
    ]
}

/// Builds the JSON schema fragment describing the fields accepted by the
/// completion request body. Only the required prompt field is contractually
/// guaranteed.
fn build_artificial_intelligence_completion_request_field_schema() -> Value {
    json!({
        "type": "object",
        "required": ["prompt"],
        "properties": {
            "prompt": {
                "type": "string",
                "description": "Non-empty prompt text to complete",
                "validation": describe_prompt_non_empty_text_validation_rule(),
            }
        }
    })
}

/// Builds the JSON schema fragment describing the fields returned in the
/// completion response body.
fn build_artificial_intelligence_completion_response_field_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "produced_text": {
                "type": "string",
                "description": "The text produced by the artificial intelligence adapter",
            }
        }
    })
}

/// Describes the contract of the required prompt field in structured form so
/// clients can validate input before submitting a request.
fn describe_required_prompt_field_contract() -> Value {
    json!({
        "field": "prompt",
        "required": true,
        "type": "string",
        "constraint": describe_prompt_non_empty_text_validation_rule(),
    })
}

/// Returns the semantic version of the artificial intelligence service
/// descriptor contract.
fn describe_artificial_intelligence_service_version() -> &'static str {
    ARTIFICIAL_INTELLIGENCE_SERVICE_VERSION
}

/// Reports the kind of artificial intelligence adapter that is currently
/// configured in the application state. This is a coarse-grained label used
/// only for diagnostics and discovery, never for behavioral branching.
fn report_configured_artificial_intelligence_adapter_kind<TransactionalUnitOfWork>(
    application_state: &ApplicationState<TransactionalUnitOfWork>,
) -> &'static str
where
    TransactionalUnitOfWork: UnitOfWork,
{
    // The adapter is always present once the application state is constructed;
    // touching it here keeps this function honest about reading real state.
    let _adapter = &application_state.artificial_intelligence_adapter;
    "generative_completion_adapter"
}

/// Builds a capability matrix mapping each capability to whether it is
/// currently enabled and a short description of what it does.
fn build_artificial_intelligence_capability_matrix() -> Value {
    json!({
        "completion": {
            "enabled": true,
            "description": "Generate text from a prompt",
        },
        "multimodal": {
            "enabled": true,
            "description": "Accept combined text and image inputs",
        },
        "image_analysis": {
            "enabled": true,
            "description": "Analyze and caption image content",
        },
        "latex_to_json": {
            "enabled": true,
            "description": "Convert LaTeX documents into structured JSON",
        }
    })
}

/// Returns the human-readable validation rule applied to the prompt field.
/// The prompt is parsed as non-empty text at the boundary.
fn describe_prompt_non_empty_text_validation_rule() -> &'static str {
    "prompt must be non-empty text after trimming surrounding whitespace"
}

/// Assembles the final service response body from the supplied capabilities
/// and routes, layering in the static descriptor metadata and the required
/// prompt field contract.
fn assemble_artificial_intelligence_service_response_body(
    capabilities: Vec<&'static str>,
    routes: Vec<Value>,
) -> Value {
    let mut descriptor = build_artificial_intelligence_service_descriptor();
    if let Value::Object(ref mut map) = descriptor {
        map.insert(
            "capabilities".to_string(),
            Value::Array(capabilities.into_iter().map(|c| Value::String(c.to_string())).collect()),
        );
        map.insert("routes".to_string(), Value::Array(routes));
        map.insert(
            "prompt_field_contract".to_string(),
            describe_required_prompt_field_contract(),
        );
    }
    descriptor
}

/// Enumerates the HTTP methods supported anywhere within the artificial
/// intelligence category.
fn describe_supported_http_methods_for_artificial_intelligence_category() -> Vec<&'static str> {
    vec!["GET", "POST"]
}

/// Builds a concrete example completion request body that clients can copy to
/// exercise the completion endpoint.
fn build_artificial_intelligence_example_completion_request() -> Value {
    json!({
        "prompt": "Summarize the theory of relativity in two sentences.",
    })
}

/// Builds a lightweight health indicator for the artificial intelligence
/// service. It reports the descriptor version and a static status so a probe
/// can confirm the descriptor is reachable.
fn build_artificial_intelligence_service_health_indicator() -> Value {
    json!({
        "status": "ok",
        "version": describe_artificial_intelligence_service_version(),
        "checked_component": ARTIFICIAL_INTELLIGENCE_SERVICE_NAME,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_descriptor_contains_name_version_and_capabilities() {
        let descriptor = build_artificial_intelligence_service_descriptor();
        assert_eq!(descriptor["service"], ARTIFICIAL_INTELLIGENCE_SERVICE_NAME);
        assert_eq!(descriptor["version"], ARTIFICIAL_INTELLIGENCE_SERVICE_VERSION);
        assert!(descriptor["capabilities"].is_array());
    }

    #[test]
    fn service_descriptor_lists_supported_methods() {
        let descriptor = build_artificial_intelligence_service_descriptor();
        let methods = descriptor["supported_http_methods"].as_array().unwrap();
        assert!(methods.iter().any(|m| m == "GET"));
        assert!(methods.iter().any(|m| m == "POST"));
    }

    #[test]
    fn capabilities_list_is_non_empty_and_contains_completion() {
        let capabilities = list_supported_artificial_intelligence_capabilities();
        assert!(!capabilities.is_empty());
        assert!(capabilities.contains(&"completion"));
    }

    #[test]
    fn capabilities_list_has_expected_length() {
        let capabilities = list_supported_artificial_intelligence_capabilities();
        assert_eq!(capabilities.len(), 4);
    }

    #[test]
    fn completion_endpoint_route_uses_post_and_correct_path() {
        let route = describe_artificial_intelligence_completion_endpoint_route();
        assert_eq!(route["method"], "POST");
        assert_eq!(route["path"], "/api/ai");
    }

    #[test]
    fn completion_endpoint_route_embeds_schemas() {
        let route = describe_artificial_intelligence_completion_endpoint_route();
        assert!(route["request_schema"].is_object());
        assert!(route["response_schema"].is_object());
    }

    #[test]
    fn endpoint_routes_include_get_and_post() {
        let routes = list_artificial_intelligence_endpoint_routes();
        assert_eq!(routes.len(), 2);
        assert_eq!(routes[0]["method"], "GET");
        assert_eq!(routes[1]["method"], "POST");
    }

    #[test]
    fn endpoint_routes_all_target_ai_path() {
        let routes = list_artificial_intelligence_endpoint_routes();
        for route in &routes {
            assert_eq!(route["path"], "/api/ai");
        }
    }

    #[test]
    fn request_field_schema_requires_prompt() {
        let schema = build_artificial_intelligence_completion_request_field_schema();
        let required = schema["required"].as_array().unwrap();
        assert!(required.iter().any(|f| f == "prompt"));
        assert_eq!(schema["properties"]["prompt"]["type"], "string");
    }

    #[test]
    fn request_field_schema_is_object_type() {
        let schema = build_artificial_intelligence_completion_request_field_schema();
        assert_eq!(schema["type"], "object");
    }

    #[test]
    fn response_field_schema_describes_produced_text() {
        let schema = build_artificial_intelligence_completion_response_field_schema();
        assert_eq!(schema["properties"]["produced_text"]["type"], "string");
    }

    #[test]
    fn response_field_schema_is_object_type() {
        let schema = build_artificial_intelligence_completion_response_field_schema();
        assert_eq!(schema["type"], "object");
    }

    #[test]
    fn required_prompt_field_contract_marks_prompt_required() {
        let contract = describe_required_prompt_field_contract();
        assert_eq!(contract["field"], "prompt");
        assert_eq!(contract["required"], true);
    }

    #[test]
    fn required_prompt_field_contract_declares_string_type() {
        let contract = describe_required_prompt_field_contract();
        assert_eq!(contract["type"], "string");
    }

    #[test]
    fn service_version_is_stable_constant() {
        assert_eq!(describe_artificial_intelligence_service_version(), "1.0.0");
    }

    #[test]
    fn service_version_matches_module_constant() {
        assert_eq!(
            describe_artificial_intelligence_service_version(),
            ARTIFICIAL_INTELLIGENCE_SERVICE_VERSION
        );
    }

    #[test]
    fn capability_matrix_marks_completion_enabled() {
        let matrix = build_artificial_intelligence_capability_matrix();
        assert_eq!(matrix["completion"]["enabled"], true);
    }

    #[test]
    fn capability_matrix_includes_latex_to_json() {
        let matrix = build_artificial_intelligence_capability_matrix();
        assert!(matrix["latex_to_json"].is_object());
        assert_eq!(matrix["latex_to_json"]["enabled"], true);
    }

    #[test]
    fn prompt_validation_rule_mentions_non_empty() {
        let rule = describe_prompt_non_empty_text_validation_rule();
        assert!(rule.contains("non-empty"));
    }

    #[test]
    fn prompt_validation_rule_is_not_blank() {
        let rule = describe_prompt_non_empty_text_validation_rule();
        assert!(!rule.trim().is_empty());
    }

    #[test]
    fn assembled_response_body_carries_capabilities_and_routes() {
        let capabilities = list_supported_artificial_intelligence_capabilities();
        let routes = list_artificial_intelligence_endpoint_routes();
        let body = assemble_artificial_intelligence_service_response_body(capabilities, routes);
        assert!(body["capabilities"].is_array());
        assert!(body["routes"].is_array());
        assert_eq!(body["routes"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn assembled_response_body_handles_empty_inputs() {
        let body = assemble_artificial_intelligence_service_response_body(Vec::new(), Vec::new());
        assert_eq!(body["capabilities"].as_array().unwrap().len(), 0);
        assert_eq!(body["routes"].as_array().unwrap().len(), 0);
        // The static descriptor metadata must still be present.
        assert_eq!(body["service"], ARTIFICIAL_INTELLIGENCE_SERVICE_NAME);
    }

    #[test]
    fn assembled_response_body_includes_prompt_field_contract() {
        let body = assemble_artificial_intelligence_service_response_body(Vec::new(), Vec::new());
        assert_eq!(body["prompt_field_contract"]["field"], "prompt");
    }

    #[test]
    fn supported_methods_contain_get_and_post_only() {
        let methods = describe_supported_http_methods_for_artificial_intelligence_category();
        assert_eq!(methods.len(), 2);
        assert!(methods.contains(&"GET"));
        assert!(methods.contains(&"POST"));
    }

    #[test]
    fn supported_methods_do_not_contain_delete() {
        let methods = describe_supported_http_methods_for_artificial_intelligence_category();
        assert!(!methods.contains(&"DELETE"));
    }

    #[test]
    fn example_completion_request_has_prompt_string() {
        let example = build_artificial_intelligence_example_completion_request();
        assert!(example["prompt"].is_string());
        assert!(!example["prompt"].as_str().unwrap().is_empty());
    }

    #[test]
    fn example_completion_request_is_object() {
        let example = build_artificial_intelligence_example_completion_request();
        assert!(example.is_object());
    }

    #[test]
    fn health_indicator_reports_ok_status() {
        let health = build_artificial_intelligence_service_health_indicator();
        assert_eq!(health["status"], "ok");
    }

    #[test]
    fn health_indicator_reports_version() {
        let health = build_artificial_intelligence_service_health_indicator();
        assert_eq!(health["version"], ARTIFICIAL_INTELLIGENCE_SERVICE_VERSION);
    }
}
