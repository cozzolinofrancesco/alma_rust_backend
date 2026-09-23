use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::ports::document_collection::{DocumentCollectionPort, StoredDocument};
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::{Email, NonEmptyText};
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

/// Name of the document collection that stores each principal's current refresh token.
/// There is no dedicated constant in `collections.rs` for refresh tokens (that file only
/// declares `ALLOWED_EMAILS_COLLECTION_NAME`), so this handler owns the constant locally.
const REFRESH_TOKENS_COLLECTION_NAME: &str = "auth_refresh_tokens";

/// Minimum number of characters a presented refresh token must contain to be considered
/// structurally plausible. Rotated tokens are UUIDv4 strings (36 characters), so anything
/// shorter than this bound cannot be a token this service ever issued.
const MINIMUM_REFRESH_TOKEN_LENGTH: usize = 8;

/// Lifetime, in seconds, granted to a freshly rotated refresh token.
const ROTATED_TOKEN_LIFETIME_SECONDS: u64 = 3600;

/// Rotate the caller's refresh token.
///
/// Flow:
/// 1. Identify the authenticated principal from the pipeline.
/// 2. Read and validate the refresh token the caller presented in the body.
/// 3. Load the stored refresh token for that principal and confirm it matches.
/// 4. Generate a new token, persist it (replacing the old one), and return it.
#[route(method = "POST", path = "/api/auth/refresh-token")]
pub async fn rotate_refresh_token_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // 1. Resolve the principal that owns the token being rotated.
    let token_owner_principal = extract_token_owner_principal(&authorized_request);
    let token_owner = parse_token_owner_principal_as_email(token_owner_principal)?;

    // 2. Read and validate the token the caller presented.
    let presented_token_candidate = extract_presented_refresh_token_field(&submitted_body)?;
    let presented_token = parse_presented_refresh_token_as_non_empty(presented_token_candidate)?;
    validate_presented_refresh_token_shape(&presented_token)?;

    // 3. Load the stored token for this principal and confirm the presented one matches.
    let document_collection = &application_state.document_collection;
    let token_document_key = build_refresh_token_document_key(&token_owner);

    let stored_document =
        load_stored_refresh_token_document(document_collection, &token_document_key).await?;
    let stored_token_value = extract_stored_refresh_token_value(&stored_document)?;
    verify_presented_token_matches_stored(&presented_token, &stored_token_value)?;

    // 4. Generate the replacement token, persist it, and respond.
    let rotated_token = generate_rotated_refresh_token_value();
    let issued_at_epoch_seconds = current_epoch_seconds();
    let rotated_document_body = build_rotated_refresh_token_document_body(
        &token_owner,
        &rotated_token,
        issued_at_epoch_seconds,
    );

    persist_rotated_refresh_token(document_collection, &token_document_key, rotated_document_body)
        .await?;

    Ok(Json(build_rotated_token_response_body(
        &rotated_token,
        ROTATED_TOKEN_LIFETIME_SECONDS,
    )))
}

/// (1) Pull the authenticated principal (an email address, as a `String`) out of the pipeline.
fn extract_token_owner_principal(
    authorized_request: &HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> String {
    authorized_request.authorized_principal().as_str().to_string()
}

/// (2) Re-parse the principal string into a validated `Email`.
///
/// The pipeline already hands us an `Email`, but downstream helpers accept a `String`, so we
/// round-trip through parsing to keep this function pure and independently testable. A failure
/// here indicates an internal inconsistency rather than a client error.
fn parse_token_owner_principal_as_email(principal: String) -> Result<Email, HttpError> {
    Email::parse(principal).map_err(|parse_error| HttpError::AuthenticationCredentialsWereInvalid {
        explanation: format!("Authenticated principal is not a valid email: {parse_error}"),
    })
}

/// (3) Extract the `presented_refresh_token` field from the request body.
fn extract_presented_refresh_token_field(submitted_body: &Value) -> Result<String, HttpError> {
    let field_value = submitted_body
        .get("presented_refresh_token")
        .or_else(|| submitted_body.get("refresh_token"))
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: "Request body must include a 'presented_refresh_token' field.".to_string(),
        })?;

    let token_text = field_value
        .as_str()
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: "The 'presented_refresh_token' field must be a JSON string.".to_string(),
        })?;

    Ok(token_text.to_string())
}

/// (4) Parse the presented token into a `NonEmptyText`.
fn parse_presented_refresh_token_as_non_empty(
    token_candidate: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(token_candidate).map_err(|parse_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: format!("The presented refresh token was empty: {parse_error}"),
        }
    })
}

/// (5) Validate the structural shape of the presented token (length / character set).
///
/// This guards against obviously-forged tokens before we spend a database round trip.
fn validate_presented_refresh_token_shape(presented_token: &NonEmptyText) -> Result<(), HttpError> {
    let token_text = presented_token.as_str().trim();

    if token_text.len() < MINIMUM_REFRESH_TOKEN_LENGTH {
        return Err(HttpError::AuthenticationCredentialsWereInvalid {
            explanation: format!(
                "The presented refresh token is too short to be valid (minimum {MINIMUM_REFRESH_TOKEN_LENGTH} characters)."
            ),
        });
    }

    let has_only_allowed_characters = token_text
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_');

    if !has_only_allowed_characters {
        return Err(HttpError::AuthenticationCredentialsWereInvalid {
            explanation: "The presented refresh token contains unexpected characters.".to_string(),
        });
    }

    Ok(())
}

/// (6) The collection name where refresh tokens are stored.
fn refresh_tokens_collection_name() -> &'static str {
    REFRESH_TOKENS_COLLECTION_NAME
}

/// (7) Build the deterministic document key for a principal's refresh token record.
fn build_refresh_token_document_key(token_owner: &Email) -> String {
    format!("refresh-token::{}", token_owner.as_str())
}

/// (8) Load the stored refresh token document for the given key.
///
/// A missing document is mapped to an authentication error, because the caller is presenting a
/// token for a principal that has no active token on record.
async fn load_stored_refresh_token_document(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    token_document_key: &str,
) -> Result<StoredDocument, HttpError> {
    let maybe_document = document_collection
        .fetch_document(refresh_tokens_collection_name(), token_document_key)
        .await?;

    maybe_document.ok_or_else(|| {
        map_missing_refresh_token_to_authentication_error(
            "No active refresh token exists for this principal.",
        )
    })
}

/// (9) Read the stored token string out of the persisted document body.
fn extract_stored_refresh_token_value(stored_document: &StoredDocument) -> Result<String, HttpError> {
    let stored_value = stored_document
        .document_body
        .get("refresh_token_value")
        .and_then(|value| value.as_str())
        .ok_or_else(|| HttpError::UpstreamApplicationFailure {
            explanation: "Stored refresh token document is missing its 'refresh_token_value'."
                .to_string(),
        })?;

    if stored_value.is_empty() {
        return Err(HttpError::UpstreamApplicationFailure {
            explanation: "Stored refresh token value is empty.".to_string(),
        });
    }

    Ok(stored_value.to_string())
}

/// (10) Confirm the presented token matches the stored token value.
///
/// Comparison walks the full byte length of both values so its running time does not reveal how
/// many leading characters matched (a small constant-time-style precaution for a secret compare).
fn verify_presented_token_matches_stored(
    presented_token: &NonEmptyText,
    stored_token_value: &str,
) -> Result<(), HttpError> {
    if constant_time_str_equals(presented_token.as_str(), stored_token_value) {
        Ok(())
    } else {
        Err(HttpError::AuthenticationCredentialsWereInvalid {
            explanation: "The presented refresh token does not match the active token.".to_string(),
        })
    }
}

/// (11) Generate a brand-new refresh token value.
fn generate_rotated_refresh_token_value() -> String {
    Uuid::new_v4().to_string()
}

/// (12) Build the document body to persist for the rotated token.
fn build_rotated_refresh_token_document_body(
    token_owner: &Email,
    rotated_token: &str,
    issued_at_epoch_seconds: u64,
) -> Value {
    json!({
        "token_owner": token_owner.as_str(),
        "refresh_token_value": rotated_token,
        "issued_at_epoch_seconds": issued_at_epoch_seconds,
        "expires_at_epoch_seconds": issued_at_epoch_seconds + ROTATED_TOKEN_LIFETIME_SECONDS,
    })
}

/// (13) Persist the rotated token, replacing the old record (inserting if none existed).
async fn persist_rotated_refresh_token(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    token_document_key: &str,
    rotated_document_body: Value,
) -> Result<(), HttpError> {
    let owning_account = rotated_document_body
        .get("token_owner")
        .and_then(|value| value.as_str())
        .map(|owner| owner.to_string());

    let document_to_store = StoredDocument {
        document_identifier: token_document_key.to_string(),
        owning_account,
        document_body: rotated_document_body,
    };

    let was_replaced = document_collection
        .replace_document(refresh_tokens_collection_name(), document_to_store.clone())
        .await?;

    if !was_replaced {
        // No prior record existed for this key; create it fresh.
        document_collection
            .insert_document(refresh_tokens_collection_name(), document_to_store)
            .await?;
    }

    Ok(())
}

/// (14) Build the JSON response body returned to the caller after a successful rotation.
fn build_rotated_token_response_body(rotated_token: &str, expires_in_seconds: u64) -> Value {
    json!({
        "rotated_token": rotated_token,
        "expires_in_seconds": expires_in_seconds,
        "token_type": "refresh",
    })
}

/// (15) Map a "no refresh token found" condition into an authentication error.
fn map_missing_refresh_token_to_authentication_error(explanation: &str) -> HttpError {
    HttpError::AuthenticationCredentialsWereMissing {
        explanation: explanation.to_string(),
    }
}

/// Return the current Unix epoch time in whole seconds, saturating to `0` if the system clock is
/// somehow set before the epoch (rather than panicking).
fn current_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// Byte-wise equality that always inspects both full strings, to avoid leaking match length via
/// early return timing. Not a hardened cryptographic primitive, but adequate for opaque tokens.
fn constant_time_str_equals(left: &str, right: &str) -> bool {
    let left_bytes = left.as_bytes();
    let right_bytes = right.as_bytes();

    if left_bytes.len() != right_bytes.len() {
        return false;
    }

    let mut difference_accumulator: u8 = 0;
    for index in 0..left_bytes.len() {
        difference_accumulator |= left_bytes[index] ^ right_bytes[index];
    }

    difference_accumulator == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_email() -> Email {
        Email::parse("scholar@example.org".to_string()).expect("valid sample email")
    }

    #[test]
    fn parse_token_owner_principal_as_email_accepts_valid_address() {
        let parsed = parse_token_owner_principal_as_email("owner@example.com".to_string());
        assert!(parsed.is_ok());
        assert_eq!(parsed.unwrap().as_str(), "owner@example.com");
    }

    #[test]
    fn parse_token_owner_principal_as_email_rejects_garbage() {
        let parsed = parse_token_owner_principal_as_email("not-an-email".to_string());
        assert!(matches!(
            parsed,
            Err(HttpError::AuthenticationCredentialsWereInvalid { .. })
        ));
    }

    #[test]
    fn extract_presented_refresh_token_field_reads_primary_key() {
        let body = json!({ "presented_refresh_token": "abcd-efgh-1234" });
        let extracted = extract_presented_refresh_token_field(&body);
        assert_eq!(extracted.unwrap(), "abcd-efgh-1234");
    }

    #[test]
    fn extract_presented_refresh_token_field_reads_fallback_key() {
        let body = json!({ "refresh_token": "fallback-token-value" });
        let extracted = extract_presented_refresh_token_field(&body);
        assert_eq!(extracted.unwrap(), "fallback-token-value");
    }

    #[test]
    fn extract_presented_refresh_token_field_rejects_missing_field() {
        let body = json!({ "unrelated": true });
        let extracted = extract_presented_refresh_token_field(&body);
        assert!(matches!(
            extracted,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn extract_presented_refresh_token_field_rejects_non_string() {
        let body = json!({ "presented_refresh_token": 42 });
        let extracted = extract_presented_refresh_token_field(&body);
        assert!(matches!(
            extracted,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn parse_presented_refresh_token_as_non_empty_accepts_content() {
        let parsed = parse_presented_refresh_token_as_non_empty("token-value-123".to_string());
        assert!(parsed.is_ok());
        assert_eq!(parsed.unwrap().as_str(), "token-value-123");
    }

    #[test]
    fn parse_presented_refresh_token_as_non_empty_rejects_blank() {
        let parsed = parse_presented_refresh_token_as_non_empty("   ".to_string());
        assert!(matches!(
            parsed,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn validate_presented_refresh_token_shape_accepts_uuid_like_token() {
        let token = NonEmptyText::parse(Uuid::new_v4().to_string()).unwrap();
        assert!(validate_presented_refresh_token_shape(&token).is_ok());
    }

    #[test]
    fn validate_presented_refresh_token_shape_rejects_short_token() {
        let token = NonEmptyText::parse("abc123".to_string()).unwrap();
        let result = validate_presented_refresh_token_shape(&token);
        assert!(matches!(
            result,
            Err(HttpError::AuthenticationCredentialsWereInvalid { .. })
        ));
    }

    #[test]
    fn validate_presented_refresh_token_shape_rejects_illegal_characters() {
        let token = NonEmptyText::parse("token with spaces!!".to_string()).unwrap();
        let result = validate_presented_refresh_token_shape(&token);
        assert!(matches!(
            result,
            Err(HttpError::AuthenticationCredentialsWereInvalid { .. })
        ));
    }

    #[test]
    fn refresh_tokens_collection_name_is_stable() {
        assert_eq!(refresh_tokens_collection_name(), "auth_refresh_tokens");
    }

    #[test]
    fn build_refresh_token_document_key_is_deterministic() {
        let owner = sample_email();
        let key_one = build_refresh_token_document_key(&owner);
        let key_two = build_refresh_token_document_key(&owner);
        assert_eq!(key_one, key_two);
        assert_eq!(key_one, "refresh-token::scholar@example.org");
    }

    #[test]
    fn extract_stored_refresh_token_value_reads_present_value() {
        let document = StoredDocument {
            document_identifier: "refresh-token::scholar@example.org".to_string(),
            owning_account: Some("scholar@example.org".to_string()),
            document_body: json!({ "refresh_token_value": "stored-token-xyz" }),
        };
        let value = extract_stored_refresh_token_value(&document);
        assert_eq!(value.unwrap(), "stored-token-xyz");
    }

    #[test]
    fn extract_stored_refresh_token_value_rejects_missing_value() {
        let document = StoredDocument {
            document_identifier: "refresh-token::scholar@example.org".to_string(),
            owning_account: None,
            document_body: json!({ "unrelated_field": "value" }),
        };
        let value = extract_stored_refresh_token_value(&document);
        assert!(matches!(
            value,
            Err(HttpError::UpstreamApplicationFailure { .. })
        ));
    }

    #[test]
    fn extract_stored_refresh_token_value_rejects_empty_value() {
        let document = StoredDocument {
            document_identifier: "key".to_string(),
            owning_account: None,
            document_body: json!({ "refresh_token_value": "" }),
        };
        let value = extract_stored_refresh_token_value(&document);
        assert!(matches!(
            value,
            Err(HttpError::UpstreamApplicationFailure { .. })
        ));
    }

    #[test]
    fn verify_presented_token_matches_stored_accepts_equal_values() {
        let presented = NonEmptyText::parse("matching-token".to_string()).unwrap();
        assert!(verify_presented_token_matches_stored(&presented, "matching-token").is_ok());
    }

    #[test]
    fn verify_presented_token_matches_stored_rejects_mismatch() {
        let presented = NonEmptyText::parse("presented-token".to_string()).unwrap();
        let result = verify_presented_token_matches_stored(&presented, "different-token");
        assert!(matches!(
            result,
            Err(HttpError::AuthenticationCredentialsWereInvalid { .. })
        ));
    }

    #[test]
    fn generate_rotated_refresh_token_value_produces_unique_values() {
        let first = generate_rotated_refresh_token_value();
        let second = generate_rotated_refresh_token_value();
        assert_ne!(first, second);
        assert_eq!(first.len(), 36);
    }

    #[test]
    fn build_rotated_refresh_token_document_body_contains_expected_fields() {
        let owner = sample_email();
        let body = build_rotated_refresh_token_document_body(&owner, "new-token-value", 1_000);
        assert_eq!(body["token_owner"], json!("scholar@example.org"));
        assert_eq!(body["refresh_token_value"], json!("new-token-value"));
        assert_eq!(body["issued_at_epoch_seconds"], json!(1_000));
        assert_eq!(
            body["expires_at_epoch_seconds"],
            json!(1_000 + ROTATED_TOKEN_LIFETIME_SECONDS)
        );
    }

    #[test]
    fn build_rotated_token_response_body_matches_contract() {
        let response = build_rotated_token_response_body("rotated-abc", 3600);
        assert_eq!(response["rotated_token"], json!("rotated-abc"));
        assert_eq!(response["expires_in_seconds"], json!(3600));
        assert_eq!(response["token_type"], json!("refresh"));
    }

    #[test]
    fn map_missing_refresh_token_to_authentication_error_maps_correctly() {
        let error = map_missing_refresh_token_to_authentication_error("nothing found");
        match error {
            HttpError::AuthenticationCredentialsWereMissing { explanation } => {
                assert_eq!(explanation, "nothing found");
            }
            other => panic!("unexpected error variant: {other:?}"),
        }
    }

    #[test]
    fn constant_time_str_equals_detects_equality_and_difference() {
        assert!(constant_time_str_equals("same-value", "same-value"));
        assert!(!constant_time_str_equals("value-a", "value-b"));
        assert!(!constant_time_str_equals("short", "longer-value"));
    }
}
