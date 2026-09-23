use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::ports::ai::{ArtificialIntelligencePort, GeneratedCompletion};
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::error::DomainError;
use alma_domain::value_objects::NonEmptyText;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};

/// The default upper bound applied to an assessment score when the request does
/// not explicitly supply a `maximum_score` field. Ten is a familiar grading
/// scale for policy answers and keeps the derived percentages intuitive.
const DEFAULT_MAXIMUM_ASSESSMENT_SCORE: u8 = 10;

/// The largest value a caller may request for `maximum_score`. Scores above one
/// hundred stop being meaningful for a single free-text answer and inflating the
/// ceiling only makes the language-model extraction noisier.
const LARGEST_PERMITTED_MAXIMUM_SCORE: u8 = 100;

/// The maximum number of characters of a submitted answer that we are willing to
/// embed into the assessment prompt. Long answers are truncated so the prompt
/// stays within a reasonable size and the model focuses on the substance.
const MAXIMUM_ANSWER_CHARACTERS_IN_PROMPT: usize = 4000;

/// The fraction (as a percentage) of the maximum score an answer must reach to
/// be classified as a pass. Sixty percent is a conventional passing threshold.
const PASSING_SCORE_PERCENTAGE: u32 = 60;

#[route(method = "POST", path = "/api/assess-policy-answer")]
pub async fn assess_policy_answer_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let supplied_question = extract_required_question_field(&submitted_body)?;
    let supplied_answer = extract_required_answer_field(&submitted_body)?;
    reject_blank_answer_submission(&supplied_answer)?;

    let grading_rubric = extract_optional_grading_rubric_field(&submitted_body);
    let maximum_score = extract_optional_maximum_score_field(&submitted_body)?;

    let answer_for_prompt =
        truncate_oversized_answer_for_prompt(&supplied_answer, MAXIMUM_ANSWER_CHARACTERS_IN_PROMPT);
    let combined_prompt = compose_policy_assessment_prompt(
        &supplied_question,
        &answer_for_prompt,
        grading_rubric.as_deref(),
    );
    let prompt_text = parse_assessment_prompt_into_non_empty_text(combined_prompt)?;

    let completion =
        request_assessment_completion(application_state.artificial_intelligence_adapter.as_ref(), &prompt_text)
            .await?;

    let raw_score = extract_numeric_score_from_completion_text(&completion.produced_text)
        .unwrap_or(0);
    let clamped_score = clamp_extracted_score_to_maximum(raw_score, maximum_score);
    let qualitative_feedback =
        extract_qualitative_feedback_from_completion_text(&completion.produced_text);
    let has_passed = classify_answer_pass_or_fail(clamped_score, maximum_score);

    let response_payload = build_assessment_response_payload(
        clamped_score,
        maximum_score,
        has_passed,
        &qualitative_feedback,
    );
    Ok(Json(response_payload))
}

/// (1) Pull the mandatory `question` field out of the request body, rejecting the
/// request if the field is missing or not a JSON string.
fn extract_required_question_field(submitted_body: &Value) -> Result<String, HttpError> {
    submitted_body
        .get("question")
        .and_then(|question_value| question_value.as_str())
        .map(|question_str| question_str.to_string())
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: String::from("the 'question' field is required and must be a string"),
        })
}

/// (2) Pull the mandatory `answer` field out of the request body, rejecting the
/// request if the field is missing or not a JSON string.
fn extract_required_answer_field(submitted_body: &Value) -> Result<String, HttpError> {
    submitted_body
        .get("answer")
        .and_then(|answer_value| answer_value.as_str())
        .map(|answer_str| answer_str.to_string())
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: String::from("the 'answer' field is required and must be a string"),
        })
}

/// (3) Read the optional `grading_rubric` field. A missing field, a non-string
/// value, or a rubric that is only whitespace all collapse to `None` so the
/// prompt builder can simply skip the rubric section.
fn extract_optional_grading_rubric_field(submitted_body: &Value) -> Option<String> {
    submitted_body
        .get("grading_rubric")
        .and_then(|rubric_value| rubric_value.as_str())
        .map(|rubric_str| rubric_str.trim())
        .filter(|trimmed_rubric| !trimmed_rubric.is_empty())
        .map(|trimmed_rubric| trimmed_rubric.to_string())
}

/// (4) Read the optional `maximum_score` field. When absent we fall back to the
/// default ceiling; when present it must be a positive integer within the
/// permitted range, otherwise the request is rejected as malformed.
fn extract_optional_maximum_score_field(submitted_body: &Value) -> Result<u8, HttpError> {
    let maximum_score_value = match submitted_body.get("maximum_score") {
        None => return Ok(DEFAULT_MAXIMUM_ASSESSMENT_SCORE),
        Some(value) if value.is_null() => return Ok(DEFAULT_MAXIMUM_ASSESSMENT_SCORE),
        Some(value) => value,
    };

    let parsed_maximum = maximum_score_value.as_u64().ok_or_else(|| {
        HttpError::RequestBodyWasMalformed {
            explanation: String::from("the 'maximum_score' field must be a non-negative integer"),
        }
    })?;

    if parsed_maximum == 0 {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from("the 'maximum_score' field must be greater than zero"),
        });
    }
    if parsed_maximum > u64::from(LARGEST_PERMITTED_MAXIMUM_SCORE) {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "the 'maximum_score' field must not exceed {LARGEST_PERMITTED_MAXIMUM_SCORE}"
            ),
        });
    }
    Ok(parsed_maximum as u8)
}

/// (5) Guard against answers that are empty or made up entirely of whitespace;
/// there is nothing meaningful to assess in that case.
fn reject_blank_answer_submission(candidate_answer: &str) -> Result<(), HttpError> {
    if candidate_answer.trim().is_empty() {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from("the 'answer' field must not be blank"),
        });
    }
    Ok(())
}

/// (6) Assemble the natural-language instruction sent to the assessing model.
/// The prompt asks the model to emit a machine-parseable `Score:` line followed
/// by qualitative `Feedback:`, which the downstream extractors rely on.
fn compose_policy_assessment_prompt(
    supplied_question: &str,
    supplied_answer: &str,
    grading_rubric: Option<&str>,
) -> String {
    let mut prompt = String::new();
    prompt.push_str(
        "You are grading a written policy answer. Evaluate the answer against the question",
    );
    if let Some(rubric_text) = grading_rubric {
        prompt.push_str(" and the provided grading rubric.\n\n");
        prompt.push_str("Grading rubric:\n");
        prompt.push_str(rubric_text);
        prompt.push_str("\n\n");
    } else {
        prompt.push_str(".\n\n");
    }
    prompt.push_str("Question:\n");
    prompt.push_str(supplied_question);
    prompt.push_str("\n\nAnswer:\n");
    prompt.push_str(supplied_answer);
    prompt.push_str(
        "\n\nRespond on two lines. First line: 'Score: <integer>' out of the maximum. \
Second line onward: 'Feedback: <one paragraph of constructive feedback>'.",
    );
    prompt
}

/// (7) Convert the composed prompt into a validated `NonEmptyText`, translating a
/// domain validation failure into a malformed-body HTTP error.
fn parse_assessment_prompt_into_non_empty_text(
    combined_prompt: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(combined_prompt).map_err(map_domain_parse_failure_to_malformed_body)
}

/// (8) Uniform mapping from a domain parse failure to the malformed-body variant
/// of `HttpError`.
fn map_domain_parse_failure_to_malformed_body(parsing_failure: DomainError) -> HttpError {
    HttpError::RequestBodyWasMalformed {
        explanation: parsing_failure.to_string(),
    }
}

/// (9) Scan the model's completion for the first integer that follows a `Score:`
/// label (case-insensitive). If no labelled score is present, fall back to the
/// first standalone integer anywhere in the text. Returns `None` if no digits at
/// all are found.
fn extract_numeric_score_from_completion_text(produced_text: &str) -> Option<u8> {
    let lowercased = produced_text.to_lowercase();
    if let Some(label_position) = lowercased.find("score") {
        let after_label = &produced_text[label_position + "score".len()..];
        if let Some(found) = first_integer_in(after_label) {
            return Some(found);
        }
    }
    first_integer_in(produced_text)
}

/// Helper for (9): read the first run of ASCII digits found in `text`, saturating
/// at `u8::MAX` so absurdly large numbers do not overflow.
fn first_integer_in(text: &str) -> Option<u8> {
    let mut digits = String::new();
    for character in text.chars() {
        if character.is_ascii_digit() {
            digits.push(character);
        } else if !digits.is_empty() {
            break;
        }
    }
    if digits.is_empty() {
        return None;
    }
    Some(digits.parse::<u32>().map_or(u8::MAX, |parsed| {
        if parsed > u32::from(u8::MAX) {
            u8::MAX
        } else {
            parsed as u8
        }
    }))
}

/// (10) Clamp the raw extracted score so it never exceeds the effective maximum.
fn clamp_extracted_score_to_maximum(raw_score: u8, maximum_score: u8) -> u8 {
    if raw_score > maximum_score {
        maximum_score
    } else {
        raw_score
    }
}

/// (11) Pull the qualitative feedback out of the completion. Prefers the text
/// after a `Feedback:` label; otherwise returns the trimmed completion in full;
/// a completely empty completion yields a neutral placeholder.
fn extract_qualitative_feedback_from_completion_text(produced_text: &str) -> String {
    let lowercased = produced_text.to_lowercase();
    if let Some(label_position) = lowercased.find("feedback:") {
        let after_label = &produced_text[label_position + "feedback:".len()..];
        let trimmed = after_label.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let whole = produced_text.trim();
    if whole.is_empty() {
        String::from("No qualitative feedback was produced for this answer.")
    } else {
        whole.to_string()
    }
}

/// (12) Decide whether an answer passes by comparing its clamped score against
/// the configured passing percentage of the maximum. Uses integer arithmetic to
/// avoid floating-point rounding surprises.
fn classify_answer_pass_or_fail(clamped_score: u8, maximum_score: u8) -> bool {
    if maximum_score == 0 {
        return false;
    }
    let scaled_score = u32::from(clamped_score) * 100;
    let threshold = u32::from(maximum_score) * PASSING_SCORE_PERCENTAGE;
    scaled_score >= threshold
}

/// (13) Build the JSON response returned to the caller, carrying the score, the
/// maximum, the pass/fail verdict, and the qualitative feedback.
fn build_assessment_response_payload(
    clamped_score: u8,
    maximum_score: u8,
    has_passed: bool,
    feedback: &str,
) -> Value {
    json!({
        "score": clamped_score,
        "maximum_score": maximum_score,
        "passed": has_passed,
        "feedback": feedback,
    })
}

/// (14) Truncate an over-long answer down to at most `maximum_character_count`
/// characters (counted by Unicode scalar values, so multi-byte characters are
/// never split), appending an ellipsis marker when truncation occurs.
fn truncate_oversized_answer_for_prompt(
    supplied_answer: &str,
    maximum_character_count: usize,
) -> String {
    if supplied_answer.chars().count() <= maximum_character_count {
        return supplied_answer.to_string();
    }
    let mut truncated: String = supplied_answer.chars().take(maximum_character_count).collect();
    truncated.push_str(" [...]");
    truncated
}

/// (15) Thin async wrapper that forwards the prompt to the AI adapter and lifts
/// the application-level error into an `HttpError`. Generic over the port so it
/// can be unit-checked against fakes and accept the `dyn` adapter held in state.
async fn request_assessment_completion<A: ArtificialIntelligencePort + ?Sized>(
    adapter: &A,
    prompt_text: &NonEmptyText,
) -> Result<GeneratedCompletion, HttpError> {
    adapter
        .generate_completion(prompt_text)
        .await
        .map_err(HttpError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_required_question_field_reads_a_present_string() {
        let body = json!({ "question": "What is subsidiarity?" });
        let extracted = extract_required_question_field(&body).expect("question should parse");
        assert_eq!(extracted, "What is subsidiarity?");
    }

    #[test]
    fn extract_required_question_field_rejects_missing_field() {
        let body = json!({ "answer": "something" });
        assert!(extract_required_question_field(&body).is_err());
    }

    #[test]
    fn extract_required_answer_field_reads_a_present_string() {
        let body = json!({ "answer": "Local decisions first." });
        let extracted = extract_required_answer_field(&body).expect("answer should parse");
        assert_eq!(extracted, "Local decisions first.");
    }

    #[test]
    fn extract_required_answer_field_rejects_non_string() {
        let body = json!({ "answer": 42 });
        assert!(extract_required_answer_field(&body).is_err());
    }

    #[test]
    fn extract_optional_grading_rubric_field_returns_trimmed_value() {
        let body = json!({ "grading_rubric": "  weigh clarity  " });
        assert_eq!(
            extract_optional_grading_rubric_field(&body),
            Some(String::from("weigh clarity"))
        );
    }

    #[test]
    fn extract_optional_grading_rubric_field_returns_none_for_blank() {
        let body = json!({ "grading_rubric": "   " });
        assert_eq!(extract_optional_grading_rubric_field(&body), None);
    }

    #[test]
    fn extract_optional_maximum_score_field_defaults_when_absent() {
        let body = json!({});
        assert_eq!(
            extract_optional_maximum_score_field(&body).unwrap(),
            DEFAULT_MAXIMUM_ASSESSMENT_SCORE
        );
    }

    #[test]
    fn extract_optional_maximum_score_field_reads_valid_value() {
        let body = json!({ "maximum_score": 20 });
        assert_eq!(extract_optional_maximum_score_field(&body).unwrap(), 20);
    }

    #[test]
    fn extract_optional_maximum_score_field_rejects_zero() {
        let body = json!({ "maximum_score": 0 });
        assert!(extract_optional_maximum_score_field(&body).is_err());
    }

    #[test]
    fn extract_optional_maximum_score_field_rejects_out_of_range() {
        let body = json!({ "maximum_score": 250 });
        assert!(extract_optional_maximum_score_field(&body).is_err());
    }

    #[test]
    fn reject_blank_answer_submission_accepts_real_text() {
        assert!(reject_blank_answer_submission("a real answer").is_ok());
    }

    #[test]
    fn reject_blank_answer_submission_rejects_whitespace() {
        assert!(reject_blank_answer_submission("   \n\t").is_err());
    }

    #[test]
    fn compose_policy_assessment_prompt_includes_rubric_when_present() {
        let prompt = compose_policy_assessment_prompt("Q?", "A.", Some("be strict"));
        assert!(prompt.contains("Grading rubric:"));
        assert!(prompt.contains("be strict"));
        assert!(prompt.contains("Q?"));
        assert!(prompt.contains("A."));
    }

    #[test]
    fn compose_policy_assessment_prompt_omits_rubric_when_absent() {
        let prompt = compose_policy_assessment_prompt("Q?", "A.", None);
        assert!(!prompt.contains("Grading rubric:"));
    }

    #[test]
    fn parse_assessment_prompt_into_non_empty_text_accepts_content() {
        let parsed = parse_assessment_prompt_into_non_empty_text(String::from("hello"));
        assert!(parsed.is_ok());
    }

    #[test]
    fn parse_assessment_prompt_into_non_empty_text_rejects_empty() {
        let parsed = parse_assessment_prompt_into_non_empty_text(String::new());
        assert!(parsed.is_err());
    }

    #[test]
    fn extract_numeric_score_from_completion_text_reads_labelled_score() {
        let text = "Score: 8\nFeedback: solid answer.";
        assert_eq!(extract_numeric_score_from_completion_text(text), Some(8));
    }

    #[test]
    fn extract_numeric_score_from_completion_text_falls_back_to_first_integer() {
        let text = "The candidate earned 7 points overall.";
        assert_eq!(extract_numeric_score_from_completion_text(text), Some(7));
    }

    #[test]
    fn extract_numeric_score_from_completion_text_returns_none_without_digits() {
        let text = "No numeric score present.";
        assert_eq!(extract_numeric_score_from_completion_text(text), None);
    }

    #[test]
    fn first_integer_in_saturates_large_values() {
        assert_eq!(first_integer_in("value 99999"), Some(u8::MAX));
    }

    #[test]
    fn clamp_extracted_score_to_maximum_limits_overflow() {
        assert_eq!(clamp_extracted_score_to_maximum(15, 10), 10);
    }

    #[test]
    fn clamp_extracted_score_to_maximum_passes_through_valid() {
        assert_eq!(clamp_extracted_score_to_maximum(6, 10), 6);
    }

    #[test]
    fn extract_qualitative_feedback_from_completion_text_reads_labelled() {
        let text = "Score: 9\nFeedback: excellent structure and clarity.";
        assert_eq!(
            extract_qualitative_feedback_from_completion_text(text),
            "excellent structure and clarity."
        );
    }

    #[test]
    fn extract_qualitative_feedback_from_completion_text_falls_back_to_whole() {
        let text = "This is a general assessment with no label.";
        assert_eq!(
            extract_qualitative_feedback_from_completion_text(text),
            "This is a general assessment with no label."
        );
    }

    #[test]
    fn extract_qualitative_feedback_from_completion_text_handles_empty() {
        assert_eq!(
            extract_qualitative_feedback_from_completion_text("   "),
            "No qualitative feedback was produced for this answer."
        );
    }

    #[test]
    fn classify_answer_pass_or_fail_passes_at_threshold() {
        // 6 out of 10 == 60% == passing.
        assert!(classify_answer_pass_or_fail(6, 10));
    }

    #[test]
    fn classify_answer_pass_or_fail_fails_below_threshold() {
        assert!(!classify_answer_pass_or_fail(5, 10));
    }

    #[test]
    fn classify_answer_pass_or_fail_fails_on_zero_maximum() {
        assert!(!classify_answer_pass_or_fail(0, 0));
    }

    #[test]
    fn build_assessment_response_payload_shapes_all_fields() {
        let payload = build_assessment_response_payload(7, 10, true, "well argued");
        assert_eq!(payload["score"], json!(7));
        assert_eq!(payload["maximum_score"], json!(10));
        assert_eq!(payload["passed"], json!(true));
        assert_eq!(payload["feedback"], json!("well argued"));
    }

    #[test]
    fn truncate_oversized_answer_for_prompt_leaves_short_answers_intact() {
        let answer = "short answer";
        assert_eq!(
            truncate_oversized_answer_for_prompt(answer, 100),
            "short answer"
        );
    }

    #[test]
    fn truncate_oversized_answer_for_prompt_shortens_long_answers() {
        let answer = "abcdefghij";
        let truncated = truncate_oversized_answer_for_prompt(answer, 5);
        assert_eq!(truncated, "abcde [...]");
    }

    #[test]
    fn truncate_oversized_answer_for_prompt_counts_unicode_scalars() {
        let answer = "áéíóútyp";
        let truncated = truncate_oversized_answer_for_prompt(answer, 5);
        // First five characters kept, then the ellipsis marker.
        assert_eq!(truncated, "áéíóú [...]");
    }
}
