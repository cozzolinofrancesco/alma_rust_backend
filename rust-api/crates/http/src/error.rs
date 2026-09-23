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

impl IntoResponse for HttpError {
    fn into_response(self) -> Response {
        let response_status_code = self.corresponding_status_code();
        let serialized_body = SerializedErrorBody {
            error_category: String::from(self.category_label()),
            error_explanation: self.explanation_text(),
        };
        (response_status_code, Json(serialized_body)).into_response()
    }
}
