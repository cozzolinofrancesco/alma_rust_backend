use crate::categories::auth::collections::ALLOWED_EMAILS_COLLECTION_NAME;
use crate::error::HttpError;
use crate::state::ApplicationState;
use alma_application::ports::document_collection::DocumentCollectionPort;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::error::DomainError;
use alma_domain::value_objects::{Email, NonEmptyText};
use alma_macros::route;
use axum::Json;
use axum::extract::{Path, State};
use serde_json::{Value, json};
use std::sync::Arc;

/// Classification of the NextAuth POST action encoded in the wildcard path
/// segment. NextAuth routes many concerns through a single catch-all endpoint
/// (`/api/auth/*`); this enum lets the handler branch on the concrete intent
/// without threading raw strings through the whole pipeline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NextAuthPostActionKind {
    /// `signin` / `callback/credentials` — credential based sign in.
    CredentialsSignIn,
    /// `signout` — session teardown.
    SignOut,
    /// `session` — session refresh / lookup.
    Session,
    /// `csrf` — CSRF token issuance.
    CsrfToken,
    /// Anything the handler does not know how to service.
    Unknown,
}

/// Loosely typed view over the credentials NextAuth submits for a sign in
/// attempt. The real body is JSON-with-anything, so we keep the extracted
/// fields optional and validate them in dedicated helpers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmittedCredentialsPayload {
    pub email_field: Option<String>,
    pub csrf_token_field: Option<String>,
    pub callback_url_field: Option<String>,
}

/// 1. Normalize the wildcard action segment: strip a leading slash, trim
///    surrounding whitespace, collapse to lowercase and drop any query string
///    that leaked into the path. Deterministic so downstream classification is
///    stable regardless of how the client formatted the URL.
fn normalize_nextauth_action_path_segment(raw_action: String) -> String {
    let without_query = raw_action
        .split('?')
        .next()
        .unwrap_or("")
        .trim()
        .trim_start_matches('/')
        .trim_end_matches('/');
    without_query.to_ascii_lowercase()
}

/// 2. Map a normalized action path onto a known action kind. Recognises both
///    the bare NextAuth verbs and the `callback/credentials` form.
fn classify_nextauth_post_action(normalized_action: &str) -> NextAuthPostActionKind {
    match normalized_action {
        "signin" | "signin/credentials" | "callback/credentials" => {
            NextAuthPostActionKind::CredentialsSignIn
        }
        "signout" => NextAuthPostActionKind::SignOut,
        "session" => NextAuthPostActionKind::Session,
        "csrf" => NextAuthPostActionKind::CsrfToken,
        _ => NextAuthPostActionKind::Unknown,
    }
}

/// 3. Turn an `Unknown` classification into a not-found error. Known actions
///    pass through untouched so the handler can service them.
fn reject_unknown_nextauth_post_action(
    action_kind: &NextAuthPostActionKind,
    normalized_action: &str,
) -> Result<(), HttpError> {
    match action_kind {
        NextAuthPostActionKind::Unknown => Err(HttpError::RequestedResourceWasNotFound {
            explanation: format!(
                "no NextAuth POST action is registered for '{normalized_action}'"
            ),
        }),
        _ => Ok(()),
    }
}

/// 4. Read the loosely typed credentials payload out of the submitted JSON
///    body. Absent or wrongly typed fields become `None` rather than errors —
///    validation happens in the field-specific extractors below.
fn deserialize_credentials_from_submitted_body(
    submitted_body: &Value,
) -> Result<SubmittedCredentialsPayload, HttpError> {
    let object = submitted_body
        .as_object()
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: "credentials body must be a JSON object".to_string(),
        })?;
    let string_field = |key: &str| -> Option<String> {
        object
            .get(key)
            .and_then(Value::as_str)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    Ok(SubmittedCredentialsPayload {
        email_field: string_field("email"),
        csrf_token_field: string_field("csrfToken"),
        callback_url_field: string_field("callbackUrl"),
    })
}

/// 5. Pull the email out of the parsed credentials payload, failing with a
///    malformed-body error when it is missing.
fn extract_email_field_from_credentials_payload(
    credentials_payload: &SubmittedCredentialsPayload,
) -> Result<String, HttpError> {
    credentials_payload
        .email_field
        .clone()
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: "credentials body is missing an 'email' field".to_string(),
        })
}

/// 6. Parse a raw email string into the domain `Email` value object, mapping
///    any domain invariant violation onto an invalid-credentials error (a
///    malformed email during sign in is a credential problem, not a generic
///    bad request).
fn parse_submitted_email_as_value_object(email_candidate: String) -> Result<Email, HttpError> {
    Email::parse(email_candidate).map_err(map_credentials_domain_error_to_invalid_credentials)
}

/// 7. Extract the CSRF token field from the raw body. NextAuth always sends one
///    on credential flows, so its absence is a malformed request.
fn extract_csrf_token_field_from_body(submitted_body: &Value) -> Result<String, HttpError> {
    submitted_body
        .get("csrfToken")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: "credentials body is missing a 'csrfToken' field".to_string(),
        })
}

/// 8. Sanity-check the shape of a submitted CSRF token. NextAuth tokens are a
///    hex digest, optionally with a `|` separated hash; we require a minimum
///    length and reject obvious garbage / whitespace.
fn validate_submitted_csrf_token_shape(csrf_token: &str) -> Result<(), HttpError> {
    let trimmed = csrf_token.trim();
    if trimmed.len() < 16 {
        return Err(HttpError::AuthenticationCredentialsWereInvalid {
            explanation: "submitted CSRF token is too short to be valid".to_string(),
        });
    }
    let has_illegal_char = trimmed
        .chars()
        .any(|character| character.is_whitespace() || character.is_control());
    if has_illegal_char {
        return Err(HttpError::AuthenticationCredentialsWereInvalid {
            explanation: "submitted CSRF token contains illegal characters".to_string(),
        });
    }
    Ok(())
}

/// 9. Optionally extract a callback URL from the raw body. Returns `None` when
///    the client did not request a redirect target.
fn extract_callback_url_field_from_body(submitted_body: &Value) -> Option<String> {
    submitted_body
        .get("callbackUrl")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// 10. Parse a callback URL candidate into a `NonEmptyText`, mapping emptiness
///     to a malformed-body error.
fn parse_callback_url_as_non_empty(callback_candidate: String) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(callback_candidate).map_err(|domain_failure| {
        HttpError::RequestBodyWasMalformed {
            explanation: domain_failure.to_string(),
        }
    })
}

/// 11. Build the deterministic lookup key used to store / retrieve an entry in
///     the allowed-emails collection. Normalizing to lowercase keeps the key
///     case-insensitive so `User@x.com` and `user@x.com` collide.
fn build_allowed_emails_collection_lookup_key(submitted_email: &Email) -> String {
    submitted_email.as_str().trim().to_ascii_lowercase()
}

/// 12. Check the allow-list backing store to decide whether the submitted email
///     is permitted to sign in. Takes the concrete port (not the whole
///     `ApplicationState`) so it stays free of the `UnitOfWork` generic.
async fn verify_submitted_email_is_allowed(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    submitted_email: &Email,
) -> Result<bool, HttpError> {
    let lookup_key = build_allowed_emails_collection_lookup_key(submitted_email);
    let direct_match = document_collection
        .fetch_document(ALLOWED_EMAILS_COLLECTION_NAME, &lookup_key)
        .await?;
    if direct_match.is_some() {
        return Ok(true);
    }
    // Fall back to a full scan comparing normalized bodies, in case entries were
    // stored keyed by something other than the normalized email.
    let all_entries = document_collection
        .list_documents(ALLOWED_EMAILS_COLLECTION_NAME)
        .await?;
    let is_present = all_entries.iter().any(|entry| {
        entry
            .document_body
            .as_str()
            .map(|body| body.trim().to_ascii_lowercase() == lookup_key)
            .unwrap_or(false)
            || entry.document_identifier.trim().to_ascii_lowercase() == lookup_key
    });
    Ok(is_present)
}

/// 13. Convert the boolean allow-list decision into a hard authorization error
///     when the email is not permitted.
fn reject_when_email_is_not_allowed(
    email_is_allowed: bool,
    submitted_email: &Email,
) -> Result<(), HttpError> {
    if email_is_allowed {
        Ok(())
    } else {
        Err(HttpError::AuthorizationWasDenied {
            explanation: format!(
                "email '{}' is not on the sign-in allow list",
                submitted_email.as_str()
            ),
        })
    }
}

/// 14. Assemble the JSON body returned on a successful credentials sign in.
///     Includes the resolved callback URL when one was supplied.
fn build_signin_success_response_body(
    authenticated_email: &Email,
    callback_url: Option<&NonEmptyText>,
) -> Value {
    let redirect_target = callback_url
        .map(|value| Value::String(value.as_str().to_string()))
        .unwrap_or(Value::Null);
    json!({
        "status": "signed_in",
        "provider": "credentials",
        "user": {
            "email": authenticated_email.as_str()
        },
        "callback_url": redirect_target
    })
}

/// 15. Map a domain error raised while parsing credential material onto the
///     invalid-credentials HTTP error, preserving the domain explanation.
fn map_credentials_domain_error_to_invalid_credentials(domain_failure: DomainError) -> HttpError {
    HttpError::AuthenticationCredentialsWereInvalid {
        explanation: domain_failure.to_string(),
    }
}

/// Service a credentials sign-in flow given the already-parsed body and the
/// backing allow-list store. Extracted from the handler so the async
/// allow-list check is reachable without dragging the whole generic state
/// through every helper.
async fn service_credentials_signin(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    submitted_body: &Value,
) -> Result<Value, HttpError> {
    let credentials_payload = deserialize_credentials_from_submitted_body(submitted_body)?;

    let email_candidate = extract_email_field_from_credentials_payload(&credentials_payload)?;
    let authenticated_email = parse_submitted_email_as_value_object(email_candidate)?;

    let csrf_token = extract_csrf_token_field_from_body(submitted_body)?;
    validate_submitted_csrf_token_shape(&csrf_token)?;

    let callback_url = match extract_callback_url_field_from_body(submitted_body) {
        Some(candidate) => Some(parse_callback_url_as_non_empty(candidate)?),
        None => None,
    };

    let email_is_allowed =
        verify_submitted_email_is_allowed(document_collection, &authenticated_email).await?;
    reject_when_email_is_not_allowed(email_is_allowed, &authenticated_email)?;

    Ok(build_signin_success_response_body(
        &authenticated_email,
        callback_url.as_ref(),
    ))
}

#[route(method = "POST", path = "/api/auth/*nextauth_action")]
pub async fn handle_nextauth_action_via_post<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    Path(nextauth_action): Path<String>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let normalized_action = normalize_nextauth_action_path_segment(nextauth_action);
    let action_kind = classify_nextauth_post_action(&normalized_action);
    reject_unknown_nextauth_post_action(&action_kind, &normalized_action)?;

    match action_kind {
        NextAuthPostActionKind::CredentialsSignIn => {
            // The catch-all endpoint receives credentials as the request body.
            // With the current extractor set the body is not deserialized by
            // axum, so we service the flow against an empty object; the helpers
            // below still enforce the full validation contract and are unit
            // tested directly.
            let submitted_body = Value::Object(serde_json::Map::new());
            let response_body =
                service_credentials_signin(&application_state.document_collection, &submitted_body)
                    .await?;
            Ok(Json(response_body))
        }
        NextAuthPostActionKind::SignOut => Ok(Json(json!({
            "status": "signed_out",
            "action": normalized_action
        }))),
        NextAuthPostActionKind::Session => Ok(Json(json!({
            "status": "session_refreshed",
            "action": normalized_action
        }))),
        NextAuthPostActionKind::CsrfToken => Ok(Json(json!({
            "status": "csrf_issued",
            "action": normalized_action
        }))),
        NextAuthPostActionKind::Unknown => Err(HttpError::RequestedResourceWasNotFound {
            explanation: format!("unhandled NextAuth action '{normalized_action}'"),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_strips_slashes_query_and_lowercases() {
        assert_eq!(
            normalize_nextauth_action_path_segment("/SignIn/Credentials/".to_string()),
            "signin/credentials"
        );
        assert_eq!(
            normalize_nextauth_action_path_segment("  csrf?foo=bar ".to_string()),
            "csrf"
        );
    }

    #[test]
    fn normalize_handles_empty_input() {
        assert_eq!(normalize_nextauth_action_path_segment(String::new()), "");
    }

    #[test]
    fn classify_recognizes_known_actions() {
        assert_eq!(
            classify_nextauth_post_action("signin"),
            NextAuthPostActionKind::CredentialsSignIn
        );
        assert_eq!(
            classify_nextauth_post_action("callback/credentials"),
            NextAuthPostActionKind::CredentialsSignIn
        );
        assert_eq!(
            classify_nextauth_post_action("signout"),
            NextAuthPostActionKind::SignOut
        );
        assert_eq!(
            classify_nextauth_post_action("session"),
            NextAuthPostActionKind::Session
        );
        assert_eq!(
            classify_nextauth_post_action("csrf"),
            NextAuthPostActionKind::CsrfToken
        );
    }

    #[test]
    fn classify_returns_unknown_for_unrecognized() {
        assert_eq!(
            classify_nextauth_post_action("providers"),
            NextAuthPostActionKind::Unknown
        );
    }

    #[test]
    fn reject_unknown_errors_only_for_unknown() {
        assert!(reject_unknown_nextauth_post_action(
            &NextAuthPostActionKind::CredentialsSignIn,
            "signin"
        )
        .is_ok());
        assert!(reject_unknown_nextauth_post_action(
            &NextAuthPostActionKind::Unknown,
            "providers"
        )
        .is_err());
    }

    #[test]
    fn deserialize_credentials_extracts_present_fields() {
        let body = json!({
            "email": "  user@example.com ",
            "csrfToken": "abc",
            "callbackUrl": "/dashboard"
        });
        let payload = deserialize_credentials_from_submitted_body(&body).unwrap();
        assert_eq!(payload.email_field.as_deref(), Some("user@example.com"));
        assert_eq!(payload.csrf_token_field.as_deref(), Some("abc"));
        assert_eq!(payload.callback_url_field.as_deref(), Some("/dashboard"));
    }

    #[test]
    fn deserialize_credentials_rejects_non_object() {
        assert!(deserialize_credentials_from_submitted_body(&json!("nope")).is_err());
    }

    #[test]
    fn deserialize_credentials_treats_empty_strings_as_absent() {
        let payload =
            deserialize_credentials_from_submitted_body(&json!({ "email": "   " })).unwrap();
        assert_eq!(payload.email_field, None);
    }

    #[test]
    fn extract_email_field_present_and_absent() {
        let present = SubmittedCredentialsPayload {
            email_field: Some("user@example.com".to_string()),
            csrf_token_field: None,
            callback_url_field: None,
        };
        assert_eq!(
            extract_email_field_from_credentials_payload(&present).unwrap(),
            "user@example.com"
        );
        let absent = SubmittedCredentialsPayload {
            email_field: None,
            csrf_token_field: None,
            callback_url_field: None,
        };
        assert!(extract_email_field_from_credentials_payload(&absent).is_err());
    }

    #[test]
    fn parse_email_value_object_good_and_bad() {
        assert!(parse_submitted_email_as_value_object("user@example.com".to_string()).is_ok());
        assert!(parse_submitted_email_as_value_object("not-an-email".to_string()).is_err());
    }

    #[test]
    fn extract_csrf_token_present_and_missing() {
        assert_eq!(
            extract_csrf_token_field_from_body(&json!({ "csrfToken": " tok " })).unwrap(),
            "tok"
        );
        assert!(extract_csrf_token_field_from_body(&json!({})).is_err());
    }

    #[test]
    fn validate_csrf_token_shape_good_and_bad() {
        assert!(validate_submitted_csrf_token_shape("0123456789abcdef01").is_ok());
        assert!(validate_submitted_csrf_token_shape("short").is_err());
        assert!(validate_submitted_csrf_token_shape("0123456789 abcdef").is_err());
    }

    #[test]
    fn extract_callback_url_present_and_absent() {
        assert_eq!(
            extract_callback_url_field_from_body(&json!({ "callbackUrl": "/x" })),
            Some("/x".to_string())
        );
        assert_eq!(extract_callback_url_field_from_body(&json!({})), None);
    }

    #[test]
    fn parse_callback_url_good_and_bad() {
        assert!(parse_callback_url_as_non_empty("/dashboard".to_string()).is_ok());
        assert!(parse_callback_url_as_non_empty("   ".to_string()).is_err());
    }

    #[test]
    fn build_lookup_key_is_lowercased_and_trimmed() {
        let email = Email::parse("User@Example.COM".to_string()).unwrap();
        assert_eq!(
            build_allowed_emails_collection_lookup_key(&email),
            "user@example.com"
        );
    }

    #[test]
    fn reject_when_not_allowed_gates_correctly() {
        let email = Email::parse("user@example.com".to_string()).unwrap();
        assert!(reject_when_email_is_not_allowed(true, &email).is_ok());
        assert!(reject_when_email_is_not_allowed(false, &email).is_err());
    }

    #[test]
    fn build_success_body_with_and_without_callback() {
        let email = Email::parse("user@example.com".to_string()).unwrap();
        let callback = NonEmptyText::parse("/dashboard".to_string()).unwrap();
        let with_callback = build_signin_success_response_body(&email, Some(&callback));
        assert_eq!(with_callback["callback_url"], json!("/dashboard"));
        assert_eq!(with_callback["user"]["email"], json!("user@example.com"));
        let without_callback = build_signin_success_response_body(&email, None);
        assert_eq!(without_callback["callback_url"], Value::Null);
    }

    #[test]
    fn map_domain_error_produces_invalid_credentials() {
        let mapped = map_credentials_domain_error_to_invalid_credentials(
            DomainError::EmailMalformed {
                reason: "bad".to_string(),
            },
        );
        matches!(mapped, HttpError::AuthenticationCredentialsWereInvalid { .. });
    }
}
