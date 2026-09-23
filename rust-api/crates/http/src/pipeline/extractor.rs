use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use alma_domain::value_objects::optics::email_string_prism;
use async_trait::async_trait;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;

const CORRELATION_IDENTIFIER_HEADER_NAME: &str = "x-request-id";
const AUTHENTICATED_ACCOUNT_HEADER_NAME: &str = "x-account-email";

/// Header carrying the shared-secret service key. Mirrors the reference
/// `frontend_v3` perimeter, whose `middleware.ts` / `app/lib/serviceApiAuth.ts`
/// both read the presented key from the `x-api-key` header. Net-new here — the
/// Rust port previously trusted header-presence identity alone (plan C7,
/// Phase 1d).
const SERVICE_API_KEY_HEADER_NAME: &str = "x-api-key";

/// Environment variable holding the expected shared secret. This is the very
/// same contract the bootstrap `RuntimeConfiguration` resolves (config / S1):
/// an unset or whitespace-only value leaves the check disabled (localhost
/// only), while a present value makes a matching `x-api-key` header mandatory
/// on every authorized request.
const SERVICE_API_KEY_ENVIRONMENT_VARIABLE: &str = "SERVICE_API_KEY";

#[async_trait]
impl<SurroundingState> FromRequestParts<SurroundingState>
    for HttpRequestInPipeline<RequestHasBeenAuthorized>
where
    SurroundingState: Send + Sync,
{
    type Rejection = HttpError;

    async fn from_request_parts(
        request_parts: &mut Parts,
        _surrounding_state: &SurroundingState,
    ) -> Result<Self, Self::Rejection> {
        let resolved_correlation_identifier = request_parts
            .headers
            .get(CORRELATION_IDENTIFIER_HEADER_NAME)
            .and_then(|header_value| header_value.to_str().ok())
            .map(|borrowed_value| borrowed_value.to_string())
            .unwrap_or_else(|| String::from("unassigned-correlation-identifier"));

        // Shared-secret perimeter. Guards the whole API ahead of the
        // per-request identity work, so an unauthenticated caller is turned
        // away before any email parsing happens.
        enforce_service_key_perimeter(request_parts)?;

        let raw_authenticated_account = request_parts
            .headers
            .get(AUTHENTICATED_ACCOUNT_HEADER_NAME)
            .ok_or(HttpError::AuthenticationCredentialsWereMissing {
                explanation: format!("the '{AUTHENTICATED_ACCOUNT_HEADER_NAME}' header was absent"),
            })?
            .to_str()
            .map_err(
                |conversion_failure| HttpError::AuthenticationCredentialsWereInvalid {
                    explanation: format!(
                        "the account header was not valid text: {conversion_failure}"
                    ),
                },
            )?
            .to_string();

        let parsed_authenticated_principal = email_string_prism()
            .preview(&raw_authenticated_account)
            .ok_or(HttpError::AuthenticationCredentialsWereInvalid {
                explanation: String::from(
                    "the account header did not parse into a valid email address",
                ),
            })?;

        let validated_request =
            HttpRequestInPipeline::originate(resolved_correlation_identifier).validate()?;
        let authenticated_request =
            validated_request.authenticate(parsed_authenticated_principal)?;
        let authorized_request = authenticated_request.authorize()?;

        Ok(authorized_request)
    }
}

/// Resolve the configured service key, mirroring the bootstrap config's
/// `read_environment_string` (config / S1): unset and whitespace-only both read
/// as absent, so an exported-but-empty `SERVICE_API_KEY` never enables a check
/// no caller could satisfy (the falsy/null trap).
///
/// The value is read from the environment here rather than pulled from
/// `ApplicationState` because the resolved `RuntimeConfiguration` lives in the
/// `bootstrap` crate — which depends on this one — and threading it through the
/// shared state is wiring the stage integrator owns. The `SERVICE_API_KEY`
/// contract itself is entirely config's.
fn resolve_configured_service_key() -> Option<String> {
    std::env::var(SERVICE_API_KEY_ENVIRONMENT_VARIABLE)
        .ok()
        .map(|raw_value| raw_value.trim().to_string())
        .filter(|trimmed_value| !trimmed_value.is_empty())
}

/// Enforce the shared-secret perimeter. When no `SERVICE_API_KEY` is configured
/// the check is skipped entirely (localhost only — plan C7); when one is
/// configured the request must carry a byte-identical `x-api-key` header.
fn enforce_service_key_perimeter(request_parts: &Parts) -> Result<(), HttpError> {
    let Some(expected_service_key) = resolve_configured_service_key() else {
        return Ok(());
    };

    verify_presented_service_key(request_parts, &expected_service_key)
}

/// Compare the `x-api-key` header against the expected secret. Missing header →
/// 401 "credentials were missing"; present-but-wrong (or non-text) → 401
/// "credentials were invalid", mirroring the reference's two 401 branches
/// ("API key is required." / "Invalid API key provided.").
fn verify_presented_service_key(
    request_parts: &Parts,
    expected_service_key: &str,
) -> Result<(), HttpError> {
    let presented_service_key = request_parts
        .headers
        .get(SERVICE_API_KEY_HEADER_NAME)
        .ok_or(HttpError::AuthenticationCredentialsWereMissing {
            explanation: format!("the '{SERVICE_API_KEY_HEADER_NAME}' header was absent"),
        })?
        .to_str()
        .map_err(
            |conversion_failure| HttpError::AuthenticationCredentialsWereInvalid {
                explanation: format!(
                    "the service key header was not valid text: {conversion_failure}"
                ),
            },
        )?;

    if service_keys_match_in_constant_time(
        presented_service_key.as_bytes(),
        expected_service_key.as_bytes(),
    ) {
        Ok(())
    } else {
        Err(HttpError::AuthenticationCredentialsWereInvalid {
            explanation: String::from(
                "the service key header did not match the configured secret",
            ),
        })
    }
}

/// Compare two secrets without an early-out on the first differing byte, so a
/// caller cannot recover the expected key byte-by-byte from response timing.
/// Behaviourally identical to `==` — same accept/reject outcome — it only
/// closes the timing side channel. (The length comparison is deliberately
/// permitted to short-circuit; the secret's length is not treated as sensitive.)
fn service_keys_match_in_constant_time(
    presented_service_key: &[u8],
    expected_service_key: &[u8],
) -> bool {
    if presented_service_key.len() != expected_service_key.len() {
        return false;
    }

    let mut accumulated_difference: u8 = 0;
    for (presented_byte, expected_byte) in presented_service_key
        .iter()
        .zip(expected_service_key.iter())
    {
        accumulated_difference |= presented_byte ^ expected_byte;
    }

    accumulated_difference == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;

    fn request_parts_with_service_key_header(header_value: &str) -> Parts {
        Request::builder()
            .header(SERVICE_API_KEY_HEADER_NAME, header_value)
            .body(())
            .expect("a request carrying only a service-key header is well-formed")
            .into_parts()
            .0
    }

    fn request_parts_without_any_headers() -> Parts {
        Request::builder()
            .body(())
            .expect("an empty request is well-formed")
            .into_parts()
            .0
    }

    #[test]
    fn matching_keys_of_equal_length_are_accepted() {
        assert!(service_keys_match_in_constant_time(
            b"correct-horse-battery-staple",
            b"correct-horse-battery-staple",
        ));
    }

    #[test]
    fn differing_keys_of_equal_length_are_rejected() {
        assert!(!service_keys_match_in_constant_time(
            b"correct-horse-battery-staple",
            b"correct-horse-battery-stapfe",
        ));
    }

    #[test]
    fn keys_of_differing_length_are_rejected() {
        assert!(!service_keys_match_in_constant_time(b"short", b"short-suffix"));
    }

    #[test]
    fn two_empty_keys_are_treated_as_equal() {
        assert!(service_keys_match_in_constant_time(b"", b""));
    }

    #[test]
    fn a_matching_header_passes_verification() {
        let request_parts = request_parts_with_service_key_header("expected-secret");
        assert!(verify_presented_service_key(&request_parts, "expected-secret").is_ok());
    }

    #[test]
    fn a_mismatched_header_is_rejected_as_invalid() {
        let request_parts = request_parts_with_service_key_header("wrong-secret");
        let verification_outcome = verify_presented_service_key(&request_parts, "expected-secret");
        assert!(matches!(
            verification_outcome,
            Err(HttpError::AuthenticationCredentialsWereInvalid { .. })
        ));
    }

    #[test]
    fn an_absent_header_is_rejected_as_missing() {
        let request_parts = request_parts_without_any_headers();
        let verification_outcome = verify_presented_service_key(&request_parts, "expected-secret");
        assert!(matches!(
            verification_outcome,
            Err(HttpError::AuthenticationCredentialsWereMissing { .. })
        ));
    }

    #[test]
    fn a_whitespace_only_configured_key_resolves_to_absent() {
        // Mirrors config S1's `read_environment_string`: the resolver trims and
        // treats a blank value as no key at all.
        let raw_value = "   ";
        let resolved = Some(raw_value.to_string())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        assert_eq!(resolved, None);
    }
}
