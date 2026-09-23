use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};

/// GET handler that returns a machine-readable description of the LaTeX-to-JSON
/// conversion service. This endpoint is purely descriptive: it advertises the
/// request/response schema, supported document environments, and the validation
/// rules that the companion conversion endpoint enforces. No AI generation is
/// performed here, so the handler only needs the (currently unused) extractors.
#[route(method = "GET", path = "/api/latex-to-json-ai")]
pub async fn describe_latex_to_json_service_handler<TransactionalUnitOfWork>(
    State(_application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let required_field = describe_required_latex_source_field();
    let supported_environments = list_supported_latex_document_environments();
    let response_body =
        assemble_latex_to_json_service_response_body(required_field, supported_environments);
    Ok(Json(response_body))
}

/// (1) Build the top-level descriptor object for the LaTeX-to-JSON service.
/// This is the canonical, self-contained description assembled from the
/// individual schema/behavior helpers below.
fn build_latex_to_json_service_descriptor() -> Value {
    json!({
        "service": "latex to json conversion",
        "version": describe_latex_to_json_service_version(),
        "route": describe_latex_to_json_endpoint_route(),
        "request_schema": build_latex_to_json_request_field_schema(),
        "response_schema": build_latex_to_json_response_field_schema(),
        "code_fence_stripping": describe_json_code_fence_stripping_behavior(),
        "raw_text_fallback": describe_raw_text_fallback_representation_contract(),
        "brace_balancing": describe_latex_brace_balancing_validation_rule(),
        "non_empty_source_rule": describe_latex_source_non_empty_text_rule(),
    })
}

/// (2) The single required field name that a conversion request must supply.
fn describe_required_latex_source_field() -> &'static str {
    "latex"
}

/// (3) Describe the shape of the request field the conversion endpoint accepts.
fn build_latex_to_json_request_field_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "latex": {
                "type": "string",
                "required": true,
                "description": "The raw LaTeX source to convert into a JSON structure.",
                "constraint": describe_latex_source_non_empty_text_rule(),
            }
        }
    })
}

/// (4) Describe the shape of the JSON body the conversion endpoint returns.
fn build_latex_to_json_response_field_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "json": {
                "type": ["object", "array", "string"],
                "description": "The structured representation parsed from the LaTeX source.",
            },
            "raw_text_fallback": {
                "type": "string",
                "description": describe_raw_text_fallback_representation_contract(),
            }
        }
    })
}

/// (5) Describe the HTTP route (method + path) that serves this descriptor.
fn describe_latex_to_json_endpoint_route() -> Value {
    json!({
        "method": "GET",
        "path": "/api/latex-to-json-ai",
    })
}

/// (6) Explain how the service strips Markdown code fences from AI output before
/// attempting to parse it as JSON.
fn describe_json_code_fence_stripping_behavior() -> &'static str {
    "Leading and trailing Markdown code fences (```json ... ```) are removed \
     from the model output before the remaining text is parsed as JSON."
}

/// (7) The list of LaTeX document environments the converter understands.
fn list_supported_latex_document_environments() -> Vec<&'static str> {
    vec![
        "document",
        "itemize",
        "enumerate",
        "tabular",
        "equation",
        "figure",
        "table",
        "abstract",
    ]
}

/// (8) State the rule that the LaTeX source must be non-empty text.
fn describe_latex_source_non_empty_text_rule() -> &'static str {
    "The `latex` field must be non-empty text after trimming surrounding \
     whitespace; empty or whitespace-only input is rejected as malformed."
}

/// (9) Provide an example request body for documentation clients.
fn build_latex_to_json_example_request_body() -> Value {
    json!({
        "latex": "\\begin{itemize}\\item First\\item Second\\end{itemize}"
    })
}

/// (10) Provide an example response body for documentation clients.
fn build_latex_to_json_example_response_body() -> Value {
    json!({
        "json": {
            "itemize": ["First", "Second"]
        },
        "raw_text_fallback": null
    })
}

/// (11) Describe the contract for the raw-text fallback representation used when
/// structured parsing is not possible.
fn describe_raw_text_fallback_representation_contract() -> &'static str {
    "When the LaTeX source cannot be mapped to a structured object, the service \
     returns the original text under `raw_text_fallback` and sets `json` to \
     that same string so callers always receive a usable value."
}

/// (12) Describe the brace-balancing validation rule applied to LaTeX source.
fn describe_latex_brace_balancing_validation_rule() -> &'static str {
    "Curly braces `{` and `}` in the LaTeX source must be balanced; an unequal \
     count of opening and closing braces is rejected as malformed input."
}

/// (13) Assemble the full response body returned by the handler, combining the
/// descriptor with the runtime-supplied required field and environment list.
fn assemble_latex_to_json_service_response_body(
    required_field: &'static str,
    supported_environments: Vec<&'static str>,
) -> Value {
    json!({
        "service": "latex to json conversion",
        "required_field": required_field,
        "supported_environments": supported_environments,
        "descriptor": build_latex_to_json_service_descriptor(),
        "example_request": build_latex_to_json_example_request_body(),
        "example_response": build_latex_to_json_example_response_body(),
        "health": build_latex_to_json_service_health_indicator(),
    })
}

/// (14) Report the semantic version string of the descriptor contract.
fn describe_latex_to_json_service_version() -> &'static str {
    "1.0.0"
}

/// (15) Build a small health indicator object for the descriptor payload.
fn build_latex_to_json_service_health_indicator() -> Value {
    json!({
        "status": "ok",
        "descriptive_only": true,
        "supported_environment_count": list_supported_latex_document_environments().len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptor_contains_expected_top_level_keys() {
        let descriptor = build_latex_to_json_service_descriptor();
        assert_eq!(descriptor["service"], "latex to json conversion");
        assert!(descriptor.get("version").is_some());
        assert!(descriptor.get("route").is_some());
        assert!(descriptor.get("request_schema").is_some());
        assert!(descriptor.get("response_schema").is_some());
    }

    #[test]
    fn descriptor_is_a_json_object_not_scalar() {
        let descriptor = build_latex_to_json_service_descriptor();
        assert!(descriptor.is_object());
        // A bad shape (e.g. a bare string) would fail this.
        assert!(!descriptor.is_string());
    }

    #[test]
    fn required_latex_source_field_is_latex() {
        assert_eq!(describe_required_latex_source_field(), "latex");
    }

    #[test]
    fn required_latex_source_field_is_not_empty() {
        assert!(!describe_required_latex_source_field().is_empty());
    }

    #[test]
    fn request_field_schema_marks_latex_required() {
        let schema = build_latex_to_json_request_field_schema();
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["properties"]["latex"]["required"], true);
    }

    #[test]
    fn request_field_schema_has_no_unexpected_body_property() {
        let schema = build_latex_to_json_request_field_schema();
        assert!(schema["properties"].get("body").is_none());
        assert!(schema["properties"].get("latex").is_some());
    }

    #[test]
    fn response_field_schema_documents_fallback() {
        let schema = build_latex_to_json_response_field_schema();
        assert!(schema["properties"]["raw_text_fallback"].is_object());
        assert_eq!(schema["properties"]["raw_text_fallback"]["type"], "string");
    }

    #[test]
    fn response_field_schema_missing_json_key_would_fail() {
        let schema = build_latex_to_json_response_field_schema();
        // Good input: the json property exists.
        assert!(schema["properties"].get("json").is_some());
        // Bad-shape guard: the top level is an object, not an array.
        assert!(!schema.is_array());
    }

    #[test]
    fn endpoint_route_reports_get_and_path() {
        let route = describe_latex_to_json_endpoint_route();
        assert_eq!(route["method"], "GET");
        assert_eq!(route["path"], "/api/latex-to-json-ai");
    }

    #[test]
    fn endpoint_route_is_not_post() {
        let route = describe_latex_to_json_endpoint_route();
        assert_ne!(route["method"], "POST");
    }

    #[test]
    fn code_fence_stripping_description_mentions_fences() {
        let text = describe_json_code_fence_stripping_behavior();
        assert!(text.contains("```"));
        assert!(!text.is_empty());
    }

    #[test]
    fn code_fence_stripping_description_is_stable_nonempty() {
        assert!(describe_json_code_fence_stripping_behavior().len() > 10);
    }

    #[test]
    fn supported_environments_include_document_and_itemize() {
        let environments = list_supported_latex_document_environments();
        assert!(environments.contains(&"document"));
        assert!(environments.contains(&"itemize"));
    }

    #[test]
    fn supported_environments_exclude_unknown_environment() {
        let environments = list_supported_latex_document_environments();
        assert!(!environments.contains(&"nonexistent_environment"));
        assert!(!environments.is_empty());
    }

    #[test]
    fn non_empty_source_rule_mentions_latex_field() {
        let rule = describe_latex_source_non_empty_text_rule();
        assert!(rule.contains("latex"));
        assert!(rule.contains("non-empty"));
    }

    #[test]
    fn non_empty_source_rule_is_not_placeholder() {
        let rule = describe_latex_source_non_empty_text_rule();
        assert_ne!(rule, "todo");
        assert!(rule.len() > 20);
    }

    #[test]
    fn example_request_body_uses_latex_key() {
        let body = build_latex_to_json_example_request_body();
        assert!(body.get("latex").is_some());
        assert!(body["latex"].as_str().unwrap().contains("itemize"));
    }

    #[test]
    fn example_request_body_has_no_json_key() {
        let body = build_latex_to_json_example_request_body();
        assert!(body.get("json").is_none());
    }

    #[test]
    fn example_response_body_has_json_and_fallback() {
        let body = build_latex_to_json_example_response_body();
        assert!(body.get("json").is_some());
        assert!(body.get("raw_text_fallback").is_some());
    }

    #[test]
    fn example_response_body_json_is_object() {
        let body = build_latex_to_json_example_response_body();
        assert!(body["json"].is_object());
        assert!(!body["json"].is_string());
    }

    #[test]
    fn raw_text_fallback_contract_mentions_fallback_key() {
        let contract = describe_raw_text_fallback_representation_contract();
        assert!(contract.contains("raw_text_fallback"));
        assert!(contract.contains("json"));
    }

    #[test]
    fn raw_text_fallback_contract_is_descriptive() {
        assert!(describe_raw_text_fallback_representation_contract().len() > 30);
    }

    #[test]
    fn brace_balancing_rule_mentions_braces() {
        let rule = describe_latex_brace_balancing_validation_rule();
        assert!(rule.contains("{"));
        assert!(rule.contains("}"));
    }

    #[test]
    fn brace_balancing_rule_mentions_balance() {
        let rule = describe_latex_brace_balancing_validation_rule();
        assert!(rule.contains("balanced") || rule.contains("balancing"));
    }

    #[test]
    fn assembled_response_body_has_required_field_and_environments() {
        let required_field = describe_required_latex_source_field();
        let environments = list_supported_latex_document_environments();
        let expected_count = environments.len();
        let body = assemble_latex_to_json_service_response_body(required_field, environments);
        assert_eq!(body["required_field"], "latex");
        assert_eq!(
            body["supported_environments"].as_array().unwrap().len(),
            expected_count
        );
    }

    #[test]
    fn assembled_response_body_with_empty_environments_is_valid() {
        let body = assemble_latex_to_json_service_response_body("latex", Vec::new());
        assert_eq!(body["required_field"], "latex");
        assert_eq!(body["supported_environments"].as_array().unwrap().len(), 0);
        assert!(body["descriptor"].is_object());
    }

    #[test]
    fn service_version_is_semver_like() {
        let version = describe_latex_to_json_service_version();
        assert_eq!(version.split('.').count(), 3);
    }

    #[test]
    fn service_version_is_not_zero_zero_zero() {
        assert_ne!(describe_latex_to_json_service_version(), "0.0.0");
    }

    #[test]
    fn health_indicator_reports_ok_status() {
        let health = build_latex_to_json_service_health_indicator();
        assert_eq!(health["status"], "ok");
        assert_eq!(health["descriptive_only"], true);
    }

    #[test]
    fn health_indicator_environment_count_matches_list() {
        let health = build_latex_to_json_service_health_indicator();
        let expected = list_supported_latex_document_environments().len();
        assert_eq!(
            health["supported_environment_count"].as_u64().unwrap() as usize,
            expected
        );
    }
}
