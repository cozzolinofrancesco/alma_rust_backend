use crate::categories::auth::collections::ALLOWED_EMAILS_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::error::ApplicationError;
use alma_application::ports::document_collection::DocumentCollectionPort;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::Email;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// Collection where a subject's per-window request counters are stored.
///
/// Rate-limit counters share the auth category's document collection so that a
/// principal's quota lives alongside the identity records that authorize it.
const RATE_LIMIT_COUNTER_COLLECTION_NAME: &str = ALLOWED_EMAILS_COLLECTION_NAME;

// ---------------------------------------------------------------------------
// Function 1 — extract the raw subject identifier from the authorized request.
// ---------------------------------------------------------------------------

/// Pull the authorized principal's email string out of the request pipeline.
///
/// The rate limiter is keyed on the authenticated identity, so the subject is
/// always the principal that survived authorization.
fn extract_rate_limit_subject_identifier(
    authorized_request: &HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> String {
    authorized_request.authorized_principal().as_str().to_owned()
}

// ---------------------------------------------------------------------------
// Function 2 — validate that the subject identifier is a well-formed email.
// ---------------------------------------------------------------------------

/// Re-parse the subject identifier into a strongly-typed [`Email`].
///
/// Even though the principal was already authorized, re-parsing guards against
/// a malformed identifier leaking into the counter key.
fn parse_rate_limit_subject_as_email(subject_identifier: String) -> Result<Email, HttpError> {
    Email::parse(subject_identifier).map_err(|domain_error| {
        HttpError::AuthenticationCredentialsWereInvalid {
            explanation: domain_error.to_string(),
        }
    })
}

// ---------------------------------------------------------------------------
// Function 3 & 4 — configuration defaults.
// ---------------------------------------------------------------------------

/// The number of requests a single subject may make within one window.
fn default_requests_allowed_per_window() -> u32 {
    100
}

/// The duration, in seconds, of one rate-limit window.
fn default_rate_limit_window_duration_seconds() -> u64 {
    60
}

// ---------------------------------------------------------------------------
// Function 5 — align a timestamp to the start of its window.
// ---------------------------------------------------------------------------

/// Compute the epoch-second at which the window containing `now` began.
///
/// Windows are fixed and contiguous: the start is `now` floored to the nearest
/// multiple of `window_seconds`. A zero window collapses to the instant itself
/// so callers never divide by zero.
fn compute_current_window_start_epoch_seconds(now_epoch_seconds: u64, window_seconds: u64) -> u64 {
    if window_seconds == 0 {
        return now_epoch_seconds;
    }
    now_epoch_seconds - (now_epoch_seconds % window_seconds)
}

// ---------------------------------------------------------------------------
// Function 6 — build the deterministic document key for a counter.
// ---------------------------------------------------------------------------

/// Derive the counter document key for a subject in a specific window.
///
/// Keying on both email and window start means each window gets its own
/// document and counters never bleed across window boundaries.
fn build_rate_limit_counter_document_key(
    subject_email: &Email,
    window_start_epoch_seconds: u64,
) -> String {
    format!(
        "rate-limit::{}::{}",
        subject_email.as_str(),
        window_start_epoch_seconds
    )
}

// ---------------------------------------------------------------------------
// Function 7 — load the consumed count for a window from the collection.
// ---------------------------------------------------------------------------

/// Fetch the counter document for `counter_key` and return its consumed count.
///
/// A missing document means the subject has not been seen in this window, which
/// is reported as zero consumption rather than an error.
async fn load_consumed_request_count_for_window(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    counter_key: &str,
) -> Result<u32, HttpError> {
    let maybe_counter_document = document_collection
        .fetch_document(RATE_LIMIT_COUNTER_COLLECTION_NAME, counter_key)
        .await
        .map_err(map_document_collection_failure_to_http_error)?;

    let consumed_count = match maybe_counter_document {
        Some(counter_document) => {
            parse_consumed_count_from_counter_document_body(&counter_document.document_body)
        }
        None => 0,
    };

    Ok(consumed_count)
}

// ---------------------------------------------------------------------------
// Function 8 — extract the count from a counter document body.
// ---------------------------------------------------------------------------

/// Read the `consumed_requests` field out of a stored counter document body.
///
/// Anything missing, negative, non-numeric, or beyond `u32::MAX` is treated as
/// a clamped, sane value so a corrupt document can never crash the handler.
fn parse_consumed_count_from_counter_document_body(document_body: &Value) -> u32 {
    match document_body.get("consumed_requests") {
        Some(count_value) => match count_value.as_u64() {
            Some(raw_count) if raw_count <= u64::from(u32::MAX) => raw_count as u32,
            Some(_) => u32::MAX,
            None => 0,
        },
        None => 0,
    }
}

// ---------------------------------------------------------------------------
// Function 9 — remaining allowance.
// ---------------------------------------------------------------------------

/// Compute how many requests remain in the window (saturating at zero).
fn compute_remaining_request_allowance(requests_allowed: u32, requests_consumed: u32) -> u32 {
    requests_allowed.saturating_sub(requests_consumed)
}

// ---------------------------------------------------------------------------
// Function 10 — human-readable status label.
// ---------------------------------------------------------------------------

/// Translate a remaining allowance into a coarse status label for clients.
fn determine_quota_status_label(remaining_allowance: u32) -> &'static str {
    if remaining_allowance == 0 {
        "quota_exhausted"
    } else if remaining_allowance <= 10 {
        "approaching_limit"
    } else {
        "within_limits"
    }
}

// ---------------------------------------------------------------------------
// Function 11 — seconds until the current window resets.
// ---------------------------------------------------------------------------

/// Compute how many seconds remain until the current window rolls over.
///
/// A zero window, or a `now` that has already passed the window end (clock
/// skew), both report an immediate reset of zero seconds.
fn compute_seconds_until_window_reset(
    now_epoch_seconds: u64,
    window_start_epoch_seconds: u64,
    window_seconds: u64,
) -> u64 {
    if window_seconds == 0 {
        return 0;
    }
    let window_end_epoch_seconds = window_start_epoch_seconds + window_seconds;
    window_end_epoch_seconds.saturating_sub(now_epoch_seconds)
}

// ---------------------------------------------------------------------------
// Function 12 — is the request still within limits?
// ---------------------------------------------------------------------------

/// Report whether a subject that has consumed `requests_consumed` is still
/// allowed to make one more request this window.
fn is_request_within_configured_limits(requests_consumed: u32, requests_allowed: u32) -> bool {
    requests_consumed < requests_allowed
}

// ---------------------------------------------------------------------------
// Function 13 — reject when the quota is exhausted.
// ---------------------------------------------------------------------------

/// Fail the request with an authorization denial when no allowance remains.
///
/// The reset countdown is surfaced in the explanation so callers know when to
/// retry.
fn reject_when_quota_exhausted(
    remaining_allowance: u32,
    seconds_until_reset: u64,
) -> Result<(), HttpError> {
    if remaining_allowance == 0 {
        return Err(HttpError::AuthorizationWasDenied {
            explanation: format!(
                "rate limit quota exhausted; retry in {} second(s)",
                seconds_until_reset
            ),
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Function 14 — serialize the quota report body.
// ---------------------------------------------------------------------------

/// Assemble the JSON body describing the caller's current quota position.
fn serialize_rate_limit_quota_report(
    status_label: &str,
    remaining_allowance: u32,
    window_seconds: u64,
    seconds_until_reset: u64,
) -> Value {
    json!({
        "status": status_label,
        "remaining_requests": remaining_allowance,
        "window_seconds": window_seconds,
        "seconds_until_reset": seconds_until_reset
    })
}

// ---------------------------------------------------------------------------
// Function 15 — map a document-collection failure to an HTTP error.
// ---------------------------------------------------------------------------

/// Translate a document-collection [`ApplicationError`] into an [`HttpError`].
///
/// A not-found from the collection is a lookup miss, not a client-visible 404
/// in this context, so it maps to an upstream failure; everything else defers
/// to the canonical `From` conversion.
fn map_document_collection_failure_to_http_error(port_failure: ApplicationError) -> HttpError {
    match port_failure {
        ApplicationError::DocumentCollectionFailure { failure_description } => {
            HttpError::UpstreamApplicationFailure {
                explanation: format!(
                    "the rate-limit counter store reported a failure: {}",
                    failure_description
                ),
            }
        }
        other_failure => HttpError::from(other_failure),
    }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/// Read the current epoch second from the system clock, tolerating a clock set
/// before the Unix epoch by clamping to zero.
fn read_current_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

#[route(method = "GET", path = "/api/rate-limit/check")]
pub async fn check_rate_limit_quota_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let subject_identifier = extract_rate_limit_subject_identifier(&authorized_request);
    let subject_email = parse_rate_limit_subject_as_email(subject_identifier)?;

    let requests_allowed = default_requests_allowed_per_window();
    let window_seconds = default_rate_limit_window_duration_seconds();

    let now_epoch_seconds = read_current_epoch_seconds();
    let window_start_epoch_seconds =
        compute_current_window_start_epoch_seconds(now_epoch_seconds, window_seconds);

    let counter_key =
        build_rate_limit_counter_document_key(&subject_email, window_start_epoch_seconds);

    let requests_consumed = load_consumed_request_count_for_window(
        &application_state.document_collection,
        &counter_key,
    )
    .await?;

    let remaining_allowance =
        compute_remaining_request_allowance(requests_allowed, requests_consumed);
    let seconds_until_reset = compute_seconds_until_window_reset(
        now_epoch_seconds,
        window_start_epoch_seconds,
        window_seconds,
    );

    reject_when_quota_exhausted(remaining_allowance, seconds_until_reset)?;

    // `is_request_within_configured_limits` is the authoritative check that
    // backs the coarse status label; keeping both in agreement guards against a
    // subject that is at exactly the boundary.
    let status_label = if is_request_within_configured_limits(requests_consumed, requests_allowed) {
        determine_quota_status_label(remaining_allowance)
    } else {
        "quota_exhausted"
    };

    let quota_report = serialize_rate_limit_quota_report(
        status_label,
        remaining_allowance,
        window_seconds,
        seconds_until_reset,
    );

    Ok(Json(quota_report))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_valid_subject_email() {
        let parsed = parse_rate_limit_subject_as_email("researcher@example.com".to_owned());
        assert!(parsed.is_ok());
        assert_eq!(parsed.unwrap().as_str(), "researcher@example.com");
    }

    #[test]
    fn rejects_a_malformed_subject_email() {
        let parsed = parse_rate_limit_subject_as_email("not-an-email".to_owned());
        assert!(parsed.is_err());
        match parsed.unwrap_err() {
            HttpError::AuthenticationCredentialsWereInvalid { .. } => {}
            other => panic!("expected invalid-credentials error, got {other:?}"),
        }
    }

    #[test]
    fn configuration_defaults_are_sensible() {
        assert_eq!(default_requests_allowed_per_window(), 100);
        assert_eq!(default_rate_limit_window_duration_seconds(), 60);
    }

    #[test]
    fn floors_timestamp_to_window_start() {
        assert_eq!(compute_current_window_start_epoch_seconds(125, 60), 120);
        assert_eq!(compute_current_window_start_epoch_seconds(120, 60), 120);
        assert_eq!(compute_current_window_start_epoch_seconds(0, 60), 0);
    }

    #[test]
    fn zero_window_returns_instant_as_start() {
        assert_eq!(compute_current_window_start_epoch_seconds(125, 0), 125);
    }

    #[test]
    fn builds_deterministic_counter_key() {
        let email = Email::parse("a@b.com".to_owned()).unwrap();
        let key = build_rate_limit_counter_document_key(&email, 120);
        assert_eq!(key, "rate-limit::a@b.com::120");
        // Same inputs yield the same key.
        assert_eq!(key, build_rate_limit_counter_document_key(&email, 120));
        // Different window yields a different key.
        assert_ne!(key, build_rate_limit_counter_document_key(&email, 180));
    }

    #[test]
    fn parses_consumed_count_from_valid_body() {
        let body = json!({ "consumed_requests": 42 });
        assert_eq!(parse_consumed_count_from_counter_document_body(&body), 42);
    }

    #[test]
    fn parses_missing_or_corrupt_count_as_zero() {
        assert_eq!(
            parse_consumed_count_from_counter_document_body(&json!({})),
            0
        );
        assert_eq!(
            parse_consumed_count_from_counter_document_body(&json!({ "consumed_requests": "oops" })),
            0
        );
        assert_eq!(
            parse_consumed_count_from_counter_document_body(&json!({ "consumed_requests": -5 })),
            0
        );
    }

    #[test]
    fn clamps_oversized_count_to_u32_max() {
        let body = json!({ "consumed_requests": (u64::from(u32::MAX)) + 100 });
        assert_eq!(
            parse_consumed_count_from_counter_document_body(&body),
            u32::MAX
        );
    }

    #[test]
    fn computes_remaining_allowance_and_saturates() {
        assert_eq!(compute_remaining_request_allowance(100, 40), 60);
        assert_eq!(compute_remaining_request_allowance(100, 100), 0);
        assert_eq!(compute_remaining_request_allowance(100, 250), 0);
    }

    #[test]
    fn labels_status_by_remaining_allowance() {
        assert_eq!(determine_quota_status_label(0), "quota_exhausted");
        assert_eq!(determine_quota_status_label(5), "approaching_limit");
        assert_eq!(determine_quota_status_label(10), "approaching_limit");
        assert_eq!(determine_quota_status_label(11), "within_limits");
        assert_eq!(determine_quota_status_label(100), "within_limits");
    }

    #[test]
    fn computes_seconds_until_window_reset() {
        assert_eq!(compute_seconds_until_window_reset(125, 120, 60), 55);
        assert_eq!(compute_seconds_until_window_reset(120, 120, 60), 60);
    }

    #[test]
    fn window_reset_handles_clock_skew_and_zero_window() {
        // now already past window end -> immediate reset.
        assert_eq!(compute_seconds_until_window_reset(500, 120, 60), 0);
        // zero window -> immediate reset.
        assert_eq!(compute_seconds_until_window_reset(125, 120, 0), 0);
    }

    #[test]
    fn evaluates_within_configured_limits() {
        assert!(is_request_within_configured_limits(0, 100));
        assert!(is_request_within_configured_limits(99, 100));
        assert!(!is_request_within_configured_limits(100, 100));
        assert!(!is_request_within_configured_limits(150, 100));
    }

    #[test]
    fn rejects_only_when_quota_is_exhausted() {
        assert!(reject_when_quota_exhausted(5, 30).is_ok());
        let rejection = reject_when_quota_exhausted(0, 30);
        assert!(rejection.is_err());
        match rejection.unwrap_err() {
            HttpError::AuthorizationWasDenied { explanation } => {
                assert!(explanation.contains("30"));
            }
            other => panic!("expected authorization-denied error, got {other:?}"),
        }
    }

    #[test]
    fn serializes_quota_report_body() {
        let body = serialize_rate_limit_quota_report("within_limits", 60, 60, 55);
        assert_eq!(body["status"], "within_limits");
        assert_eq!(body["remaining_requests"], 60);
        assert_eq!(body["window_seconds"], 60);
        assert_eq!(body["seconds_until_reset"], 55);
    }

    #[test]
    fn maps_document_collection_failure_to_upstream_error() {
        let failure = ApplicationError::DocumentCollectionFailure {
            failure_description: "connection reset".to_owned(),
        };
        match map_document_collection_failure_to_http_error(failure) {
            HttpError::UpstreamApplicationFailure { explanation } => {
                assert!(explanation.contains("connection reset"));
            }
            other => panic!("expected upstream failure, got {other:?}"),
        }
    }

    #[test]
    fn maps_not_found_failure_via_canonical_conversion() {
        let failure = ApplicationError::RequestedResourceCouldNotBeLocated;
        match map_document_collection_failure_to_http_error(failure) {
            HttpError::RequestedResourceWasNotFound { .. } => {}
            other => panic!("expected not-found error, got {other:?}"),
        }
    }
}
