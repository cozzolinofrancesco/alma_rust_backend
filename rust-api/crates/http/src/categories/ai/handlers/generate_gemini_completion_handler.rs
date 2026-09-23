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

/// The lowest valid value for the Gemini sampling temperature parameter.
const MINIMUM_SUPPORTED_GEMINI_TEMPERATURE: f64 = 0.0;

/// The highest valid value for the Gemini sampling temperature parameter.
const MAXIMUM_SUPPORTED_GEMINI_TEMPERATURE: f64 = 1.0;

/// Returns the canonical default Gemini model name used when the caller does
/// not explicitly request a particular model.
fn default_gemini_model_name() -> &'static str {
    "gemini-1.5-flash"
}

/// Returns the full list of Gemini model identifiers that this handler is
/// willing to route completions to. Any requested model outside this list is
/// rejected as a malformed request.
fn list_supported_gemini_model_names() -> Vec<&'static str> {
    vec![
        "gemini-1.5-flash",
        "gemini-1.5-pro",
        "gemini-2.0-flash",
        "gemini-2.0-pro",
    ]
}

/// Reads the raw `prompt` field from the submitted JSON body and returns it as
/// a borrowed string slice when present and of string type.
fn read_prompt_field_as_string_slice(submitted_body: &Value) -> Option<&str> {
    submitted_body
        .get("prompt")
        .and_then(|prompt_value| prompt_value.as_str())
}

/// Extracts the mandatory `prompt` field from the submitted body as an owned
/// string, returning a malformed-body error when it is missing or not a string.
fn extract_gemini_prompt_field_from_body(submitted_body: &Value) -> Result<String, HttpError> {
    read_prompt_field_as_string_slice(submitted_body)
        .map(|prompt_slice| prompt_slice.to_string())
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: String::from("the 'prompt' field is required and must be a string"),
        })
}

/// Converts a domain parsing failure into a malformed-body HTTP error, keeping
/// the original explanation from the domain layer.
fn map_gemini_prompt_parsing_failure_to_malformed_body_error(
    parsing_error: alma_domain::error::DomainError,
) -> HttpError {
    HttpError::RequestBodyWasMalformed {
        explanation: parsing_error.to_string(),
    }
}

/// Parses the caller-supplied prompt string into a validated `NonEmptyText`,
/// mapping any domain parse failure into a malformed-body error.
fn parse_gemini_prompt_into_non_empty_text(
    prompt_string: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(prompt_string)
        .map_err(map_gemini_prompt_parsing_failure_to_malformed_body_error)
}

/// Reads the optional `model` field from the submitted body, returning it as an
/// owned string when it is present and of string type.
fn read_requested_gemini_model_name_field(submitted_body: &Value) -> Option<String> {
    submitted_body
        .get("model")
        .and_then(|model_value| model_value.as_str())
        .map(|model_slice| model_slice.trim().to_string())
        .filter(|trimmed_model_name| !trimmed_model_name.is_empty())
}

/// Resolves the effective Gemini model name to use for the completion, falling
/// back to the default model when the caller did not request one.
fn resolve_effective_gemini_model_name(requested_model_name: Option<String>) -> String {
    match requested_model_name {
        Some(explicit_model_name) => explicit_model_name,
        None => default_gemini_model_name().to_string(),
    }
}

/// Validates that the effective model name is one of the supported Gemini
/// models, returning a malformed-body error otherwise.
fn validate_requested_gemini_model_is_supported(
    effective_model_name: &str,
) -> Result<(), HttpError> {
    if list_supported_gemini_model_names().contains(&effective_model_name) {
        Ok(())
    } else {
        Err(HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "the requested model '{}' is not supported; supported models are: {}",
                effective_model_name,
                list_supported_gemini_model_names().join(", ")
            ),
        })
    }
}

/// Reads the optional `temperature` field from the submitted body, returning it
/// as a floating point value when it is present and numeric.
fn read_optional_gemini_temperature_field(submitted_body: &Value) -> Option<f64> {
    submitted_body
        .get("temperature")
        .and_then(|temperature_value| temperature_value.as_f64())
}

/// Validates that a supplied temperature, when present, lies within the closed
/// unit range accepted by the Gemini API. Absent temperatures are always valid.
fn validate_gemini_temperature_within_unit_range(
    temperature: Option<f64>,
) -> Result<(), HttpError> {
    match temperature {
        None => Ok(()),
        Some(temperature_value) => {
            if temperature_value.is_nan() {
                return Err(HttpError::RequestBodyWasMalformed {
                    explanation: String::from("the 'temperature' field must be a real number"),
                });
            }
            if temperature_value < MINIMUM_SUPPORTED_GEMINI_TEMPERATURE
                || temperature_value > MAXIMUM_SUPPORTED_GEMINI_TEMPERATURE
            {
                return Err(HttpError::RequestBodyWasMalformed {
                    explanation: format!(
                        "the 'temperature' field must be between {} and {}",
                        MINIMUM_SUPPORTED_GEMINI_TEMPERATURE,
                        MAXIMUM_SUPPORTED_GEMINI_TEMPERATURE
                    ),
                });
            }
            Ok(())
        }
    }
}

/// Builds the final prompt string that is sent to the AI adapter by prefixing
/// the caller's prompt with a directive naming the target Gemini model. This
/// keeps the underlying single-string adapter interface intact while still
/// communicating the requested model.
fn build_gemini_prompt_with_model_directive(
    prompt_text: &NonEmptyText,
    effective_model_name: &str,
) -> String {
    format!(
        "[gemini-model: {}]\n{}",
        effective_model_name,
        prompt_text.as_str()
    )
}

/// Parses the assembled directive prompt back into a validated `NonEmptyText`
/// so it can be handed to the AI adapter, mapping parse failures to a
/// malformed-body error.
fn parse_gemini_directive_prompt_into_non_empty_text(
    directive_prompt_string: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(directive_prompt_string)
        .map_err(map_gemini_prompt_parsing_failure_to_malformed_body_error)
}

/// Requests a completion from the AI adapter for the assembled Gemini prompt,
/// propagating any application failure as an HTTP error via the existing
/// `From<ApplicationError>` conversion.
async fn request_gemini_completion_from_adapter(
    artificial_intelligence_adapter: &std::sync::Arc<dyn ArtificialIntelligencePort>,
    gemini_prompt: &NonEmptyText,
) -> Result<GeneratedCompletion, HttpError> {
    let generated_completion = artificial_intelligence_adapter
        .generate_completion(gemini_prompt)
        .await?;
    Ok(generated_completion)
}

/// Builds the JSON response body returned to the caller, echoing both the
/// produced text and the effective model that served the request.
fn build_gemini_completion_response_body(
    completion: GeneratedCompletion,
    effective_model_name: &str,
) -> Value {
    json!({
        "response": completion.produced_text,
        "model": effective_model_name,
    })
}

#[route(method = "POST", path = "/api/gemini")]
pub async fn generate_gemini_completion_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let prompt_string = extract_gemini_prompt_field_from_body(&submitted_body)?;
    let prompt_text = parse_gemini_prompt_into_non_empty_text(prompt_string)?;

    let requested_model_name = read_requested_gemini_model_name_field(&submitted_body);
    let effective_model_name = resolve_effective_gemini_model_name(requested_model_name);
    validate_requested_gemini_model_is_supported(&effective_model_name)?;

    let requested_temperature = read_optional_gemini_temperature_field(&submitted_body);
    validate_gemini_temperature_within_unit_range(requested_temperature)?;

    let directive_prompt_string =
        build_gemini_prompt_with_model_directive(&prompt_text, &effective_model_name);
    let gemini_prompt = parse_gemini_directive_prompt_into_non_empty_text(directive_prompt_string)?;

    let completion = request_gemini_completion_from_adapter(
        &application_state.artificial_intelligence_adapter,
        &gemini_prompt,
    )
    .await?;

    let response_body = build_gemini_completion_response_body(completion, &effective_model_name);
    Ok(Json(response_body))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_malformed_body_error(error: &HttpError) -> bool {
        matches!(error, HttpError::RequestBodyWasMalformed { .. })
    }

    #[test]
    fn read_prompt_field_as_string_slice_returns_present_string() {
        let body = json!({ "prompt": "hello world" });
        assert_eq!(read_prompt_field_as_string_slice(&body), Some("hello world"));
    }

    #[test]
    fn read_prompt_field_as_string_slice_returns_none_for_missing_or_wrong_type() {
        let missing = json!({ "other": "x" });
        assert_eq!(read_prompt_field_as_string_slice(&missing), None);
        let wrong_type = json!({ "prompt": 42 });
        assert_eq!(read_prompt_field_as_string_slice(&wrong_type), None);
    }

    #[test]
    fn extract_gemini_prompt_field_from_body_returns_owned_string_when_present() {
        let body = json!({ "prompt": "summarize this" });
        let extracted = extract_gemini_prompt_field_from_body(&body).expect("should extract");
        assert_eq!(extracted, "summarize this");
    }

    #[test]
    fn extract_gemini_prompt_field_from_body_errors_when_absent() {
        let body = json!({ "model": "gemini-1.5-pro" });
        let error = extract_gemini_prompt_field_from_body(&body).expect_err("should error");
        assert!(is_malformed_body_error(&error));
    }

    #[test]
    fn map_gemini_prompt_parsing_failure_produces_malformed_body_error() {
        let parse_failure = NonEmptyText::parse(String::new())
            .expect_err("empty text must fail to parse");
        let mapped = map_gemini_prompt_parsing_failure_to_malformed_body_error(parse_failure);
        assert!(is_malformed_body_error(&mapped));
    }

    #[test]
    fn parse_gemini_prompt_into_non_empty_text_succeeds_for_valid_input() {
        let parsed = parse_gemini_prompt_into_non_empty_text(String::from("valid prompt"))
            .expect("should parse");
        assert_eq!(parsed.as_str(), "valid prompt");
    }

    #[test]
    fn parse_gemini_prompt_into_non_empty_text_errors_for_empty_input() {
        let error = parse_gemini_prompt_into_non_empty_text(String::new())
            .expect_err("empty should error");
        assert!(is_malformed_body_error(&error));
    }

    #[test]
    fn read_requested_gemini_model_name_field_returns_trimmed_value() {
        let body = json!({ "model": "  gemini-1.5-pro  " });
        assert_eq!(
            read_requested_gemini_model_name_field(&body),
            Some(String::from("gemini-1.5-pro"))
        );
    }

    #[test]
    fn read_requested_gemini_model_name_field_returns_none_for_blank_or_missing() {
        let blank = json!({ "model": "   " });
        assert_eq!(read_requested_gemini_model_name_field(&blank), None);
        let missing = json!({ "prompt": "x" });
        assert_eq!(read_requested_gemini_model_name_field(&missing), None);
    }

    #[test]
    fn resolve_effective_gemini_model_name_uses_default_when_absent() {
        assert_eq!(
            resolve_effective_gemini_model_name(None),
            default_gemini_model_name()
        );
    }

    #[test]
    fn resolve_effective_gemini_model_name_uses_requested_when_present() {
        assert_eq!(
            resolve_effective_gemini_model_name(Some(String::from("gemini-2.0-pro"))),
            "gemini-2.0-pro"
        );
    }

    #[test]
    fn validate_requested_gemini_model_is_supported_accepts_known_model() {
        assert!(validate_requested_gemini_model_is_supported("gemini-1.5-flash").is_ok());
    }

    #[test]
    fn validate_requested_gemini_model_is_supported_rejects_unknown_model() {
        let error = validate_requested_gemini_model_is_supported("gpt-4")
            .expect_err("unknown model should error");
        assert!(is_malformed_body_error(&error));
    }

    #[test]
    fn read_optional_gemini_temperature_field_returns_numeric_value() {
        let body = json!({ "temperature": 0.7 });
        assert_eq!(read_optional_gemini_temperature_field(&body), Some(0.7));
    }

    #[test]
    fn read_optional_gemini_temperature_field_returns_none_when_absent_or_non_numeric() {
        let absent = json!({ "prompt": "x" });
        assert_eq!(read_optional_gemini_temperature_field(&absent), None);
        let non_numeric = json!({ "temperature": "hot" });
        assert_eq!(read_optional_gemini_temperature_field(&non_numeric), None);
    }

    #[test]
    fn validate_gemini_temperature_within_unit_range_accepts_none_and_bounds() {
        assert!(validate_gemini_temperature_within_unit_range(None).is_ok());
        assert!(validate_gemini_temperature_within_unit_range(Some(0.0)).is_ok());
        assert!(validate_gemini_temperature_within_unit_range(Some(1.0)).is_ok());
        assert!(validate_gemini_temperature_within_unit_range(Some(0.5)).is_ok());
    }

    #[test]
    fn validate_gemini_temperature_within_unit_range_rejects_out_of_range_and_nan() {
        assert!(
            validate_gemini_temperature_within_unit_range(Some(-0.1)).is_err()
        );
        assert!(validate_gemini_temperature_within_unit_range(Some(1.1)).is_err());
        assert!(validate_gemini_temperature_within_unit_range(Some(f64::NAN)).is_err());
    }

    #[test]
    fn build_gemini_prompt_with_model_directive_prefixes_directive() {
        let prompt = NonEmptyText::parse(String::from("do the thing")).expect("parse");
        let built = build_gemini_prompt_with_model_directive(&prompt, "gemini-1.5-pro");
        assert_eq!(built, "[gemini-model: gemini-1.5-pro]\ndo the thing");
    }

    #[test]
    fn parse_gemini_directive_prompt_into_non_empty_text_succeeds_for_valid_input() {
        let parsed = parse_gemini_directive_prompt_into_non_empty_text(String::from(
            "[gemini-model: gemini-1.5-flash]\nhi",
        ))
        .expect("should parse");
        assert!(parsed.as_str().contains("gemini-1.5-flash"));
    }

    #[test]
    fn parse_gemini_directive_prompt_into_non_empty_text_errors_for_empty_input() {
        let error = parse_gemini_directive_prompt_into_non_empty_text(String::new())
            .expect_err("empty should error");
        assert!(is_malformed_body_error(&error));
    }

    #[test]
    fn build_gemini_completion_response_body_includes_text_and_model() {
        let completion = GeneratedCompletion {
            produced_text: String::from("the answer"),
        };
        let body = build_gemini_completion_response_body(completion, "gemini-2.0-flash");
        assert_eq!(body.get("response").and_then(|v| v.as_str()), Some("the answer"));
        assert_eq!(body.get("model").and_then(|v| v.as_str()), Some("gemini-2.0-flash"));
    }

    #[test]
    fn list_supported_gemini_model_names_includes_default() {
        assert!(list_supported_gemini_model_names().contains(&default_gemini_model_name()));
    }

    #[test]
    fn default_gemini_model_name_is_stable() {
        assert_eq!(default_gemini_model_name(), "gemini-1.5-flash");
    }
}
