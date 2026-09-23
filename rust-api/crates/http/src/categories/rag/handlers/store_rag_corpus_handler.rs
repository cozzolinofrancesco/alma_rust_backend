use crate::categories::rag::collections::{
    RAG_CORPORA_COLLECTION_NAME, RAG_KNOWLEDGE_COLLECTION_NAME,
};
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
use axum::extract::State;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

/// Persist a new RAG corpus for the authenticated principal.
///
/// The submitted body is expected to carry a human-readable display name, an
/// optional description, and an optional list of initial knowledge-source
/// references that are seeded into the knowledge collection alongside the
/// corpus record itself.
#[route(method = "POST", path = "/api/rag/corpora")]
pub async fn store_rag_corpus_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let owning_account = parse_owning_account(authorized_request.authorized_principal().as_str())?;

    let corpus_display_name = extract_corpus_display_name_from_body(&submitted_body)?;
    let corpus_description = extract_optional_corpus_description(&submitted_body);
    let knowledge_source_references = extract_initial_knowledge_source_references(&submitted_body);

    assert_corpus_display_name_is_unique_for_account(
        &application_state.document_collection,
        &owning_account,
        &corpus_display_name,
    )
    .await?;

    let corpus_identifier = generate_new_corpus_identifier();
    let created_timestamp = stamp_corpus_created_timestamp(SystemTime::now());

    let corpus_document_body = build_corpus_document_body(
        &corpus_display_name,
        &corpus_description,
        &created_timestamp,
        &knowledge_source_references,
    );

    let corpus_document =
        assemble_corpus_stored_document(&corpus_identifier, &owning_account, corpus_document_body);

    let knowledge_documents = build_initial_knowledge_documents(
        &corpus_identifier,
        &owning_account,
        &knowledge_source_references,
    );

    let seeded_knowledge_count = perform_corpus_creation_within_transaction(
        &application_state,
        corpus_document,
        knowledge_documents,
    )
    .await?;

    Ok(Json(assemble_store_corpus_response(
        &corpus_identifier,
        seeded_knowledge_count,
    )))
}

/// Re-parse the authenticated principal's e-mail into a domain value object.
///
/// The pipeline already authenticated the principal, so a failure here would
/// indicate an internal inconsistency rather than bad client input.
fn parse_owning_account(principal_email: &str) -> Result<Email, HttpError> {
    Email::parse(principal_email.to_string()).map_err(|domain_error| {
        HttpError::UpstreamApplicationFailure {
            explanation: format!(
                "the authenticated principal could not be interpreted as an e-mail: {domain_error}"
            ),
        }
    })
}

/// (1) Extract and validate the corpus display name from the submitted body.
fn extract_corpus_display_name_from_body(
    submitted_body: &Value,
) -> Result<NonEmptyText, HttpError> {
    let raw_display_name = submitted_body
        .get("displayName")
        .and_then(Value::as_str)
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: "the request body must contain a string 'displayName' field".to_string(),
        })?;

    NonEmptyText::parse(raw_display_name.to_string()).map_err(|domain_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: format!("the corpus display name was not acceptable: {domain_error}"),
        }
    })
}

/// (2) Extract an optional, trimmed free-text description of the corpus.
///
/// A missing field, a non-string value, or a blank string all collapse to
/// `None` so downstream code never has to reason about empty descriptions.
fn extract_optional_corpus_description(submitted_body: &Value) -> Option<String> {
    submitted_body
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|trimmed_description| !trimmed_description.is_empty())
        .map(str::to_string)
}

/// (3) Extract the list of initial knowledge-source references.
///
/// Accepts an array under `knowledgeSources`; each element may be either a bare
/// string reference or an object carrying a `reference`/`uri` string. Blank and
/// duplicate references are discarded while preserving first-seen order.
fn extract_initial_knowledge_source_references(submitted_body: &Value) -> Vec<String> {
    let Some(raw_entries) = submitted_body.get("knowledgeSources").and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut collected_references: Vec<String> = Vec::new();
    for raw_entry in raw_entries {
        let candidate_reference = match raw_entry {
            Value::String(direct_reference) => Some(direct_reference.trim().to_string()),
            Value::Object(_) => raw_entry
                .get("reference")
                .or_else(|| raw_entry.get("uri"))
                .and_then(Value::as_str)
                .map(|inner| inner.trim().to_string()),
            _ => None,
        };

        if let Some(reference) = candidate_reference {
            if !reference.is_empty() && !collected_references.contains(&reference) {
                collected_references.push(reference);
            }
        }
    }

    collected_references
}

/// (4) Reject the request when the account already owns a corpus with the same
/// display name (case-insensitive comparison after trimming).
async fn assert_corpus_display_name_is_unique_for_account(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    owning_account: &Email,
    candidate_name: &NonEmptyText,
) -> Result<(), HttpError> {
    let existing_corpora = document_collection
        .list_documents_owned_by(RAG_CORPORA_COLLECTION_NAME, owning_account.as_str())
        .await
        .map_err(map_application_error_to_store_http_error)?;

    let normalized_candidate = normalize_display_name_for_comparison(candidate_name.as_str());

    let collides_with_existing = existing_corpora.iter().any(|existing_corpus| {
        normalize_display_name_for_comparison(&read_corpus_display_name(existing_corpus))
            == normalized_candidate
    });

    if collides_with_existing {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "a corpus named '{}' already exists for this account",
                candidate_name.as_str()
            ),
        });
    }

    Ok(())
}

/// Normalize a display name for uniqueness comparisons.
fn normalize_display_name_for_comparison(raw_display_name: &str) -> String {
    raw_display_name.trim().to_lowercase()
}

/// (5) Read the display name out of a stored corpus document, defaulting to an
/// empty string when the field is absent or not a string.
fn read_corpus_display_name(corpus_document: &StoredDocument) -> String {
    corpus_document
        .document_body
        .get("displayName")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// (6) Generate a fresh, globally-unique corpus identifier.
fn generate_new_corpus_identifier() -> String {
    Uuid::new_v4().to_string()
}

/// (7) Produce an ISO-8601-ish UTC timestamp string for the corpus.
///
/// The `time` crate is not available to this crate, so the instant is captured
/// as seconds since the Unix epoch and rendered as `unix:<seconds>` — a stable,
/// sortable representation that downstream services can parse deterministically.
fn stamp_corpus_created_timestamp(created_instant: SystemTime) -> String {
    let elapsed_since_epoch = created_instant
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    format!("unix:{elapsed_since_epoch}")
}

/// (8) Build the JSON body persisted for the corpus record.
fn build_corpus_document_body(
    display_name: &NonEmptyText,
    description: &Option<String>,
    created_timestamp: &str,
    knowledge_source_references: &[String],
) -> Value {
    json!({
        "displayName": display_name.as_str(),
        "description": description,
        "createdAt": created_timestamp,
        "knowledgeSourceReferences": knowledge_source_references,
        "seededKnowledgeCount": knowledge_source_references.len(),
    })
}

/// (9) Wrap a corpus document body into a `StoredDocument` owned by the account.
fn assemble_corpus_stored_document(
    corpus_identifier: &str,
    owning_account: &Email,
    document_body: Value,
) -> StoredDocument {
    StoredDocument {
        document_identifier: corpus_identifier.to_string(),
        owning_account: Some(owning_account.as_str().to_string()),
        document_body,
    }
}

/// (10) Persist the corpus record into the corpora collection.
async fn persist_corpus_document(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    corpus_document: StoredDocument,
) -> Result<(), HttpError> {
    document_collection
        .insert_document(RAG_CORPORA_COLLECTION_NAME, corpus_document)
        .await
        .map_err(map_application_error_to_store_http_error)
}

/// (11) Materialize a `StoredDocument` for every initial knowledge reference.
///
/// Each knowledge document is linked back to its owning corpus and account so
/// that later retrieval can scope by both dimensions.
fn build_initial_knowledge_documents(
    corpus_identifier: &str,
    owning_account: &Email,
    knowledge_source_references: &[String],
) -> Vec<StoredDocument> {
    knowledge_source_references
        .iter()
        .enumerate()
        .map(|(ordinal_position, source_reference)| StoredDocument {
            document_identifier: format!("{corpus_identifier}:{ordinal_position}"),
            owning_account: Some(owning_account.as_str().to_string()),
            document_body: json!({
                "corpusIdentifier": corpus_identifier,
                "ordinalPosition": ordinal_position,
                "sourceReference": source_reference,
            }),
        })
        .collect()
}

/// (12) Persist every initial knowledge document, returning how many landed.
async fn persist_initial_knowledge_documents(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    knowledge_documents: Vec<StoredDocument>,
) -> Result<usize, HttpError> {
    let mut persisted_count = 0usize;
    for knowledge_document in knowledge_documents {
        document_collection
            .insert_document(RAG_KNOWLEDGE_COLLECTION_NAME, knowledge_document)
            .await
            .map_err(map_application_error_to_store_http_error)?;
        persisted_count += 1;
    }
    Ok(persisted_count)
}

/// (13) Coordinate persistence of the corpus record and its seed knowledge as a
/// single logical unit of creation, returning the number of knowledge documents
/// that were seeded.
async fn perform_corpus_creation_within_transaction<TransactionalUnitOfWork>(
    application_state: &ApplicationState<TransactionalUnitOfWork>,
    corpus_document: StoredDocument,
    knowledge_documents: Vec<StoredDocument>,
) -> Result<usize, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork,
{
    persist_corpus_document(&application_state.document_collection, corpus_document).await?;
    let seeded_knowledge_count = persist_initial_knowledge_documents(
        &application_state.document_collection,
        knowledge_documents,
    )
    .await?;
    Ok(seeded_knowledge_count)
}

/// (14) Translate an application-layer error into the HTTP error surfaced by
/// this store handler.
fn map_application_error_to_store_http_error(application_error: ApplicationError) -> HttpError {
    match application_error {
        ApplicationError::RequestedProjectCouldNotBeLocated
        | ApplicationError::RequestedResourceCouldNotBeLocated => {
            HttpError::RequestedResourceWasNotFound {
                explanation: application_error.to_string(),
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

/// (15) Assemble the success payload returned to the client.
fn assemble_store_corpus_response(corpus_identifier: &str, seeded_knowledge_count: usize) -> Value {
    json!({
        "corpusId": corpus_identifier,
        "seededKnowledgeCount": seeded_knowledge_count,
        "status": "created",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_body() -> Value {
        json!({
            "displayName": "Climate Reports",
            "description": "  A curated corpus  ",
            "knowledgeSources": [
                "doi:10.1/abc",
                { "reference": "doi:10.2/def" },
                { "uri": "https://example.org/paper" },
                "doi:10.1/abc",
                "   ",
                42
            ]
        })
    }

    #[test]
    fn extract_display_name_accepts_valid_name() {
        let parsed = extract_corpus_display_name_from_body(&sample_body()).unwrap();
        assert_eq!(parsed.as_str(), "Climate Reports");
    }

    #[test]
    fn extract_display_name_rejects_missing_field() {
        let body = json!({ "description": "no name here" });
        assert!(extract_corpus_display_name_from_body(&body).is_err());
    }

    #[test]
    fn extract_display_name_rejects_blank_field() {
        let body = json!({ "displayName": "   " });
        assert!(extract_corpus_display_name_from_body(&body).is_err());
    }

    #[test]
    fn extract_description_trims_and_keeps_content() {
        assert_eq!(
            extract_optional_corpus_description(&sample_body()),
            Some("A curated corpus".to_string())
        );
    }

    #[test]
    fn extract_description_returns_none_for_blank_or_missing() {
        assert_eq!(
            extract_optional_corpus_description(&json!({ "displayName": "x" })),
            None
        );
        assert_eq!(
            extract_optional_corpus_description(&json!({ "description": "   " })),
            None
        );
    }

    #[test]
    fn extract_knowledge_references_dedupes_and_filters() {
        let references = extract_initial_knowledge_source_references(&sample_body());
        assert_eq!(
            references,
            vec![
                "doi:10.1/abc".to_string(),
                "doi:10.2/def".to_string(),
                "https://example.org/paper".to_string(),
            ]
        );
    }

    #[test]
    fn extract_knowledge_references_empty_when_absent() {
        let references = extract_initial_knowledge_source_references(&json!({ "displayName": "x" }));
        assert!(references.is_empty());
    }

    #[test]
    fn read_display_name_defaults_when_missing() {
        let document = StoredDocument {
            document_identifier: "id".to_string(),
            owning_account: None,
            document_body: json!({}),
        };
        assert_eq!(read_corpus_display_name(&document), "");
    }

    #[test]
    fn read_display_name_reads_field() {
        let document = StoredDocument {
            document_identifier: "id".to_string(),
            owning_account: None,
            document_body: json!({ "displayName": "Physics" }),
        };
        assert_eq!(read_corpus_display_name(&document), "Physics");
    }

    #[test]
    fn generate_identifier_is_unique_and_nonempty() {
        let first = generate_new_corpus_identifier();
        let second = generate_new_corpus_identifier();
        assert!(!first.is_empty());
        assert_ne!(first, second);
    }

    #[test]
    fn stamp_timestamp_uses_unix_prefix() {
        let stamped = stamp_corpus_created_timestamp(SystemTime::now());
        assert!(stamped.starts_with("unix:"));
        let seconds_part = stamped.trim_start_matches("unix:");
        assert!(seconds_part.parse::<u64>().is_ok());
    }

    #[test]
    fn build_body_captures_all_fields() {
        let display_name = NonEmptyText::parse("Corpus A".to_string()).unwrap();
        let description = Some("desc".to_string());
        let references = vec!["r1".to_string(), "r2".to_string()];
        let body = build_corpus_document_body(&display_name, &description, "unix:5", &references);
        assert_eq!(body.get("displayName").unwrap(), "Corpus A");
        assert_eq!(body.get("description").unwrap(), "desc");
        assert_eq!(body.get("createdAt").unwrap(), "unix:5");
        assert_eq!(body.get("seededKnowledgeCount").unwrap(), 2);
    }

    #[test]
    fn assemble_stored_document_sets_owner_and_id() {
        let owner = Email::parse("researcher@example.org".to_string()).unwrap();
        let document = assemble_corpus_stored_document("corpus-1", &owner, json!({ "k": "v" }));
        assert_eq!(document.document_identifier, "corpus-1");
        assert_eq!(
            document.owning_account,
            Some("researcher@example.org".to_string())
        );
        assert_eq!(document.document_body.get("k").unwrap(), "v");
    }

    #[test]
    fn build_knowledge_documents_links_corpus_and_orders() {
        let owner = Email::parse("author@example.org".to_string()).unwrap();
        let references = vec!["a".to_string(), "b".to_string()];
        let documents = build_initial_knowledge_documents("corpus-9", &owner, &references);
        assert_eq!(documents.len(), 2);
        assert_eq!(documents[0].document_identifier, "corpus-9:0");
        assert_eq!(documents[1].document_identifier, "corpus-9:1");
        assert_eq!(
            documents[1].document_body.get("corpusIdentifier").unwrap(),
            "corpus-9"
        );
        assert_eq!(documents[1].document_body.get("sourceReference").unwrap(), "b");
    }

    #[test]
    fn build_knowledge_documents_empty_for_no_references() {
        let owner = Email::parse("author@example.org".to_string()).unwrap();
        let documents = build_initial_knowledge_documents("corpus-9", &owner, &[]);
        assert!(documents.is_empty());
    }

    #[test]
    fn map_error_routes_not_found() {
        let mapped = map_application_error_to_store_http_error(
            ApplicationError::RequestedResourceCouldNotBeLocated,
        );
        assert!(matches!(mapped, HttpError::RequestedResourceWasNotFound { .. }));
    }

    #[test]
    fn map_error_routes_generic_failure_to_upstream() {
        let mapped = map_application_error_to_store_http_error(
            ApplicationError::DocumentCollectionFailure {
                failure_description: "boom".to_string(),
            },
        );
        assert!(matches!(mapped, HttpError::UpstreamApplicationFailure { .. }));
    }

    #[test]
    fn map_error_routes_authorization_denied() {
        let mapped =
            map_application_error_to_store_http_error(ApplicationError::AuthorizationWasDenied);
        assert!(matches!(mapped, HttpError::AuthorizationWasDenied { .. }));
    }

    #[test]
    fn assemble_response_reports_counts_and_status() {
        let response = assemble_store_corpus_response("corpus-7", 3);
        assert_eq!(response.get("corpusId").unwrap(), "corpus-7");
        assert_eq!(response.get("seededKnowledgeCount").unwrap(), 3);
        assert_eq!(response.get("status").unwrap(), "created");
    }

    #[test]
    fn normalize_display_name_lowercases_and_trims() {
        assert_eq!(normalize_display_name_for_comparison("  ABC "), "abc");
    }

    #[test]
    fn parse_owning_account_accepts_valid_email() {
        assert!(parse_owning_account("valid@example.org").is_ok());
    }
}
