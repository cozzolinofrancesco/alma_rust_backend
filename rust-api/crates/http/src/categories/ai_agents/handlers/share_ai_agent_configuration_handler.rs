use crate::categories::ai_agents::collections::AI_AGENT_EXPORTS_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::error::ApplicationError;
use alma_application::ports::document_collection::StoredDocument;
use alma_application::ports::storage::StorageBlob;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::Email;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};
use uuid::Uuid;

/// Folder within the storage backend used to hold rendered share-notification
/// email bodies until an out-of-band mailer picks them up.
const SHARE_NOTIFICATION_STORAGE_FOLDER: &str = "ai_agent_share_notifications";

/// Base path used to construct the public link a recipient follows to open a
/// shared agent configuration.
const SHARE_ACCESS_LINK_BASE_PATH: &str = "https://alma.app/shared-agents";

#[route(method = "POST", path = "/api/ai-agents/share")]
pub async fn share_ai_agent_configuration_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // 1. Validate & parse the recipient email address.
    let raw_recipient_email = extract_recipient_email_field(&submitted_body)?;
    let recipient_email = parse_recipient_email_into_email_value_object(raw_recipient_email)?;

    // 2. Pull the configuration payload the caller wants to share.
    let shared_configuration_object = extract_shared_configuration_object(&submitted_body)?;
    let shared_agent_display_name =
        extract_shared_agent_display_name(shared_configuration_object)?;
    let share_note_message = extract_optional_share_note_message(&submitted_body);

    // 3. Resolve who is doing the sharing and mint identifiers/tokens.
    let sharing_owner_account =
        resolve_sharing_owner_account_from_authorized_principal(
            authorized_request.authorized_principal().as_str(),
        );
    let share_record_identifier = generate_share_record_identifier();
    let share_access_token = generate_share_access_token();
    let share_access_link = build_share_access_link_from_token(&share_access_token);

    // 4. Persist the share record so the recipient can later resolve the token.
    let share_persistence_body = assemble_share_persistence_body(
        &recipient_email,
        &sharing_owner_account,
        &share_access_token,
        shared_configuration_object,
    );
    let stored_share_document = assemble_stored_share_document(
        share_record_identifier.clone(),
        sharing_owner_account.clone(),
        share_persistence_body,
    );
    application_state
        .document_collection
        .insert_document(AI_AGENT_EXPORTS_COLLECTION_NAME, stored_share_document)
        .await
        .map_err(map_share_persistence_failure_to_http_error)?;

    // 5. Render the notification email and hand it to the storage backend so an
    //    out-of-band mailer can deliver it.
    let share_notification_email_body = build_share_notification_email_body(
        &shared_agent_display_name,
        &share_access_link,
        &share_note_message,
    );
    let share_notification_storage_blob = assemble_share_notification_storage_blob(
        &recipient_email,
        share_notification_email_body,
    );
    application_state
        .storage_adapter
        .persist_blob(share_notification_storage_blob)
        .await
        .map_err(map_share_persistence_failure_to_http_error)?;

    // 6. Report success back to the caller.
    let response_payload = assemble_share_success_response_payload(
        &recipient_email,
        &share_access_link,
        &share_record_identifier,
    );
    Ok(Json(response_payload))
}

/// (1) Extract the mandatory `recipient_email` string field from the request body.
fn extract_recipient_email_field(submitted_body: &Value) -> Result<String, HttpError> {
    submitted_body
        .get("recipient_email")
        .and_then(|candidate_value| candidate_value.as_str())
        .map(|found_value| found_value.trim().to_string())
        .filter(|trimmed_value| !trimmed_value.is_empty())
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: String::from("the 'recipient_email' field is required"),
        })
}

/// (2) Parse the raw recipient email string into a validated `Email` value object.
fn parse_recipient_email_into_email_value_object(
    raw_recipient_email: String,
) -> Result<Email, HttpError> {
    Email::parse(raw_recipient_email).map_err(|domain_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: domain_error.to_string(),
        }
    })
}

/// (3) Extract the `shared_configuration` object that carries the agent payload.
fn extract_shared_configuration_object(submitted_body: &Value) -> Result<&Value, HttpError> {
    submitted_body
        .get("shared_configuration")
        .filter(|candidate_value| candidate_value.is_object())
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: String::from(
                "the 'shared_configuration' object field is required",
            ),
        })
}

/// (4) Pull the human-readable display name for the shared agent.
fn extract_shared_agent_display_name(
    shared_configuration_object: &Value,
) -> Result<String, HttpError> {
    shared_configuration_object
        .get("display_name")
        .and_then(|candidate_value| candidate_value.as_str())
        .map(|found_value| found_value.trim().to_string())
        .filter(|trimmed_value| !trimmed_value.is_empty())
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: String::from(
                "the shared configuration requires a non-empty 'display_name'",
            ),
        })
}

/// (5) Extract the optional free-text note accompanying the share.
fn extract_optional_share_note_message(submitted_body: &Value) -> String {
    submitted_body
        .get("note")
        .and_then(|candidate_value| candidate_value.as_str())
        .map(|found_value| found_value.trim().to_string())
        .unwrap_or_default()
}

/// (6) Derive the owning account for the share record from the authorized principal.
fn resolve_sharing_owner_account_from_authorized_principal(authorized_principal: &str) -> String {
    let normalized_principal = authorized_principal.trim().to_lowercase();
    if normalized_principal.is_empty() {
        String::from("unknown-principal")
    } else {
        normalized_principal
    }
}

/// (7) Generate a stable identifier for the persisted share record.
fn generate_share_record_identifier() -> String {
    format!("agent-share-{}", Uuid::new_v4())
}

/// (8) Generate an opaque, hard-to-guess access token for the share link.
fn generate_share_access_token() -> String {
    Uuid::new_v4().simple().to_string()
}

/// (9) Build the public access link the recipient follows, from the access token.
fn build_share_access_link_from_token(share_access_token: &str) -> String {
    format!("{SHARE_ACCESS_LINK_BASE_PATH}/{share_access_token}")
}

/// (10) Assemble the JSON body persisted alongside the share record.
fn assemble_share_persistence_body(
    recipient_email: &Email,
    sharing_owner_account: &str,
    share_access_token: &str,
    shared_configuration_object: &Value,
) -> Value {
    json!({
        "recipient_email": recipient_email.as_str(),
        "sharing_owner_account": sharing_owner_account,
        "share_access_token": share_access_token,
        "shared_configuration": shared_configuration_object.clone(),
        "share_status": "pending",
    })
}

/// (11) Wrap the persistence body into a `StoredDocument` for the collection port.
fn assemble_stored_share_document(
    share_record_identifier: String,
    sharing_owner_account: String,
    share_persistence_body: Value,
) -> StoredDocument {
    StoredDocument {
        document_identifier: share_record_identifier,
        owning_account: Some(sharing_owner_account),
        document_body: share_persistence_body,
    }
}

/// (12) Render the plain-text notification email body sent to the recipient.
fn build_share_notification_email_body(
    shared_agent_display_name: &str,
    share_access_link: &str,
    share_note_message: &str,
) -> String {
    let mut rendered_body = String::new();
    rendered_body.push_str("Hello,\n\n");
    rendered_body.push_str(&format!(
        "You have been invited to view the shared AI agent \"{shared_agent_display_name}\".\n\n"
    ));
    rendered_body.push_str(&format!("Open it here: {share_access_link}\n"));
    if !share_note_message.is_empty() {
        rendered_body.push_str(&format!("\nPersonal note: {share_note_message}\n"));
    }
    rendered_body.push_str("\nRegards,\nThe Alma team\n");
    rendered_body
}

/// (13) Build the storage blob holding the rendered notification email body.
fn assemble_share_notification_storage_blob(
    recipient_email: &Email,
    share_notification_email_body: String,
) -> StorageBlob {
    let declared_name = format!("{}.eml", sanitize_email_for_file_name(recipient_email));
    StorageBlob {
        containing_folder: SHARE_NOTIFICATION_STORAGE_FOLDER.to_string(),
        declared_name,
        raw_bytes: share_notification_email_body.into_bytes(),
    }
}

/// (14) Translate a persistence-layer failure into the appropriate HTTP error.
fn map_share_persistence_failure_to_http_error(
    originating_application_error: ApplicationError,
) -> HttpError {
    HttpError::UpstreamApplicationFailure {
        explanation: format!(
            "failed to persist the agent share notification: {originating_application_error}"
        ),
    }
}

/// (15) Assemble the success response payload returned to the API caller.
fn assemble_share_success_response_payload(
    recipient_email: &Email,
    share_access_link: &str,
    share_record_identifier: &str,
) -> Value {
    json!({
        "success": true,
        "message": "Share notification queued",
        "recipient_email": recipient_email.as_str(),
        "share_access_link": share_access_link,
        "share_record_identifier": share_record_identifier,
    })
}

/// Turn an email address into a filesystem-safe file-name component. Non
/// alphanumeric characters (other than the common `.`, `-`, `_`) become `_`.
fn sanitize_email_for_file_name(recipient_email: &Email) -> String {
    recipient_email
        .as_str()
        .chars()
        .map(|current_character| {
            if current_character.is_ascii_alphanumeric()
                || matches!(current_character, '.' | '-' | '_')
            {
                current_character
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_recipient_email_field_returns_trimmed_value_when_present() {
        let submitted_body = json!({ "recipient_email": "  friend@example.com  " });
        let extracted = extract_recipient_email_field(&submitted_body).unwrap();
        assert_eq!(extracted, "friend@example.com");
    }

    #[test]
    fn extract_recipient_email_field_rejects_missing_or_blank_value() {
        assert!(extract_recipient_email_field(&json!({})).is_err());
        assert!(extract_recipient_email_field(&json!({ "recipient_email": "   " })).is_err());
    }

    #[test]
    fn parse_recipient_email_accepts_valid_and_rejects_invalid() {
        assert!(
            parse_recipient_email_into_email_value_object("valid@example.com".to_string())
                .is_ok()
        );
        assert!(
            parse_recipient_email_into_email_value_object("not-an-email".to_string()).is_err()
        );
    }

    #[test]
    fn extract_shared_configuration_object_requires_an_object() {
        let good_body = json!({ "shared_configuration": { "display_name": "Agent" } });
        assert!(extract_shared_configuration_object(&good_body).is_ok());

        let bad_body = json!({ "shared_configuration": "oops" });
        assert!(extract_shared_configuration_object(&bad_body).is_err());
        assert!(extract_shared_configuration_object(&json!({})).is_err());
    }

    #[test]
    fn extract_shared_agent_display_name_handles_present_and_missing() {
        let good = json!({ "display_name": "  Research Buddy  " });
        assert_eq!(
            extract_shared_agent_display_name(&good).unwrap(),
            "Research Buddy"
        );
        assert!(extract_shared_agent_display_name(&json!({})).is_err());
        assert!(extract_shared_agent_display_name(&json!({ "display_name": "" })).is_err());
    }

    #[test]
    fn extract_optional_share_note_message_defaults_to_empty() {
        assert_eq!(extract_optional_share_note_message(&json!({})), "");
        assert_eq!(
            extract_optional_share_note_message(&json!({ "note": "  hi  " })),
            "hi"
        );
    }

    #[test]
    fn resolve_sharing_owner_account_normalizes_and_falls_back() {
        assert_eq!(
            resolve_sharing_owner_account_from_authorized_principal("  User@Example.COM "),
            "user@example.com"
        );
        assert_eq!(
            resolve_sharing_owner_account_from_authorized_principal("   "),
            "unknown-principal"
        );
    }

    #[test]
    fn generate_share_record_identifier_is_prefixed_and_unique() {
        let first = generate_share_record_identifier();
        let second = generate_share_record_identifier();
        assert!(first.starts_with("agent-share-"));
        assert_ne!(first, second);
    }

    #[test]
    fn generate_share_access_token_is_non_empty_and_unique() {
        let first = generate_share_access_token();
        let second = generate_share_access_token();
        assert!(!first.is_empty());
        assert_ne!(first, second);
    }

    #[test]
    fn build_share_access_link_embeds_token() {
        let link = build_share_access_link_from_token("abc123");
        assert_eq!(link, "https://alma.app/shared-agents/abc123");
    }

    #[test]
    fn assemble_share_persistence_body_contains_expected_fields() {
        let email = Email::parse("friend@example.com".to_string()).unwrap();
        let config = json!({ "display_name": "Agent", "steps": [] });
        let body = assemble_share_persistence_body(&email, "owner@example.com", "tok", &config);
        assert_eq!(body["recipient_email"], "friend@example.com");
        assert_eq!(body["sharing_owner_account"], "owner@example.com");
        assert_eq!(body["share_access_token"], "tok");
        assert_eq!(body["share_status"], "pending");
        assert_eq!(body["shared_configuration"]["display_name"], "Agent");
    }

    #[test]
    fn assemble_stored_share_document_maps_fields() {
        let body = json!({ "k": "v" });
        let document = assemble_stored_share_document(
            "id-1".to_string(),
            "owner".to_string(),
            body.clone(),
        );
        assert_eq!(document.document_identifier, "id-1");
        assert_eq!(document.owning_account, Some("owner".to_string()));
        assert_eq!(document.document_body, body);
    }

    #[test]
    fn build_share_notification_email_body_includes_link_and_optional_note() {
        let with_note =
            build_share_notification_email_body("My Agent", "https://link", "check this out");
        assert!(with_note.contains("My Agent"));
        assert!(with_note.contains("https://link"));
        assert!(with_note.contains("check this out"));

        let without_note = build_share_notification_email_body("My Agent", "https://link", "");
        assert!(!without_note.contains("Personal note"));
    }

    #[test]
    fn assemble_share_notification_storage_blob_uses_sanitized_name() {
        let email = Email::parse("friend@example.com".to_string()).unwrap();
        let blob = assemble_share_notification_storage_blob(&email, "body".to_string());
        assert_eq!(blob.containing_folder, SHARE_NOTIFICATION_STORAGE_FOLDER);
        assert_eq!(blob.declared_name, "friend_example.com.eml");
        assert_eq!(blob.raw_bytes, b"body".to_vec());
    }

    #[test]
    fn map_share_persistence_failure_produces_upstream_failure() {
        let mapped = map_share_persistence_failure_to_http_error(
            ApplicationError::StorageAdapterFailure {
                failure_description: "boom".to_string(),
            },
        );
        match mapped {
            HttpError::UpstreamApplicationFailure { explanation } => {
                assert!(explanation.contains("boom"));
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn assemble_share_success_response_payload_reports_details() {
        let email = Email::parse("friend@example.com".to_string()).unwrap();
        let payload =
            assemble_share_success_response_payload(&email, "https://link", "rec-1");
        assert_eq!(payload["success"], true);
        assert_eq!(payload["recipient_email"], "friend@example.com");
        assert_eq!(payload["share_access_link"], "https://link");
        assert_eq!(payload["share_record_identifier"], "rec-1");
    }

    #[test]
    fn sanitize_email_for_file_name_replaces_unsafe_characters() {
        let email = Email::parse("a+b@x.com".to_string()).unwrap();
        let sanitized = sanitize_email_for_file_name(&email);
        assert_eq!(sanitized, "a_b_x.com");
    }
}
