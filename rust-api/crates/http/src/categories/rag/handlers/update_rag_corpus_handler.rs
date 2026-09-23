use crate::categories::rag::collections::RAG_CORPORA_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::error::ApplicationError;
use alma_application::ports::document_collection::{DocumentCollectionPort, StoredDocument};
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::{Email, NonEmptyText};
use alma_macros::route;
use axum::Json;
use axum::extract::{Path, State};
use serde_json::{Value, json};
use std::sync::Arc;

/// Structured representation of the mutable fields a caller may submit when
/// patching an existing retrieval-augmented-generation corpus. Every field is
/// optional so a partial update touches only the attributes the caller supplied.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RagCorpusUpdatePatch {
    /// A replacement human-facing display name, when the caller wishes to rename
    /// the corpus. `None` means "leave the current name untouched".
    pub replacement_display_name: Option<String>,
    /// A replacement free-form description. An explicitly supplied empty string
    /// clears the description; `None` leaves the current description untouched.
    pub replacement_description: Option<String>,
    /// Knowledge-source references (document identifiers) to append to the
    /// corpus's membership set.
    pub knowledge_source_references_to_add: Vec<String>,
    /// Knowledge-source references to remove from the corpus's membership set.
    pub knowledge_source_references_to_remove: Vec<String>,
}

/// Validates and normalizes the corpus identifier arriving on the request path,
/// rejecting blank identifiers before any collection access is attempted.
fn extract_corpus_identifier_from_path(
    supplied_path_parameter: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(supplied_path_parameter).map_err(|domain_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "the corpus identifier on the request path was not usable: {domain_error}"
            ),
        }
    })
}

/// Parses the raw JSON request body into a strongly typed update patch. The body
/// must be a JSON object; individual fields are extracted defensively so that a
/// missing field simply becomes `None`/empty rather than an error.
fn extract_corpus_update_patch_from_body(
    submitted_body: Value,
) -> Result<RagCorpusUpdatePatch, HttpError> {
    let body_object = submitted_body.as_object().ok_or_else(|| {
        HttpError::RequestBodyWasMalformed {
            explanation: String::from("the update payload was expected to be a JSON object"),
        }
    })?;

    let replacement_display_name = match body_object.get("display_name") {
        None | Some(Value::Null) => None,
        Some(Value::String(candidate)) => Some(candidate.clone()),
        Some(_) => {
            return Err(HttpError::RequestBodyWasMalformed {
                explanation: String::from("the field 'display_name' must be a string when present"),
            });
        }
    };

    let replacement_description = match body_object.get("description") {
        None | Some(Value::Null) => None,
        Some(Value::String(candidate)) => Some(candidate.clone()),
        Some(_) => {
            return Err(HttpError::RequestBodyWasMalformed {
                explanation: String::from("the field 'description' must be a string when present"),
            });
        }
    };

    let knowledge_source_references_to_add =
        extract_string_reference_array(body_object.get("add_knowledge_sources"), "add_knowledge_sources")?;
    let knowledge_source_references_to_remove = extract_string_reference_array(
        body_object.get("remove_knowledge_sources"),
        "remove_knowledge_sources",
    )?;

    Ok(RagCorpusUpdatePatch {
        replacement_display_name,
        replacement_description,
        knowledge_source_references_to_add,
        knowledge_source_references_to_remove,
    })
}

/// Reads an optional JSON array of strings from a patch field, tolerating absence
/// (returns an empty vector) but rejecting a non-array value or non-string
/// elements so malformed membership edits fail loudly.
fn extract_string_reference_array(
    optional_field_value: Option<&Value>,
    field_label: &str,
) -> Result<Vec<String>, HttpError> {
    match optional_field_value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(array_elements)) => {
            let mut collected_references = Vec::with_capacity(array_elements.len());
            for individual_element in array_elements {
                match individual_element.as_str() {
                    Some(reference_text) if !reference_text.trim().is_empty() => {
                        collected_references.push(reference_text.to_string());
                    }
                    _ => {
                        return Err(HttpError::RequestBodyWasMalformed {
                            explanation: format!(
                                "the field '{field_label}' must contain only non-empty strings"
                            ),
                        });
                    }
                }
            }
            Ok(collected_references)
        }
        Some(_) => Err(HttpError::RequestBodyWasMalformed {
            explanation: format!("the field '{field_label}' must be an array of strings"),
        }),
    }
}

/// When the patch carries a display-name change, validates it into a
/// `NonEmptyText`; when it does not, yields `None` so downstream logic knows the
/// name is unchanged.
fn validate_updated_corpus_display_name(
    patch: &RagCorpusUpdatePatch,
) -> Result<Option<NonEmptyText>, HttpError> {
    match &patch.replacement_display_name {
        None => Ok(None),
        Some(raw_display_name) => {
            let validated_name = NonEmptyText::parse(raw_display_name.clone()).map_err(
                |domain_error| HttpError::RequestBodyWasMalformed {
                    explanation: format!(
                        "the replacement display name was not usable: {domain_error}"
                    ),
                },
            )?;
            Ok(Some(validated_name))
        }
    }
}

/// Loads the corpus document targeted by the update, translating an absent
/// document into a 404-style error.
async fn fetch_corpus_document_or_not_found(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    corpus_identifier: &NonEmptyText,
) -> Result<StoredDocument, HttpError> {
    let optionally_located_document = document_collection
        .fetch_document(RAG_CORPORA_COLLECTION_NAME, corpus_identifier.as_str())
        .await?;
    optionally_located_document.ok_or_else(|| HttpError::RequestedResourceWasNotFound {
        explanation: String::from("no rag corpus exists under the supplied identifier"),
    })
}

/// Ensures the authenticated principal owns the corpus before any mutation is
/// applied. A corpus with no recorded owner is treated as unowned and therefore
/// not modifiable by an ordinary principal.
fn assert_corpus_document_is_owned_by_requester(
    corpus_document: &StoredDocument,
    requesting_account: &Email,
) -> Result<(), HttpError> {
    match &corpus_document.owning_account {
        Some(recorded_owner) if recorded_owner == requesting_account.as_str() => Ok(()),
        _ => Err(HttpError::AuthorizationWasDenied {
            explanation: String::from(
                "the authenticated principal may not modify this rag corpus",
            ),
        }),
    }
}

/// Guards against two corpora owned by the same principal sharing a display name.
/// Scans the principal's other corpora (excluding the one being edited) and
/// rejects a candidate name that collides case-insensitively.
async fn assert_updated_display_name_remains_unique(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    owning_account: &Email,
    corpus_identifier: &NonEmptyText,
    candidate_name: &NonEmptyText,
) -> Result<(), HttpError> {
    let corpora_owned_by_principal = document_collection
        .list_documents_owned_by(RAG_CORPORA_COLLECTION_NAME, owning_account.as_str())
        .await?;

    let a_conflicting_corpus_exists = corpora_owned_by_principal.iter().any(|existing_corpus| {
        existing_corpus.document_identifier != corpus_identifier.as_str()
            && read_display_name_from_corpus_body(existing_corpus)
                .map(|existing_name| existing_name.eq_ignore_ascii_case(candidate_name.as_str()))
                .unwrap_or(false)
    });

    if a_conflicting_corpus_exists {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from(
                "another corpus owned by this principal already uses the requested display name",
            ),
        });
    }
    Ok(())
}

/// Pure helper: reads the `display_name` string out of a stored corpus body,
/// returning `None` when the field is absent or not a string.
fn read_display_name_from_corpus_body(corpus_document: &StoredDocument) -> Option<String> {
    corpus_document
        .document_body
        .get("display_name")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Writes the validated replacement display name into the corpus body.
fn apply_display_name_change_to_corpus_body(
    corpus_document: &mut StoredDocument,
    new_display_name: &NonEmptyText,
) {
    let corpus_body_object = ensure_corpus_body_is_object(corpus_document);
    corpus_body_object.insert(
        String::from("display_name"),
        Value::String(new_display_name.to_string()),
    );
}

/// Writes (or clears) the description on the corpus body. A supplied `Some`
/// replaces the current value; a supplied `None` leaves the field untouched. To
/// clear a description the caller passes `Some("".into())`.
fn apply_description_change_to_corpus_body(
    corpus_document: &mut StoredDocument,
    new_description: &Option<String>,
) {
    if let Some(description_text) = new_description {
        let corpus_body_object = ensure_corpus_body_is_object(corpus_document);
        corpus_body_object.insert(
            String::from("description"),
            Value::String(description_text.clone()),
        );
    }
}

/// Appends knowledge-source references to the corpus membership array without
/// introducing duplicates and preserving insertion order.
fn apply_knowledge_source_additions_to_corpus_body(
    corpus_document: &mut StoredDocument,
    added_source_references: &[String],
) {
    if added_source_references.is_empty() {
        return;
    }
    let mut current_references = read_knowledge_source_references(corpus_document);
    for candidate_reference in added_source_references {
        if !current_references.iter().any(|existing| existing == candidate_reference) {
            current_references.push(candidate_reference.clone());
        }
    }
    write_knowledge_source_references(corpus_document, current_references);
}

/// Removes knowledge-source references from the corpus membership array. Absent
/// references are silently ignored so removals are idempotent.
fn apply_knowledge_source_removals_from_corpus_body(
    corpus_document: &mut StoredDocument,
    removed_source_references: &[String],
) {
    if removed_source_references.is_empty() {
        return;
    }
    let retained_references: Vec<String> = read_knowledge_source_references(corpus_document)
        .into_iter()
        .filter(|existing_reference| {
            !removed_source_references
                .iter()
                .any(|to_remove| to_remove == existing_reference)
        })
        .collect();
    write_knowledge_source_references(corpus_document, retained_references);
}

/// Pure helper: reads the current knowledge-source reference list from a corpus
/// body, returning an empty vector when the field is missing or malformed.
fn read_knowledge_source_references(corpus_document: &StoredDocument) -> Vec<String> {
    corpus_document
        .document_body
        .get("knowledge_source_references")
        .and_then(Value::as_array)
        .map(|array_elements| {
            array_elements
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Pure helper: writes a knowledge-source reference list back into a corpus body.
fn write_knowledge_source_references(
    corpus_document: &mut StoredDocument,
    references: Vec<String>,
) {
    let corpus_body_object = ensure_corpus_body_is_object(corpus_document);
    let serialized_references = references.into_iter().map(Value::String).collect();
    corpus_body_object.insert(
        String::from("knowledge_source_references"),
        Value::Array(serialized_references),
    );
}

/// Guarantees the corpus body is a JSON object (replacing any non-object value
/// with an empty object) and returns a mutable handle to it.
fn ensure_corpus_body_is_object(
    corpus_document: &mut StoredDocument,
) -> &mut serde_json::Map<String, Value> {
    if !corpus_document.document_body.is_object() {
        corpus_document.document_body = Value::Object(serde_json::Map::new());
    }
    corpus_document
        .document_body
        .as_object_mut()
        .expect("corpus body was just normalized into an object")
}

/// Records the moment the corpus was last modified. The instant is supplied as
/// an ISO-8601 string by the caller (the http crate has no clock dependency),
/// keeping this helper pure and trivially testable.
fn stamp_corpus_last_modified_timestamp(
    corpus_document: &mut StoredDocument,
    modified_instant: String,
) {
    let corpus_body_object = ensure_corpus_body_is_object(corpus_document);
    corpus_body_object.insert(
        String::from("last_modified_at"),
        Value::String(modified_instant),
    );
}

/// Executes the persistence of the updated corpus inside a unit-of-work
/// transaction so the write commits atomically, then returns the stored
/// document to the caller for response assembly.
async fn perform_corpus_update_within_transaction<TransactionalUnitOfWork>(
    application_state: &ApplicationState<TransactionalUnitOfWork>,
    corpus_document: StoredDocument,
) -> Result<StoredDocument, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork,
{
    let document_for_persistence = corpus_document.clone();
    let document_collection_handle = Arc::clone(&application_state.document_collection);

    application_state
        .transactional_unit_of_work
        .execute_within_transaction(move |_project_repository| {
            Box::pin(async move {
                let replacement_succeeded = document_collection_handle
                    .replace_document(RAG_CORPORA_COLLECTION_NAME, document_for_persistence)
                    .await?;
                if replacement_succeeded {
                    Ok(())
                } else {
                    Err(ApplicationError::RequestedResourceCouldNotBeLocated)
                }
            })
        })
        .await
        .map_err(map_application_error_to_update_http_error)?;

    Ok(corpus_document)
}

/// Translates an application-layer error into the HTTP error surface. Mirrors the
/// crate-wide `From<ApplicationError>` conversion but keeps the mapping explicit
/// and local so the transactional path can attach corpus-specific context.
fn map_application_error_to_update_http_error(application_error: ApplicationError) -> HttpError {
    match application_error {
        ApplicationError::RequestedProjectCouldNotBeLocated
        | ApplicationError::RequestedResourceCouldNotBeLocated => {
            HttpError::RequestedResourceWasNotFound {
                explanation: String::from(
                    "the rag corpus could not be located while committing the update",
                ),
            }
        }
        ApplicationError::AuthorizationWasDenied => HttpError::AuthorizationWasDenied {
            explanation: application_error.to_string(),
        },
        ApplicationError::DomainInvariantViolated(_) => HttpError::RequestBodyWasMalformed {
            explanation: application_error.to_string(),
        },
        other_application_error => HttpError::UpstreamApplicationFailure {
            explanation: other_application_error.to_string(),
        },
    }
}

/// Builds the JSON response body describing the corpus after the update was
/// applied, echoing back the identifier, owner, and the updated body.
fn assemble_update_corpus_response(updated_corpus_document: &StoredDocument) -> Value {
    json!({
        "corpus_identifier": updated_corpus_document.document_identifier,
        "owning_account": updated_corpus_document.owning_account,
        "corpus": updated_corpus_document.document_body,
    })
}

#[route(method = "PATCH", path = "/api/rag/corpora/:corpus_identifier")]
pub async fn update_rag_corpus_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Path(corpus_identifier): Path<String>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let validated_corpus_identifier = extract_corpus_identifier_from_path(corpus_identifier)?;
    let update_patch = extract_corpus_update_patch_from_body(submitted_body)?;
    let optional_validated_display_name = validate_updated_corpus_display_name(&update_patch)?;

    let requesting_account = authorized_request.authorized_principal().clone();
    let correlation_identifier = authorized_request.correlation_identifier().to_string();

    let mut corpus_document = fetch_corpus_document_or_not_found(
        &application_state.document_collection,
        &validated_corpus_identifier,
    )
    .await?;

    assert_corpus_document_is_owned_by_requester(&corpus_document, &requesting_account)?;

    if let Some(validated_display_name) = &optional_validated_display_name {
        assert_updated_display_name_remains_unique(
            &application_state.document_collection,
            &requesting_account,
            &validated_corpus_identifier,
            validated_display_name,
        )
        .await?;
        apply_display_name_change_to_corpus_body(&mut corpus_document, validated_display_name);
    }

    apply_description_change_to_corpus_body(&mut corpus_document, &update_patch.replacement_description);
    apply_knowledge_source_additions_to_corpus_body(
        &mut corpus_document,
        &update_patch.knowledge_source_references_to_add,
    );
    apply_knowledge_source_removals_from_corpus_body(
        &mut corpus_document,
        &update_patch.knowledge_source_references_to_remove,
    );
    stamp_corpus_last_modified_timestamp(&mut corpus_document, correlation_identifier);

    let updated_corpus_document =
        perform_corpus_update_within_transaction(&application_state, corpus_document).await?;

    Ok(Json(assemble_update_corpus_response(&updated_corpus_document)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn corpus_with_body(identifier: &str, owner: Option<&str>, body: Value) -> StoredDocument {
        StoredDocument {
            document_identifier: identifier.to_string(),
            owning_account: owner.map(str::to_string),
            document_body: body,
        }
    }

    #[test]
    fn extract_corpus_identifier_from_path_accepts_valid_identifier() {
        let parsed = extract_corpus_identifier_from_path("corpus-42".to_string());
        assert!(parsed.is_ok());
        assert_eq!(parsed.unwrap().as_str(), "corpus-42");
    }

    #[test]
    fn extract_corpus_identifier_from_path_rejects_blank_identifier() {
        let parsed = extract_corpus_identifier_from_path("   ".to_string());
        assert!(parsed.is_err());
    }

    #[test]
    fn extract_corpus_update_patch_from_body_parses_all_fields() {
        let body = json!({
            "display_name": "Renamed Corpus",
            "description": "a description",
            "add_knowledge_sources": ["doc-1", "doc-2"],
            "remove_knowledge_sources": ["doc-9"],
        });
        let patch = extract_corpus_update_patch_from_body(body).unwrap();
        assert_eq!(patch.replacement_display_name.as_deref(), Some("Renamed Corpus"));
        assert_eq!(patch.replacement_description.as_deref(), Some("a description"));
        assert_eq!(patch.knowledge_source_references_to_add, vec!["doc-1", "doc-2"]);
        assert_eq!(patch.knowledge_source_references_to_remove, vec!["doc-9"]);
    }

    #[test]
    fn extract_corpus_update_patch_from_body_rejects_non_object() {
        let result = extract_corpus_update_patch_from_body(json!(["not", "an", "object"]));
        assert!(result.is_err());
    }

    #[test]
    fn extract_corpus_update_patch_from_body_rejects_non_string_display_name() {
        let result = extract_corpus_update_patch_from_body(json!({ "display_name": 5 }));
        assert!(result.is_err());
    }

    #[test]
    fn extract_string_reference_array_handles_absence_and_arrays() {
        assert_eq!(extract_string_reference_array(None, "f").unwrap(), Vec::<String>::new());
        let value = json!(["a", "b"]);
        assert_eq!(
            extract_string_reference_array(Some(&value), "f").unwrap(),
            vec!["a".to_string(), "b".to_string()]
        );
    }

    #[test]
    fn extract_string_reference_array_rejects_non_string_elements() {
        let value = json!(["a", 3]);
        assert!(extract_string_reference_array(Some(&value), "f").is_err());
    }

    #[test]
    fn validate_updated_corpus_display_name_yields_none_when_absent() {
        let patch = RagCorpusUpdatePatch::default();
        assert_eq!(validate_updated_corpus_display_name(&patch).unwrap(), None);
    }

    #[test]
    fn validate_updated_corpus_display_name_rejects_blank_name() {
        let patch = RagCorpusUpdatePatch {
            replacement_display_name: Some("   ".to_string()),
            ..RagCorpusUpdatePatch::default()
        };
        assert!(validate_updated_corpus_display_name(&patch).is_err());
    }

    #[test]
    fn assert_corpus_document_is_owned_by_requester_allows_owner() {
        let owner = Email::parse("owner@example.com".to_string()).unwrap();
        let document = corpus_with_body("c1", Some("owner@example.com"), json!({}));
        assert!(assert_corpus_document_is_owned_by_requester(&document, &owner).is_ok());
    }

    #[test]
    fn assert_corpus_document_is_owned_by_requester_denies_other_and_unowned() {
        let stranger = Email::parse("stranger@example.com".to_string()).unwrap();
        let owned = corpus_with_body("c1", Some("owner@example.com"), json!({}));
        assert!(assert_corpus_document_is_owned_by_requester(&owned, &stranger).is_err());
        let unowned = corpus_with_body("c1", None, json!({}));
        assert!(assert_corpus_document_is_owned_by_requester(&unowned, &stranger).is_err());
    }

    #[test]
    fn read_display_name_from_corpus_body_reads_present_and_absent() {
        let with_name = corpus_with_body("c", None, json!({ "display_name": "Alpha" }));
        assert_eq!(read_display_name_from_corpus_body(&with_name).as_deref(), Some("Alpha"));
        let without_name = corpus_with_body("c", None, json!({}));
        assert_eq!(read_display_name_from_corpus_body(&without_name), None);
    }

    #[test]
    fn apply_display_name_change_to_corpus_body_writes_name() {
        let mut document = corpus_with_body("c", None, json!({}));
        let new_name = NonEmptyText::parse("Beta".to_string()).unwrap();
        apply_display_name_change_to_corpus_body(&mut document, &new_name);
        assert_eq!(document.document_body.get("display_name").unwrap(), &json!("Beta"));
    }

    #[test]
    fn apply_display_name_change_normalizes_non_object_body() {
        let mut document = corpus_with_body("c", None, json!("scalar"));
        let new_name = NonEmptyText::parse("Gamma".to_string()).unwrap();
        apply_display_name_change_to_corpus_body(&mut document, &new_name);
        assert_eq!(document.document_body.get("display_name").unwrap(), &json!("Gamma"));
    }

    #[test]
    fn apply_description_change_to_corpus_body_writes_and_skips() {
        let mut document = corpus_with_body("c", None, json!({ "description": "old" }));
        apply_description_change_to_corpus_body(&mut document, &None);
        assert_eq!(document.document_body.get("description").unwrap(), &json!("old"));
        apply_description_change_to_corpus_body(&mut document, &Some("new".to_string()));
        assert_eq!(document.document_body.get("description").unwrap(), &json!("new"));
    }

    #[test]
    fn apply_knowledge_source_additions_deduplicates() {
        let mut document =
            corpus_with_body("c", None, json!({ "knowledge_source_references": ["doc-1"] }));
        apply_knowledge_source_additions_to_corpus_body(
            &mut document,
            &["doc-1".to_string(), "doc-2".to_string()],
        );
        assert_eq!(read_knowledge_source_references(&document), vec!["doc-1", "doc-2"]);
    }

    #[test]
    fn apply_knowledge_source_removals_is_idempotent() {
        let mut document = corpus_with_body(
            "c",
            None,
            json!({ "knowledge_source_references": ["doc-1", "doc-2"] }),
        );
        apply_knowledge_source_removals_from_corpus_body(
            &mut document,
            &["doc-2".to_string(), "doc-absent".to_string()],
        );
        assert_eq!(read_knowledge_source_references(&document), vec!["doc-1"]);
    }

    #[test]
    fn read_knowledge_source_references_defaults_to_empty() {
        let document = corpus_with_body("c", None, json!({}));
        assert!(read_knowledge_source_references(&document).is_empty());
    }

    #[test]
    fn write_knowledge_source_references_round_trips() {
        let mut document = corpus_with_body("c", None, json!({}));
        write_knowledge_source_references(&mut document, vec!["x".to_string(), "y".to_string()]);
        assert_eq!(read_knowledge_source_references(&document), vec!["x", "y"]);
    }

    #[test]
    fn stamp_corpus_last_modified_timestamp_writes_instant() {
        let mut document = corpus_with_body("c", None, json!({}));
        stamp_corpus_last_modified_timestamp(&mut document, "2026-07-07T00:00:00Z".to_string());
        assert_eq!(
            document.document_body.get("last_modified_at").unwrap(),
            &json!("2026-07-07T00:00:00Z")
        );
    }

    #[test]
    fn map_application_error_to_update_http_error_maps_not_found() {
        let mapped = map_application_error_to_update_http_error(
            ApplicationError::RequestedResourceCouldNotBeLocated,
        );
        assert!(matches!(mapped, HttpError::RequestedResourceWasNotFound { .. }));
    }

    #[test]
    fn map_application_error_to_update_http_error_maps_generic_failure() {
        let mapped = map_application_error_to_update_http_error(
            ApplicationError::DocumentCollectionFailure {
                failure_description: "boom".to_string(),
            },
        );
        assert!(matches!(mapped, HttpError::UpstreamApplicationFailure { .. }));
    }

    #[test]
    fn assemble_update_corpus_response_echoes_fields() {
        let document = corpus_with_body(
            "corpus-7",
            Some("owner@example.com"),
            json!({ "display_name": "Delta" }),
        );
        let response = assemble_update_corpus_response(&document);
        assert_eq!(response.get("corpus_identifier").unwrap(), &json!("corpus-7"));
        assert_eq!(response.get("owning_account").unwrap(), &json!("owner@example.com"));
        assert_eq!(
            response.get("corpus").unwrap().get("display_name").unwrap(),
            &json!("Delta")
        );
    }
}
