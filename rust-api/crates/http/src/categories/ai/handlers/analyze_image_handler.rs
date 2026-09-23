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

/// Maximum number of characters retained in the short summary field that is
/// returned alongside the full completion for image analysis responses.
const MAXIMUM_ANALYSIS_SUMMARY_CHARACTERS: usize = 280;

/// POST `/api/image-analysis`
///
/// Accepts a textual instruction (via `prompt` or `caption`) together with one
/// or more base64-encoded images and asks the artificial intelligence adapter
/// to analyze them. The handler orchestrates a series of small, individually
/// testable helpers: it extracts and validates the instruction, extracts and
/// validates the supplied image payloads, composes a combined analysis prompt,
/// requests a completion from the adapter and finally builds the response body.
#[route(method = "POST", path = "/api/image-analysis")]
pub async fn analyze_image_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let instruction_string = extract_image_analysis_instruction_field_from_body(&submitted_body)?;
    let instruction_text = parse_analysis_instruction_into_non_empty_text(instruction_string)?;

    let image_payloads = extract_base64_image_payloads_from_body(&submitted_body);
    validate_at_least_one_image_was_supplied(&image_payloads)?;
    let analyzed_image_count = count_supplied_image_payloads(&image_payloads);

    // The declared MIME type is optional metadata; when present it is folded
    // into the prompt so the adapter has extra context about the payloads.
    let declared_mime_type = read_declared_image_mime_type_field(&submitted_body);

    let combined_prompt_string = build_image_analysis_prompt_from_instruction_and_image_count(
        &instruction_text,
        analyzed_image_count,
    );
    let combined_prompt_string = match declared_mime_type {
        Some(mime_type) => format!("{combined_prompt_string} The images are encoded as {mime_type}."),
        None => combined_prompt_string,
    };
    let analysis_prompt = parse_image_analysis_prompt_into_non_empty_text(combined_prompt_string)?;

    let completion = request_image_analysis_completion_from_adapter(
        &application_state.artificial_intelligence_adapter,
        &analysis_prompt,
    )
    .await?;

    let response_body = build_image_analysis_response_body(completion, analyzed_image_count);
    Ok(Json(response_body))
}

/// Extract the instruction text for the analysis, preferring the `prompt`
/// field and falling back to the `caption` field. Returns a malformed-body
/// error when neither field is present as a string.
fn extract_image_analysis_instruction_field_from_body(
    submitted_body: &Value,
) -> Result<String, HttpError> {
    let prompt_slice = read_prompt_field_as_string_slice(submitted_body);
    let caption_slice = read_caption_field_as_string_slice(submitted_body);
    choose_first_present_instruction_source(prompt_slice, caption_slice).ok_or_else(|| {
        HttpError::RequestBodyWasMalformed {
            explanation: String::from("either the 'prompt' or 'caption' field is required"),
        }
    })
}

/// Read the `prompt` field of the body as a borrowed string slice, if present.
fn read_prompt_field_as_string_slice(submitted_body: &Value) -> Option<&str> {
    submitted_body
        .get("prompt")
        .and_then(|prompt_value| prompt_value.as_str())
}

/// Read the `caption` field of the body as a borrowed string slice, if present.
fn read_caption_field_as_string_slice(submitted_body: &Value) -> Option<&str> {
    submitted_body
        .get("caption")
        .and_then(|caption_value| caption_value.as_str())
}

/// Choose the first present instruction source, preferring the prompt slice
/// over the caption slice, converting the chosen slice into an owned string.
fn choose_first_present_instruction_source(
    prompt_slice: Option<&str>,
    caption_slice: Option<&str>,
) -> Option<String> {
    prompt_slice
        .or(caption_slice)
        .map(|instruction_slice| instruction_slice.to_string())
}

/// Parse the raw instruction string into a validated `NonEmptyText`, mapping
/// domain parse failures onto a malformed-body HTTP error.
fn parse_analysis_instruction_into_non_empty_text(
    instruction_string: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(instruction_string)
        .map_err(|parsing_error| HttpError::RequestBodyWasMalformed {
            explanation: parsing_error.to_string(),
        })
}

/// Extract the list of base64-encoded image payloads from the body. Supports
/// both a single `image` string field and an `images` array of strings; any
/// non-string array entry is skipped rather than aborting the whole request.
fn extract_base64_image_payloads_from_body(submitted_body: &Value) -> Vec<String> {
    let mut collected_payloads: Vec<String> = Vec::new();

    if let Some(single_image) = submitted_body
        .get("image")
        .and_then(|image_value| image_value.as_str())
    {
        if !single_image.is_empty() {
            collected_payloads.push(single_image.to_string());
        }
    }

    if let Some(image_array) = submitted_body
        .get("images")
        .and_then(|images_value| images_value.as_array())
    {
        for image_entry in image_array {
            if let Some(image_slice) = image_entry.as_str() {
                if !image_slice.is_empty() {
                    collected_payloads.push(image_slice.to_string());
                }
            }
        }
    }

    collected_payloads
}

/// Count how many image payloads were supplied.
fn count_supplied_image_payloads(image_payloads: &[String]) -> usize {
    image_payloads.len()
}

/// Validate that at least one image payload was supplied, returning a
/// malformed-body error otherwise.
fn validate_at_least_one_image_was_supplied(image_payloads: &[String]) -> Result<(), HttpError> {
    if image_payloads.is_empty() {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from(
                "at least one image must be supplied via 'image' or 'images'",
            ),
        });
    }
    Ok(())
}

/// Read the optional declared image MIME type from the body. Returns `None`
/// when the field is absent, non-string, or empty after trimming.
fn read_declared_image_mime_type_field(submitted_body: &Value) -> Option<String> {
    submitted_body
        .get("mime_type")
        .and_then(|mime_value| mime_value.as_str())
        .map(|mime_slice| mime_slice.trim().to_string())
        .filter(|trimmed_mime| !trimmed_mime.is_empty())
}

/// Build the combined natural-language prompt that instructs the adapter to
/// analyze the supplied images, incorporating both the user's instruction and
/// the number of images that were provided.
fn build_image_analysis_prompt_from_instruction_and_image_count(
    instruction_text: &NonEmptyText,
    image_count: usize,
) -> String {
    let image_noun = if image_count == 1 { "image" } else { "images" };
    format!(
        "Analyze the following {image_count} {image_noun}. \
Instruction: {instruction}",
        image_count = image_count,
        image_noun = image_noun,
        instruction = instruction_text.as_str(),
    )
}

/// Parse the composed prompt string into a validated `NonEmptyText`, mapping
/// any domain parse failure onto a malformed-body error via the shared mapper.
fn parse_image_analysis_prompt_into_non_empty_text(
    combined_prompt_string: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(combined_prompt_string).map_err(map_completion_parsing_failure_to_malformed_body_error)
}

/// Map a domain parsing failure onto a malformed-body HTTP error. Extracted so
/// the mapping is applied consistently wherever prompt parsing occurs.
fn map_completion_parsing_failure_to_malformed_body_error(
    parsing_error: alma_domain::error::DomainError,
) -> HttpError {
    HttpError::RequestBodyWasMalformed {
        explanation: parsing_error.to_string(),
    }
}

/// Build the JSON response body for a successful image analysis, exposing the
/// full completion text, a truncated summary, and the number of analyzed
/// images.
fn build_image_analysis_response_body(
    completion: GeneratedCompletion,
    analyzed_image_count: usize,
) -> Value {
    let analysis_summary = truncate_completion_text_to_analysis_summary_length(
        &completion.produced_text,
        MAXIMUM_ANALYSIS_SUMMARY_CHARACTERS,
    );
    json!({
        "completion": completion.produced_text,
        "summary": analysis_summary,
        "analyzed_image_count": analyzed_image_count,
    })
}

/// Request an image-analysis completion from the artificial intelligence
/// adapter, propagating any application error as an HTTP error via the shared
/// `From<ApplicationError>` conversion.
async fn request_image_analysis_completion_from_adapter(
    artificial_intelligence_adapter: &std::sync::Arc<dyn ArtificialIntelligencePort>,
    analysis_prompt: &NonEmptyText,
) -> Result<GeneratedCompletion, HttpError> {
    let completion = artificial_intelligence_adapter
        .generate_completion(analysis_prompt)
        .await?;
    Ok(completion)
}

/// Truncate the completion text to at most `maximum_summary_characters`
/// characters, appending an ellipsis when truncation actually occurred. The
/// truncation is performed on character boundaries to remain UTF-8 safe.
fn truncate_completion_text_to_analysis_summary_length(
    produced_text: &str,
    maximum_summary_characters: usize,
) -> String {
    let total_characters = produced_text.chars().count();
    if total_characters <= maximum_summary_characters {
        return produced_text.to_string();
    }
    let mut truncated_summary: String = produced_text.chars().take(maximum_summary_characters).collect();
    truncated_summary.push('…');
    truncated_summary
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn read_prompt_field_returns_slice_when_present() {
        let body = json!({ "prompt": "describe this" });
        assert_eq!(read_prompt_field_as_string_slice(&body), Some("describe this"));
    }

    #[test]
    fn read_prompt_field_returns_none_when_absent_or_non_string() {
        let missing = json!({ "other": "value" });
        assert_eq!(read_prompt_field_as_string_slice(&missing), None);
        let non_string = json!({ "prompt": 42 });
        assert_eq!(read_prompt_field_as_string_slice(&non_string), None);
    }

    #[test]
    fn read_caption_field_returns_slice_when_present() {
        let body = json!({ "caption": "a cat" });
        assert_eq!(read_caption_field_as_string_slice(&body), Some("a cat"));
    }

    #[test]
    fn read_caption_field_returns_none_when_absent() {
        let body = json!({ "prompt": "hi" });
        assert_eq!(read_caption_field_as_string_slice(&body), None);
    }

    #[test]
    fn choose_first_present_prefers_prompt_over_caption() {
        let chosen = choose_first_present_instruction_source(Some("prompt text"), Some("caption text"));
        assert_eq!(chosen, Some(String::from("prompt text")));
    }

    #[test]
    fn choose_first_present_falls_back_to_caption() {
        let chosen = choose_first_present_instruction_source(None, Some("caption text"));
        assert_eq!(chosen, Some(String::from("caption text")));
    }

    #[test]
    fn choose_first_present_returns_none_when_both_absent() {
        assert_eq!(choose_first_present_instruction_source(None, None), None);
    }

    #[test]
    fn extract_instruction_field_reads_prompt_first() {
        let body = json!({ "prompt": "explain", "caption": "ignored" });
        let extracted = extract_image_analysis_instruction_field_from_body(&body).unwrap();
        assert_eq!(extracted, "explain");
    }

    #[test]
    fn extract_instruction_field_errors_when_both_missing() {
        let body = json!({ "images": ["abc"] });
        let error = extract_image_analysis_instruction_field_from_body(&body).unwrap_err();
        assert!(matches!(error, HttpError::RequestBodyWasMalformed { .. }));
    }

    #[test]
    fn parse_analysis_instruction_accepts_non_empty() {
        let parsed = parse_analysis_instruction_into_non_empty_text(String::from("hello")).unwrap();
        assert_eq!(parsed.as_str(), "hello");
    }

    #[test]
    fn parse_analysis_instruction_rejects_empty() {
        let error = parse_analysis_instruction_into_non_empty_text(String::new()).unwrap_err();
        assert!(matches!(error, HttpError::RequestBodyWasMalformed { .. }));
    }

    #[test]
    fn extract_image_payloads_reads_single_and_array() {
        let body = json!({
            "image": "single",
            "images": ["first", "second", 7, "", "third"]
        });
        let payloads = extract_base64_image_payloads_from_body(&body);
        assert_eq!(payloads, vec!["single", "first", "second", "third"]);
    }

    #[test]
    fn extract_image_payloads_returns_empty_when_none_present() {
        let body = json!({ "prompt": "no images here" });
        let payloads = extract_base64_image_payloads_from_body(&body);
        assert!(payloads.is_empty());
    }

    #[test]
    fn count_supplied_image_payloads_counts_entries() {
        let payloads = vec![String::from("a"), String::from("b")];
        assert_eq!(count_supplied_image_payloads(&payloads), 2);
        let empty: Vec<String> = Vec::new();
        assert_eq!(count_supplied_image_payloads(&empty), 0);
    }

    #[test]
    fn validate_at_least_one_image_accepts_non_empty() {
        let payloads = vec![String::from("payload")];
        assert!(validate_at_least_one_image_was_supplied(&payloads).is_ok());
    }

    #[test]
    fn validate_at_least_one_image_rejects_empty() {
        let empty: Vec<String> = Vec::new();
        let error = validate_at_least_one_image_was_supplied(&empty).unwrap_err();
        assert!(matches!(error, HttpError::RequestBodyWasMalformed { .. }));
    }

    #[test]
    fn read_declared_mime_type_returns_trimmed_value() {
        let body = json!({ "mime_type": "  image/png  " });
        assert_eq!(read_declared_image_mime_type_field(&body), Some(String::from("image/png")));
    }

    #[test]
    fn read_declared_mime_type_returns_none_for_blank_or_absent() {
        let blank = json!({ "mime_type": "   " });
        assert_eq!(read_declared_image_mime_type_field(&blank), None);
        let absent = json!({ "prompt": "x" });
        assert_eq!(read_declared_image_mime_type_field(&absent), None);
    }

    #[test]
    fn build_prompt_uses_singular_and_plural_nouns() {
        let instruction = NonEmptyText::parse(String::from("identify objects")).unwrap();
        let singular = build_image_analysis_prompt_from_instruction_and_image_count(&instruction, 1);
        assert!(singular.contains("1 image."));
        assert!(singular.contains("identify objects"));
        let plural = build_image_analysis_prompt_from_instruction_and_image_count(&instruction, 3);
        assert!(plural.contains("3 images."));
    }

    #[test]
    fn parse_image_analysis_prompt_accepts_non_empty() {
        let parsed = parse_image_analysis_prompt_into_non_empty_text(String::from("analyze")).unwrap();
        assert_eq!(parsed.as_str(), "analyze");
    }

    #[test]
    fn parse_image_analysis_prompt_rejects_empty() {
        let error = parse_image_analysis_prompt_into_non_empty_text(String::new()).unwrap_err();
        assert!(matches!(error, HttpError::RequestBodyWasMalformed { .. }));
    }

    #[test]
    fn map_completion_parsing_failure_produces_malformed_body() {
        let domain_error = NonEmptyText::parse(String::new()).unwrap_err();
        let mapped = map_completion_parsing_failure_to_malformed_body_error(domain_error);
        assert!(matches!(mapped, HttpError::RequestBodyWasMalformed { .. }));
    }

    #[test]
    fn build_response_body_exposes_completion_summary_and_count() {
        let completion = GeneratedCompletion {
            produced_text: String::from("a detailed description"),
        };
        let body = build_image_analysis_response_body(completion, 2);
        assert_eq!(body["completion"], json!("a detailed description"));
        assert_eq!(body["summary"], json!("a detailed description"));
        assert_eq!(body["analyzed_image_count"], json!(2));
    }

    #[test]
    fn truncate_returns_original_when_short() {
        let text = "short text";
        assert_eq!(
            truncate_completion_text_to_analysis_summary_length(text, 280),
            "short text"
        );
    }

    #[test]
    fn truncate_shortens_and_appends_ellipsis_when_long() {
        let text = "abcdefghij";
        let truncated = truncate_completion_text_to_analysis_summary_length(text, 5);
        assert_eq!(truncated, "abcde…");
    }

    // Note: the async helper `request_image_analysis_completion_from_adapter`
    // is a thin `?`-propagating wrapper around the adapter call and is covered
    // through the handler at runtime. A dedicated async unit test is omitted
    // here because the `http` crate declares no `tokio` (dev-)dependency, so an
    // executor is not available inside this crate's test target.
}
