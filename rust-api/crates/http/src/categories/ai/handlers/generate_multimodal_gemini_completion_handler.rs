use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::ports::ai::{ArtificialIntelligencePort, GeneratedCompletion};
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::NonEmptyText;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};

/// Handle a request to produce a Gemini completion for a multimodal prompt.
///
/// The submitted body is expected to contain a textual `prompt`, an optional
/// array of base64-encoded `images`, and an optional `model` name. The handler
/// validates the prompt, enforces the maximum number of attached images,
/// composes a prompt that describes the attached images, and forwards the
/// composed prompt to the configured artificial intelligence adapter.
#[route(method = "POST", path = "/api/multimodalgemini")]
pub async fn generate_multimodal_gemini_completion_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let prompt_string = extract_multimodal_gemini_prompt_field_from_body(&submitted_body)?;
    let prompt_text = parse_multimodal_prompt_into_non_empty_text(prompt_string)?;

    let image_payloads = extract_multimodal_image_payloads_from_body(&submitted_body);
    let supplied_image_count = count_supplied_multimodal_image_payloads(&image_payloads);
    validate_multimodal_image_payload_count_within_limit(
        supplied_image_count,
        maximum_accepted_multimodal_image_count(),
    )?;
    validate_each_image_payload_is_non_empty(&image_payloads)?;

    let requested_model_name = read_requested_multimodal_gemini_model_name(&submitted_body);
    let effective_model_name = resolve_effective_multimodal_gemini_model_name(requested_model_name);

    let composed_prompt_string =
        build_multimodal_prompt_describing_attached_images(&prompt_text, supplied_image_count);
    let composed_prompt_text =
        parse_multimodal_composed_prompt_into_non_empty_text(composed_prompt_string)?;

    let completion = request_multimodal_gemini_completion_from_adapter(
        &application_state.artificial_intelligence_adapter,
        &composed_prompt_text,
    )
    .await?;

    let response_body = build_multimodal_gemini_completion_response_body(
        completion,
        supplied_image_count,
        &effective_model_name,
    );

    Ok(Json(response_body))
}

/// Extract the required `prompt` field from the submitted body as an owned
/// string, returning a malformed-body error when it is missing or not a string.
fn extract_multimodal_gemini_prompt_field_from_body(
    submitted_body: &Value,
) -> Result<String, HttpError> {
    read_prompt_field_as_string_slice(submitted_body)
        .map(|prompt_slice| prompt_slice.to_string())
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: String::from("the 'prompt' field is required and must be a string"),
        })
}

/// Read the `prompt` field of the submitted body as a borrowed string slice, if
/// present and of the correct type.
fn read_prompt_field_as_string_slice(submitted_body: &Value) -> Option<&str> {
    submitted_body
        .get("prompt")
        .and_then(|prompt_value| prompt_value.as_str())
}

/// Parse a raw prompt string into a validated non-empty text value, mapping any
/// domain validation failure into a malformed-body error.
fn parse_multimodal_prompt_into_non_empty_text(
    prompt_string: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(prompt_string).map_err(map_multimodal_prompt_parsing_failure_to_malformed_body_error)
}

/// Extract every image payload from the optional `images` array of the submitted
/// body, keeping only entries that are strings.
fn extract_multimodal_image_payloads_from_body(submitted_body: &Value) -> Vec<String> {
    submitted_body
        .get("images")
        .and_then(|images_value| images_value.as_array())
        .map(|images_array| {
            images_array
                .iter()
                .filter_map(|image_value| image_value.as_str())
                .map(|image_slice| image_slice.to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// Count how many image payloads were supplied.
fn count_supplied_multimodal_image_payloads(image_payloads: &[String]) -> usize {
    image_payloads.len()
}

/// Ensure the number of supplied image payloads does not exceed the maximum the
/// handler is willing to accept.
fn validate_multimodal_image_payload_count_within_limit(
    supplied_image_count: usize,
    maximum_image_count: usize,
) -> Result<(), HttpError> {
    if supplied_image_count > maximum_image_count {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "at most {maximum_image_count} images may be attached, but {supplied_image_count} were supplied"
            ),
        });
    }
    Ok(())
}

/// Ensure every supplied image payload contains non-whitespace content.
fn validate_each_image_payload_is_non_empty(image_payloads: &[String]) -> Result<(), HttpError> {
    for (image_index, image_payload) in image_payloads.iter().enumerate() {
        if image_payload.trim().is_empty() {
            return Err(HttpError::RequestBodyWasMalformed {
                explanation: format!("image payload at index {image_index} must not be empty"),
            });
        }
    }
    Ok(())
}

/// Read the optional requested Gemini `model` name from the submitted body,
/// keeping only non-empty string values.
fn read_requested_multimodal_gemini_model_name(submitted_body: &Value) -> Option<String> {
    submitted_body
        .get("model")
        .and_then(|model_value| model_value.as_str())
        .map(|model_slice| model_slice.trim().to_string())
        .filter(|model_name| !model_name.is_empty())
}

/// Resolve the effective Gemini model name, falling back to a sensible default
/// when none was requested.
fn resolve_effective_multimodal_gemini_model_name(requested_model_name: Option<String>) -> String {
    requested_model_name.unwrap_or_else(|| String::from("gemini-1.5-flash"))
}

/// Compose a textual prompt that combines the caller's prompt with a description
/// of how many images were attached, so a text-only completion port receives the
/// relevant multimodal context.
fn build_multimodal_prompt_describing_attached_images(
    prompt_text: &NonEmptyText,
    supplied_image_count: usize,
) -> String {
    match supplied_image_count {
        0 => prompt_text.as_str().to_string(),
        1 => format!(
            "{} (1 image is attached to this request; take it into account when responding.)",
            prompt_text.as_str()
        ),
        _ => format!(
            "{} ({} images are attached to this request; take them into account when responding.)",
            prompt_text.as_str(),
            supplied_image_count
        ),
    }
}

/// Parse a composed multimodal prompt string into a validated non-empty text
/// value, mapping any domain validation failure into a malformed-body error.
fn parse_multimodal_composed_prompt_into_non_empty_text(
    composed_prompt_string: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(composed_prompt_string)
        .map_err(map_multimodal_prompt_parsing_failure_to_malformed_body_error)
}

/// Forward the composed multimodal prompt to the artificial intelligence adapter
/// and return the generated completion, propagating any upstream failure.
async fn request_multimodal_gemini_completion_from_adapter(
    artificial_intelligence_adapter: &std::sync::Arc<dyn ArtificialIntelligencePort>,
    multimodal_prompt: &NonEmptyText,
) -> Result<GeneratedCompletion, HttpError> {
    let completion = artificial_intelligence_adapter
        .generate_completion(multimodal_prompt)
        .await?;
    Ok(completion)
}

/// Convert a domain parsing failure into the malformed-body HTTP error variant.
fn map_multimodal_prompt_parsing_failure_to_malformed_body_error(
    parsing_error: alma_domain::error::DomainError,
) -> HttpError {
    HttpError::RequestBodyWasMalformed {
        explanation: parsing_error.to_string(),
    }
}

/// Build the JSON response body describing the generated completion, the number
/// of processed images, and the model that was used.
fn build_multimodal_gemini_completion_response_body(
    completion: GeneratedCompletion,
    processed_image_count: usize,
    effective_model_name: &str,
) -> Value {
    json!({
        "response": completion.produced_text,
        "image_count": processed_image_count,
        "model": effective_model_name,
    })
}

/// The maximum number of image payloads the multimodal handler will accept in a
/// single request.
fn maximum_accepted_multimodal_image_count() -> usize {
    16
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn non_empty(text: &str) -> NonEmptyText {
        NonEmptyText::parse(text.to_string()).expect("test fixture must be non-empty")
    }

    #[test]
    fn extract_prompt_field_returns_owned_string_when_present() {
        let body = json!({ "prompt": "describe this scene" });
        let extracted = extract_multimodal_gemini_prompt_field_from_body(&body)
            .expect("prompt should be extracted");
        assert_eq!(extracted, "describe this scene");
    }

    #[test]
    fn extract_prompt_field_errors_when_missing_or_wrong_type() {
        let missing = json!({ "images": [] });
        assert!(matches!(
            extract_multimodal_gemini_prompt_field_from_body(&missing),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));

        let wrong_type = json!({ "prompt": 42 });
        assert!(matches!(
            extract_multimodal_gemini_prompt_field_from_body(&wrong_type),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn read_prompt_field_as_string_slice_handles_good_and_bad_input() {
        let good = json!({ "prompt": "hello" });
        assert_eq!(read_prompt_field_as_string_slice(&good), Some("hello"));

        let bad = json!({ "prompt": ["not", "a", "string"] });
        assert_eq!(read_prompt_field_as_string_slice(&bad), None);
    }

    #[test]
    fn parse_multimodal_prompt_into_non_empty_text_accepts_valid_and_rejects_blank() {
        let parsed = parse_multimodal_prompt_into_non_empty_text("valid prompt".to_string())
            .expect("valid prompt should parse");
        assert_eq!(parsed.as_str(), "valid prompt");

        assert!(matches!(
            parse_multimodal_prompt_into_non_empty_text("   ".to_string()),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn extract_image_payloads_collects_strings_and_ignores_non_strings() {
        let body = json!({ "images": ["aaa", 5, "bbb", null] });
        let payloads = extract_multimodal_image_payloads_from_body(&body);
        assert_eq!(payloads, vec!["aaa".to_string(), "bbb".to_string()]);

        let no_images = json!({ "prompt": "x" });
        assert!(extract_multimodal_image_payloads_from_body(&no_images).is_empty());
    }

    #[test]
    fn count_supplied_image_payloads_reports_length() {
        let none: Vec<String> = Vec::new();
        assert_eq!(count_supplied_multimodal_image_payloads(&none), 0);

        let some = vec!["a".to_string(), "b".to_string()];
        assert_eq!(count_supplied_multimodal_image_payloads(&some), 2);
    }

    #[test]
    fn validate_image_count_within_limit_accepts_and_rejects() {
        assert!(validate_multimodal_image_payload_count_within_limit(3, 16).is_ok());
        assert!(validate_multimodal_image_payload_count_within_limit(16, 16).is_ok());
        assert!(matches!(
            validate_multimodal_image_payload_count_within_limit(17, 16),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn validate_each_image_payload_is_non_empty_flags_blank_entries() {
        let good = vec!["aaa".to_string(), "bbb".to_string()];
        assert!(validate_each_image_payload_is_non_empty(&good).is_ok());

        let bad = vec!["aaa".to_string(), "   ".to_string()];
        assert!(matches!(
            validate_each_image_payload_is_non_empty(&bad),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn read_requested_model_name_trims_and_filters_empty() {
        let with_model = json!({ "model": "  gemini-1.5-pro  " });
        assert_eq!(
            read_requested_multimodal_gemini_model_name(&with_model),
            Some("gemini-1.5-pro".to_string())
        );

        let blank_model = json!({ "model": "   " });
        assert_eq!(read_requested_multimodal_gemini_model_name(&blank_model), None);

        let no_model = json!({ "prompt": "x" });
        assert_eq!(read_requested_multimodal_gemini_model_name(&no_model), None);
    }

    #[test]
    fn resolve_effective_model_name_uses_default_when_absent() {
        assert_eq!(
            resolve_effective_multimodal_gemini_model_name(Some("custom-model".to_string())),
            "custom-model"
        );
        assert_eq!(
            resolve_effective_multimodal_gemini_model_name(None),
            "gemini-1.5-flash"
        );
    }

    #[test]
    fn build_prompt_describing_images_varies_with_count() {
        let prompt = non_empty("summarize");

        let zero = build_multimodal_prompt_describing_attached_images(&prompt, 0);
        assert_eq!(zero, "summarize");

        let one = build_multimodal_prompt_describing_attached_images(&prompt, 1);
        assert!(one.contains("1 image is attached"));
        assert!(one.starts_with("summarize"));

        let many = build_multimodal_prompt_describing_attached_images(&prompt, 3);
        assert!(many.contains("3 images are attached"));
    }

    #[test]
    fn parse_composed_prompt_accepts_valid_and_rejects_blank() {
        let parsed = parse_multimodal_composed_prompt_into_non_empty_text(
            "composed prompt".to_string(),
        )
        .expect("valid composed prompt should parse");
        assert_eq!(parsed.as_str(), "composed prompt");

        assert!(matches!(
            parse_multimodal_composed_prompt_into_non_empty_text("".to_string()),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn map_parsing_failure_produces_malformed_body_error() {
        let domain_error = NonEmptyText::parse(String::new())
            .expect_err("empty string must fail domain validation");
        let http_error = map_multimodal_prompt_parsing_failure_to_malformed_body_error(domain_error);
        assert!(matches!(
            http_error,
            HttpError::RequestBodyWasMalformed { .. }
        ));
    }

    #[test]
    fn build_response_body_includes_all_fields() {
        let completion = GeneratedCompletion {
            produced_text: "generated answer".to_string(),
        };
        let body = build_multimodal_gemini_completion_response_body(completion, 2, "gemini-1.5-flash");
        assert_eq!(body["response"], "generated answer");
        assert_eq!(body["image_count"], 2);
        assert_eq!(body["model"], "gemini-1.5-flash");
    }

    #[test]
    fn maximum_accepted_image_count_is_positive() {
        assert!(maximum_accepted_multimodal_image_count() > 0);
    }
}
