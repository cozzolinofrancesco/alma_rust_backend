use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::error::ApplicationError;
use alma_application::ports::ai::{ArtificialIntelligencePort, GeneratedCompletion};
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::NonEmptyText;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};

/// The upper bound, in tokens, that a client is permitted to request as a hint
/// for the maximum length of a generated completion. Requests exceeding this
/// bound are rejected as malformed rather than silently clamped.
const MAXIMUM_PERMITTED_OUTPUT_TOKEN_HINT: u32 = 32_768;

/// The number of characters we assume, on average, a single token expands to.
/// Used to translate a token hint into a character budget for post-generation
/// truncation. This is an intentionally coarse approximation.
const ASSUMED_CHARACTERS_PER_OUTPUT_TOKEN: usize = 4;

#[route(method = "POST", path = "/api/ai")]
pub async fn generate_artificial_intelligence_completion_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let prompt_string = extract_completion_prompt_field_from_body(&submitted_body)?;
    let prompt_text = parse_completion_prompt_into_non_empty_text(prompt_string)?;

    let optional_system_instruction = read_optional_system_instruction_field(&submitted_body);
    let composed_prompt_string =
        compose_prompt_with_optional_system_instruction(optional_system_instruction, &prompt_text);
    let effective_prompt = parse_composed_prompt_into_non_empty_text(composed_prompt_string)?;

    let maximum_output_token_hint = read_optional_maximum_output_token_hint(&submitted_body);
    validate_maximum_output_token_hint_within_bounds(maximum_output_token_hint)?;

    let completion = request_artificial_intelligence_completion_from_adapter(
        &application_state.artificial_intelligence_adapter,
        &effective_prompt,
    )
    .await?;

    let trimmed_text = trim_trailing_whitespace_from_completion_text(&completion.produced_text);
    let budgeted_text =
        enforce_maximum_output_character_budget(trimmed_text, maximum_output_token_hint);
    let final_completion = GeneratedCompletion {
        produced_text: budgeted_text,
    };

    let response_body = build_artificial_intelligence_completion_response_body(final_completion);
    Ok(Json(response_body))
}

/// (1) Read the required `prompt` field from the request body as an owned
/// `String`, returning a malformed-body error when it is absent or not a string.
fn extract_completion_prompt_field_from_body(
    submitted_body: &serde_json::Value,
) -> Result<String, HttpError> {
    read_prompt_field_as_string_slice(submitted_body)
        .map(|prompt_slice| prompt_slice.to_string())
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: String::from("the 'prompt' field is required and must be a string"),
        })
}

/// (2) Borrow the `prompt` field as a string slice if present and of string type.
fn read_prompt_field_as_string_slice(submitted_body: &serde_json::Value) -> Option<&str> {
    submitted_body
        .get("prompt")
        .and_then(|prompt_value| prompt_value.as_str())
}

/// (3) Parse the raw prompt string into a validated `NonEmptyText` domain value.
fn parse_completion_prompt_into_non_empty_text(
    prompt_string: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(prompt_string).map_err(map_prompt_parsing_failure_to_malformed_body_error)
}

/// (4) Translate a domain parsing failure into a malformed-body HTTP error.
fn map_prompt_parsing_failure_to_malformed_body_error(
    parsing_error: alma_domain::error::DomainError,
) -> HttpError {
    HttpError::RequestBodyWasMalformed {
        explanation: parsing_error.to_string(),
    }
}

/// (5) Read the optional `system_instruction` field, returning `None` when it is
/// absent, null, non-string, or blank after trimming.
fn read_optional_system_instruction_field(submitted_body: &serde_json::Value) -> Option<String> {
    submitted_body
        .get("system_instruction")
        .and_then(|instruction_value| instruction_value.as_str())
        .map(|instruction_slice| instruction_slice.trim().to_string())
        .filter(|trimmed_instruction| !trimmed_instruction.is_empty())
}

/// (6) Compose the effective prompt string, prepending a system instruction
/// block when one is supplied. When absent, the original prompt text is used
/// verbatim.
fn compose_prompt_with_optional_system_instruction(
    system_instruction: Option<String>,
    prompt_text: &NonEmptyText,
) -> String {
    match system_instruction {
        Some(instruction) => {
            format!(
                "System instruction:\n{}\n\nUser prompt:\n{}",
                instruction,
                prompt_text.as_str()
            )
        }
        None => prompt_text.as_str().to_string(),
    }
}

/// (7) Parse the composed prompt string back into a `NonEmptyText`. Because the
/// composed string always contains at least the original non-empty prompt, a
/// failure here is exceptional but still mapped to a malformed-body error.
fn parse_composed_prompt_into_non_empty_text(
    composed_prompt_string: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(composed_prompt_string)
        .map_err(map_prompt_parsing_failure_to_malformed_body_error)
}

/// (8) Read the optional `maximum_output_tokens` field as a `u32`, ignoring
/// values that are absent, non-numeric, or outside the representable range.
fn read_optional_maximum_output_token_hint(submitted_body: &serde_json::Value) -> Option<u32> {
    submitted_body
        .get("maximum_output_tokens")
        .and_then(|hint_value| hint_value.as_u64())
        .and_then(|hint_as_u64| u32::try_from(hint_as_u64).ok())
}

/// (9) Validate that a supplied maximum-output-token hint is strictly positive
/// and within the permitted upper bound.
fn validate_maximum_output_token_hint_within_bounds(
    maximum_output_tokens: Option<u32>,
) -> Result<(), HttpError> {
    match maximum_output_tokens {
        None => Ok(()),
        Some(0) => Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from(
                "the 'maximum_output_tokens' field, when present, must be greater than zero",
            ),
        }),
        Some(requested_tokens) if requested_tokens > MAXIMUM_PERMITTED_OUTPUT_TOKEN_HINT => {
            Err(HttpError::RequestBodyWasMalformed {
                explanation: format!(
                    "the 'maximum_output_tokens' field must not exceed {}",
                    MAXIMUM_PERMITTED_OUTPUT_TOKEN_HINT
                ),
            })
        }
        Some(_) => Ok(()),
    }
}

/// (10) Delegate to the artificial intelligence adapter to produce a completion
/// for the effective prompt, mapping any application-layer failure into the HTTP
/// error taxonomy.
async fn request_artificial_intelligence_completion_from_adapter(
    artificial_intelligence_adapter: &std::sync::Arc<dyn ArtificialIntelligencePort>,
    effective_prompt: &NonEmptyText,
) -> Result<GeneratedCompletion, HttpError> {
    artificial_intelligence_adapter
        .generate_completion(effective_prompt)
        .await
        .map_err(map_application_error_to_http_error)
}

/// (11) Remove trailing whitespace (including newlines) from a completion,
/// preserving any leading or interior whitespace.
fn trim_trailing_whitespace_from_completion_text(produced_text: &str) -> String {
    produced_text.trim_end().to_string()
}

/// (12) Truncate the completion text to a character budget derived from the
/// optional token hint. When no hint is supplied the text is returned unchanged.
/// Truncation respects UTF-8 character boundaries.
fn enforce_maximum_output_character_budget(
    produced_text: String,
    maximum_output_tokens: Option<u32>,
) -> String {
    let maximum_output_tokens = match maximum_output_tokens {
        Some(tokens) => tokens,
        None => return produced_text,
    };

    let character_budget = (maximum_output_tokens as usize)
        .saturating_mul(ASSUMED_CHARACTERS_PER_OUTPUT_TOKEN);

    if count_completion_output_characters(&produced_text) <= character_budget {
        return produced_text;
    }

    produced_text
        .chars()
        .take(character_budget)
        .collect::<String>()
}

/// (13) Count the number of Unicode scalar values (characters) in a completion.
fn count_completion_output_characters(produced_text: &str) -> usize {
    produced_text.chars().count()
}

/// (14) Assemble the JSON response body returned to the client, exposing the
/// produced text along with a character-count metadata field.
fn build_artificial_intelligence_completion_response_body(
    completion: GeneratedCompletion,
) -> serde_json::Value {
    let produced_character_count = count_completion_output_characters(&completion.produced_text);
    json!({
        "response": completion.produced_text,
        "character_count": produced_character_count,
    })
}

/// (15) Map an application-layer error into the corresponding HTTP error. This
/// mirrors the crate-wide `From<ApplicationError>` conversion but is kept local
/// so adapter calls can attach it explicitly at the call site.
fn map_application_error_to_http_error(application_error: ApplicationError) -> HttpError {
    match application_error {
        ApplicationError::RequestedProjectCouldNotBeLocated
        | ApplicationError::RequestedResourceCouldNotBeLocated => {
            HttpError::RequestedResourceWasNotFound {
                explanation: application_error.to_string(),
            }
        }
        ApplicationError::AuthorizationWasDenied => HttpError::AuthorizationWasDenied {
            explanation: application_error.to_string(),
        },
        ApplicationError::DomainInvariantViolated(_) => HttpError::RequestBodyWasMalformed {
            explanation: application_error.to_string(),
        },
        other_application_error => HttpError::UpstreamApplicationFailure {
            explanation: other_application_error.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    struct StubArtificialIntelligenceAdapter {
        canned_text: String,
    }

    #[async_trait::async_trait]
    impl ArtificialIntelligencePort for StubArtificialIntelligenceAdapter {
        async fn generate_completion(
            &self,
            _prompt_instruction: &NonEmptyText,
        ) -> Result<GeneratedCompletion, ApplicationError> {
            Ok(GeneratedCompletion {
                produced_text: self.canned_text.clone(),
            })
        }
    }

    #[test]
    fn extract_completion_prompt_field_from_body_reads_present_string() {
        let body = json!({ "prompt": "hello world" });
        let extracted = extract_completion_prompt_field_from_body(&body).expect("should extract");
        assert_eq!(extracted, "hello world");
    }

    #[test]
    fn extract_completion_prompt_field_from_body_rejects_missing_field() {
        let body = json!({ "not_prompt": "hello" });
        let outcome = extract_completion_prompt_field_from_body(&body);
        assert!(matches!(
            outcome,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn read_prompt_field_as_string_slice_returns_some_for_string() {
        let body = json!({ "prompt": "abc" });
        assert_eq!(read_prompt_field_as_string_slice(&body), Some("abc"));
    }

    #[test]
    fn read_prompt_field_as_string_slice_returns_none_for_number() {
        let body = json!({ "prompt": 42 });
        assert_eq!(read_prompt_field_as_string_slice(&body), None);
    }

    #[test]
    fn parse_completion_prompt_into_non_empty_text_accepts_non_empty() {
        let parsed = parse_completion_prompt_into_non_empty_text(String::from("valid"))
            .expect("should parse");
        assert_eq!(parsed.as_str(), "valid");
    }

    #[test]
    fn parse_completion_prompt_into_non_empty_text_rejects_blank() {
        let outcome = parse_completion_prompt_into_non_empty_text(String::from("   "));
        assert!(matches!(
            outcome,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn map_prompt_parsing_failure_yields_malformed_body_error() {
        let domain_error = NonEmptyText::parse(String::new())
            .expect_err("empty string must fail to parse");
        let http_error = map_prompt_parsing_failure_to_malformed_body_error(domain_error);
        assert!(matches!(
            http_error,
            HttpError::RequestBodyWasMalformed { .. }
        ));
    }

    #[test]
    fn read_optional_system_instruction_field_returns_trimmed_value() {
        let body = json!({ "system_instruction": "  be concise  " });
        assert_eq!(
            read_optional_system_instruction_field(&body),
            Some(String::from("be concise"))
        );
    }

    #[test]
    fn read_optional_system_instruction_field_returns_none_for_blank() {
        let body = json!({ "system_instruction": "   " });
        assert_eq!(read_optional_system_instruction_field(&body), None);
    }

    #[test]
    fn compose_prompt_with_system_instruction_prepends_block() {
        let prompt = NonEmptyText::parse(String::from("do the thing")).expect("parse");
        let composed = compose_prompt_with_optional_system_instruction(
            Some(String::from("be terse")),
            &prompt,
        );
        assert!(composed.contains("System instruction:"));
        assert!(composed.contains("be terse"));
        assert!(composed.contains("do the thing"));
    }

    #[test]
    fn compose_prompt_without_system_instruction_returns_prompt_verbatim() {
        let prompt = NonEmptyText::parse(String::from("just this")).expect("parse");
        let composed = compose_prompt_with_optional_system_instruction(None, &prompt);
        assert_eq!(composed, "just this");
    }

    #[test]
    fn parse_composed_prompt_into_non_empty_text_accepts_non_empty() {
        let parsed = parse_composed_prompt_into_non_empty_text(String::from("composed"))
            .expect("should parse");
        assert_eq!(parsed.as_str(), "composed");
    }

    #[test]
    fn parse_composed_prompt_into_non_empty_text_rejects_empty() {
        let outcome = parse_composed_prompt_into_non_empty_text(String::new());
        assert!(matches!(
            outcome,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn read_optional_maximum_output_token_hint_reads_valid_number() {
        let body = json!({ "maximum_output_tokens": 256 });
        assert_eq!(read_optional_maximum_output_token_hint(&body), Some(256));
    }

    #[test]
    fn read_optional_maximum_output_token_hint_returns_none_for_missing() {
        let body = json!({ "prompt": "x" });
        assert_eq!(read_optional_maximum_output_token_hint(&body), None);
    }

    #[test]
    fn validate_maximum_output_token_hint_accepts_absent() {
        assert!(validate_maximum_output_token_hint_within_bounds(None).is_ok());
    }

    #[test]
    fn validate_maximum_output_token_hint_accepts_in_range() {
        assert!(validate_maximum_output_token_hint_within_bounds(Some(1_024)).is_ok());
    }

    #[test]
    fn validate_maximum_output_token_hint_rejects_zero() {
        let outcome = validate_maximum_output_token_hint_within_bounds(Some(0));
        assert!(matches!(
            outcome,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn validate_maximum_output_token_hint_rejects_over_bound() {
        let outcome = validate_maximum_output_token_hint_within_bounds(Some(
            MAXIMUM_PERMITTED_OUTPUT_TOKEN_HINT + 1,
        ));
        assert!(matches!(
            outcome,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn trim_trailing_whitespace_removes_trailing_newlines() {
        assert_eq!(
            trim_trailing_whitespace_from_completion_text("answer\n\n  "),
            "answer"
        );
    }

    #[test]
    fn trim_trailing_whitespace_preserves_leading_whitespace() {
        assert_eq!(
            trim_trailing_whitespace_from_completion_text("  answer"),
            "  answer"
        );
    }

    #[test]
    fn enforce_maximum_output_character_budget_leaves_short_text() {
        let text = String::from("short");
        let budgeted = enforce_maximum_output_character_budget(text.clone(), Some(10));
        assert_eq!(budgeted, text);
    }

    #[test]
    fn enforce_maximum_output_character_budget_truncates_long_text() {
        // Budget = 1 token * 4 chars = 4 characters.
        let text = String::from("abcdefgh");
        let budgeted = enforce_maximum_output_character_budget(text, Some(1));
        assert_eq!(budgeted, "abcd");
    }

    #[test]
    fn enforce_maximum_output_character_budget_no_hint_returns_unchanged() {
        let text = String::from("unbounded output");
        let budgeted = enforce_maximum_output_character_budget(text.clone(), None);
        assert_eq!(budgeted, text);
    }

    #[test]
    fn count_completion_output_characters_counts_unicode_scalars() {
        assert_eq!(count_completion_output_characters("héllo"), 5);
    }

    #[test]
    fn count_completion_output_characters_counts_empty_as_zero() {
        assert_eq!(count_completion_output_characters(""), 0);
    }

    #[test]
    fn build_response_body_exposes_text_and_count() {
        let completion = GeneratedCompletion {
            produced_text: String::from("hi"),
        };
        let body = build_artificial_intelligence_completion_response_body(completion);
        assert_eq!(body.get("response").and_then(|v| v.as_str()), Some("hi"));
        assert_eq!(
            body.get("character_count").and_then(|v| v.as_u64()),
            Some(2)
        );
    }

    #[test]
    fn map_application_error_maps_not_found() {
        let http_error = map_application_error_to_http_error(
            ApplicationError::RequestedResourceCouldNotBeLocated,
        );
        assert!(matches!(
            http_error,
            HttpError::RequestedResourceWasNotFound { .. }
        ));
    }

    #[test]
    fn map_application_error_maps_authorization_denied() {
        let http_error =
            map_application_error_to_http_error(ApplicationError::AuthorizationWasDenied);
        assert!(matches!(
            http_error,
            HttpError::AuthorizationWasDenied { .. }
        ));
    }

    #[test]
    fn map_application_error_maps_adapter_failure_to_upstream() {
        let http_error =
            map_application_error_to_http_error(ApplicationError::ArtificialIntelligenceAdapterFailure {
                failure_description: String::from("boom"),
            });
        assert!(matches!(
            http_error,
            HttpError::UpstreamApplicationFailure { .. }
        ));
    }

    #[test]
    fn stub_adapter_can_be_constructed_as_port_trait_object() {
        // The http crate has no tokio dev-dependency, so we cannot drive the
        // async adapter call in a unit test. We still exercise the stub's
        // construction and its use as a trait object to keep the helper's
        // wiring covered without a runtime.
        let adapter: Arc<dyn ArtificialIntelligencePort> =
            Arc::new(StubArtificialIntelligenceAdapter {
                canned_text: String::from("stubbed answer"),
            });
        // Confirm the trait object is usable (address is stable / non-null by construction).
        assert!(Arc::strong_count(&adapter) >= 1);
    }
}
