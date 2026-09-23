use crate::categories::templates_policy::collections::STUDY_TYPE_TEMPLATES_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::ports::document_collection::{DocumentCollectionPort, StoredDocument};
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::error::DomainError;
use alma_domain::value_objects::{Email, NonEmptyText};
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};
use uuid::Uuid;

/// Create a new study-type template.
///
/// A study-type template describes the skeleton of a particular kind of study
/// (e.g. "Randomised Controlled Trial", "Case Report") as an ordered list of
/// named sections. Callers submit a JSON body of the shape:
///
/// ```json
/// {
///   "study_type_name": "Randomised Controlled Trial",
///   "study_type_description": "Optional prose describing the type",
///   "section_outline": [
///     { "heading": "Background" },
///     { "heading": "Methods" }
///   ]
/// }
/// ```
///
/// The submitted body is validated, normalised and persisted as a document in
/// the study-type templates collection, owned by the authenticated principal.
#[route(method = "POST", path = "/api/templates/study-types")]
pub async fn create_study_type_template_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // 1. Extract and validate the required study-type name.
    let raw_study_type_name = extract_required_study_type_name_field(&submitted_body)?;
    let study_type_name = parse_study_type_name_into_non_empty_text(raw_study_type_name)?;

    // 2. Extract and validate the required section outline.
    let raw_section_outline = extract_required_section_outline_array(&submitted_body)?;
    validate_section_outline_is_non_empty(&raw_section_outline)?;

    // 3. Ensure every outline entry has a heading and that headings are unique.
    let mut section_headings: Vec<String> = Vec::with_capacity(raw_section_outline.len());
    for outline_entry in &raw_section_outline {
        section_headings.push(extract_section_heading_from_outline_entry(outline_entry)?);
    }
    reject_duplicate_section_headings(&section_headings)?;

    // 4. Extract the optional free-form description.
    let optional_description = extract_optional_study_type_description_field(&submitted_body);

    // 5. Normalise the outline entries into a canonical shape.
    let normalized_outline = normalize_section_outline_entries(raw_section_outline);

    // 6. Assemble the persisted document body.
    let document_body = assemble_study_type_template_document_body(
        &study_type_name,
        &normalized_outline,
        optional_description.as_deref(),
    );

    // 7. Resolve ownership and identifier, then build and persist the document.
    let owning_account = resolve_owning_account_from_principal(authorized_request.authorized_principal());
    let generated_identifier = generate_study_type_template_identifier();
    let document_to_insert = build_study_type_template_stored_document(
        generated_identifier.clone(),
        owning_account,
        document_body,
    );

    persist_study_type_template_document(
        application_state.document_collection.as_ref(),
        document_to_insert,
    )
    .await?;

    // 8. Report success back to the caller.
    Ok(Json(build_study_type_template_creation_response(
        &generated_identifier,
    )))
}

/// (1) Extract the mandatory `study_type_name` string field from the body.
fn extract_required_study_type_name_field(submitted_body: &Value) -> Result<String, HttpError> {
    match submitted_body.get("study_type_name") {
        Some(Value::String(study_type_name)) => Ok(study_type_name.clone()),
        Some(_) => Err(HttpError::RequestBodyWasMalformed {
            explanation: "field 'study_type_name' must be a string".to_string(),
        }),
        None => Err(HttpError::RequestBodyWasMalformed {
            explanation: "field 'study_type_name' is required".to_string(),
        }),
    }
}

/// (2) Extract the mandatory `section_outline` array field from the body.
fn extract_required_section_outline_array(submitted_body: &Value) -> Result<Vec<Value>, HttpError> {
    match submitted_body.get("section_outline") {
        Some(Value::Array(section_outline)) => Ok(section_outline.clone()),
        Some(_) => Err(HttpError::RequestBodyWasMalformed {
            explanation: "field 'section_outline' must be an array".to_string(),
        }),
        None => Err(HttpError::RequestBodyWasMalformed {
            explanation: "field 'section_outline' is required".to_string(),
        }),
    }
}

/// (3) Extract the optional `study_type_description` field. A missing field,
/// null, non-string value, or an all-whitespace string all yield `None`.
fn extract_optional_study_type_description_field(submitted_body: &Value) -> Option<String> {
    match submitted_body.get("study_type_description") {
        Some(Value::String(description)) => {
            let trimmed = description.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        _ => None,
    }
}

/// (4) Parse a raw study-type name into a validated `NonEmptyText`.
fn parse_study_type_name_into_non_empty_text(
    study_type_name: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(study_type_name).map_err(map_domain_parse_failure_to_malformed_body)
}

/// (5) Extract a non-empty `heading` string from a single outline entry.
fn extract_section_heading_from_outline_entry(outline_entry: &Value) -> Result<String, HttpError> {
    match outline_entry.get("heading") {
        Some(Value::String(heading)) => {
            let trimmed = heading.trim();
            if trimmed.is_empty() {
                Err(HttpError::RequestBodyWasMalformed {
                    explanation: "each section outline entry must have a non-empty 'heading'"
                        .to_string(),
                })
            } else {
                Ok(trimmed.to_string())
            }
        }
        Some(_) => Err(HttpError::RequestBodyWasMalformed {
            explanation: "section outline entry 'heading' must be a string".to_string(),
        }),
        None => Err(HttpError::RequestBodyWasMalformed {
            explanation: "each section outline entry must contain a 'heading' field".to_string(),
        }),
    }
}

/// (6) Ensure the section outline contains at least one entry.
fn validate_section_outline_is_non_empty(section_outline: &[Value]) -> Result<(), HttpError> {
    if section_outline.is_empty() {
        Err(HttpError::RequestBodyWasMalformed {
            explanation: "field 'section_outline' must contain at least one section".to_string(),
        })
    } else {
        Ok(())
    }
}

/// (7) Reject the request if two sections share the same heading, comparing
/// case-insensitively so that "Methods" and "methods" are treated as a clash.
fn reject_duplicate_section_headings(section_headings: &[String]) -> Result<(), HttpError> {
    let mut seen_headings: Vec<String> = Vec::with_capacity(section_headings.len());
    for heading in section_headings {
        let canonical = heading.to_lowercase();
        if seen_headings.contains(&canonical) {
            return Err(HttpError::RequestBodyWasMalformed {
                explanation: format!("duplicate section heading '{heading}' is not permitted"),
            });
        }
        seen_headings.push(canonical);
    }
    Ok(())
}

/// (8) Generate a fresh unique identifier for a study-type template.
fn generate_study_type_template_identifier() -> String {
    Uuid::new_v4().to_string()
}

/// (9) Resolve the owning account string from the authenticated principal.
fn resolve_owning_account_from_principal(authorized_principal: &Email) -> String {
    authorized_principal.as_str().to_string()
}

/// (10) Map a domain-layer parse failure onto a malformed-body HTTP error.
fn map_domain_parse_failure_to_malformed_body(parsing_failure: DomainError) -> HttpError {
    HttpError::RequestBodyWasMalformed {
        explanation: parsing_failure.to_string(),
    }
}

/// (11) Normalise outline entries into a canonical `{ "heading", "position" }`
/// shape, preserving any additional caller-supplied guidance if present.
fn normalize_section_outline_entries(section_outline: Vec<Value>) -> Vec<Value> {
    section_outline
        .into_iter()
        .enumerate()
        .filter_map(|(index, outline_entry)| {
            let heading = outline_entry
                .get("heading")
                .and_then(Value::as_str)
                .map(|value| value.trim().to_string())?;
            if heading.is_empty() {
                return None;
            }
            let mut normalized_entry = json!({
                "heading": heading,
                "position": index,
            });
            if let Some(guidance) = outline_entry.get("guidance").and_then(Value::as_str) {
                let trimmed_guidance = guidance.trim();
                if !trimmed_guidance.is_empty() {
                    normalized_entry["guidance"] = json!(trimmed_guidance);
                }
            }
            Some(normalized_entry)
        })
        .collect()
}

/// (12) Assemble the JSON document body persisted for the template.
fn assemble_study_type_template_document_body(
    study_type_name: &NonEmptyText,
    section_outline: &[Value],
    description: Option<&str>,
) -> Value {
    let mut document_body = json!({
        "study_type_name": study_type_name.as_str(),
        "section_outline": section_outline,
        "section_count": section_outline.len(),
        "template_kind": "study_type",
    });
    if let Some(description_text) = description {
        document_body["study_type_description"] = json!(description_text);
    }
    document_body
}

/// (13) Build the `StoredDocument` wrapper for persistence.
fn build_study_type_template_stored_document(
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

/// (14) Persist the study-type template document into its collection.
async fn persist_study_type_template_document<C: DocumentCollectionPort + ?Sized>(
    collection: &C,
    document_to_insert: StoredDocument,
) -> Result<(), HttpError> {
    collection
        .insert_document(STUDY_TYPE_TEMPLATES_COLLECTION_NAME, document_to_insert)
        .await?;
    Ok(())
}

/// (15) Build the success response returned to the caller.
fn build_study_type_template_creation_response(generated_identifier: &str) -> Value {
    json!({
        "document_identifier": generated_identifier,
        "acknowledgement": "study type template created",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_required_study_type_name_field_accepts_string() {
        let body = json!({ "study_type_name": "Case Report" });
        let extracted = extract_required_study_type_name_field(&body).unwrap();
        assert_eq!(extracted, "Case Report");
    }

    #[test]
    fn extract_required_study_type_name_field_rejects_missing() {
        let body = json!({});
        assert!(extract_required_study_type_name_field(&body).is_err());
    }

    #[test]
    fn extract_required_study_type_name_field_rejects_non_string() {
        let body = json!({ "study_type_name": 42 });
        assert!(extract_required_study_type_name_field(&body).is_err());
    }

    #[test]
    fn extract_required_section_outline_array_accepts_array() {
        let body = json!({ "section_outline": [{ "heading": "Intro" }] });
        let extracted = extract_required_section_outline_array(&body).unwrap();
        assert_eq!(extracted.len(), 1);
    }

    #[test]
    fn extract_required_section_outline_array_rejects_object() {
        let body = json!({ "section_outline": { "heading": "Intro" } });
        assert!(extract_required_section_outline_array(&body).is_err());
    }

    #[test]
    fn extract_required_section_outline_array_rejects_missing() {
        let body = json!({});
        assert!(extract_required_section_outline_array(&body).is_err());
    }

    #[test]
    fn extract_optional_study_type_description_field_returns_trimmed_value() {
        let body = json!({ "study_type_description": "  a description  " });
        assert_eq!(
            extract_optional_study_type_description_field(&body),
            Some("a description".to_string())
        );
    }

    #[test]
    fn extract_optional_study_type_description_field_returns_none_for_blank() {
        let body = json!({ "study_type_description": "   " });
        assert_eq!(extract_optional_study_type_description_field(&body), None);
    }

    #[test]
    fn extract_optional_study_type_description_field_returns_none_when_absent() {
        let body = json!({});
        assert_eq!(extract_optional_study_type_description_field(&body), None);
    }

    #[test]
    fn parse_study_type_name_into_non_empty_text_accepts_valid() {
        let parsed = parse_study_type_name_into_non_empty_text("Cohort Study".to_string()).unwrap();
        assert_eq!(parsed.as_str(), "Cohort Study");
    }

    #[test]
    fn parse_study_type_name_into_non_empty_text_rejects_empty() {
        assert!(parse_study_type_name_into_non_empty_text("   ".to_string()).is_err());
    }

    #[test]
    fn extract_section_heading_from_outline_entry_accepts_valid() {
        let entry = json!({ "heading": "  Methods  " });
        assert_eq!(
            extract_section_heading_from_outline_entry(&entry).unwrap(),
            "Methods"
        );
    }

    #[test]
    fn extract_section_heading_from_outline_entry_rejects_blank() {
        let entry = json!({ "heading": "   " });
        assert!(extract_section_heading_from_outline_entry(&entry).is_err());
    }

    #[test]
    fn extract_section_heading_from_outline_entry_rejects_missing() {
        let entry = json!({ "other": "value" });
        assert!(extract_section_heading_from_outline_entry(&entry).is_err());
    }

    #[test]
    fn validate_section_outline_is_non_empty_accepts_populated() {
        let outline = vec![json!({ "heading": "Intro" })];
        assert!(validate_section_outline_is_non_empty(&outline).is_ok());
    }

    #[test]
    fn validate_section_outline_is_non_empty_rejects_empty() {
        assert!(validate_section_outline_is_non_empty(&[]).is_err());
    }

    #[test]
    fn reject_duplicate_section_headings_accepts_unique() {
        let headings = vec!["Intro".to_string(), "Methods".to_string()];
        assert!(reject_duplicate_section_headings(&headings).is_ok());
    }

    #[test]
    fn reject_duplicate_section_headings_rejects_case_insensitive_duplicates() {
        let headings = vec!["Methods".to_string(), "methods".to_string()];
        assert!(reject_duplicate_section_headings(&headings).is_err());
    }

    #[test]
    fn generate_study_type_template_identifier_produces_unique_values() {
        let first = generate_study_type_template_identifier();
        let second = generate_study_type_template_identifier();
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
    fn map_domain_parse_failure_to_malformed_body_yields_malformed_variant() {
        let failure = NonEmptyText::parse("".to_string()).unwrap_err();
        let mapped = map_domain_parse_failure_to_malformed_body(failure);
        assert!(matches!(
            mapped,
            HttpError::RequestBodyWasMalformed { .. }
        ));
    }

    #[test]
    fn normalize_section_outline_entries_assigns_positions() {
        let outline = vec![
            json!({ "heading": " Background " }),
            json!({ "heading": "Methods", "guidance": "  describe design  " }),
        ];
        let normalized = normalize_section_outline_entries(outline);
        assert_eq!(normalized.len(), 2);
        assert_eq!(normalized[0]["heading"], json!("Background"));
        assert_eq!(normalized[0]["position"], json!(0));
        assert_eq!(normalized[1]["heading"], json!("Methods"));
        assert_eq!(normalized[1]["position"], json!(1));
        assert_eq!(normalized[1]["guidance"], json!("describe design"));
    }

    #[test]
    fn normalize_section_outline_entries_drops_invalid_entries() {
        let outline = vec![json!({ "heading": "Valid" }), json!({ "other": "x" })];
        let normalized = normalize_section_outline_entries(outline);
        assert_eq!(normalized.len(), 1);
        assert_eq!(normalized[0]["heading"], json!("Valid"));
    }

    #[test]
    fn assemble_study_type_template_document_body_includes_description() {
        let name = NonEmptyText::parse("RCT".to_string()).unwrap();
        let outline = vec![json!({ "heading": "Intro", "position": 0 })];
        let body = assemble_study_type_template_document_body(&name, &outline, Some("a trial"));
        assert_eq!(body["study_type_name"], json!("RCT"));
        assert_eq!(body["section_count"], json!(1));
        assert_eq!(body["study_type_description"], json!("a trial"));
        assert_eq!(body["template_kind"], json!("study_type"));
    }

    #[test]
    fn assemble_study_type_template_document_body_omits_missing_description() {
        let name = NonEmptyText::parse("RCT".to_string()).unwrap();
        let outline = vec![json!({ "heading": "Intro", "position": 0 })];
        let body = assemble_study_type_template_document_body(&name, &outline, None);
        assert!(body.get("study_type_description").is_none());
    }

    #[test]
    fn build_study_type_template_stored_document_sets_fields() {
        let document = build_study_type_template_stored_document(
            "id-1".to_string(),
            "owner@example.com".to_string(),
            json!({ "key": "value" }),
        );
        assert_eq!(document.document_identifier, "id-1");
        assert_eq!(document.owning_account, Some("owner@example.com".to_string()));
        assert_eq!(document.document_body, json!({ "key": "value" }));
    }

    #[test]
    fn build_study_type_template_creation_response_shape() {
        let response = build_study_type_template_creation_response("id-99");
        assert_eq!(response["document_identifier"], json!("id-99"));
        assert_eq!(
            response["acknowledgement"],
            json!("study type template created")
        );
    }
}
