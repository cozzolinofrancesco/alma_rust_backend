use alma_application::error::ApplicationError;
use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

#[derive(Debug)]
pub enum HttpError {
    RequestBodyWasMalformed { explanation: String },
    AuthenticationCredentialsWereMissing { explanation: String },
    AuthenticationCredentialsWereInvalid { explanation: String },
    AuthorizationWasDenied { explanation: String },
    RequestedResourceWasNotFound { explanation: String },
    UpstreamApplicationFailure { explanation: String },
}

#[derive(Debug, Serialize)]
struct SerializedErrorBody {
    error_category: String,
    error_explanation: String,
}

impl HttpError {
    fn corresponding_status_code(&self) -> StatusCode {
        match self {
            HttpError::RequestBodyWasMalformed { .. } => StatusCode::BAD_REQUEST,
            HttpError::AuthenticationCredentialsWereMissing { .. } => StatusCode::UNAUTHORIZED,
            HttpError::AuthenticationCredentialsWereInvalid { .. } => StatusCode::UNAUTHORIZED,
            HttpError::AuthorizationWasDenied { .. } => StatusCode::FORBIDDEN,
            HttpError::RequestedResourceWasNotFound { .. } => StatusCode::NOT_FOUND,
            HttpError::UpstreamApplicationFailure { .. } => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    fn category_label(&self) -> &'static str {
        match self {
            HttpError::RequestBodyWasMalformed { .. } => "request_body_was_malformed",
            HttpError::AuthenticationCredentialsWereMissing { .. } => {
                "authentication_credentials_were_missing"
            }
            HttpError::AuthenticationCredentialsWereInvalid { .. } => {
                "authentication_credentials_were_invalid"
            }
            HttpError::AuthorizationWasDenied { .. } => "authorization_was_denied",
            HttpError::RequestedResourceWasNotFound { .. } => "requested_resource_was_not_found",
            HttpError::UpstreamApplicationFailure { .. } => "upstream_application_failure",
        }
    }

    fn explanation_text(&self) -> String {
        match self {
            HttpError::RequestBodyWasMalformed { explanation }
            | HttpError::AuthenticationCredentialsWereMissing { explanation }
            | HttpError::AuthenticationCredentialsWereInvalid { explanation }
            | HttpError::AuthorizationWasDenied { explanation }
            | HttpError::RequestedResourceWasNotFound { explanation }
            | HttpError::UpstreamApplicationFailure { explanation } => explanation.clone(),
        }
    }
}

impl From<ApplicationError> for HttpError {
    fn from(originating_application_error: ApplicationError) -> Self {
        match originating_application_error {
            ApplicationError::RequestedProjectCouldNotBeLocated
            | ApplicationError::RequestedResourceCouldNotBeLocated => {
                HttpError::RequestedResourceWasNotFound {
                    explanation: originating_application_error.to_string(),
                }
            }
            ApplicationError::AuthorizationWasDenied => HttpError::AuthorizationWasDenied {
                explanation: originating_application_error.to_string(),
            },
            ApplicationError::DomainInvariantViolated(_) => HttpError::RequestBodyWasMalformed {
                explanation: originating_application_error.to_string(),
            },
            other_application_error => HttpError::UpstreamApplicationFailure {
                explanation: other_application_error.to_string(),
            },
        }
    }
}

/// Query-parameter names whose values are secrets and must never reach a client.
const SENSITIVE_QUERY_PARAMETERS: &[&str] = &["key", "api_key", "apikey", "access_token", "token"];

/// Redact secret-bearing query parameters (e.g. `?key=…`) from any URL-ish text
/// before it is returned to a client. An upstream `reqwest` error stringifies the
/// full request URL — which, for the Gemini calls, carries the API key in the
/// query string — and that error text is folded into `UpstreamApplicationFailure`
/// and serialized to the caller (RUST-SECRET-002). Scrubbing here closes the
/// client-exposure regardless of how the key is placed in the outbound URL.
fn redact_sensitive_query_parameters(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut remainder = text;
    while let Some(equals_index) = remainder.find('=') {
        let (head, tail) = remainder.split_at(equals_index + 1);
        result.push_str(head);
        // The parameter name is the token immediately before '=', back to the
        // last '?', '&', or whitespace.
        let parameter_name = head[..head.len() - 1]
            .rsplit(|character: char| character == '?' || character == '&' || character.is_whitespace())
            .next()
            .unwrap_or("");
        let value_end = tail
            .find(|character: char| {
                character == '&'
                    || character == '"'
                    || character == '\''
                    || character.is_whitespace()
            })
            .unwrap_or(tail.len());
        if SENSITIVE_QUERY_PARAMETERS
            .iter()
            .any(|sensitive_name| sensitive_name.eq_ignore_ascii_case(parameter_name))
        {
            result.push_str("<redacted>");
        } else {
            result.push_str(&tail[..value_end]);
        }
        remainder = &tail[value_end..];
    }
    result.push_str(remainder);
    result
}

impl IntoResponse for HttpError {
    fn into_response(self) -> Response {
        let response_status_code = self.corresponding_status_code();
        let serialized_body = SerializedErrorBody {
            error_category: String::from(self.category_label()),
            error_explanation: redact_sensitive_query_parameters(&self.explanation_text()),
        };
        (response_status_code, Json(serialized_body)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_the_gemini_key_from_a_url_bearing_error() {
        let leaked = "error sending request for url \
            (https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent?key=AIzaSECRET)";
        let redacted = redact_sensitive_query_parameters(leaked);
        assert!(!redacted.contains("AIzaSECRET"));
        assert!(redacted.contains("key=<redacted>"));
    }

    #[test]
    fn redacts_multiple_sensitive_parameters_but_keeps_benign_ones() {
        let redacted = redact_sensitive_query_parameters(
            "https://host/path?model=gemini-2.5-flash&api_key=SECRET1&token=SECRET2&page=2",
        );
        assert!(redacted.contains("model=gemini-2.5-flash"));
        assert!(redacted.contains("page=2"));
        assert!(!redacted.contains("SECRET1"));
        assert!(!redacted.contains("SECRET2"));
    }

    #[test]
    fn leaves_ordinary_text_without_query_parameters_untouched() {
        let text = "Failed to parse the request body as JSON: prompt: EOF at line 1 column 10";
        assert_eq!(redact_sensitive_query_parameters(text), text);
    }
}
