use crate::error::HttpError;
use crate::state::ApplicationState;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::error::DomainError;
use alma_domain::value_objects::NonEmptyText;
use alma_macros::route;
use axum::Json;
use axum::extract::{Path, State};
use serde_json::{Value, json};

/// The set of NextAuth "GET" actions this endpoint understands.
///
/// NextAuth exposes a handful of read-style endpoints under `/api/auth/*`:
/// `csrf`, `providers`, `session`, `signin`, `signout`. Anything else that
/// arrives on the wildcard route is treated as an unrecognized action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NextAuthGetActionKind {
    /// `GET /api/auth/csrf` — hand back a CSRF token envelope.
    CsrfToken,
    /// `GET /api/auth/providers` — enumerate the configured providers.
    ProvidersCatalog,
    /// `GET /api/auth/session` — probe the current session state.
    SessionProbe,
    /// `GET /api/auth/signin` or `GET /api/auth/signin/:provider`.
    SignIn,
    /// `GET /api/auth/signout` — render the sign-out confirmation.
    SignOut,
    /// Anything not in the recognized set.
    Unrecognized,
}

#[route(method = "GET", path = "/api/auth/*nextauth_action")]
pub async fn handle_nextauth_action_via_get<TransactionalUnitOfWork>(
    State(_application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    Path(nextauth_action): Path<String>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let normalized_action = normalize_nextauth_action_path_segment(nextauth_action);
    reject_empty_nextauth_action(&normalized_action)?;

    let action_segments = split_nextauth_action_into_segments(&normalized_action);
    let action_kind = classify_nextauth_get_action(&action_segments);
    reject_unknown_nextauth_action(&action_kind, &normalized_action)?;

    // A sign-in action may carry a provider identifier as a trailing segment;
    // if present it must be a well-formed, non-empty value. We validate it here
    // so a malformed provider is rejected before we build a response body.
    if action_kind == NextAuthGetActionKind::SignIn {
        if let Some(provider_candidate) =
            extract_provider_identifier_from_signin_action(&action_segments)
        {
            let _validated_provider = parse_provider_identifier_as_non_empty(provider_candidate)?;
        }
    }

    let response_body = render_response_for_nextauth_get_action(&action_kind, &action_segments);
    Ok(Json(response_body))
}

/// Normalize the raw wildcard path segment into a canonical action string.
///
/// The wildcard capture can arrive with surrounding whitespace, a leading or
/// trailing slash, or mixed casing. We trim whitespace, strip the outer
/// slashes, and lowercase so downstream classification is deterministic.
fn normalize_nextauth_action_path_segment(raw_action: String) -> String {
    raw_action
        .trim()
        .trim_matches('/')
        .to_ascii_lowercase()
        .trim()
        .to_string()
}

/// Break a normalized action into its slash-delimited segments.
///
/// Empty segments (produced by doubled slashes) are discarded so
/// `signin//github` collapses to `["signin", "github"]`.
fn split_nextauth_action_into_segments(normalized_action: &str) -> Vec<String> {
    normalized_action
        .split('/')
        .map(|segment| segment.trim())
        .filter(|segment| !segment.is_empty())
        .map(|segment| segment.to_string())
        .collect()
}

/// Classify the leading segment of the action into a known kind.
fn classify_nextauth_get_action(action_segments: &[String]) -> NextAuthGetActionKind {
    let leading_segment = match action_segments.first() {
        Some(segment) => segment.as_str(),
        None => return NextAuthGetActionKind::Unrecognized,
    };
    match leading_segment {
        "csrf" => NextAuthGetActionKind::CsrfToken,
        "providers" => NextAuthGetActionKind::ProvidersCatalog,
        "session" => NextAuthGetActionKind::SessionProbe,
        "signin" => NextAuthGetActionKind::SignIn,
        "signout" => NextAuthGetActionKind::SignOut,
        _ => NextAuthGetActionKind::Unrecognized,
    }
}

/// Reject an action that normalized down to an empty string.
fn reject_empty_nextauth_action(normalized_action: &str) -> Result<(), HttpError> {
    if normalized_action.is_empty() {
        return Err(HttpError::RequestedResourceWasNotFound {
            explanation: "no NextAuth action was supplied in the request path".to_string(),
        });
    }
    Ok(())
}

/// Whether the classified action is one we can actually service.
fn is_recognized_nextauth_get_action(action_kind: &NextAuthGetActionKind) -> bool {
    !matches!(action_kind, NextAuthGetActionKind::Unrecognized)
}

/// Reject any action that did not classify into a recognized kind.
fn reject_unknown_nextauth_action(
    action_kind: &NextAuthGetActionKind,
    normalized_action: &str,
) -> Result<(), HttpError> {
    if is_recognized_nextauth_get_action(action_kind) {
        return Ok(());
    }
    Err(HttpError::RequestedResourceWasNotFound {
        explanation: format!("unsupported NextAuth GET action: '{normalized_action}'"),
    })
}

/// Pull the provider identifier out of a `signin/:provider` action, if any.
///
/// Returns `None` for a bare `signin` action (the generic sign-in page).
fn extract_provider_identifier_from_signin_action(
    action_segments: &[String],
) -> Option<String> {
    action_segments
        .get(1)
        .map(|provider_segment| provider_segment.clone())
        .filter(|provider_segment| !provider_segment.is_empty())
}

/// Validate a provider identifier candidate as a non-empty domain value.
fn parse_provider_identifier_as_non_empty(
    provider_candidate: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(provider_candidate).map_err(map_domain_error_to_malformed_action_error)
}

/// Build the CSRF-token response envelope.
///
/// The token itself is derived deterministically here from a fixed marker so
/// the endpoint is self-contained; a production deployment would source it
/// from the session layer.
fn build_csrf_token_response_body() -> Value {
    json!({
        "action": "csrf",
        "http_method": "GET",
        "csrf_token": "nextauth-csrf-placeholder-token",
        "status": "issued"
    })
}

/// Build the providers-catalog response envelope.
fn build_providers_catalog_response_body() -> Value {
    json!({
        "action": "providers",
        "http_method": "GET",
        "providers": {
            "google": {
                "id": "google",
                "name": "Google",
                "type": "oauth",
                "signin_url": "/api/auth/signin/google",
                "callback_url": "/api/auth/callback/google"
            }
        },
        "status": "handled"
    })
}

/// Build the session-probe response envelope.
///
/// When a principal is available the session is reported as active; otherwise
/// an anonymous, inactive session is returned (matching NextAuth's behavior of
/// returning an empty session object for unauthenticated callers).
fn build_session_probe_response_body(authenticated_principal: Option<&str>) -> Value {
    match authenticated_principal {
        Some(principal) if !principal.trim().is_empty() => json!({
            "action": "session",
            "http_method": "GET",
            "authenticated_principal": principal,
            "session_status": "active"
        }),
        _ => json!({
            "action": "session",
            "http_method": "GET",
            "authenticated_principal": Value::Null,
            "session_status": "anonymous"
        }),
    }
}

/// Build the sign-in redirect envelope for a specific provider.
fn build_signin_redirect_response_body(provider_identifier: &NonEmptyText) -> Value {
    let provider = provider_identifier.as_str();
    json!({
        "action": "signin",
        "http_method": "GET",
        "provider": provider,
        "redirect_url": format!("/api/auth/callback/{provider}"),
        "status": "redirecting"
    })
}

/// Build the sign-out confirmation envelope.
fn build_signout_confirmation_response_body() -> Value {
    json!({
        "action": "signout",
        "http_method": "GET",
        "redirect_url": "/api/auth/signin",
        "status": "signed_out"
    })
}

/// Render the final response body for a recognized action.
///
/// This assumes the action has already been validated by the handler; an
/// unrecognized kind falls through to a benign "handled" acknowledgement so
/// this pure helper is total.
fn render_response_for_nextauth_get_action(
    action_kind: &NextAuthGetActionKind,
    action_segments: &[String],
) -> Value {
    match action_kind {
        NextAuthGetActionKind::CsrfToken => build_csrf_token_response_body(),
        NextAuthGetActionKind::ProvidersCatalog => build_providers_catalog_response_body(),
        NextAuthGetActionKind::SessionProbe => build_session_probe_response_body(None),
        NextAuthGetActionKind::SignIn => {
            match extract_provider_identifier_from_signin_action(action_segments)
                .and_then(|provider_candidate| NonEmptyText::parse(provider_candidate).ok())
            {
                Some(provider_identifier) => {
                    build_signin_redirect_response_body(&provider_identifier)
                }
                None => json!({
                    "action": "signin",
                    "http_method": "GET",
                    "provider": Value::Null,
                    "status": "signin_page"
                }),
            }
        }
        NextAuthGetActionKind::SignOut => build_signout_confirmation_response_body(),
        NextAuthGetActionKind::Unrecognized => json!({
            "action": "unknown",
            "http_method": "GET",
            "status": "handled"
        }),
    }
}

/// Translate a domain validation failure into a malformed-action HTTP error.
fn map_domain_error_to_malformed_action_error(domain_failure: DomainError) -> HttpError {
    HttpError::RequestBodyWasMalformed {
        explanation: domain_failure.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_strips_slashes_whitespace_and_casing() {
        assert_eq!(
            normalize_nextauth_action_path_segment("  /SignIn/GitHub/ ".to_string()),
            "signin/github"
        );
        assert_eq!(
            normalize_nextauth_action_path_segment("CSRF".to_string()),
            "csrf"
        );
    }

    #[test]
    fn normalize_of_only_slashes_is_empty() {
        assert_eq!(normalize_nextauth_action_path_segment("///".to_string()), "");
        assert_eq!(normalize_nextauth_action_path_segment("   ".to_string()), "");
    }

    #[test]
    fn split_discards_empty_segments() {
        assert_eq!(
            split_nextauth_action_into_segments("signin//github"),
            vec!["signin".to_string(), "github".to_string()]
        );
        assert!(split_nextauth_action_into_segments("").is_empty());
    }

    #[test]
    fn classify_recognizes_known_leading_segments() {
        assert_eq!(
            classify_nextauth_get_action(&["csrf".to_string()]),
            NextAuthGetActionKind::CsrfToken
        );
        assert_eq!(
            classify_nextauth_get_action(&["providers".to_string()]),
            NextAuthGetActionKind::ProvidersCatalog
        );
        assert_eq!(
            classify_nextauth_get_action(&["session".to_string()]),
            NextAuthGetActionKind::SessionProbe
        );
        assert_eq!(
            classify_nextauth_get_action(&[
                "signin".to_string(),
                "google".to_string()
            ]),
            NextAuthGetActionKind::SignIn
        );
        assert_eq!(
            classify_nextauth_get_action(&["signout".to_string()]),
            NextAuthGetActionKind::SignOut
        );
    }

    #[test]
    fn classify_unknown_and_empty_is_unrecognized() {
        assert_eq!(
            classify_nextauth_get_action(&["callback".to_string()]),
            NextAuthGetActionKind::Unrecognized
        );
        assert_eq!(
            classify_nextauth_get_action(&[]),
            NextAuthGetActionKind::Unrecognized
        );
    }

    #[test]
    fn reject_empty_action_flags_missing_action() {
        assert!(reject_empty_nextauth_action("").is_err());
        assert!(reject_empty_nextauth_action("csrf").is_ok());
    }

    #[test]
    fn is_recognized_distinguishes_kinds() {
        assert!(is_recognized_nextauth_get_action(
            &NextAuthGetActionKind::CsrfToken
        ));
        assert!(!is_recognized_nextauth_get_action(
            &NextAuthGetActionKind::Unrecognized
        ));
    }

    #[test]
    fn reject_unknown_passes_recognized_and_blocks_unknown() {
        assert!(
            reject_unknown_nextauth_action(&NextAuthGetActionKind::SignOut, "signout").is_ok()
        );
        assert!(
            reject_unknown_nextauth_action(&NextAuthGetActionKind::Unrecognized, "bogus")
                .is_err()
        );
    }

    #[test]
    fn extract_provider_returns_second_segment_when_present() {
        assert_eq!(
            extract_provider_identifier_from_signin_action(&[
                "signin".to_string(),
                "google".to_string()
            ]),
            Some("google".to_string())
        );
        assert_eq!(
            extract_provider_identifier_from_signin_action(&["signin".to_string()]),
            None
        );
    }

    #[test]
    fn parse_provider_accepts_nonempty_rejects_blank() {
        let parsed = parse_provider_identifier_as_non_empty("github".to_string());
        assert!(parsed.is_ok());
        assert_eq!(parsed.unwrap().as_str(), "github");

        assert!(parse_provider_identifier_as_non_empty("   ".to_string()).is_err());
    }

    #[test]
    fn csrf_body_carries_token_and_action() {
        let body = build_csrf_token_response_body();
        assert_eq!(body["action"], json!("csrf"));
        assert!(body["csrf_token"].is_string());
        assert_eq!(body["status"], json!("issued"));
    }

    #[test]
    fn providers_body_enumerates_at_least_one_provider() {
        let body = build_providers_catalog_response_body();
        assert_eq!(body["action"], json!("providers"));
        assert!(body["providers"]["google"]["id"] == json!("google"));
    }

    #[test]
    fn session_body_reflects_principal_presence() {
        let active = build_session_probe_response_body(Some("user@example.com"));
        assert_eq!(active["session_status"], json!("active"));
        assert_eq!(active["authenticated_principal"], json!("user@example.com"));

        let anonymous = build_session_probe_response_body(None);
        assert_eq!(anonymous["session_status"], json!("anonymous"));
        assert!(anonymous["authenticated_principal"].is_null());

        let blank = build_session_probe_response_body(Some("   "));
        assert_eq!(blank["session_status"], json!("anonymous"));
    }

    #[test]
    fn signin_redirect_body_embeds_provider() {
        let provider = NonEmptyText::parse("google".to_string()).unwrap();
        let body = build_signin_redirect_response_body(&provider);
        assert_eq!(body["provider"], json!("google"));
        assert_eq!(body["redirect_url"], json!("/api/auth/callback/google"));
        assert_eq!(body["status"], json!("redirecting"));
    }

    #[test]
    fn signout_body_points_back_to_signin() {
        let body = build_signout_confirmation_response_body();
        assert_eq!(body["action"], json!("signout"));
        assert_eq!(body["redirect_url"], json!("/api/auth/signin"));
        assert_eq!(body["status"], json!("signed_out"));
    }

    #[test]
    fn render_dispatches_per_action_kind() {
        let csrf = render_response_for_nextauth_get_action(
            &NextAuthGetActionKind::CsrfToken,
            &["csrf".to_string()],
        );
        assert_eq!(csrf["action"], json!("csrf"));

        let signin_with_provider = render_response_for_nextauth_get_action(
            &NextAuthGetActionKind::SignIn,
            &["signin".to_string(), "google".to_string()],
        );
        assert_eq!(signin_with_provider["provider"], json!("google"));

        let signin_generic = render_response_for_nextauth_get_action(
            &NextAuthGetActionKind::SignIn,
            &["signin".to_string()],
        );
        assert_eq!(signin_generic["status"], json!("signin_page"));

        let session = render_response_for_nextauth_get_action(
            &NextAuthGetActionKind::SessionProbe,
            &["session".to_string()],
        );
        assert_eq!(session["action"], json!("session"));
    }

    #[test]
    fn map_domain_error_yields_malformed_body_error() {
        let mapped = map_domain_error_to_malformed_action_error(DomainError::NonEmptyTextEmpty);
        match mapped {
            HttpError::RequestBodyWasMalformed { explanation } => {
                assert!(!explanation.is_empty());
            }
            other => panic!("expected RequestBodyWasMalformed, got {other:?}"),
        }
    }
}
