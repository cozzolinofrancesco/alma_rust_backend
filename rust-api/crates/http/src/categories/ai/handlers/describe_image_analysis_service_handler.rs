use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::NonEmptyText;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};

/// GET metadata endpoint that describes the image analysis service.
///
/// This is a discovery/self-description endpoint: it returns a static
/// descriptor of the request/response schema, supported payloads, and health
/// so front-end clients can validate their requests before actually submitting
/// an image for analysis. It performs no mutation and touches no unit of work.
#[route(method = "GET", path = "/api/image-analysis")]
pub async fn describe_image_analysis_service_handler<TransactionalUnitOfWork>(
    State(_application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let accepted_fields = list_accepted_image_analysis_instruction_fields();
    let mime_types = list_supported_image_payload_mime_types();

    // Validate at least one accepted field name is well-formed as a NonEmptyText.
    // This keeps the descriptor honest: the fields it advertises are real,
    // non-empty identifiers rather than accidental empty strings.
    for field_name in &accepted_fields {
        NonEmptyText::parse(field_name.to_string())
            .map_err(|e| HttpError::RequestBodyWasMalformed {
                explanation: e.to_string(),
            })?;
    }

    let response_body = assemble_image_analysis_service_response_body(accepted_fields, mime_types);
    Ok(Json(response_body))
}

/// Build the top-level descriptor object for the image analysis service.
fn build_image_analysis_service_descriptor() -> serde_json::Value {
    json!({
        "service": "image analysis",
        "summary": "Analyze one or more images guided by a natural-language prompt or caption.",
        "version": describe_image_analysis_service_version(),
        "precedence_rule": describe_prompt_and_caption_field_precedence_rule(),
        "non_empty_text_rule": describe_image_analysis_instruction_non_empty_text_rule(),
        "base64_requirement": describe_image_payload_base64_encoding_requirement(),
        "maximum_accepted_image_payload_count": describe_maximum_accepted_image_payload_count(),
    })
}

/// The instruction fields the endpoint accepts, in precedence order.
fn list_accepted_image_analysis_instruction_fields() -> Vec<&'static str> {
    vec!["prompt", "caption"]
}

/// Human-readable rule describing how prompt and caption interact.
fn describe_prompt_and_caption_field_precedence_rule() -> &'static str {
    "When both `prompt` and `caption` are supplied, `prompt` takes precedence \
     and `caption` is treated as supplementary context."
}

/// JSON schema fragment describing the accepted request fields.
fn build_image_analysis_request_field_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "properties": {
            "prompt": {
                "type": "string",
                "description": "Primary natural-language instruction. Non-empty when present.",
                "required": false
            },
            "caption": {
                "type": "string",
                "description": "Supplementary caption/context. Non-empty when present.",
                "required": false
            },
            "images": {
                "type": "array",
                "description": "Base64-encoded image payloads.",
                "items": {
                    "type": "object",
                    "properties": {
                        "mime_type": {
                            "type": "string",
                            "enum": list_supported_image_payload_mime_types()
                        },
                        "data": {
                            "type": "string",
                            "description": "Base64-encoded image bytes."
                        }
                    },
                    "required": ["mime_type", "data"]
                },
                "maxItems": describe_maximum_accepted_image_payload_count()
            }
        },
        "anyOf": [
            { "required": ["prompt"] },
            { "required": ["caption"] }
        ]
    })
}

/// JSON schema fragment describing the response fields.
fn build_image_analysis_response_field_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "properties": {
            "analysis": {
                "type": "string",
                "description": "The generated textual analysis of the image(s)."
            },
            "instruction_field_used": {
                "type": "string",
                "enum": list_accepted_image_analysis_instruction_fields(),
                "description": "Which instruction field drove the analysis."
            },
            "image_payload_count": {
                "type": "integer",
                "description": "Number of image payloads that were analyzed."
            }
        },
        "required": ["analysis", "instruction_field_used", "image_payload_count"]
    })
}

/// The image MIME types the service will accept as payloads.
fn list_supported_image_payload_mime_types() -> Vec<&'static str> {
    vec![
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
    ]
}

/// Describe the HTTP route (method + path) this endpoint answers on.
fn describe_image_analysis_endpoint_route() -> serde_json::Value {
    json!({
        "method": "GET",
        "path": "/api/image-analysis"
    })
}

/// The maximum number of image payloads accepted in a single request.
fn describe_maximum_accepted_image_payload_count() -> usize {
    8
}

/// Rule describing how image payloads must be encoded.
fn describe_image_payload_base64_encoding_requirement() -> &'static str {
    "Each image payload must be provided as a standard (RFC 4648) base64-encoded \
     string in the `data` field, without a data-URI prefix."
}

/// A worked example request body clients can copy.
fn build_image_analysis_example_request_body() -> serde_json::Value {
    json!({
        "prompt": "Describe the main subject and its surroundings.",
        "caption": "Photo taken during fieldwork.",
        "images": [
            {
                "mime_type": "image/png",
                "data": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCA',...(base64)..."
            }
        ]
    })
}

/// A worked example response body clients can expect.
fn build_image_analysis_example_response_body() -> serde_json::Value {
    json!({
        "analysis": "The image shows a rock outcrop in an arid landscape, with \
                     visible stratification suggesting sedimentary layering.",
        "instruction_field_used": "prompt",
        "image_payload_count": 1
    })
}

/// Rule describing the non-empty-text constraint on instruction fields.
fn describe_image_analysis_instruction_non_empty_text_rule() -> &'static str {
    "Any supplied `prompt` or `caption` must be a non-empty text value; \
     whitespace-only strings are rejected as malformed."
}

/// Assemble the full response body from the dynamic parts.
fn assemble_image_analysis_service_response_body(
    accepted_fields: Vec<&'static str>,
    mime_types: Vec<&'static str>,
) -> serde_json::Value {
    json!({
        "descriptor": build_image_analysis_service_descriptor(),
        "accepted_fields": accepted_fields,
        "supported_image_mime_types": mime_types,
        "route": describe_image_analysis_endpoint_route(),
        "request_schema": build_image_analysis_request_field_schema(),
        "response_schema": build_image_analysis_response_field_schema(),
        "example_request": build_image_analysis_example_request_body(),
        "example_response": build_image_analysis_example_response_body(),
        "health": build_image_analysis_service_health_indicator(),
    })
}

/// The semantic version string of the image analysis service contract.
fn describe_image_analysis_service_version() -> &'static str {
    "1.0.0"
}

/// A small health indicator object for this metadata endpoint.
fn build_image_analysis_service_health_indicator() -> serde_json::Value {
    json!({
        "status": "ok",
        "version": describe_image_analysis_service_version(),
        "route": describe_image_analysis_endpoint_route(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptor_contains_expected_keys() {
        let descriptor = build_image_analysis_service_descriptor();
        assert_eq!(descriptor["service"], "image analysis");
        assert_eq!(descriptor["version"], describe_image_analysis_service_version());
        assert!(descriptor["summary"].is_string());
        assert!(descriptor["precedence_rule"].is_string());
        assert_eq!(
            descriptor["maximum_accepted_image_payload_count"],
            describe_maximum_accepted_image_payload_count()
        );
    }

    #[test]
    fn descriptor_has_no_unexpected_null_fields() {
        let descriptor = build_image_analysis_service_descriptor();
        for (_key, value) in descriptor.as_object().unwrap() {
            assert!(!value.is_null());
        }
    }

    #[test]
    fn accepted_instruction_fields_are_prompt_and_caption_in_order() {
        let fields = list_accepted_image_analysis_instruction_fields();
        assert_eq!(fields, vec!["prompt", "caption"]);
    }

    #[test]
    fn accepted_instruction_fields_are_all_non_empty_text() {
        // Good input: each advertised field parses as NonEmptyText.
        for field in list_accepted_image_analysis_instruction_fields() {
            assert!(NonEmptyText::parse(field.to_string()).is_ok());
        }
        // Bad input: an empty string must not parse.
        assert!(NonEmptyText::parse(String::new()).is_err());
    }

    #[test]
    fn precedence_rule_mentions_both_fields() {
        let rule = describe_prompt_and_caption_field_precedence_rule();
        assert!(rule.contains("prompt"));
        assert!(rule.contains("caption"));
        // Bad case guard: rule must not be empty.
        assert!(!rule.trim().is_empty());
    }

    #[test]
    fn request_schema_declares_object_with_known_properties() {
        let schema = build_image_analysis_request_field_schema();
        assert_eq!(schema["type"], "object");
        assert!(schema["properties"]["prompt"].is_object());
        assert!(schema["properties"]["caption"].is_object());
        assert!(schema["properties"]["images"].is_object());
    }

    #[test]
    fn request_schema_images_max_items_matches_limit() {
        let schema = build_image_analysis_request_field_schema();
        assert_eq!(
            schema["properties"]["images"]["maxItems"],
            describe_maximum_accepted_image_payload_count()
        );
    }

    #[test]
    fn response_schema_requires_core_fields() {
        let schema = build_image_analysis_response_field_schema();
        assert_eq!(schema["type"], "object");
        let required = schema["required"].as_array().unwrap();
        assert!(required.iter().any(|v| v == "analysis"));
        assert!(required.iter().any(|v| v == "instruction_field_used"));
        assert!(required.iter().any(|v| v == "image_payload_count"));
    }

    #[test]
    fn supported_mime_types_are_all_image_types() {
        let mime_types = list_supported_image_payload_mime_types();
        assert!(!mime_types.is_empty());
        for mime in &mime_types {
            assert!(mime.starts_with("image/"), "unexpected mime: {mime}");
        }
        // Bad case guard: a non-image mime is not present.
        assert!(!mime_types.contains(&"application/pdf"));
    }

    #[test]
    fn endpoint_route_matches_handler_attribute() {
        let route = describe_image_analysis_endpoint_route();
        assert_eq!(route["method"], "GET");
        assert_eq!(route["path"], "/api/image-analysis");
    }

    #[test]
    fn maximum_accepted_image_payload_count_is_positive() {
        // Good: the limit is a sensible positive number.
        assert!(describe_maximum_accepted_image_payload_count() > 0);
        // Bad-case guard: it is not absurdly large.
        assert!(describe_maximum_accepted_image_payload_count() <= 64);
    }

    #[test]
    fn base64_requirement_mentions_encoding() {
        let requirement = describe_image_payload_base64_encoding_requirement();
        assert!(requirement.to_lowercase().contains("base64"));
        assert!(!requirement.trim().is_empty());
    }

    #[test]
    fn example_request_body_uses_accepted_fields() {
        let example = build_image_analysis_example_request_body();
        assert!(example["prompt"].is_string());
        assert!(example["caption"].is_string());
        assert!(example["images"].is_array());
    }

    #[test]
    fn example_response_body_matches_response_schema_fields() {
        let example = build_image_analysis_example_response_body();
        assert!(example["analysis"].is_string());
        let used = example["instruction_field_used"].as_str().unwrap();
        // Good: the used field is one of the accepted fields.
        assert!(list_accepted_image_analysis_instruction_fields().contains(&used));
        // Bad-case guard: it is not an unaccepted field.
        assert_ne!(used, "description");
        assert!(example["image_payload_count"].is_number());
    }

    #[test]
    fn instruction_non_empty_text_rule_is_descriptive() {
        let rule = describe_image_analysis_instruction_non_empty_text_rule();
        assert!(rule.contains("non-empty"));
        assert!(!rule.trim().is_empty());
    }

    #[test]
    fn assembled_response_body_contains_all_sections() {
        let accepted_fields = list_accepted_image_analysis_instruction_fields();
        let mime_types = list_supported_image_payload_mime_types();
        let body = assemble_image_analysis_service_response_body(accepted_fields, mime_types);

        assert!(body["descriptor"].is_object());
        assert!(body["accepted_fields"].is_array());
        assert!(body["supported_image_mime_types"].is_array());
        assert!(body["route"].is_object());
        assert!(body["request_schema"].is_object());
        assert!(body["response_schema"].is_object());
        assert!(body["example_request"].is_object());
        assert!(body["example_response"].is_object());
        assert!(body["health"].is_object());
    }

    #[test]
    fn assembled_response_body_preserves_passed_fields() {
        let body = assemble_image_analysis_service_response_body(
            vec!["prompt", "caption"],
            vec!["image/png"],
        );
        let fields = body["accepted_fields"].as_array().unwrap();
        assert_eq!(fields.len(), 2);
        let mimes = body["supported_image_mime_types"].as_array().unwrap();
        assert_eq!(mimes.len(), 1);
        assert_eq!(mimes[0], "image/png");
    }

    #[test]
    fn service_version_is_non_empty_semver_like() {
        let version = describe_image_analysis_service_version();
        assert!(!version.is_empty());
        // Good: three dot-separated components.
        assert_eq!(version.split('.').count(), 3);
    }

    #[test]
    fn health_indicator_reports_ok_status() {
        let health = build_image_analysis_service_health_indicator();
        assert_eq!(health["status"], "ok");
        assert_eq!(health["version"], describe_image_analysis_service_version());
        assert!(health["route"].is_object());
    }
}
