use crate::categories::templates_policy::collections::DRAFTING_TEMPLATES_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::error::ApplicationError;
use alma_application::ports::document_collection::{DocumentCollectionPort, StoredDocument};
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::error::DomainError;
use alma_domain::value_objects::{Email, NonEmptyText};
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};
use uuid::Uuid;

/// Create a new drafting template. A drafting template captures a reusable
/// document skeleton (name + body text) plus optional metadata (a human-facing
/// description and a set of placeholder tokens that must appear inside the body).
#[route(method = "POST", path = "/api/templates/drafting-templates")]
pub async fn create_drafting_template_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // 1. Pull the raw fields out of the submitted JSON body.
    let raw_template_name = extract_required_template_name_field(&submitted_body)?;
    let raw_template_body = extract_required_template_body_field(&submitted_body)?;
    let optional_description = extract_optional_template_description_field(&submitted_body);
    let placeholder_tokens = extract_optional_placeholder_token_list(&submitted_body)?;

    // 2. Parse the mandatory text fields into validated domain value objects.
    let parsed_template_name = parse_template_name_into_non_empty_text(raw_template_name)?;
    let parsed_template_body = parse_template_body_into_non_empty_text(raw_template_body)?;

    // 3. Enforce the cross-field invariant: every declared placeholder token
    //    must actually appear somewhere within the template body.
    validate_placeholder_tokens_present_in_body(
        parsed_template_body.as_str(),
        &placeholder_tokens,
    )?;

    // 4. Assemble the persisted representation.
    let generated_identifier = generate_drafting_template_identifier();
    let owning_account = resolve_owning_account_from_principal(
        authorized_request.authorized_principal(),
    );
    let document_body = assemble_drafting_template_document_body(
        &parsed_template_name,
        &parsed_template_body,
        optional_description.as_deref(),
        &placeholder_tokens,
    );
    let document_to_insert = build_drafting_template_stored_document(
        generated_identifier.clone(),
        owning_account,
        document_body,
    );

    // 5. Persist and respond.
    persist_drafting_template_document(
        application_state.document_collection.as_ref(),
        document_to_insert,
    )
    .await?;

    Ok(Json(build_drafting_template_creation_response(
        &generated_identifier,
    )))
}

/// (1) Extract the mandatory `template_name` string field.
fn extract_required_template_name_field(submitted_body: &Value) -> Result<String, HttpError> {
    let field_value = submitted_body.get("template_name").ok_or_else(|| {
        HttpError::RequestBodyWasMalformed {
            explanation: "the field 'template_name' is required".to_string(),
        }
    })?;
    let text = field_value.as_str().ok_or_else(|| HttpError::RequestBodyWasMalformed {
        explanation: "the field 'template_name' must be a string".to_string(),
    })?;
    Ok(text.to_string())
}

/// (2) Extract the mandatory `template_body` string field.
fn extract_required_template_body_field(submitted_body: &Value) -> Result<String, HttpError> {
    let field_value = submitted_body.get("template_body").ok_or_else(|| {
        HttpError::RequestBodyWasMalformed {
            explanation: "the field 'template_body' is required".to_string(),
        }
    })?;
    let text = field_value.as_str().ok_or_else(|| HttpError::RequestBodyWasMalformed {
        explanation: "the field 'template_body' must be a string".to_string(),
    })?;
    Ok(text.to_string())
}

/// (3) Extract the optional `description` field. Blank / whitespace-only values
/// are treated as absent so we never store an empty description.
fn extract_optional_template_description_field(submitted_body: &Value) -> Option<String> {
    submitted_body
        .get("description")
        .and_then(|value| value.as_str())
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

/// (4) Extract the optional `placeholder_tokens` array. When present it must be
/// an array of non-blank strings; blank entries are rejected as malformed.
fn extract_optional_placeholder_token_list(
    submitted_body: &Value,
) -> Result<Vec<String>, HttpError> {
    let field_value = match submitted_body.get("placeholder_tokens") {
        None => return Ok(Vec::new()),
        Some(Value::Null) => return Ok(Vec::new()),
        Some(value) => value,
    };
    let array = field_value.as_array().ok_or_else(|| HttpError::RequestBodyWasMalformed {
        explanation: "the field 'placeholder_tokens' must be an array of strings".to_string(),
    })?;
    let mut collected_tokens: Vec<String> = Vec::with_capacity(array.len());
    for entry in array {
        let token = entry.as_str().ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: "every entry in 'placeholder_tokens' must be a string".to_string(),
        })?;
        let trimmed = token.trim();
        if trimmed.is_empty() {
            return Err(HttpError::RequestBodyWasMalformed {
                explanation: "'placeholder_tokens' may not contain blank entries".to_string(),
            });
        }
        collected_tokens.push(trimmed.to_string());
    }
    Ok(collected_tokens)
}

/// (5) Parse the template name into a validated `NonEmptyText`.
fn parse_template_name_into_non_empty_text(
    template_name: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(template_name).map_err(map_domain_parse_failure_to_malformed_body)
}

/// (6) Parse the template body into a validated `NonEmptyText`.
fn parse_template_body_into_non_empty_text(
    template_body: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(template_body).map_err(map_domain_parse_failure_to_malformed_body)
}

/// (7) Confirm every declared placeholder token is present in the body text.
fn validate_placeholder_tokens_present_in_body(
    template_body: &str,
    placeholder_tokens: &[String],
) -> Result<(), HttpError> {
    for token in placeholder_tokens {
        if !template_body.contains(token.as_str()) {
            return Err(HttpError::RequestBodyWasMalformed {
                explanation: format!(
                    "the placeholder token '{token}' does not appear in the template body"
                ),
            });
        }
    }
    Ok(())
}

/// (8) Generate a fresh, unique identifier for the drafting template.
fn generate_drafting_template_identifier() -> String {
    Uuid::new_v4().to_string()
}

/// (9) Resolve the owning account string from the authenticated principal.
fn resolve_owning_account_from_principal(authorized_principal: &Email) -> String {
    authorized_principal.as_str().to_string()
}

/// (10) Translate a domain parsing failure into a malformed-body HTTP error.
fn map_domain_parse_failure_to_malformed_body(parsing_failure: DomainError) -> HttpError {
    HttpError::RequestBodyWasMalformed {
        explanation: parsing_failure.to_string(),
    }
}

/// (11) Assemble the canonical JSON body that gets persisted for the template.
fn assemble_drafting_template_document_body(
    template_name: &NonEmptyText,
    template_body: &NonEmptyText,
    description: Option<&str>,
    placeholder_tokens: &[String],
) -> Value {
    json!({
        "template_name": template_name.as_str(),
        "template_body": template_body.as_str(),
        "description": description,
        "placeholder_tokens": placeholder_tokens,
        "template_kind": "drafting_template",
    })
}

/// (12) Build the `StoredDocument` wrapper for persistence.
fn build_drafting_template_stored_document(
    document_identifier: String,
    owning_account: String,
    document_body: Value,
) -> StoredDocument {
    StoredDocument {
        document_identifier,
        owning_account: Some(owning_account),
        document_body,
    }
}

/// (13) Persist the assembled document via the document-collection port.
async fn persist_drafting_template_document<C: DocumentCollectionPort + ?Sized>(
    collection: &C,
    document_to_insert: StoredDocument,
) -> Result<(), HttpError> {
    collection
        .insert_document(DRAFTING_TEMPLATES_COLLECTION_NAME, document_to_insert)
        .await
        .map_err(map_application_error_to_http_error)
}

/// (14) Build the success response payload.
fn build_drafting_template_creation_response(generated_identifier: &str) -> Value {
    json!({
        "document_identifier": generated_identifier,
        "acknowledgement": "drafting template created",
    })
}

/// (15) Map an application-layer error onto the appropriate HTTP error variant.
fn map_application_error_to_http_error(application_error: ApplicationError) -> HttpError {
    match application_error {
        ApplicationError::DomainInvariantViolated(domain_error) => {
            HttpError::RequestBodyWasMalformed {
                explanation: domain_error.to_string(),
            }
        }
        ApplicationError::AuthorizationWasDenied => HttpError::AuthorizationWasDenied {
            explanation: "the authenticated principal may not create this template".to_string(),
        },
        ApplicationError::RequestedResourceCouldNotBeLocated
        | ApplicationError::RequestedProjectCouldNotBeLocated => {
            HttpError::RequestedResourceWasNotFound {
                explanation: "a required resource could not be located".to_string(),
            }
        }
        other_failure => HttpError::UpstreamApplicationFailure {
            explanation: other_failure.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_required_template_name_field_accepts_valid_string() {
        let body = json!({ "template_name": "Systematic Review" });
        let result = extract_required_template_name_field(&body).unwrap();
        assert_eq!(result, "Systematic Review");
    }

    #[test]
    fn extract_required_template_name_field_rejects_missing_field() {
        let body = json!({ "template_body": "content" });
        assert!(extract_required_template_name_field(&body).is_err());
    }

    #[test]
    fn extract_required_template_name_field_rejects_non_string() {
        let body = json!({ "template_name": 42 });
        assert!(extract_required_template_name_field(&body).is_err());
    }

    #[test]
    fn extract_required_template_body_field_accepts_valid_string() {
        let body = json!({ "template_body": "Hello {{name}}" });
        let result = extract_required_template_body_field(&body).unwrap();
        assert_eq!(result, "Hello {{name}}");
    }

    #[test]
    fn extract_required_template_body_field_rejects_missing_field() {
        let body = json!({ "template_name": "x" });
        assert!(extract_required_template_body_field(&body).is_err());
    }

    #[test]
    fn extract_optional_template_description_field_returns_trimmed_value() {
        let body = json!({ "description": "  a helpful note  " });
        assert_eq!(
            extract_optional_template_description_field(&body),
            Some("a helpful note".to_string())
        );
    }

    #[test]
    fn extract_optional_template_description_field_treats_blank_as_absent() {
        let body = json!({ "description": "   " });
        assert_eq!(extract_optional_template_description_field(&body), None);
    }

    #[test]
    fn extract_optional_template_description_field_absent_when_missing() {
        let body = json!({});
        assert_eq!(extract_optional_template_description_field(&body), None);
    }

    #[test]
    fn extract_optional_placeholder_token_list_defaults_to_empty() {
        let body = json!({});
        assert_eq!(
            extract_optional_placeholder_token_list(&body).unwrap(),
            Vec::<String>::new()
        );
    }

    #[test]
    fn extract_optional_placeholder_token_list_parses_and_trims() {
        let body = json!({ "placeholder_tokens": [" {{name}} ", "{{date}}"] });
        assert_eq!(
            extract_optional_placeholder_token_list(&body).unwrap(),
            vec!["{{name}}".to_string(), "{{date}}".to_string()]
        );
    }

    #[test]
    fn extract_optional_placeholder_token_list_rejects_non_array() {
        let body = json!({ "placeholder_tokens": "not-an-array" });
        assert!(extract_optional_placeholder_token_list(&body).is_err());
    }

    #[test]
    fn extract_optional_placeholder_token_list_rejects_blank_entry() {
        let body = json!({ "placeholder_tokens": ["{{ok}}", "   "] });
        assert!(extract_optional_placeholder_token_list(&body).is_err());
    }

    #[test]
    fn extract_optional_placeholder_token_list_rejects_non_string_entry() {
        let body = json!({ "placeholder_tokens": [1, 2] });
        assert!(extract_optional_placeholder_token_list(&body).is_err());
    }

    #[test]
    fn parse_template_name_into_non_empty_text_accepts_valid() {
        let parsed = parse_template_name_into_non_empty_text("Grant Proposal".to_string()).unwrap();
        assert_eq!(parsed.as_str(), "Grant Proposal");
    }

    #[test]
    fn parse_template_name_into_non_empty_text_rejects_blank() {
        assert!(parse_template_name_into_non_empty_text("   ".to_string()).is_err());
    }

    #[test]
    fn parse_template_body_into_non_empty_text_accepts_valid() {
        let parsed = parse_template_body_into_non_empty_text("body".to_string()).unwrap();
        assert_eq!(parsed.as_str(), "body");
    }

    #[test]
    fn parse_template_body_into_non_empty_text_rejects_blank() {
        assert!(parse_template_body_into_non_empty_text("".to_string()).is_err());
    }

    #[test]
    fn validate_placeholder_tokens_present_in_body_passes_when_all_present() {
        let body = "Dear {{name}}, dated {{date}}.";
        let tokens = vec!["{{name}}".to_string(), "{{date}}".to_string()];
        assert!(validate_placeholder_tokens_present_in_body(body, &tokens).is_ok());
    }

    #[test]
    fn validate_placeholder_tokens_present_in_body_fails_when_missing() {
        let body = "Dear {{name}}.";
        let tokens = vec!["{{date}}".to_string()];
        assert!(validate_placeholder_tokens_present_in_body(body, &tokens).is_err());
    }

    #[test]
    fn validate_placeholder_tokens_present_in_body_passes_with_no_tokens() {
        assert!(validate_placeholder_tokens_present_in_body("anything", &[]).is_ok());
    }

    #[test]
    fn generate_drafting_template_identifier_produces_unique_values() {
        let first = generate_drafting_template_identifier();
        let second = generate_drafting_template_identifier();
        assert_ne!(first, second);
        assert_eq!(first.len(), 36);
    }

    #[test]
    fn resolve_owning_account_from_principal_returns_email_string() {
        let principal = Email::parse("author@example.com".to_string()).unwrap();
        assert_eq!(
            resolve_owning_account_from_principal(&principal),
            "author@example.com"
        );
    }

    #[test]
    fn map_domain_parse_failure_to_malformed_body_produces_malformed_variant() {
        let failure = NonEmptyText::parse("".to_string()).unwrap_err();
        let http_error = map_domain_parse_failure_to_malformed_body(failure);
        assert!(matches!(
            http_error,
            HttpError::RequestBodyWasMalformed { .. }
        ));
    }

    #[test]
    fn assemble_drafting_template_document_body_includes_all_fields() {
        let name = NonEmptyText::parse("Name".to_string()).unwrap();
        let body = NonEmptyText::parse("Body {{x}}".to_string()).unwrap();
        let tokens = vec!["{{x}}".to_string()];
        let assembled =
            assemble_drafting_template_document_body(&name, &body, Some("desc"), &tokens);
        assert_eq!(assembled["template_name"], "Name");
        assert_eq!(assembled["template_body"], "Body {{x}}");
        assert_eq!(assembled["description"], "desc");
        assert_eq!(assembled["placeholder_tokens"][0], "{{x}}");
        assert_eq!(assembled["template_kind"], "drafting_template");
    }

    #[test]
    fn assemble_drafting_template_document_body_handles_absent_description() {
        let name = NonEmptyText::parse("Name".to_string()).unwrap();
        let body = NonEmptyText::parse("Body".to_string()).unwrap();
        let assembled = assemble_drafting_template_document_body(&name, &body, None, &[]);
        assert!(assembled["description"].is_null());
    }

    #[test]
    fn build_drafting_template_stored_document_wraps_fields() {
        let document = build_drafting_template_stored_document(
            "id-123".to_string(),
            "owner@example.com".to_string(),
            json!({ "k": "v" }),
        );
        assert_eq!(document.document_identifier, "id-123");
        assert_eq!(document.owning_account, Some("owner@example.com".to_string()));
        assert_eq!(document.document_body["k"], "v");
    }

    #[test]
    fn build_drafting_template_creation_response_contains_identifier() {
        let response = build_drafting_template_creation_response("id-xyz");
        assert_eq!(response["document_identifier"], "id-xyz");
        assert_eq!(response["acknowledgement"], "drafting template created");
    }

    #[test]
    fn map_application_error_to_http_error_maps_domain_invariant() {
        let domain_error = NonEmptyText::parse("".to_string()).unwrap_err();
        let mapped = map_application_error_to_http_error(
            ApplicationError::DomainInvariantViolated(domain_error),
        );
        assert!(matches!(mapped, HttpError::RequestBodyWasMalformed { .. }));
    }

    #[test]
    fn map_application_error_to_http_error_maps_authorization_denied() {
        let mapped = map_application_error_to_http_error(ApplicationError::AuthorizationWasDenied);
        assert!(matches!(mapped, HttpError::AuthorizationWasDenied { .. }));
    }

    #[test]
    fn map_application_error_to_http_error_maps_not_found() {
        let mapped = map_application_error_to_http_error(
            ApplicationError::RequestedResourceCouldNotBeLocated,
        );
        assert!(matches!(mapped, HttpError::RequestedResourceWasNotFound { .. }));
    }

    #[test]
    fn map_application_error_to_http_error_maps_generic_failure() {
        let mapped = map_application_error_to_http_error(
            ApplicationError::DocumentCollectionFailure {
                failure_description: "boom".to_string(),
            },
        );
        assert!(matches!(mapped, HttpError::UpstreamApplicationFailure { .. }));
    }
}
