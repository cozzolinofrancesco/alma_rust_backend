use crate::categories::templates_policy::collections::CORRECTIONS_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::error::ApplicationError;
use alma_application::ports::document_collection::{DocumentCollectionPort, StoredDocument};
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::error::DomainError;
use alma_domain::value_objects::{Email, NonEmptyText};
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

/// POST handler that records a submitted textual correction.
///
/// A correction captures the original wording, the corrected wording, and an
/// optional free-form note explaining the change. The pair is validated,
/// normalised into domain value objects, assembled into a document body, and
/// persisted into the corrections collection under the authenticated principal.
#[route(method = "POST", path = "/api/corrections")]
pub async fn create_correction_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let extracted_original_text = extract_required_original_text_field(&submitted_body)?;
    let extracted_corrected_text = extract_required_corrected_text_field(&submitted_body)?;
    let extracted_correction_note = extract_optional_correction_note_field(&submitted_body);

    reject_identical_original_and_corrected_text(
        &extracted_original_text,
        &extracted_corrected_text,
    )?;

    let validated_original_text = parse_original_text_into_non_empty_text(extracted_original_text)?;
    let validated_corrected_text =
        parse_corrected_text_into_non_empty_text(extracted_corrected_text)?;

    let generated_identifier = generate_correction_document_identifier();
    let owning_account = resolve_owning_account_from_principal(
        authorized_request.authorized_principal(),
    );
    let created_at = current_creation_timestamp_iso8601();

    let assembled_document_body = assemble_correction_document_body(
        &validated_original_text,
        &validated_corrected_text,
        extracted_correction_note.as_deref(),
        &created_at,
    );

    let document_to_insert = build_correction_stored_document(
        generated_identifier.clone(),
        owning_account,
        assembled_document_body,
    );

    persist_correction_document(
        application_state.document_collection.as_ref(),
        document_to_insert,
    )
    .await?;

    Ok(Json(build_correction_creation_response(&generated_identifier)))
}

/// Extract the mandatory `original_text` string field from the request body.
fn extract_required_original_text_field(submitted_body: &Value) -> Result<String, HttpError> {
    match submitted_body.get("original_text") {
        Some(Value::String(present_value)) => Ok(present_value.to_string()),
        Some(_) => Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from("field 'original_text' must be a string"),
        }),
        None => Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from("field 'original_text' is required"),
        }),
    }
}

/// Extract the mandatory `corrected_text` string field from the request body.
fn extract_required_corrected_text_field(submitted_body: &Value) -> Result<String, HttpError> {
    match submitted_body.get("corrected_text") {
        Some(Value::String(present_value)) => Ok(present_value.to_string()),
        Some(_) => Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from("field 'corrected_text' must be a string"),
        }),
        None => Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from("field 'corrected_text' is required"),
        }),
    }
}

/// Extract the optional `correction_note` field.
///
/// A missing field, a JSON null, a non-string value, or a value that is empty
/// after trimming all collapse to `None` so downstream logic never stores a
/// meaningless note.
fn extract_optional_correction_note_field(submitted_body: &Value) -> Option<String> {
    match submitted_body.get("correction_note") {
        Some(Value::String(present_value)) => {
            let trimmed_value = present_value.trim();
            if trimmed_value.is_empty() {
                None
            } else {
                Some(trimmed_value.to_string())
            }
        }
        _ => None,
    }
}

/// Reject submissions whose original and corrected text are identical.
///
/// Comparison is performed on the trimmed values so that a change consisting of
/// leading/trailing whitespace only is also treated as a no-op correction.
fn reject_identical_original_and_corrected_text(
    original_text: &str,
    corrected_text: &str,
) -> Result<(), HttpError> {
    if original_text.trim() == corrected_text.trim() {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from(
                "'original_text' and 'corrected_text' must differ from one another",
            ),
        });
    }
    Ok(())
}

/// Validate and normalise the original text into a domain `NonEmptyText`.
fn parse_original_text_into_non_empty_text(
    original_text: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(original_text).map_err(map_domain_parse_failure_to_malformed_body)
}

/// Validate and normalise the corrected text into a domain `NonEmptyText`.
fn parse_corrected_text_into_non_empty_text(
    corrected_text: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(corrected_text).map_err(map_domain_parse_failure_to_malformed_body)
}

/// Generate a fresh, unique identifier for a correction document.
fn generate_correction_document_identifier() -> String {
    Uuid::new_v4().to_string()
}

/// Resolve the owning account string from the authenticated principal.
fn resolve_owning_account_from_principal(authorized_principal: &Email) -> String {
    authorized_principal.as_str().to_string()
}

/// Translate a domain parse failure into a malformed-request HTTP error.
fn map_domain_parse_failure_to_malformed_body(parsing_failure: DomainError) -> HttpError {
    HttpError::RequestBodyWasMalformed {
        explanation: parsing_failure.to_string(),
    }
}

/// Assemble the JSON body that will be stored for a correction.
fn assemble_correction_document_body(
    original_text: &NonEmptyText,
    corrected_text: &NonEmptyText,
    correction_note: Option<&str>,
    created_at: &str,
) -> Value {
    json!({
        "original_text": original_text.as_str(),
        "corrected_text": corrected_text.as_str(),
        "correction_note": correction_note,
        "created_at": created_at,
    })
}

/// Produce an ISO-8601 / RFC-3339 UTC timestamp for the moment of creation.
///
/// The http crate has no calendar dependency, so this derives the calendar
/// fields directly from the seconds elapsed since the Unix epoch. A clock that
/// somehow reports a pre-epoch time falls back to the epoch itself rather than
/// panicking.
fn current_creation_timestamp_iso8601() -> String {
    let seconds_since_epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed_duration| elapsed_duration.as_secs())
        .unwrap_or(0);
    format_unix_seconds_as_iso8601(seconds_since_epoch)
}

/// Pure conversion of a Unix-epoch second count into an RFC-3339 UTC string.
///
/// Kept separate from the clock-reading function above so the calendar
/// arithmetic can be exercised deterministically by the test suite.
fn format_unix_seconds_as_iso8601(seconds_since_epoch: u64) -> String {
    let seconds_within_day = seconds_since_epoch % 86_400;
    let whole_days_since_epoch = seconds_since_epoch / 86_400;

    let hour_component = seconds_within_day / 3_600;
    let minute_component = (seconds_within_day % 3_600) / 60;
    let second_component = seconds_within_day % 60;

    let (year_component, month_component, day_component) =
        convert_days_since_epoch_to_calendar_date(whole_days_since_epoch);

    format!(
        "{year_component:04}-{month_component:02}-{day_component:02}T{hour_component:02}:{minute_component:02}:{second_component:02}Z"
    )
}

/// Convert a count of whole days since 1970-01-01 into a `(year, month, day)`
/// calendar tuple in the proleptic Gregorian calendar (UTC).
fn convert_days_since_epoch_to_calendar_date(whole_days_since_epoch: u64) -> (u64, u64, u64) {
    let mut remaining_days = whole_days_since_epoch;
    let mut current_year: u64 = 1970;

    loop {
        let days_in_current_year = if is_gregorian_leap_year(current_year) {
            366
        } else {
            365
        };
        if remaining_days < days_in_current_year {
            break;
        }
        remaining_days -= days_in_current_year;
        current_year += 1;
    }

    let months_length = month_lengths_for_year(current_year);
    let mut current_month: u64 = 1;
    for length_of_month in months_length {
        if remaining_days < length_of_month {
            break;
        }
        remaining_days -= length_of_month;
        current_month += 1;
    }

    let current_day = remaining_days + 1;
    (current_year, current_month, current_day)
}

/// Determine whether a year is a leap year in the Gregorian calendar.
fn is_gregorian_leap_year(candidate_year: u64) -> bool {
    (candidate_year % 4 == 0 && candidate_year % 100 != 0) || (candidate_year % 400 == 0)
}

/// Produce the length in days of each month for a given year.
fn month_lengths_for_year(target_year: u64) -> [u64; 12] {
    let february_length = if is_gregorian_leap_year(target_year) {
        29
    } else {
        28
    };
    [
        31,
        february_length,
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ]
}

/// Build a `StoredDocument` from its constituent parts.
fn build_correction_stored_document(
    document_identifier: String,
    owning_account: String,
    document_body: Value,
) -> StoredDocument {
    StoredDocument {
        document_identifier,
        owning_account: Some(owning_account),
        document_body,
    }
}

/// Persist the assembled correction document into the corrections collection.
async fn persist_correction_document<C: DocumentCollectionPort + ?Sized>(
    collection: &C,
    document_to_insert: StoredDocument,
) -> Result<(), HttpError> {
    collection
        .insert_document(CORRECTIONS_COLLECTION_NAME, document_to_insert)
        .await
        .map_err(map_application_error_to_http_error)
}

/// Build the JSON acknowledgement returned to a successful caller.
fn build_correction_creation_response(generated_identifier: &str) -> Value {
    json!({
        "document_identifier": generated_identifier,
        "acknowledgement": "correction created",
    })
}

/// Map an application-layer error onto the corresponding HTTP error.
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

    #[test]
    fn extract_required_original_text_field_accepts_a_present_string() {
        let submitted_body = json!({ "original_text": "the quik brown fox" });
        let extracted = extract_required_original_text_field(&submitted_body);
        assert_eq!(extracted.unwrap(), "the quik brown fox");
    }

    #[test]
    fn extract_required_original_text_field_rejects_absent_and_non_string() {
        let missing_field = json!({ "corrected_text": "x" });
        assert!(matches!(
            extract_required_original_text_field(&missing_field),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
        let wrong_type = json!({ "original_text": 42 });
        assert!(matches!(
            extract_required_original_text_field(&wrong_type),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn extract_required_corrected_text_field_accepts_a_present_string() {
        let submitted_body = json!({ "corrected_text": "the quick brown fox" });
        let extracted = extract_required_corrected_text_field(&submitted_body);
        assert_eq!(extracted.unwrap(), "the quick brown fox");
    }

    #[test]
    fn extract_required_corrected_text_field_rejects_absent_and_non_string() {
        let missing_field = json!({ "original_text": "x" });
        assert!(matches!(
            extract_required_corrected_text_field(&missing_field),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
        let wrong_type = json!({ "corrected_text": ["a", "b"] });
        assert!(matches!(
            extract_required_corrected_text_field(&wrong_type),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn extract_optional_correction_note_field_returns_trimmed_value_when_present() {
        let submitted_body = json!({ "correction_note": "  spelling fix  " });
        assert_eq!(
            extract_optional_correction_note_field(&submitted_body),
            Some(String::from("spelling fix"))
        );
    }

    #[test]
    fn extract_optional_correction_note_field_returns_none_for_missing_empty_or_wrong_type() {
        assert_eq!(extract_optional_correction_note_field(&json!({})), None);
        assert_eq!(
            extract_optional_correction_note_field(&json!({ "correction_note": "   " })),
            None
        );
        assert_eq!(
            extract_optional_correction_note_field(&json!({ "correction_note": 7 })),
            None
        );
    }

    #[test]
    fn reject_identical_original_and_corrected_text_allows_differing_values() {
        assert!(reject_identical_original_and_corrected_text("alpha", "beta").is_ok());
    }

    #[test]
    fn reject_identical_original_and_corrected_text_rejects_matching_values() {
        assert!(matches!(
            reject_identical_original_and_corrected_text("same", "same"),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
        assert!(matches!(
            reject_identical_original_and_corrected_text("  same  ", "same"),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn parse_original_text_into_non_empty_text_accepts_and_rejects() {
        assert!(parse_original_text_into_non_empty_text(String::from("hello")).is_ok());
        assert!(matches!(
            parse_original_text_into_non_empty_text(String::from("   ")),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn parse_corrected_text_into_non_empty_text_accepts_and_rejects() {
        assert!(parse_corrected_text_into_non_empty_text(String::from("world")).is_ok());
        assert!(matches!(
            parse_corrected_text_into_non_empty_text(String::from("")),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn generate_correction_document_identifier_is_unique_and_parseable() {
        let first_identifier = generate_correction_document_identifier();
        let second_identifier = generate_correction_document_identifier();
        assert_ne!(first_identifier, second_identifier);
        assert!(Uuid::parse_str(&first_identifier).is_ok());
    }

    #[test]
    fn resolve_owning_account_from_principal_returns_the_email_string() {
        let principal = Email::parse(String::from("editor@example.com")).unwrap();
        assert_eq!(
            resolve_owning_account_from_principal(&principal),
            "editor@example.com"
        );
    }

    #[test]
    fn map_domain_parse_failure_to_malformed_body_produces_malformed_variant() {
        let mapped = map_domain_parse_failure_to_malformed_body(DomainError::NonEmptyTextEmpty);
        assert!(matches!(mapped, HttpError::RequestBodyWasMalformed { .. }));
    }

    #[test]
    fn assemble_correction_document_body_includes_all_fields() {
        let original = NonEmptyText::parse(String::from("teh")).unwrap();
        let corrected = NonEmptyText::parse(String::from("the")).unwrap();
        let body = assemble_correction_document_body(
            &original,
            &corrected,
            Some("typo"),
            "2026-07-07T00:00:00Z",
        );
        assert_eq!(body["original_text"], json!("teh"));
        assert_eq!(body["corrected_text"], json!("the"));
        assert_eq!(body["correction_note"], json!("typo"));
        assert_eq!(body["created_at"], json!("2026-07-07T00:00:00Z"));
    }

    #[test]
    fn assemble_correction_document_body_serialises_absent_note_as_null() {
        let original = NonEmptyText::parse(String::from("a")).unwrap();
        let corrected = NonEmptyText::parse(String::from("b")).unwrap();
        let body =
            assemble_correction_document_body(&original, &corrected, None, "2026-07-07T00:00:00Z");
        assert_eq!(body["correction_note"], Value::Null);
    }

    #[test]
    fn is_gregorian_leap_year_matches_known_years() {
        assert!(is_gregorian_leap_year(2000));
        assert!(is_gregorian_leap_year(2024));
        assert!(!is_gregorian_leap_year(1900));
        assert!(!is_gregorian_leap_year(2023));
    }

    #[test]
    fn month_lengths_for_year_handles_february_correctly() {
        assert_eq!(month_lengths_for_year(2023)[1], 28);
        assert_eq!(month_lengths_for_year(2024)[1], 29);
        assert_eq!(month_lengths_for_year(2023).iter().sum::<u64>(), 365);
        assert_eq!(month_lengths_for_year(2024).iter().sum::<u64>(), 366);
    }

    #[test]
    fn convert_days_since_epoch_to_calendar_date_maps_known_offsets() {
        assert_eq!(convert_days_since_epoch_to_calendar_date(0), (1970, 1, 1));
        assert_eq!(convert_days_since_epoch_to_calendar_date(31), (1970, 2, 1));
        // 2000-01-01 is 10957 days after the Unix epoch.
        assert_eq!(convert_days_since_epoch_to_calendar_date(10957), (2000, 1, 1));
    }

    #[test]
    fn format_unix_seconds_as_iso8601_formats_epoch_and_a_known_instant() {
        assert_eq!(format_unix_seconds_as_iso8601(0), "1970-01-01T00:00:00Z");
        // 946684800 == 2000-01-01T00:00:00Z
        assert_eq!(
            format_unix_seconds_as_iso8601(946_684_800),
            "2000-01-01T00:00:00Z"
        );
        // 946684800 + 3661 == 2000-01-01T01:01:01Z
        assert_eq!(
            format_unix_seconds_as_iso8601(946_688_461),
            "2000-01-01T01:01:01Z"
        );
    }

    #[test]
    fn current_creation_timestamp_iso8601_has_the_expected_shape() {
        let timestamp = current_creation_timestamp_iso8601();
        assert_eq!(timestamp.len(), 20);
        assert!(timestamp.ends_with('Z'));
        assert!(timestamp.contains('T'));
    }

    #[test]
    fn build_correction_stored_document_populates_all_fields() {
        let document = build_correction_stored_document(
            String::from("id-123"),
            String::from("owner@example.com"),
            json!({ "k": "v" }),
        );
        assert_eq!(document.document_identifier, "id-123");
        assert_eq!(
            document.owning_account,
            Some(String::from("owner@example.com"))
        );
        assert_eq!(document.document_body, json!({ "k": "v" }));
    }

    #[test]
    fn build_correction_creation_response_reports_identifier_and_acknowledgement() {
        let response = build_correction_creation_response("id-abc");
        assert_eq!(response["document_identifier"], json!("id-abc"));
        assert_eq!(response["acknowledgement"], json!("correction created"));
    }

    #[test]
    fn map_application_error_to_http_error_covers_each_category() {
        assert!(matches!(
            map_application_error_to_http_error(
                ApplicationError::RequestedResourceCouldNotBeLocated
            ),
            HttpError::RequestedResourceWasNotFound { .. }
        ));
        assert!(matches!(
            map_application_error_to_http_error(ApplicationError::AuthorizationWasDenied),
            HttpError::AuthorizationWasDenied { .. }
        ));
        assert!(matches!(
            map_application_error_to_http_error(ApplicationError::DomainInvariantViolated(
                DomainError::NonEmptyTextEmpty
            )),
            HttpError::RequestBodyWasMalformed { .. }
        ));
        assert!(matches!(
            map_application_error_to_http_error(ApplicationError::StorageAdapterFailure {
                failure_description: String::from("boom"),
            }),
            HttpError::UpstreamApplicationFailure { .. }
        ));
    }
}
