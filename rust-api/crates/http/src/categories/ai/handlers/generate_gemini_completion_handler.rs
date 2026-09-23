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
/// not explicitly request a particular model. Mirrors the bootstrap
/// `DEFAULT_GENERATION_MODEL`.
fn default_gemini_model_name() -> &'static str {
    "gemini-2.5-flash"
}

/// Reads the raw `prompt` field from the submitted JSON body and returns it as
/// a borrowed string slice when present and of string type.
fn read_prompt_field_as_string_slice(submitted_body: &Value) -> Option<&str> {
    submitted_body
        .get("prompt")
        .and_then(|prompt_value| prompt_value.as_str())
}

/// Reads an optional `systemInstruction`, accepting either a bare string or a
/// `{ text }` object (both shapes the reference `/api/gemini` accepts).
fn read_system_instruction_text(submitted_body: &Value) -> Option<String> {
    let system_instruction = submitted_body.get("systemInstruction")?;
    if let Some(text) = system_instruction.as_str() {
        return Some(text.to_string());
    }
    system_instruction
        .get("text")
        .and_then(Value::as_str)
        .map(|text| text.to_string())
}

/// Extract the prompt text from **either** the `prompt` string field or a
/// `messages` array. canvas-272 sends `{ messages: [{ role, text }], model }`
/// (`StepEditorModal.tsx`), while other callers send `{ prompt }`. An optional
/// `systemInstruction` is prepended. The single-string adapter interface takes
/// one prompt, so message turns are flattened (blank-line separated) — grounding
/// / multi-turn role fidelity is out of scope for this text-only path.
fn extract_gemini_prompt_text(submitted_body: &Value) -> Result<String, HttpError> {
    // Prefer an explicit non-empty `prompt`.
    if let Some(prompt) = read_prompt_field_as_string_slice(submitted_body) {
        if !prompt.trim().is_empty() {
            return Ok(prompt.to_string());
        }
    }

    // Otherwise flatten `messages` (+ optional systemInstruction).
    if let Some(messages) = submitted_body.get("messages").and_then(Value::as_array) {
        let mut parts: Vec<String> = Vec::new();
        if let Some(system) = read_system_instruction_text(submitted_body) {
            if !system.trim().is_empty() {
                parts.push(system.trim().to_string());
            }
        }
        for message in messages {
            if let Some(text) = message.get("text").and_then(Value::as_str) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    parts.push(trimmed.to_string());
                }
            }
        }
        let joined = parts.join("\n\n");
        if !joined.trim().is_empty() {
            return Ok(joined);
        }
    }

    Err(HttpError::RequestBodyWasMalformed {
        explanation: String::from(
            "the request must include a non-empty 'prompt' string or a 'messages' array",
        ),
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
/// back to the default model when the caller did not request one. The model is
/// **not** checked against a hardcoded allow-list here: resolution/validation is
/// deferred to the AI adapter (the real Gemini adapter errors on a truly unknown
/// model; the hermetic stub ignores it), so current-generation model ids the
/// frontend sends are accepted.
fn resolve_effective_gemini_model_name(requested_model_name: Option<String>) -> String {
    match requested_model_name {
        Some(explicit_model_name) => explicit_model_name,
        None => default_gemini_model_name().to_string(),
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
                        MINIMUM_SUPPORTED_GEMINI_TEMPERATURE, MAXIMUM_SUPPORTED_GEMINI_TEMPERATURE
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
    let prompt_string = extract_gemini_prompt_text(&submitted_body)?;
    let prompt_text = parse_gemini_prompt_into_non_empty_text(prompt_string)?;

    let requested_model_name = read_requested_gemini_model_name_field(&submitted_body);
    let effective_model_name = resolve_effective_gemini_model_name(requested_model_name);

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
    fn extract_prompt_text_prefers_explicit_prompt() {
        let body = json!({ "prompt": "summarize this" });
        assert_eq!(extract_gemini_prompt_text(&body).unwrap(), "summarize this");
    }

    #[test]
    fn extract_prompt_text_flattens_messages() {
        // canvas-272's shape: { messages: [{role, text}], model }.
        let body = json!({
            "messages": [
                { "role": "user", "text": "  first turn  " },
                { "role": "user", "text": "second turn" },
            ],
            "model": "gemini-2.5-flash",
        });
        assert_eq!(
            extract_gemini_prompt_text(&body).unwrap(),
            "first turn\n\nsecond turn"
        );
    }

    #[test]
    fn extract_prompt_text_prepends_system_instruction_for_messages() {
        let body = json!({
            "systemInstruction": { "text": "You are helpful." },
            "messages": [{ "role": "user", "text": "hi" }],
        });
        assert_eq!(
            extract_gemini_prompt_text(&body).unwrap(),
            "You are helpful.\n\nhi"
        );
    }

    #[test]
    fn extract_prompt_text_errors_when_neither_present() {
        let body = json!({ "model": "gemini-2.5-flash" });
        assert!(is_malformed_body_error(
            &extract_gemini_prompt_text(&body).unwrap_err()
        ));
        // Empty messages array is also malformed.
        let empty = json!({ "messages": [] });
        assert!(is_malformed_body_error(
            &extract_gemini_prompt_text(&empty).unwrap_err()
        ));
    }

    #[test]
    fn parse_gemini_prompt_into_non_empty_text_succeeds_for_valid_input() {
        let parsed =
            parse_gemini_prompt_into_non_empty_text(String::from("valid prompt")).expect("parse");
        assert_eq!(parsed.as_str(), "valid prompt");
    }

    #[test]
    fn read_requested_gemini_model_name_field_returns_trimmed_value() {
        let body = json!({ "model": "  gemini-3.5-flash  " });
        assert_eq!(
            read_requested_gemini_model_name_field(&body),
            Some(String::from("gemini-3.5-flash"))
        );
    }

    #[test]
    fn resolve_effective_gemini_model_name_uses_default_when_absent() {
        assert_eq!(
            resolve_effective_gemini_model_name(None),
            default_gemini_model_name()
        );
    }

    #[test]
    fn resolve_effective_gemini_model_name_accepts_any_current_model() {
        // No allow-list: a current-generation id the frontend sends is accepted.
        assert_eq!(
            resolve_effective_gemini_model_name(Some(String::from("gemini-3.5-flash"))),
            "gemini-3.5-flash"
        );
    }

    #[test]
    fn validate_gemini_temperature_within_unit_range_accepts_none_and_bounds() {
        assert!(validate_gemini_temperature_within_unit_range(None).is_ok());
        assert!(validate_gemini_temperature_within_unit_range(Some(0.0)).is_ok());
        assert!(validate_gemini_temperature_within_unit_range(Some(1.0)).is_ok());
    }

    #[test]
    fn validate_gemini_temperature_within_unit_range_rejects_out_of_range_and_nan() {
        assert!(validate_gemini_temperature_within_unit_range(Some(-0.1)).is_err());
        assert!(validate_gemini_temperature_within_unit_range(Some(1.1)).is_err());
        assert!(validate_gemini_temperature_within_unit_range(Some(f64::NAN)).is_err());
    }

    #[test]
    fn build_gemini_prompt_with_model_directive_prefixes_directive() {
        let prompt = NonEmptyText::parse(String::from("do the thing")).expect("parse");
        let built = build_gemini_prompt_with_model_directive(&prompt, "gemini-2.5-flash");
        assert_eq!(built, "[gemini-model: gemini-2.5-flash]\ndo the thing");
    }

    #[test]
    fn build_gemini_completion_response_body_includes_text_and_model() {
        let completion = GeneratedCompletion {
            produced_text: String::from("the answer"),
        };
        let body = build_gemini_completion_response_body(completion, "gemini-2.5-flash");
        assert_eq!(
            body.get("response").and_then(|v| v.as_str()),
            Some("the answer")
        );
        assert_eq!(
            body.get("model").and_then(|v| v.as_str()),
            Some("gemini-2.5-flash")
        );
    }

    #[test]
    fn default_gemini_model_name_is_current_default() {
        assert_eq!(default_gemini_model_name(), "gemini-2.5-flash");
    }
}
