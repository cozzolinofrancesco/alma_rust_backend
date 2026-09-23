use crate::categories::auth::collections::ALLOWED_EMAILS_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::error::ApplicationError;
use alma_application::ports::document_collection::{DocumentCollectionPort, StoredDocument};
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::Email;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};
use std::sync::Arc;

/// GET /api/allowed-emails
///
/// Returns the set of email addresses that are permitted to access the
/// application. The persisted allow-list is augmented with the currently
/// authenticated principal so that the caller always appears in the response,
/// even if it has not yet been explicitly recorded in the collection.
#[route(method = "GET", path = "/api/allowed-emails")]
pub async fn list_allowed_emails_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let requesting_account_principal = extract_requesting_account_principal(&authorized_request);
    let requesting_account_email = parse_requesting_account_as_email(requesting_account_principal)?;

    let collection_name = allowed_emails_collection_name();
    let stored_documents =
        load_allowed_email_documents(&application_state.document_collection, collection_name)
            .await?;

    let mut allowed_emails = collect_valid_allowed_emails_from_documents(stored_documents);
    append_requesting_account_when_absent(&mut allowed_emails, requesting_account_email);

    let mut allowed_emails = deduplicate_allowed_emails_preserving_order(allowed_emails);
    sort_allowed_emails_case_insensitively(&mut allowed_emails);

    let total_count = count_total_allowed_emails(&allowed_emails);
    let serialized_emails = serialize_allowed_emails_collection(&allowed_emails);
    let response_body = build_allowed_emails_response_body(serialized_emails, total_count);

    Ok(Json(response_body))
}

/// (1) Pull the raw authenticated principal string out of the authorized
/// request pipeline stage.
fn extract_requesting_account_principal(
    authorized_request: &HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> String {
    authorized_request
        .authorized_principal()
        .as_str()
        .to_string()
}

/// (2) Validate that the requesting principal is a well-formed email address.
/// A malformed principal indicates a broken authentication pipeline, so it is
/// surfaced as an invalid-credentials failure rather than a bad request body.
fn parse_requesting_account_as_email(principal: String) -> Result<Email, HttpError> {
    Email::parse(principal).map_err(|domain_error| {
        HttpError::AuthenticationCredentialsWereInvalid {
            explanation: domain_error.to_string(),
        }
    })
}

/// (3) The document collection name that stores the persisted allow-list.
fn allowed_emails_collection_name() -> &'static str {
    ALLOWED_EMAILS_COLLECTION_NAME
}

/// (4) Fetch every stored document from the allow-list collection, mapping any
/// port failure onto an HTTP error.
async fn load_allowed_email_documents(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    collection_name: &str,
) -> Result<Vec<StoredDocument>, HttpError> {
    document_collection
        .list_documents(collection_name)
        .await
        .map_err(map_document_collection_failure_to_http_error)
}

/// (5) Extract a candidate email string from a stored document body. The body
/// may either be a bare JSON string, or an object carrying an `email` (or
/// `email_address`) field. Anything else yields `None`.
fn extract_email_string_from_stored_document(stored_document: &StoredDocument) -> Option<String> {
    match &stored_document.document_body {
        Value::String(bare_email) => Some(bare_email.clone()),
        Value::Object(document_fields) => document_fields
            .get("email")
            .or_else(|| document_fields.get("email_address"))
            .and_then(|field_value| field_value.as_str())
            .map(|email_str| email_str.to_string()),
        _ => None,
    }
}

/// (6) Parse a raw stored email string into a validated `Email`, discarding
/// entries that fail validation instead of aborting the whole listing.
fn parse_stored_email_string_as_value_object(email_candidate: String) -> Option<Email> {
    Email::parse(email_candidate).ok()
}

/// (7) Convert the stored documents into validated `Email` value objects,
/// silently dropping any document that has no usable email or that fails
/// validation.
fn collect_valid_allowed_emails_from_documents(stored_documents: Vec<StoredDocument>) -> Vec<Email> {
    stored_documents
        .iter()
        .filter_map(extract_email_string_from_stored_document)
        .filter_map(parse_stored_email_string_as_value_object)
        .collect()
}

/// (8) Ensure the requesting account is represented in the allow-list. The
/// comparison is case-insensitive so that differing casing does not produce a
/// duplicate entry.
fn append_requesting_account_when_absent(
    allowed_emails: &mut Vec<Email>,
    requesting_account: Email,
) {
    let already_present = allowed_emails
        .iter()
        .any(|existing_email| emails_match_case_insensitively(existing_email, &requesting_account));
    if !already_present {
        allowed_emails.push(requesting_account);
    }
}

/// (9) Remove duplicate emails (case-insensitively) while keeping the first
/// occurrence of each address in its original position.
fn deduplicate_allowed_emails_preserving_order(allowed_emails: Vec<Email>) -> Vec<Email> {
    let mut deduplicated_emails: Vec<Email> = Vec::with_capacity(allowed_emails.len());
    for candidate_email in allowed_emails {
        let is_duplicate = deduplicated_emails
            .iter()
            .any(|retained_email| emails_match_case_insensitively(retained_email, &candidate_email));
        if !is_duplicate {
            deduplicated_emails.push(candidate_email);
        }
    }
    deduplicated_emails
}

/// (10) Sort the allow-list alphabetically, ignoring case, so the response is
/// deterministic regardless of insertion order.
fn sort_allowed_emails_case_insensitively(allowed_emails: &mut [Email]) {
    allowed_emails.sort_by(|first_email, second_email| {
        first_email
            .as_str()
            .to_ascii_lowercase()
            .cmp(&second_email.as_str().to_ascii_lowercase())
    });
}

/// (11) Count the total number of allowed emails.
fn count_total_allowed_emails(allowed_emails: &[Email]) -> usize {
    allowed_emails.len()
}

/// (12) Serialize a single email into a JSON string value.
fn serialize_allowed_email_to_json_value(allowed_email: &Email) -> Value {
    Value::String(allowed_email.as_str().to_string())
}

/// (13) Serialize the whole allow-list into a vector of JSON string values.
fn serialize_allowed_emails_collection(allowed_emails: &[Email]) -> Vec<Value> {
    allowed_emails
        .iter()
        .map(serialize_allowed_email_to_json_value)
        .collect()
}

/// (14) Assemble the final response body carrying the serialized emails and a
/// convenience total count.
fn build_allowed_emails_response_body(serialized_emails: Vec<Value>, total_count: usize) -> Value {
    json!({
        "allowed_emails": serialized_emails,
        "total_count": total_count,
    })
}

/// (15) Translate a document-collection port failure into the corresponding
/// HTTP error. Not-found propagates as a 404; everything else is an upstream
/// failure.
fn map_document_collection_failure_to_http_error(port_failure: ApplicationError) -> HttpError {
    match port_failure {
        ApplicationError::RequestedResourceCouldNotBeLocated
        | ApplicationError::RequestedProjectCouldNotBeLocated => {
            HttpError::RequestedResourceWasNotFound {
                explanation: port_failure.to_string(),
            }
        }
        ApplicationError::AuthorizationWasDenied => HttpError::AuthorizationWasDenied {
            explanation: port_failure.to_string(),
        },
        other_failure => HttpError::UpstreamApplicationFailure {
            explanation: other_failure.to_string(),
        },
    }
}

/// Internal helper: compare two emails ignoring ASCII case.
fn emails_match_case_insensitively(first_email: &Email, second_email: &Email) -> bool {
    first_email
        .as_str()
        .eq_ignore_ascii_case(second_email.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored_document_with_body(identifier: &str, body: Value) -> StoredDocument {
        StoredDocument {
            document_identifier: identifier.to_string(),
            owning_account: None,
            document_body: body,
        }
    }

    fn email(raw: &str) -> Email {
        Email::parse(raw.to_string()).expect("test email should be valid")
    }

    #[test]
    fn allowed_emails_collection_name_matches_constant() {
        assert_eq!(allowed_emails_collection_name(), ALLOWED_EMAILS_COLLECTION_NAME);
    }

    #[test]
    fn parse_requesting_account_as_email_accepts_valid_address() {
        let parsed = parse_requesting_account_as_email("person@example.com".to_string());
        assert!(parsed.is_ok());
        assert_eq!(parsed.unwrap().as_str(), "person@example.com");
    }

    #[test]
    fn parse_requesting_account_as_email_rejects_malformed_address() {
        let parsed = parse_requesting_account_as_email("not-an-email".to_string());
        assert!(matches!(
            parsed,
            Err(HttpError::AuthenticationCredentialsWereInvalid { .. })
        ));
    }

    #[test]
    fn extract_email_string_from_bare_string_document() {
        let document = stored_document_with_body("d1", Value::String("a@b.com".to_string()));
        assert_eq!(
            extract_email_string_from_stored_document(&document),
            Some("a@b.com".to_string())
        );
    }

    #[test]
    fn extract_email_string_from_object_document_email_field() {
        let document = stored_document_with_body("d2", json!({ "email": "c@d.com" }));
        assert_eq!(
            extract_email_string_from_stored_document(&document),
            Some("c@d.com".to_string())
        );
    }

    #[test]
    fn extract_email_string_from_object_document_alternate_field() {
        let document = stored_document_with_body("d3", json!({ "email_address": "e@f.com" }));
        assert_eq!(
            extract_email_string_from_stored_document(&document),
            Some("e@f.com".to_string())
        );
    }

    #[test]
    fn extract_email_string_returns_none_for_unsupported_body() {
        let document = stored_document_with_body("d4", json!({ "unrelated": 42 }));
        assert_eq!(extract_email_string_from_stored_document(&document), None);
        let numeric = stored_document_with_body("d5", json!(7));
        assert_eq!(extract_email_string_from_stored_document(&numeric), None);
    }

    #[test]
    fn parse_stored_email_string_accepts_valid_and_rejects_invalid() {
        assert!(parse_stored_email_string_as_value_object("g@h.com".to_string()).is_some());
        assert!(parse_stored_email_string_as_value_object("garbage".to_string()).is_none());
    }

    #[test]
    fn collect_valid_allowed_emails_filters_invalid_entries() {
        let documents = vec![
            stored_document_with_body("d1", Value::String("valid@one.com".to_string())),
            stored_document_with_body("d2", json!({ "email": "valid@two.com" })),
            stored_document_with_body("d3", Value::String("broken".to_string())),
            stored_document_with_body("d4", json!({ "nope": true })),
        ];
        let collected = collect_valid_allowed_emails_from_documents(documents);
        let collected_strings: Vec<&str> = collected.iter().map(|e| e.as_str()).collect();
        assert_eq!(collected_strings, vec!["valid@one.com", "valid@two.com"]);
    }

    #[test]
    fn append_requesting_account_adds_when_absent() {
        let mut allowed = vec![email("existing@x.com")];
        append_requesting_account_when_absent(&mut allowed, email("new@x.com"));
        assert_eq!(allowed.len(), 2);
    }

    #[test]
    fn append_requesting_account_skips_when_present_case_insensitively() {
        let mut allowed = vec![email("Person@Example.com")];
        append_requesting_account_when_absent(&mut allowed, email("person@example.com"));
        assert_eq!(allowed.len(), 1);
    }

    #[test]
    fn deduplicate_allowed_emails_preserves_first_occurrence_order() {
        let allowed = vec![
            email("first@x.com"),
            email("second@x.com"),
            email("FIRST@x.com"),
            email("third@x.com"),
        ];
        let deduplicated = deduplicate_allowed_emails_preserving_order(allowed);
        let strings: Vec<&str> = deduplicated.iter().map(|e| e.as_str()).collect();
        assert_eq!(strings, vec!["first@x.com", "second@x.com", "third@x.com"]);
    }

    #[test]
    fn sort_allowed_emails_orders_case_insensitively() {
        let mut allowed = vec![email("charlie@x.com"), email("Alice@x.com"), email("bob@x.com")];
        sort_allowed_emails_case_insensitively(&mut allowed);
        let strings: Vec<&str> = allowed.iter().map(|e| e.as_str()).collect();
        // Email::parse normalizes to lowercase, so "Alice@x.com" is stored as "alice@x.com";
        // the ordering is case-insensitive alphabetical.
        assert_eq!(strings, vec!["alice@x.com", "bob@x.com", "charlie@x.com"]);
    }

    #[test]
    fn count_total_allowed_emails_reports_length() {
        let allowed = vec![email("a@x.com"), email("b@x.com")];
        assert_eq!(count_total_allowed_emails(&allowed), 2);
        assert_eq!(count_total_allowed_emails(&[]), 0);
    }

    #[test]
    fn serialize_allowed_email_produces_json_string() {
        let serialized = serialize_allowed_email_to_json_value(&email("z@x.com"));
        assert_eq!(serialized, Value::String("z@x.com".to_string()));
    }

    #[test]
    fn serialize_allowed_emails_collection_maps_all_entries() {
        let allowed = vec![email("a@x.com"), email("b@x.com")];
        let serialized = serialize_allowed_emails_collection(&allowed);
        assert_eq!(
            serialized,
            vec![
                Value::String("a@x.com".to_string()),
                Value::String("b@x.com".to_string()),
            ]
        );
    }

    #[test]
    fn build_response_body_carries_emails_and_count() {
        let serialized = vec![Value::String("a@x.com".to_string())];
        let body = build_allowed_emails_response_body(serialized, 1);
        assert_eq!(body["total_count"], json!(1));
        assert_eq!(body["allowed_emails"], json!(["a@x.com"]));
    }

    #[test]
    fn map_document_collection_failure_not_found_maps_to_404() {
        let mapped = map_document_collection_failure_to_http_error(
            ApplicationError::RequestedResourceCouldNotBeLocated,
        );
        assert!(matches!(mapped, HttpError::RequestedResourceWasNotFound { .. }));
    }

    #[test]
    fn map_document_collection_failure_denied_maps_to_authorization_denied() {
        let mapped = map_document_collection_failure_to_http_error(
            ApplicationError::AuthorizationWasDenied,
        );
        assert!(matches!(mapped, HttpError::AuthorizationWasDenied { .. }));
    }

    #[test]
    fn map_document_collection_failure_other_maps_to_upstream() {
        let mapped = map_document_collection_failure_to_http_error(
            ApplicationError::DocumentCollectionFailure {
                failure_description: "boom".to_string(),
            },
        );
        assert!(matches!(mapped, HttpError::UpstreamApplicationFailure { .. }));
    }
}
