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

/// Retrieve the authenticated session descriptor for the currently authorized
/// principal.
///
/// The pipeline has already established that the caller is authenticated and
/// authorized. This handler confirms that the principal is still provisioned in
/// the allow-list collection, derives a lightweight profile, and assembles a
/// session lifecycle descriptor (status + expiry) for the client.
#[route(method = "GET", path = "/api/auth/session")]
pub async fn retrieve_authenticated_session_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // (1) Pull the raw principal identifier established by the pipeline.
    let raw_principal_identifier = extract_authenticated_principal_identifier(&authorized_request);

    // (3) Reject an empty/whitespace-only principal before any further work.
    reject_missing_authenticated_principal(&raw_principal_identifier)?;

    // (2) Parse the principal into a validated Email value object.
    let authenticated_email = parse_authenticated_principal_as_email(raw_principal_identifier)?;

    // (5) Confirm the principal is still provisioned in the allow-list.
    let principal_is_provisioned = confirm_authenticated_principal_is_provisioned(
        &application_state.document_collection,
        &authenticated_email,
    )
    .await?;

    // (6) Deny the session when the principal is no longer provisioned.
    reject_when_principal_is_not_provisioned(principal_is_provisioned, &authenticated_email)?;

    // (7) Build a human-facing display name from the local part of the address.
    let display_name = derive_display_name_from_email_local_part(&authenticated_email);

    // (8, 9) Compute the session expiry from the current epoch second.
    let now_epoch_seconds = current_epoch_seconds();
    let time_to_live_seconds = default_session_time_to_live_seconds();
    let expiry_epoch_seconds =
        compute_session_expiry_epoch_seconds(now_epoch_seconds, time_to_live_seconds);

    // (10) Determine the textual status label for the computed lifecycle.
    let status_label = determine_session_status_label(now_epoch_seconds, expiry_epoch_seconds);

    // (11, 12, 13) Assemble the response body from its fragments.
    let profile_fragment =
        build_authenticated_user_profile_fragment(&authenticated_email, &display_name);
    let lifecycle_fragment = build_session_lifecycle_fragment(status_label, expiry_epoch_seconds);
    let response_body = serialize_authenticated_session_response(profile_fragment, lifecycle_fragment);

    Ok(Json(response_body))
}

/// (1) Extract the authenticated principal identifier from the pipeline request.
fn extract_authenticated_principal_identifier(
    authorized_request: &HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> String {
    authorized_request.authorized_principal().as_str().to_string()
}

/// (2) Parse the authenticated principal string into a validated `Email`.
fn parse_authenticated_principal_as_email(principal: String) -> Result<Email, HttpError> {
    Email::parse(principal).map_err(|domain_error| {
        HttpError::AuthenticationCredentialsWereInvalid {
            explanation: format!(
                "the authenticated principal was not a valid email address: {domain_error}"
            ),
        }
    })
}

/// (3) Reject a missing (empty / whitespace-only) authenticated principal.
fn reject_missing_authenticated_principal(principal: &str) -> Result<(), HttpError> {
    if principal.trim().is_empty() {
        return Err(map_missing_principal_to_authentication_error(
            "no authenticated principal was present on the authorized request",
        ));
    }
    Ok(())
}

/// (4) The collection name that stores the provisioned allow-list of emails.
fn allowed_emails_collection_name() -> &'static str {
    ALLOWED_EMAILS_COLLECTION_NAME
}

/// (5) Confirm the authenticated principal is provisioned in the allow-list.
///
/// A principal is considered provisioned when a document keyed by its email
/// address (or one whose owning account matches it) exists in the allow-list
/// collection. We consult the collection by identifier first (the common,
/// cheap path) and fall back to scanning for an owning-account match.
async fn confirm_authenticated_principal_is_provisioned(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    authenticated_email: &Email,
) -> Result<bool, HttpError> {
    let collection_name = allowed_emails_collection_name();
    let principal_identifier = authenticated_email.as_str();

    let direct_match = document_collection
        .fetch_document(collection_name, principal_identifier)
        .await
        .map_err(map_document_collection_failure_to_http_error)?;
    if direct_match.is_some() {
        return Ok(true);
    }

    let documents_owned_by_principal = document_collection
        .list_documents_owned_by(collection_name, principal_identifier)
        .await
        .map_err(map_document_collection_failure_to_http_error)?;
    Ok(!documents_owned_by_principal.is_empty())
}

/// (6) Deny the session when the authenticated principal is not provisioned.
fn reject_when_principal_is_not_provisioned(
    principal_is_provisioned: bool,
    authenticated_email: &Email,
) -> Result<(), HttpError> {
    if principal_is_provisioned {
        return Ok(());
    }
    Err(HttpError::AuthorizationWasDenied {
        explanation: format!(
            "the authenticated principal '{}' is not provisioned for access",
            authenticated_email.as_str()
        ),
    })
}

/// (7) Derive a display name from the local part of an email address.
///
/// The local part (before the `@`) has separators (`.`, `_`, `-`, `+`) turned
/// into spaces, each word is capitalized, and the result is trimmed. Empty
/// results fall back to the full address so a client always has something to
/// render.
fn derive_display_name_from_email_local_part(authenticated_email: &Email) -> String {
    let full_address = authenticated_email.as_str();
    let local_part = full_address.split('@').next().unwrap_or(full_address);

    let humanized: String = local_part
        .split(|character: char| matches!(character, '.' | '_' | '-' | '+'))
        .filter(|segment| !segment.is_empty())
        .map(capitalize_first_character)
        .collect::<Vec<String>>()
        .join(" ");

    if humanized.trim().is_empty() {
        full_address.to_string()
    } else {
        humanized
    }
}

/// Capitalize the first character of a word, leaving the remainder untouched.
fn capitalize_first_character(word: &str) -> String {
    let mut characters = word.chars();
    match characters.next() {
        None => String::new(),
        Some(first) => first.to_uppercase().collect::<String>() + characters.as_str(),
    }
}

/// (8) The default session time-to-live in seconds (one hour).
fn default_session_time_to_live_seconds() -> u64 {
    3_600
}

/// (9) Compute the session expiry epoch second from now + time-to-live.
///
/// Uses saturating addition so an overflow near the u64 ceiling clamps to
/// `u64::MAX` rather than wrapping to a past instant.
fn compute_session_expiry_epoch_seconds(now_epoch_seconds: u64, time_to_live_seconds: u64) -> u64 {
    now_epoch_seconds.saturating_add(time_to_live_seconds)
}

/// (10) Determine the textual status label for the session lifecycle.
fn determine_session_status_label(
    now_epoch_seconds: u64,
    expiry_epoch_seconds: u64,
) -> &'static str {
    if expiry_epoch_seconds <= now_epoch_seconds {
        return "expired";
    }
    let remaining_seconds = expiry_epoch_seconds - now_epoch_seconds;
    if remaining_seconds <= 300 {
        "expiring_soon"
    } else {
        "active"
    }
}

/// (11) Build the JSON profile fragment for the authenticated user.
fn build_authenticated_user_profile_fragment(
    authenticated_email: &Email,
    display_name: &str,
) -> Value {
    json!({
        "authenticated_principal": authenticated_email.as_str(),
        "email_address": authenticated_email.as_str(),
        "display_name": display_name,
    })
}

/// (12) Build the JSON lifecycle fragment describing the session status/expiry.
fn build_session_lifecycle_fragment(status_label: &str, expiry_epoch_seconds: u64) -> Value {
    json!({
        "session_status": status_label,
        "expires_at_epoch_seconds": expiry_epoch_seconds,
    })
}

/// (13) Merge the profile and lifecycle fragments into a single response body.
fn serialize_authenticated_session_response(
    profile_fragment: Value,
    lifecycle_fragment: Value,
) -> Value {
    json!({
        "profile": profile_fragment,
        "session": lifecycle_fragment,
    })
}

/// (14) Map a missing-principal condition to an authentication error.
fn map_missing_principal_to_authentication_error(explanation: &str) -> HttpError {
    HttpError::AuthenticationCredentialsWereMissing {
        explanation: explanation.to_string(),
    }
}

/// (15) Map a document-collection port failure to an HTTP error.
fn map_document_collection_failure_to_http_error(port_failure: ApplicationError) -> HttpError {
    HttpError::UpstreamApplicationFailure {
        explanation: format!("the session provisioning check failed: {port_failure}"),
    }
}

/// Read the current wall-clock time as whole seconds since the Unix epoch.
///
/// A clock reported as being before the epoch is treated as epoch zero rather
/// than panicking; session-expiry math tolerates this gracefully.
fn current_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_email(raw: &str) -> Email {
        Email::parse(raw.to_string()).expect("test email should be valid")
    }

    #[test]
    fn parse_authenticated_principal_as_email_accepts_valid_address() {
        let parsed = parse_authenticated_principal_as_email("Person@Example.COM".to_string());
        assert!(parsed.is_ok());
        assert_eq!(parsed.unwrap().as_str(), "person@example.com");
    }

    #[test]
    fn parse_authenticated_principal_as_email_rejects_malformed_address() {
        let parsed = parse_authenticated_principal_as_email("not-an-email".to_string());
        assert!(matches!(
            parsed,
            Err(HttpError::AuthenticationCredentialsWereInvalid { .. })
        ));
    }

    #[test]
    fn reject_missing_authenticated_principal_passes_non_empty() {
        assert!(reject_missing_authenticated_principal("someone@example.com").is_ok());
    }

    #[test]
    fn reject_missing_authenticated_principal_rejects_blank() {
        let outcome = reject_missing_authenticated_principal("   ");
        assert!(matches!(
            outcome,
            Err(HttpError::AuthenticationCredentialsWereMissing { .. })
        ));
    }

    #[test]
    fn allowed_emails_collection_name_matches_constant() {
        assert_eq!(allowed_emails_collection_name(), ALLOWED_EMAILS_COLLECTION_NAME);
        assert_eq!(allowed_emails_collection_name(), "allowed_emails");
    }

    #[test]
    fn reject_when_principal_is_not_provisioned_allows_provisioned() {
        let email = sample_email("owner@example.com");
        assert!(reject_when_principal_is_not_provisioned(true, &email).is_ok());
    }

    #[test]
    fn reject_when_principal_is_not_provisioned_denies_unprovisioned() {
        let email = sample_email("stranger@example.com");
        let outcome = reject_when_principal_is_not_provisioned(false, &email);
        assert!(matches!(outcome, Err(HttpError::AuthorizationWasDenied { .. })));
    }

    #[test]
    fn derive_display_name_humanizes_local_part() {
        let email = sample_email("ada.lovelace@example.com");
        assert_eq!(derive_display_name_from_email_local_part(&email), "Ada Lovelace");
    }

    #[test]
    fn derive_display_name_handles_multiple_separators() {
        let email = sample_email("grace_hopper-navy+tag@example.com");
        assert_eq!(
            derive_display_name_from_email_local_part(&email),
            "Grace Hopper Navy Tag"
        );
    }

    #[test]
    fn capitalize_first_character_capitalizes() {
        assert_eq!(capitalize_first_character("word"), "Word");
    }

    #[test]
    fn capitalize_first_character_handles_empty() {
        assert_eq!(capitalize_first_character(""), "");
    }

    #[test]
    fn default_session_time_to_live_is_one_hour() {
        assert_eq!(default_session_time_to_live_seconds(), 3_600);
    }

    #[test]
    fn compute_session_expiry_adds_ttl() {
        assert_eq!(compute_session_expiry_epoch_seconds(1_000, 3_600), 4_600);
    }

    #[test]
    fn compute_session_expiry_saturates_on_overflow() {
        assert_eq!(
            compute_session_expiry_epoch_seconds(u64::MAX, 3_600),
            u64::MAX
        );
    }

    #[test]
    fn determine_session_status_label_reports_active() {
        assert_eq!(determine_session_status_label(1_000, 5_000), "active");
    }

    #[test]
    fn determine_session_status_label_reports_expiring_soon() {
        assert_eq!(determine_session_status_label(1_000, 1_200), "expiring_soon");
    }

    #[test]
    fn determine_session_status_label_reports_expired() {
        assert_eq!(determine_session_status_label(5_000, 1_000), "expired");
    }

    #[test]
    fn build_authenticated_user_profile_fragment_contains_expected_fields() {
        let email = sample_email("ada@example.com");
        let fragment = build_authenticated_user_profile_fragment(&email, "Ada");
        assert_eq!(fragment["authenticated_principal"], "ada@example.com");
        assert_eq!(fragment["email_address"], "ada@example.com");
        assert_eq!(fragment["display_name"], "Ada");
    }

    #[test]
    fn build_session_lifecycle_fragment_contains_expected_fields() {
        let fragment = build_session_lifecycle_fragment("active", 4_600);
        assert_eq!(fragment["session_status"], "active");
        assert_eq!(fragment["expires_at_epoch_seconds"], 4_600);
    }

    #[test]
    fn serialize_authenticated_session_response_nests_fragments() {
        let profile = json!({ "display_name": "Ada" });
        let lifecycle = json!({ "session_status": "active" });
        let response = serialize_authenticated_session_response(profile, lifecycle);
        assert_eq!(response["profile"]["display_name"], "Ada");
        assert_eq!(response["session"]["session_status"], "active");
    }

    #[test]
    fn map_missing_principal_to_authentication_error_carries_explanation() {
        let error = map_missing_principal_to_authentication_error("nothing here");
        match error {
            HttpError::AuthenticationCredentialsWereMissing { explanation } => {
                assert!(explanation.contains("nothing here"));
            }
            other => panic!("expected missing-credentials error, got {other:?}"),
        }
    }

    #[test]
    fn map_document_collection_failure_to_http_error_wraps_upstream() {
        let failure = ApplicationError::DocumentCollectionFailure {
            failure_description: "connection reset".to_string(),
        };
        let error = map_document_collection_failure_to_http_error(failure);
        match error {
            HttpError::UpstreamApplicationFailure { explanation } => {
                assert!(explanation.contains("connection reset"));
            }
            other => panic!("expected upstream-failure error, got {other:?}"),
        }
    }
}
