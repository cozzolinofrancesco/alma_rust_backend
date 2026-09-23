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

/// The number of questions we are willing to generate for a single request.
/// A request for zero questions makes no sense, and an unbounded request would
/// produce a prompt that is expensive to run and unwieldy to parse.
const MINIMUM_QUESTION_COUNT: u8 = 1;
const MAXIMUM_QUESTION_COUNT: u8 = 10;
const DEFAULT_QUESTION_COUNT: u8 = 3;

/// The difficulty level requested for the generated policy questions. This is a
/// small closed vocabulary so that the prompt phrasing stays consistent and the
/// model is not handed arbitrary user-controlled adjectives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyQuestionDifficulty {
    Introductory,
    Intermediate,
    Advanced,
}

impl PolicyQuestionDifficulty {
    /// Parse a case-insensitive difficulty label supplied by a client. Unknown
    /// labels are rejected rather than silently coerced, so a typo surfaces as a
    /// malformed-body error instead of quietly producing the wrong difficulty.
    fn from_client_label(candidate_label: &str) -> Option<Self> {
        match candidate_label.trim().to_ascii_lowercase().as_str() {
            "introductory" | "beginner" | "basic" | "easy" => Some(Self::Introductory),
            "intermediate" | "medium" | "moderate" => Some(Self::Intermediate),
            "advanced" | "expert" | "hard" | "difficult" => Some(Self::Advanced),
            _ => None,
        }
    }
}

#[route(method = "POST", path = "/api/generate-policy-question")]
pub async fn generate_policy_question_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // (1..4) Pull every relevant field out of the request body, validating each.
    let supplied_topic = extract_required_topic_field(&submitted_body)?;
    reject_blank_topic_submission(&supplied_topic)?;
    let difficulty_level = extract_optional_difficulty_level_field(&submitted_body)?;
    let requested_question_count = extract_optional_question_count_field(&submitted_body)?;
    let target_audience = extract_optional_target_audience_field(&submitted_body);

    // (5) Clamp the count into a sane range regardless of what the client asked.
    let question_count = clamp_requested_question_count(requested_question_count);

    // (7..8) Compose a well-structured natural-language instruction for the model.
    let composed_prompt = compose_policy_question_generation_prompt(
        &supplied_topic,
        difficulty_level,
        question_count,
        target_audience.as_deref(),
    );

    // (9..10) Validate the prompt is non-empty before spending an upstream call.
    let prompt_text = parse_generation_prompt_into_non_empty_text(composed_prompt)?;

    // (11) Ask the AI adapter for the raw completion.
    let completion = request_question_generation_completion(
        &*application_state.artificial_intelligence_adapter,
        &prompt_text,
    )
    .await?;

    // (12..14) Turn the free-form completion text into a clean, bounded list.
    let parsed_questions = split_completion_text_into_individual_questions(&completion.produced_text);
    let generated_questions =
        truncate_generated_questions_to_requested_count(parsed_questions, question_count);

    // (15) Shape the JSON response.
    let response_payload = build_generated_questions_response(&generated_questions, &supplied_topic);
    Ok(Json(response_payload))
}

/// (1) Extract the mandatory `topic` string field. A missing field or a
/// non-string value is treated as a malformed request body.
fn extract_required_topic_field(submitted_body: &Value) -> Result<String, HttpError> {
    submitted_body
        .get("topic")
        .and_then(|topic_value| topic_value.as_str())
        .map(|topic_str| topic_str.to_string())
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: String::from("the 'topic' field is required and must be a string"),
        })
}

/// (2) Extract the optional `difficulty` field, defaulting to intermediate when
/// absent. A present-but-unrecognized value is a client error rather than a
/// silent fallback, so mistakes are visible.
fn extract_optional_difficulty_level_field(
    submitted_body: &Value,
) -> Result<PolicyQuestionDifficulty, HttpError> {
    match submitted_body.get("difficulty") {
        None | Some(Value::Null) => Ok(PolicyQuestionDifficulty::Intermediate),
        Some(difficulty_value) => {
            let difficulty_label = difficulty_value.as_str().ok_or_else(|| {
                HttpError::RequestBodyWasMalformed {
                    explanation: String::from("the 'difficulty' field must be a string"),
                }
            })?;
            PolicyQuestionDifficulty::from_client_label(difficulty_label).ok_or_else(|| {
                HttpError::RequestBodyWasMalformed {
                    explanation: format!(
                        "the 'difficulty' value '{difficulty_label}' is not recognized; \
                         expected one of introductory, intermediate, advanced"
                    ),
                }
            })
        }
    }
}

/// (3) Extract the optional `count` field, defaulting when absent. A value that
/// cannot fit in a `u8` or is not an integer is rejected; range clamping is a
/// separate, later concern.
fn extract_optional_question_count_field(submitted_body: &Value) -> Result<u8, HttpError> {
    match submitted_body.get("count") {
        None | Some(Value::Null) => Ok(DEFAULT_QUESTION_COUNT),
        Some(count_value) => {
            let raw_count = count_value.as_u64().ok_or_else(|| {
                HttpError::RequestBodyWasMalformed {
                    explanation: String::from(
                        "the 'count' field must be a non-negative integer",
                    ),
                }
            })?;
            u8::try_from(raw_count).map_err(|_| HttpError::RequestBodyWasMalformed {
                explanation: format!(
                    "the 'count' value {raw_count} is too large; \
                     the maximum supported is {MAXIMUM_QUESTION_COUNT}"
                ),
            })
        }
    }
}

/// (4) Extract the optional `audience` field. Blank or whitespace-only values
/// are treated as absent so they never leak an empty phrase into the prompt.
fn extract_optional_target_audience_field(submitted_body: &Value) -> Option<String> {
    submitted_body
        .get("audience")
        .and_then(|audience_value| audience_value.as_str())
        .map(|audience_str| audience_str.trim())
        .filter(|trimmed| !trimmed.is_empty())
        .map(|trimmed| trimmed.to_string())
}

/// (5) Clamp the requested count into the supported inclusive range.
fn clamp_requested_question_count(raw_question_count: u8) -> u8 {
    raw_question_count.clamp(MINIMUM_QUESTION_COUNT, MAXIMUM_QUESTION_COUNT)
}

/// (6) Reject a topic that is blank once surrounding whitespace is removed. The
/// presence check in (1) only guarantees a string, not a meaningful one.
fn reject_blank_topic_submission(candidate_topic: &str) -> Result<(), HttpError> {
    if candidate_topic.trim().is_empty() {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from("the 'topic' field must not be blank"),
        });
    }
    Ok(())
}

/// (7) Compose the natural-language instruction handed to the model. The prompt
/// pins down the count, difficulty, and (optionally) the target audience, and
/// asks for a plain numbered list so the completion is easy to parse afterward.
fn compose_policy_question_generation_prompt(
    supplied_topic: &str,
    difficulty_level: PolicyQuestionDifficulty,
    question_count: u8,
    target_audience: Option<&str>,
) -> String {
    let difficulty_phrase = render_difficulty_level_as_prompt_phrase(difficulty_level);
    let mut composed_prompt = format!(
        "Generate exactly {question_count} distinct {difficulty_phrase} policy questions \
         about the following topic: \"{}\".",
        supplied_topic.trim()
    );
    if let Some(audience) = target_audience {
        composed_prompt.push_str(&format!(
            " Tailor the questions for the following audience: {audience}."
        ));
    }
    composed_prompt.push_str(
        " Return the questions as a numbered list, one question per line, \
         with no preamble, explanations, or closing remarks.",
    );
    composed_prompt
}

/// (8) Render a difficulty level as the exact adjective phrase embedded into the
/// prompt. Returning a `&'static str` keeps the vocabulary closed and stable.
fn render_difficulty_level_as_prompt_phrase(
    difficulty_level: PolicyQuestionDifficulty,
) -> &'static str {
    match difficulty_level {
        PolicyQuestionDifficulty::Introductory => "introductory-level",
        PolicyQuestionDifficulty::Intermediate => "intermediate-level",
        PolicyQuestionDifficulty::Advanced => "advanced-level",
    }
}

/// (9) Convert the composed prompt into a validated `NonEmptyText`, translating a
/// domain parse failure into a malformed-body HTTP error.
fn parse_generation_prompt_into_non_empty_text(
    composed_prompt: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(composed_prompt).map_err(map_domain_parse_failure_to_malformed_body)
}

/// (10) Map a domain parse failure onto the malformed-body variant.
fn map_domain_parse_failure_to_malformed_body(parsing_failure: DomainError) -> HttpError {
    HttpError::RequestBodyWasMalformed {
        explanation: parsing_failure.to_string(),
    }
}

/// (11) Ask the AI adapter for a completion. `?Sized` lets the caller pass the
/// unsized trait object behind the shared `Arc` directly.
async fn request_question_generation_completion<A: ArtificialIntelligencePort + ?Sized>(
    adapter: &A,
    prompt_text: &NonEmptyText,
) -> Result<GeneratedCompletion, HttpError> {
    let completion = adapter.generate_completion(prompt_text).await?;
    Ok(completion)
}

/// (12) Split the raw completion into individual candidate questions. Each
/// non-blank line is treated as one question after its enumeration prefix is
/// stripped; blank lines and lines that reduce to nothing are dropped.
fn split_completion_text_into_individual_questions(produced_text: &str) -> Vec<String> {
    produced_text
        .lines()
        .map(strip_enumeration_prefix_from_question_line)
        .filter(|cleaned_line| !cleaned_line.is_empty())
        .collect()
}

/// (13) Strip a leading list marker (e.g. "1.", "2)", "-", "*") plus surrounding
/// whitespace from a single line, returning the bare question text.
fn strip_enumeration_prefix_from_question_line(question_line: &str) -> String {
    let trimmed_line = question_line.trim();
    if trimmed_line.is_empty() {
        return String::new();
    }

    // Strip a bullet marker such as "-" or "*".
    if let Some(after_bullet) = trimmed_line
        .strip_prefix('-')
        .or_else(|| trimmed_line.strip_prefix('*'))
        .or_else(|| trimmed_line.strip_prefix('•'))
    {
        return after_bullet.trim().to_string();
    }

    // Strip a numeric prefix such as "1." / "1)" / "12:".
    let leading_digit_count = trimmed_line
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .count();
    if leading_digit_count > 0 {
        let remainder = &trimmed_line[leading_digit_count..];
        if let Some(after_separator) = remainder
            .strip_prefix('.')
            .or_else(|| remainder.strip_prefix(')'))
            .or_else(|| remainder.strip_prefix(':'))
        {
            return after_separator.trim().to_string();
        }
    }

    trimmed_line.to_string()
}

/// (14) Truncate the parsed questions down to the requested count. The model may
/// return more (or exactly) than asked; we never fabricate to reach the count.
fn truncate_generated_questions_to_requested_count(
    mut parsed_questions: Vec<String>,
    question_count: u8,
) -> Vec<String> {
    parsed_questions.truncate(question_count as usize);
    parsed_questions
}

/// (15) Build the JSON response body. `question` preserves the historical
/// single-question shape (the first generated question, or empty), while
/// `questions` carries the full bounded list plus useful metadata.
fn build_generated_questions_response(
    generated_questions: &[String],
    supplied_topic: &str,
) -> Value {
    let primary_question = generated_questions
        .first()
        .cloned()
        .unwrap_or_default();
    json!({
        "topic": supplied_topic.trim(),
        "question": primary_question,
        "questions": generated_questions,
        "generated_count": generated_questions.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_required_topic_field_reads_present_string() {
        let body = json!({ "topic": "data privacy" });
        assert_eq!(
            extract_required_topic_field(&body).unwrap(),
            "data privacy".to_string()
        );
    }

    #[test]
    fn extract_required_topic_field_rejects_missing_and_non_string() {
        assert!(extract_required_topic_field(&json!({})).is_err());
        assert!(extract_required_topic_field(&json!({ "topic": 42 })).is_err());
    }

    #[test]
    fn extract_optional_difficulty_level_field_defaults_when_absent() {
        assert_eq!(
            extract_optional_difficulty_level_field(&json!({})).unwrap(),
            PolicyQuestionDifficulty::Intermediate
        );
        assert_eq!(
            extract_optional_difficulty_level_field(&json!({ "difficulty": null })).unwrap(),
            PolicyQuestionDifficulty::Intermediate
        );
    }

    #[test]
    fn extract_optional_difficulty_level_field_parses_and_rejects() {
        assert_eq!(
            extract_optional_difficulty_level_field(&json!({ "difficulty": "Advanced" })).unwrap(),
            PolicyQuestionDifficulty::Advanced
        );
        assert_eq!(
            extract_optional_difficulty_level_field(&json!({ "difficulty": "easy" })).unwrap(),
            PolicyQuestionDifficulty::Introductory
        );
        assert!(
            extract_optional_difficulty_level_field(&json!({ "difficulty": "nonsense" })).is_err()
        );
        assert!(extract_optional_difficulty_level_field(&json!({ "difficulty": 3 })).is_err());
    }

    #[test]
    fn extract_optional_question_count_field_defaults_and_validates() {
        assert_eq!(
            extract_optional_question_count_field(&json!({})).unwrap(),
            DEFAULT_QUESTION_COUNT
        );
        assert_eq!(
            extract_optional_question_count_field(&json!({ "count": 5 })).unwrap(),
            5
        );
        assert!(extract_optional_question_count_field(&json!({ "count": 9000 })).is_err());
        assert!(extract_optional_question_count_field(&json!({ "count": "lots" })).is_err());
    }

    #[test]
    fn extract_optional_target_audience_field_trims_and_drops_blank() {
        assert_eq!(
            extract_optional_target_audience_field(&json!({ "audience": "  students " })),
            Some("students".to_string())
        );
        assert_eq!(
            extract_optional_target_audience_field(&json!({ "audience": "   " })),
            None
        );
        assert_eq!(extract_optional_target_audience_field(&json!({})), None);
    }

    #[test]
    fn clamp_requested_question_count_bounds_both_ends() {
        assert_eq!(clamp_requested_question_count(0), MINIMUM_QUESTION_COUNT);
        assert_eq!(clamp_requested_question_count(4), 4);
        assert_eq!(clamp_requested_question_count(200), MAXIMUM_QUESTION_COUNT);
    }

    #[test]
    fn reject_blank_topic_submission_distinguishes_blank_from_real() {
        assert!(reject_blank_topic_submission("climate policy").is_ok());
        assert!(reject_blank_topic_submission("   ").is_err());
        assert!(reject_blank_topic_submission("").is_err());
    }

    #[test]
    fn compose_policy_question_generation_prompt_includes_key_details() {
        let prompt = compose_policy_question_generation_prompt(
            "housing",
            PolicyQuestionDifficulty::Advanced,
            4,
            Some("legislators"),
        );
        assert!(prompt.contains("exactly 4"));
        assert!(prompt.contains("advanced-level"));
        assert!(prompt.contains("housing"));
        assert!(prompt.contains("legislators"));
        assert!(prompt.contains("numbered list"));
    }

    #[test]
    fn compose_policy_question_generation_prompt_omits_audience_when_absent() {
        let prompt = compose_policy_question_generation_prompt(
            "energy",
            PolicyQuestionDifficulty::Introductory,
            2,
            None,
        );
        assert!(!prompt.contains("audience"));
        assert!(prompt.contains("introductory-level"));
    }

    #[test]
    fn render_difficulty_level_as_prompt_phrase_covers_all_variants() {
        assert_eq!(
            render_difficulty_level_as_prompt_phrase(PolicyQuestionDifficulty::Introductory),
            "introductory-level"
        );
        assert_eq!(
            render_difficulty_level_as_prompt_phrase(PolicyQuestionDifficulty::Intermediate),
            "intermediate-level"
        );
        assert_eq!(
            render_difficulty_level_as_prompt_phrase(PolicyQuestionDifficulty::Advanced),
            "advanced-level"
        );
    }

    #[test]
    fn parse_generation_prompt_into_non_empty_text_accepts_and_rejects() {
        assert!(parse_generation_prompt_into_non_empty_text("a real prompt".to_string()).is_ok());
        assert!(parse_generation_prompt_into_non_empty_text(String::new()).is_err());
        assert!(parse_generation_prompt_into_non_empty_text("   ".to_string()).is_err());
    }

    #[test]
    fn map_domain_parse_failure_to_malformed_body_produces_malformed_variant() {
        let failure = NonEmptyText::parse(String::new()).unwrap_err();
        let mapped = map_domain_parse_failure_to_malformed_body(failure);
        assert!(matches!(mapped, HttpError::RequestBodyWasMalformed { .. }));
    }

    #[test]
    fn split_completion_text_into_individual_questions_splits_lines() {
        let completion = "1. What is X?\n2. What is Y?\n\n3. What is Z?";
        let questions = split_completion_text_into_individual_questions(completion);
        assert_eq!(
            questions,
            vec![
                "What is X?".to_string(),
                "What is Y?".to_string(),
                "What is Z?".to_string(),
            ]
        );
    }

    #[test]
    fn split_completion_text_into_individual_questions_handles_empty() {
        assert!(split_completion_text_into_individual_questions("").is_empty());
        assert!(split_completion_text_into_individual_questions("\n  \n").is_empty());
    }

    #[test]
    fn strip_enumeration_prefix_from_question_line_handles_various_markers() {
        assert_eq!(
            strip_enumeration_prefix_from_question_line("1. Should we act?"),
            "Should we act?"
        );
        assert_eq!(
            strip_enumeration_prefix_from_question_line("12) Is it fair?"),
            "Is it fair?"
        );
        assert_eq!(
            strip_enumeration_prefix_from_question_line("- Bullet question"),
            "Bullet question"
        );
        assert_eq!(
            strip_enumeration_prefix_from_question_line("  * Star question "),
            "Star question"
        );
        assert_eq!(
            strip_enumeration_prefix_from_question_line("No prefix here"),
            "No prefix here"
        );
        assert_eq!(strip_enumeration_prefix_from_question_line("   "), "");
    }

    #[test]
    fn truncate_generated_questions_to_requested_count_bounds_length() {
        let questions = vec![
            "one".to_string(),
            "two".to_string(),
            "three".to_string(),
        ];
        assert_eq!(
            truncate_generated_questions_to_requested_count(questions.clone(), 2),
            vec!["one".to_string(), "two".to_string()]
        );
        // Requesting more than available never fabricates entries.
        assert_eq!(
            truncate_generated_questions_to_requested_count(questions.clone(), 10),
            questions
        );
    }

    #[test]
    fn build_generated_questions_response_shapes_payload() {
        let questions = vec!["Q1".to_string(), "Q2".to_string()];
        let payload = build_generated_questions_response(&questions, "  taxes ");
        assert_eq!(payload["topic"], json!("taxes"));
        assert_eq!(payload["question"], json!("Q1"));
        assert_eq!(payload["questions"], json!(["Q1", "Q2"]));
        assert_eq!(payload["generated_count"], json!(2));
    }

    #[test]
    fn build_generated_questions_response_handles_empty_list() {
        let payload = build_generated_questions_response(&[], "topic");
        assert_eq!(payload["question"], json!(""));
        assert_eq!(payload["generated_count"], json!(0));
    }
}
