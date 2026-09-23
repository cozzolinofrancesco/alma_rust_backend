//! Optional `Authorization: Bearer <token>` extractor for per-user Google access.
//!
//! Separate from the shared perimeter (`x-api-key` + `x-account-email`, see
//! [`crate::pipeline::extractor`]): the service key authorizes the *caller* to use
//! the API, while this Bearer token is the caller's *Google OAuth* token, forwarded
//! to Google Drive so the drive endpoints act on that user's own Drive. The
//! `Authorization` header is otherwise unused by the perimeter.

use crate::error::HttpError;
use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;

/// The caller's Google OAuth 2.0 access token, extracted from `Authorization:
/// Bearer <token>`. A missing or malformed header is a 401 (the drive endpoints
/// require it); handlers that want it to be optional can take `Option<GoogleAccessToken>`.
#[derive(Debug, Clone)]
pub struct GoogleAccessToken(pub String);

impl GoogleAccessToken {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[async_trait::async_trait]
impl<SurroundingState> FromRequestParts<SurroundingState> for GoogleAccessToken
where
    SurroundingState: Send + Sync,
{
    type Rejection = HttpError;

    async fn from_request_parts(
        request_parts: &mut Parts,
        _surrounding_state: &SurroundingState,
    ) -> Result<Self, Self::Rejection> {
        let header_value = request_parts.headers.get(AUTHORIZATION).ok_or(
            HttpError::AuthenticationCredentialsWereMissing {
                explanation: String::from(
                    "an 'Authorization: Bearer <google-oauth-token>' header is required to access Google Drive",
                ),
            },
        )?;

        let header_text = header_value.to_str().map_err(|conversion_failure| {
            HttpError::AuthenticationCredentialsWereInvalid {
                explanation: format!("the Authorization header was not valid text: {conversion_failure}"),
            }
        })?;

        // Case-insensitive "Bearer " scheme prefix, then a non-empty token.
        let token = header_text
            .strip_prefix("Bearer ")
            .or_else(|| header_text.strip_prefix("bearer "))
            .map(str::trim)
            .filter(|token| !token.is_empty())
            .ok_or(HttpError::AuthenticationCredentialsWereInvalid {
                explanation: String::from(
                    "the Authorization header must be of the form 'Bearer <google-oauth-token>'",
                ),
            })?;

        Ok(GoogleAccessToken(token.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;

    async fn extract(header: Option<&str>) -> Result<GoogleAccessToken, HttpError> {
        let mut builder = Request::builder();
        if let Some(header) = header {
            builder = builder.header(AUTHORIZATION, header);
        }
        let (mut parts, _body) = builder.body(()).expect("request builds").into_parts();
        GoogleAccessToken::from_request_parts(&mut parts, &()).await
    }

    #[tokio::test]
    async fn extracts_bearer_token() {
        let token = extract(Some("Bearer ya29.abc123")).await.expect("ok");
        assert_eq!(token.as_str(), "ya29.abc123");
    }

    #[tokio::test]
    async fn accepts_lowercase_scheme_and_trims() {
        let token = extract(Some("bearer   tok  ")).await.expect("ok");
        assert_eq!(token.as_str(), "tok");
    }

    #[tokio::test]
    async fn missing_header_is_401_missing() {
        assert!(matches!(
            extract(None).await,
            Err(HttpError::AuthenticationCredentialsWereMissing { .. })
        ));
    }

    #[tokio::test]
    async fn wrong_scheme_or_empty_is_401_invalid() {
        assert!(matches!(
            extract(Some("Basic abc")).await,
            Err(HttpError::AuthenticationCredentialsWereInvalid { .. })
        ));
        assert!(matches!(
            extract(Some("Bearer ")).await,
            Err(HttpError::AuthenticationCredentialsWereInvalid { .. })
        ));
    }
}
