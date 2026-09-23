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
use std::sync::Arc;

/// Convert a LaTeX source document into a structured JSON representation by way
/// of the configured artificial intelligence completion adapter.
///
/// The handler pipeline is deliberately decomposed into small, individually
/// testable helper functions so each concern (field extraction, sanitisation,
/// prompt construction, completion parsing and response shaping) can be
/// exercised in isolation.
#[route(method = "POST", path = "/api/latex-to-json-ai")]
pub async fn convert_latex_to_json_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let latex_source = extract_latex_source_field_from_body(&submitted_body)?;

    let sanitised_latex_source = strip_surrounding_latex_document_environment(&latex_source);
    detect_unbalanced_latex_brace_delimiters(&sanitised_latex_source)?;

    let latex_text = parse_latex_source_into_non_empty_text(sanitised_latex_source)?;

    let conversion_prompt_string = build_latex_to_json_conversion_prompt(&latex_text);
    let conversion_prompt = parse_conversion_prompt_into_non_empty_text(conversion_prompt_string)?;

    let completion = request_latex_conversion_completion_from_adapter(
        &application_state.artificial_intelligence_adapter,
        &conversion_prompt,
    )
    .await?;

    let fenced_completion_text =
        strip_markdown_json_code_fence_from_completion(&completion.produced_text);

    let response_body = match parse_completion_text_into_json_value(&fenced_completion_text) {
        Ok(converted_value) => {
            validate_converted_json_is_object_or_array(&converted_value)?;
            build_latex_to_json_response_body(converted_value)
        }
        Err(_recoverable_parse_failure) => {
            fall_back_to_raw_text_json_representation(&completion.produced_text)
        }
    };

    Ok(Json(response_body))
}

// ---------------------------------------------------------------------------
// 1. Extract the required `latex` field from the request body.
// ---------------------------------------------------------------------------

/// Pull the `latex` field out of the submitted JSON body, returning a malformed
/// body error when the field is absent or not a string.
fn extract_latex_source_field_from_body(submitted_body: &Value) -> Result<String, HttpError> {
    read_latex_field_as_string_slice(submitted_body)
        .map(|latex_slice| latex_slice.to_string())
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: String::from("the 'latex' field is required and must be a string"),
        })
}

// ---------------------------------------------------------------------------
// 2. Read the `latex` field as a borrowed string slice.
// ---------------------------------------------------------------------------

/// Borrow the `latex` field as a `&str` when it is present and string-typed.
fn read_latex_field_as_string_slice(submitted_body: &Value) -> Option<&str> {
    submitted_body
        .get("latex")
        .and_then(|latex_value| latex_value.as_str())
}

// ---------------------------------------------------------------------------
// 3. Parse the (sanitised) LaTeX source into a domain NonEmptyText.
// ---------------------------------------------------------------------------

/// Parse the sanitised LaTeX source into a validated [`NonEmptyText`], mapping
/// any domain validation failure into a malformed body error.
fn parse_latex_source_into_non_empty_text(latex_string: String) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(latex_string).map_err(map_latex_parsing_failure_to_malformed_body_error)
}

// ---------------------------------------------------------------------------
// 4. Strip a surrounding \begin{document} ... \end{document} wrapper.
// ---------------------------------------------------------------------------

/// Remove a surrounding `\begin{document} ... \end{document}` environment so the
/// prompt focuses on the document body. When the markers are absent the input
/// is returned trimmed but otherwise unchanged.
fn strip_surrounding_latex_document_environment(latex_source: &str) -> String {
    const DOCUMENT_BEGIN_MARKER: &str = "\\begin{document}";
    const DOCUMENT_END_MARKER: &str = "\\end{document}";

    let trimmed_source = latex_source.trim();

    if let Some(begin_marker_index) = trimmed_source.find(DOCUMENT_BEGIN_MARKER) {
        let body_start_index = begin_marker_index + DOCUMENT_BEGIN_MARKER.len();
        let remainder_after_begin = &trimmed_source[body_start_index..];

        if let Some(end_marker_relative_index) = remainder_after_begin.find(DOCUMENT_END_MARKER) {
            let document_body = &remainder_after_begin[..end_marker_relative_index];
            return document_body.trim().to_string();
        }

        return remainder_after_begin.trim().to_string();
    }

    trimmed_source.to_string()
}

// ---------------------------------------------------------------------------
// 5. Detect unbalanced { } brace delimiters in the LaTeX source.
// ---------------------------------------------------------------------------

/// Verify that curly-brace group delimiters are balanced. Escaped braces
/// (`\{` and `\}`) are ignored. Returns a malformed body error describing the
/// imbalance when detected.
fn detect_unbalanced_latex_brace_delimiters(latex_source: &str) -> Result<(), HttpError> {
    let mut open_brace_depth: i64 = 0;
    let mut previous_char_was_backslash = false;

    for current_char in latex_source.chars() {
        if previous_char_was_backslash {
            // This brace (or any character) was escaped; do not count it.
            previous_char_was_backslash = false;
            continue;
        }

        match current_char {
            '\\' => previous_char_was_backslash = true,
            '{' => open_brace_depth += 1,
            '}' => {
                open_brace_depth -= 1;
                if open_brace_depth < 0 {
                    return Err(HttpError::RequestBodyWasMalformed {
                        explanation: String::from(
                            "the LaTeX source contains a closing brace without a matching opening brace",
                        ),
                    });
                }
            }
            _ => {}
        }
    }

    if open_brace_depth != 0 {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "the LaTeX source has {open_brace_depth} unclosed opening brace(s)"
            ),
        });
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// 6. Build the conversion prompt from the validated LaTeX text.
// ---------------------------------------------------------------------------

/// Compose the natural-language instruction that asks the AI adapter to convert
/// the given LaTeX text into a JSON document.
fn build_latex_to_json_conversion_prompt(latex_text: &NonEmptyText) -> String {
    format!(
        "You are a precise document conversion engine. Convert the following LaTeX \
source into a single valid JSON document that faithfully captures its structure \
(sections, headings, paragraphs and lists). Respond with JSON only and do not wrap \
the JSON in Markdown code fences.\n\nLaTeX source:\n{}",
        latex_text.as_str()
    )
}

// ---------------------------------------------------------------------------
// 7. Parse the assembled prompt string into a NonEmptyText.
// ---------------------------------------------------------------------------

/// Parse the fully-assembled conversion prompt into a [`NonEmptyText`] suitable
/// for handing to the AI adapter.
fn parse_conversion_prompt_into_non_empty_text(
    conversion_prompt_string: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(conversion_prompt_string).map_err(|parsing_error| {
        HttpError::UpstreamApplicationFailure {
            explanation: format!(
                "failed to construct the LaTeX conversion prompt: {parsing_error}"
            ),
        }
    })
}

// ---------------------------------------------------------------------------
// 8. Request the completion from the AI adapter.
// ---------------------------------------------------------------------------

/// Delegate to the artificial intelligence adapter to obtain a completion for
/// the assembled conversion prompt.
async fn request_latex_conversion_completion_from_adapter(
    artificial_intelligence_adapter: &Arc<dyn ArtificialIntelligencePort>,
    conversion_prompt: &NonEmptyText,
) -> Result<GeneratedCompletion, HttpError> {
    let completion = artificial_intelligence_adapter
        .generate_completion(conversion_prompt)
        .await?;
    Ok(completion)
}

// ---------------------------------------------------------------------------
// 9. Strip a Markdown ```json ... ``` code fence from the completion text.
// ---------------------------------------------------------------------------

/// Remove a surrounding Markdown code fence (```json ... ``` or ``` ... ```)
/// from the completion text so the inner payload can be parsed as JSON.
fn strip_markdown_json_code_fence_from_completion(produced_text: &str) -> String {
    let trimmed_text = produced_text.trim();

    if !trimmed_text.starts_with("```") {
        return trimmed_text.to_string();
    }

    // Drop everything up to and including the first newline (the opening fence,
    // which may carry a language hint such as ```json).
    let after_opening_fence = match trimmed_text.find('\n') {
        Some(first_newline_index) => &trimmed_text[first_newline_index + 1..],
        None => return trimmed_text.trim_matches('`').trim().to_string(),
    };

    // Drop the trailing closing fence if one is present.
    let without_closing_fence = match after_opening_fence.rfind("```") {
        Some(closing_fence_index) => &after_opening_fence[..closing_fence_index],
        None => after_opening_fence,
    };

    without_closing_fence.trim().to_string()
}

// ---------------------------------------------------------------------------
// 10. Parse the fenced completion text into a serde_json::Value.
// ---------------------------------------------------------------------------

/// Parse the de-fenced completion text into a [`serde_json::Value`], mapping any
/// deserialization failure into a malformed body error.
fn parse_completion_text_into_json_value(fenced_completion_text: &str) -> Result<Value, HttpError> {
    serde_json::from_str::<Value>(fenced_completion_text)
        .map_err(map_json_deserialization_failure_to_malformed_body_error)
}

// ---------------------------------------------------------------------------
// 11. Map a serde_json parse failure into an HttpError.
// ---------------------------------------------------------------------------

/// Translate a JSON deserialization failure into an [`HttpError`] describing the
/// malformed AI output.
fn map_json_deserialization_failure_to_malformed_body_error(
    deserialization_error: serde_json::Error,
) -> HttpError {
    HttpError::RequestBodyWasMalformed {
        explanation: format!(
            "the AI completion could not be parsed as JSON: {deserialization_error}"
        ),
    }
}

// ---------------------------------------------------------------------------
// 12. Map a domain parse failure into an HttpError.
// ---------------------------------------------------------------------------

/// Translate a domain [`DomainError`](alma_domain::error::DomainError) raised
/// while validating LaTeX input into a malformed body error.
fn map_latex_parsing_failure_to_malformed_body_error(
    parsing_error: alma_domain::error::DomainError,
) -> HttpError {
    HttpError::RequestBodyWasMalformed {
        explanation: parsing_error.to_string(),
    }
}

// ---------------------------------------------------------------------------
// 13. Validate that the converted JSON is an object or array.
// ---------------------------------------------------------------------------

/// Ensure the converted value is a structured JSON object or array rather than a
/// bare scalar, which would indicate the model failed to produce a document.
fn validate_converted_json_is_object_or_array(converted_value: &Value) -> Result<(), HttpError> {
    if converted_value.is_object() || converted_value.is_array() {
        return Ok(());
    }

    Err(HttpError::RequestBodyWasMalformed {
        explanation: String::from(
            "the AI completion produced a scalar JSON value; expected an object or array",
        ),
    })
}

// ---------------------------------------------------------------------------
// 14. Build the successful response body.
// ---------------------------------------------------------------------------

/// Wrap the successfully-parsed JSON document in the handler's response envelope.
fn build_latex_to_json_response_body(converted_json_representation: Value) -> Value {
    json!({
        "json_representation": converted_json_representation,
        "was_structured": true,
    })
}

// ---------------------------------------------------------------------------
// 15. Fall back to a raw-text representation when parsing fails.
// ---------------------------------------------------------------------------

/// Produce a best-effort response that returns the raw completion text when it
/// could not be parsed into structured JSON, so the caller still receives the
/// model output rather than an error.
fn fall_back_to_raw_text_json_representation(produced_text: &str) -> Value {
    json!({
        "json_representation": produced_text,
        "was_structured": false,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // 2 / 1. Field extraction ------------------------------------------------

    #[test]
    fn reads_latex_field_as_string_slice_when_present() {
        let body = json!({ "latex": "\\section{Intro}" });
        assert_eq!(read_latex_field_as_string_slice(&body), Some("\\section{Intro}"));
    }

    #[test]
    fn reads_none_when_latex_field_is_missing_or_not_string() {
        let missing = json!({ "other": 1 });
        assert_eq!(read_latex_field_as_string_slice(&missing), None);
        let wrong_type = json!({ "latex": 42 });
        assert_eq!(read_latex_field_as_string_slice(&wrong_type), None);
    }

    #[test]
    fn extracts_latex_source_field_from_valid_body() {
        let body = json!({ "latex": "hello world" });
        let extracted = extract_latex_source_field_from_body(&body).expect("should extract");
        assert_eq!(extracted, "hello world");
    }

    #[test]
    fn extract_fails_on_missing_latex_field() {
        let body = json!({ "not_latex": "value" });
        let error = extract_latex_source_field_from_body(&body).unwrap_err();
        assert!(matches!(error, HttpError::RequestBodyWasMalformed { .. }));
    }

    // 3. Domain parsing ------------------------------------------------------

    #[test]
    fn parses_non_empty_latex_source_into_text() {
        let parsed = parse_latex_source_into_non_empty_text("content".to_string())
            .expect("non-empty input should parse");
        assert_eq!(parsed.as_str(), "content");
    }

    #[test]
    fn parse_fails_on_empty_latex_source() {
        let error = parse_latex_source_into_non_empty_text(String::new()).unwrap_err();
        assert!(matches!(error, HttpError::RequestBodyWasMalformed { .. }));
    }

    // 4. Document environment stripping -------------------------------------

    #[test]
    fn strips_surrounding_document_environment() {
        let source =
            "\\documentclass{article}\\begin{document}\nBody text.\n\\end{document}";
        assert_eq!(
            strip_surrounding_latex_document_environment(source),
            "Body text."
        );
    }

    #[test]
    fn returns_trimmed_source_when_no_document_environment() {
        let source = "  just a fragment  ";
        assert_eq!(
            strip_surrounding_latex_document_environment(source),
            "just a fragment"
        );
    }

    // 5. Brace balancing -----------------------------------------------------

    #[test]
    fn accepts_balanced_and_escaped_braces() {
        assert!(detect_unbalanced_latex_brace_delimiters("\\section{Intro} \\{ \\}").is_ok());
    }

    #[test]
    fn rejects_unbalanced_open_brace() {
        let error =
            detect_unbalanced_latex_brace_delimiters("\\section{Intro").unwrap_err();
        assert!(matches!(error, HttpError::RequestBodyWasMalformed { .. }));
    }

    #[test]
    fn rejects_stray_closing_brace() {
        let error = detect_unbalanced_latex_brace_delimiters("text}").unwrap_err();
        assert!(matches!(error, HttpError::RequestBodyWasMalformed { .. }));
    }

    // 6. Prompt construction -------------------------------------------------

    #[test]
    fn builds_conversion_prompt_including_latex_text() {
        let latex_text = NonEmptyText::parse("\\section{Intro}".to_string()).unwrap();
        let prompt = build_latex_to_json_conversion_prompt(&latex_text);
        assert!(prompt.contains("\\section{Intro}"));
        assert!(prompt.contains("JSON"));
    }

    // 7. Prompt parsing ------------------------------------------------------

    #[test]
    fn parses_non_empty_prompt_into_text() {
        let parsed = parse_conversion_prompt_into_non_empty_text("prompt body".to_string())
            .expect("non-empty prompt should parse");
        assert_eq!(parsed.as_str(), "prompt body");
    }

    #[test]
    fn prompt_parse_fails_on_empty_string() {
        let error = parse_conversion_prompt_into_non_empty_text(String::new()).unwrap_err();
        assert!(matches!(error, HttpError::UpstreamApplicationFailure { .. }));
    }

    // 9. Code-fence stripping ------------------------------------------------

    #[test]
    fn strips_json_markdown_code_fence() {
        let fenced = "```json\n{\"a\":1}\n```";
        assert_eq!(strip_markdown_json_code_fence_from_completion(fenced), "{\"a\":1}");
    }

    #[test]
    fn returns_text_unchanged_when_no_code_fence() {
        let plain = "{\"a\":1}";
        assert_eq!(strip_markdown_json_code_fence_from_completion(plain), "{\"a\":1}");
    }

    // 10. Completion parsing -------------------------------------------------

    #[test]
    fn parses_valid_json_completion() {
        let parsed = parse_completion_text_into_json_value("{\"key\":\"value\"}")
            .expect("valid json should parse");
        assert_eq!(parsed["key"], json!("value"));
    }

    #[test]
    fn completion_parse_fails_on_invalid_json() {
        let error = parse_completion_text_into_json_value("not json").unwrap_err();
        assert!(matches!(error, HttpError::RequestBodyWasMalformed { .. }));
    }

    // 11. serde error mapping ------------------------------------------------

    #[test]
    fn maps_serde_failure_to_malformed_body_error() {
        let serde_error = serde_json::from_str::<Value>("{").unwrap_err();
        let error = map_json_deserialization_failure_to_malformed_body_error(serde_error);
        assert!(matches!(error, HttpError::RequestBodyWasMalformed { .. }));
    }

    // 12. domain error mapping ----------------------------------------------

    #[test]
    fn maps_domain_failure_to_malformed_body_error() {
        let domain_error = NonEmptyText::parse(String::new()).unwrap_err();
        let error = map_latex_parsing_failure_to_malformed_body_error(domain_error);
        assert!(matches!(error, HttpError::RequestBodyWasMalformed { .. }));
    }

    // 13. structured validation ---------------------------------------------

    #[test]
    fn accepts_object_and_array_json() {
        assert!(validate_converted_json_is_object_or_array(&json!({"a":1})).is_ok());
        assert!(validate_converted_json_is_object_or_array(&json!([1, 2, 3])).is_ok());
    }

    #[test]
    fn rejects_scalar_json() {
        let error = validate_converted_json_is_object_or_array(&json!(7)).unwrap_err();
        assert!(matches!(error, HttpError::RequestBodyWasMalformed { .. }));
    }

    // 14. success response ---------------------------------------------------

    #[test]
    fn builds_structured_response_body() {
        let body = build_latex_to_json_response_body(json!({"title": "T"}));
        assert_eq!(body["was_structured"], json!(true));
        assert_eq!(body["json_representation"]["title"], json!("T"));
    }

    // 15. fallback response --------------------------------------------------

    #[test]
    fn builds_raw_text_fallback_response_body() {
        let body = fall_back_to_raw_text_json_representation("raw model output");
        assert_eq!(body["was_structured"], json!(false));
        assert_eq!(body["json_representation"], json!("raw model output"));
    }

    // 8. Adapter delegation --------------------------------------------------
    //
    // Note: the async helper `request_latex_conversion_completion_from_adapter`
    // is a thin `?`-propagating wrapper around the adapter call and is covered
    // through the handler at runtime. A dedicated async unit test is omitted
    // here because the `http` crate declares no `tokio` (dev-)dependency, so an
    // async executor is not available inside this crate's test target.
}
