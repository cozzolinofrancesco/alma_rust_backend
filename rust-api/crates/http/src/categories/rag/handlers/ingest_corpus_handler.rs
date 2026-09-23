//! POST `/api/rag/ingest` — ingest a text/markdown corpus into a Gemini File
//! Search store and persist its store-name + files into `RAG_CORPORA`.
//!
//! This is the HTTP seam for the plan's **Phase 1b-ingest**. The heavy lifting
//! (create store → resumable upload → `:importFile` → poll `listStoreDocuments`
//! until `ACTIVE` → persist the corpus record) is already implemented by the
//! ingestion-core adapter `GeminiCorpusIngestionAdapter::ingest_corpus`
//! (`crates/infrastructure/src/rag_ingest.rs`, the port of
//! `frontend_v3/app/lib/rag/fileSearchStore.ts::createFileSearchStoreFromLocalFiles`).
//! This handler is a thin orchestration layer: parse + validate the request,
//! delegate to the adapter, and marshal the outcome back to the caller.
//!
//! ## Integration contract (owned by the stage integrator, not this unit)
//!
//! The handler reaches the ingestion-core through
//! `application_state.corpus_ingestion_adapter: Arc<GeminiCorpusIngestionAdapter>`.
//! That field does not yet exist on [`ApplicationState`]; wiring it in is the
//! integrator's job (mirroring how `retrieval_adapter` is wired), which also
//! entails adding `alma-infrastructure` to `crates/http/Cargo.toml`. This file
//! deliberately touches neither, per the unit's "touch only your file" rule.

use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::error::ApplicationError;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_infrastructure::rag_ingest::{
    CorpusIngestionDocument, CorpusIngestionError, DocumentIndexingState, IngestedCorpus,
};
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};

/// Declared mime type recorded for a document when the caller omits one.
///
/// The upload mime is always `text/plain` inside the ingestion-core (per the v1
/// plan); this value is only the *declared* source type kept for display.
const DEFAULT_DOCUMENT_MIME_TYPE: &str = "text/markdown";

/// Ingest a text / markdown corpus for the authenticated principal.
///
/// The body carries a human-readable `displayName` (alias `name`) and a
/// non-empty `documents` array (alias `files`); each document is an object with
/// a `name` (alias `fileName`/`filename`), the raw `text` (alias `content`), and
/// an optional `mimeType` (alias `mime_type`). The ingestion-core creates a
/// fresh File Search store, uploads + imports every document, waits (bounded)
/// for the documents to reach `ACTIVE`, and persists the store resource-name +
/// per-file records into `RAG_CORPORA` so retrieval can resolve the store.
#[route(method = "POST", path = "/api/rag/ingest")]
pub async fn ingest_corpus_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // The pipeline already authenticated the principal; carry its e-mail as the
    // owning account recorded on the persisted corpus record.
    let owning_account = authorized_request.authorized_principal().as_str().to_string();

    let corpus_display_name = extract_corpus_display_name(&submitted_body)?;
    let documents_to_ingest = extract_ingestion_documents(&submitted_body)?;

    // Ingestion needs a real Gemini File Search backend; in the hermetic no-key
    // build the adapter is absent, so surface a clear error rather than panicking.
    let corpus_ingestion_adapter = application_state
        .corpus_ingestion_adapter
        .as_ref()
        .ok_or_else(|| HttpError::UpstreamApplicationFailure {
            explanation:
                "corpus ingestion is unavailable: the server has no GEMINI_API_KEY configured"
                    .to_string(),
        })?;

    let ingested_corpus = corpus_ingestion_adapter
        .ingest_corpus(
            &corpus_display_name,
            Some(owning_account.as_str()),
            &documents_to_ingest,
        )
        .await
        .map_err(map_ingestion_error_to_http_error)?;

    Ok(Json(assemble_ingest_response(&ingested_corpus)))
}

/// (1) Extract and validate the corpus display name.
///
/// Accepts `displayName` (primary) or `name` (alias); the value is trimmed and
/// must be non-empty.
fn extract_corpus_display_name(submitted_body: &Value) -> Result<String, HttpError> {
    submitted_body
        .get("displayName")
        .or_else(|| submitted_body.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|candidate_name| !candidate_name.is_empty())
        .map(str::to_string)
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: "the request body must contain a non-empty string 'displayName' field"
                .to_string(),
        })
}

/// (2) Extract the list of documents to ingest.
///
/// Accepts a non-empty array under `documents` (primary) or `files` (alias).
/// Every element is validated by [`parse_single_ingestion_document`]; a single
/// malformed element fails the whole request (`400`) so the caller learns which
/// document was rejected rather than silently ingesting a partial corpus.
fn extract_ingestion_documents(
    submitted_body: &Value,
) -> Result<Vec<CorpusIngestionDocument>, HttpError> {
    let raw_document_entries = submitted_body
        .get("documents")
        .or_else(|| submitted_body.get("files"))
        .and_then(Value::as_array)
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: "the request body must contain a 'documents' array".to_string(),
        })?;

    if raw_document_entries.is_empty() {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: "the 'documents' array must contain at least one document".to_string(),
        });
    }

    raw_document_entries
        .iter()
        .enumerate()
        .map(|(ordinal_position, raw_document_entry)| {
            parse_single_ingestion_document(raw_document_entry, ordinal_position)
        })
        .collect()
}

/// (3) Parse and validate one document entry into a [`CorpusIngestionDocument`].
///
/// `name` (alias `fileName`/`filename`) and `text` (alias `content`) are both
/// required and must be non-blank; `mimeType` (alias `mime_type`) is optional
/// and defaults to [`DEFAULT_DOCUMENT_MIME_TYPE`].
fn parse_single_ingestion_document(
    raw_document_entry: &Value,
    ordinal_position: usize,
) -> Result<CorpusIngestionDocument, HttpError> {
    let document_name = raw_document_entry
        .get("name")
        .or_else(|| raw_document_entry.get("fileName"))
        .or_else(|| raw_document_entry.get("filename"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|candidate_name| !candidate_name.is_empty())
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "the document at position {ordinal_position} is missing a non-empty 'name' field"
            ),
        })?
        .to_string();

    let document_text = raw_document_entry
        .get("text")
        .or_else(|| raw_document_entry.get("content"))
        .and_then(Value::as_str)
        .filter(|candidate_text| !candidate_text.trim().is_empty())
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "the document '{document_name}' (position {ordinal_position}) is missing a non-empty 'text' field"
            ),
        })?
        .to_string();

    let document_mime_type = raw_document_entry
        .get("mimeType")
        .or_else(|| raw_document_entry.get("mime_type"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|candidate_mime_type| !candidate_mime_type.is_empty())
        .unwrap_or(DEFAULT_DOCUMENT_MIME_TYPE)
        .to_string();

    Ok(CorpusIngestionDocument {
        name: document_name,
        mime_type: document_mime_type,
        text: document_text,
    })
}

/// (4) Translate an ingestion-core error into the HTTP error surfaced here.
///
/// The pure request-validation failures (`NoDocumentsSupplied` /
/// `MissingDocumentName`) map to `400`, though this handler validates those
/// conditions up front so they should not reach the adapter. Every other
/// variant is a File Search API / persistence failure and is routed through the
/// existing [`ApplicationError`] → [`HttpError`] conversion (so a persistence
/// not-found still surfaces as `404`, and Gemini seam failures as `500`).
fn map_ingestion_error_to_http_error(ingestion_error: CorpusIngestionError) -> HttpError {
    match ingestion_error {
        CorpusIngestionError::NoDocumentsSupplied | CorpusIngestionError::MissingDocumentName => {
            HttpError::RequestBodyWasMalformed {
                explanation: ingestion_error.to_string(),
            }
        }
        other_ingestion_error => HttpError::from(ApplicationError::from(other_ingestion_error)),
    }
}

/// (5) Render a stable label for the aggregate document-indexing state.
fn aggregate_state_label(aggregate_state: DocumentIndexingState) -> &'static str {
    match aggregate_state {
        DocumentIndexingState::Active => "ACTIVE",
        DocumentIndexingState::Processing => "PROCESSING",
        DocumentIndexingState::Failed => "FAILED",
    }
}

/// (6) Assemble the success payload returned to the client.
///
/// `corpusId` is the Gemini File Search store resource name (what retrieval
/// queries against); `corpusDocumentId` is the id of the persisted `RAG_CORPORA`
/// record; `isActive` reflects whether every document reached `ACTIVE` (the
/// store is fully groundable).
fn assemble_ingest_response(ingested_corpus: &IngestedCorpus) -> Value {
    let ingested_files_json: Vec<Value> = ingested_corpus
        .files
        .iter()
        .map(|ingested_file| serde_json::to_value(ingested_file).unwrap_or(Value::Null))
        .collect();

    let indexed_document_count = ingested_corpus
        .files
        .iter()
        .filter(|ingested_file| ingested_file.status == "indexed")
        .count();

    json!({
        "corpusId": ingested_corpus.store_name,
        "corpusDocumentId": ingested_corpus.corpus_document_id,
        "displayName": ingested_corpus.display_name,
        "files": ingested_files_json,
        "documentCount": indexed_document_count,
        "isActive": ingested_corpus.is_active(),
        "aggregateState": aggregate_state_label(ingested_corpus.aggregate_state),
        "status": "created",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use alma_infrastructure::rag_ingest::IngestedCorpusFile;

    fn sample_body() -> Value {
        json!({
            "displayName": "  Climate Corpus  ",
            "documents": [
                { "name": "  primer.md  ", "text": "Warming trends.", "mimeType": "text/markdown" },
                { "fileName": "notes.txt", "content": "Field notes." }
            ]
        })
    }

    #[test]
    fn extract_display_name_accepts_and_trims_primary_field() {
        assert_eq!(
            extract_corpus_display_name(&sample_body()).unwrap(),
            "Climate Corpus"
        );
    }

    #[test]
    fn extract_display_name_accepts_name_alias() {
        let body = json!({ "name": "Aliased" });
        assert_eq!(extract_corpus_display_name(&body).unwrap(), "Aliased");
    }

    #[test]
    fn extract_display_name_rejects_missing_field() {
        let body = json!({ "documents": [] });
        assert!(matches!(
            extract_corpus_display_name(&body),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn extract_display_name_rejects_blank_field() {
        let body = json!({ "displayName": "   " });
        assert!(extract_corpus_display_name(&body).is_err());
    }

    #[test]
    fn extract_documents_parses_aliases_and_defaults_mime() {
        let documents = extract_ingestion_documents(&sample_body()).unwrap();
        assert_eq!(documents.len(), 2);

        assert_eq!(documents[0].name, "primer.md");
        assert_eq!(documents[0].text, "Warming trends.");
        assert_eq!(documents[0].mime_type, "text/markdown");

        // Second entry uses the `fileName`/`content` aliases and omits mimeType.
        assert_eq!(documents[1].name, "notes.txt");
        assert_eq!(documents[1].text, "Field notes.");
        assert_eq!(documents[1].mime_type, DEFAULT_DOCUMENT_MIME_TYPE);
    }

    #[test]
    fn extract_documents_accepts_files_alias_array() {
        let body = json!({
            "files": [ { "name": "a.md", "text": "x" } ]
        });
        let documents = extract_ingestion_documents(&body).unwrap();
        assert_eq!(documents.len(), 1);
        assert_eq!(documents[0].name, "a.md");
    }

    #[test]
    fn extract_documents_rejects_missing_array() {
        let body = json!({ "displayName": "x" });
        assert!(matches!(
            extract_ingestion_documents(&body),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn extract_documents_rejects_empty_array() {
        let body = json!({ "documents": [] });
        assert!(matches!(
            extract_ingestion_documents(&body),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn extract_documents_rejects_document_without_name() {
        let body = json!({ "documents": [ { "text": "orphan" } ] });
        assert!(extract_ingestion_documents(&body).is_err());
    }

    #[test]
    fn extract_documents_rejects_document_without_text() {
        let body = json!({ "documents": [ { "name": "empty.md" } ] });
        assert!(extract_ingestion_documents(&body).is_err());
    }

    #[test]
    fn extract_documents_rejects_document_with_blank_text() {
        let body = json!({ "documents": [ { "name": "blank.md", "text": "   " } ] });
        assert!(extract_ingestion_documents(&body).is_err());
    }

    #[test]
    fn aggregate_state_label_maps_all_variants() {
        assert_eq!(aggregate_state_label(DocumentIndexingState::Active), "ACTIVE");
        assert_eq!(
            aggregate_state_label(DocumentIndexingState::Processing),
            "PROCESSING"
        );
        assert_eq!(aggregate_state_label(DocumentIndexingState::Failed), "FAILED");
    }

    #[test]
    fn map_ingestion_error_routes_no_documents_to_bad_request() {
        let mapped = map_ingestion_error_to_http_error(CorpusIngestionError::NoDocumentsSupplied);
        assert!(matches!(mapped, HttpError::RequestBodyWasMalformed { .. }));
    }

    #[test]
    fn map_ingestion_error_routes_gemini_failure_to_upstream() {
        let mapped = map_ingestion_error_to_http_error(CorpusIngestionError::GeminiApi {
            context: "store-create".to_string(),
            status: 503,
            body: "unavailable".to_string(),
        });
        assert!(matches!(mapped, HttpError::UpstreamApplicationFailure { .. }));
    }

    #[test]
    fn assemble_response_reports_store_files_and_active_flag() {
        let ingested_corpus = IngestedCorpus {
            corpus_document_id: "corpus-doc-1".to_string(),
            store_name: "fileSearchStores/abc123".to_string(),
            display_name: "Climate Corpus".to_string(),
            files: vec![
                IngestedCorpusFile {
                    file_id: "f1".to_string(),
                    name: "primer.md".to_string(),
                    mime_type: "text/markdown".to_string(),
                    size: 15,
                    status: "indexed".to_string(),
                    gemini_file_uri: Some("files/xyz".to_string()),
                    indexed_at: Some("unix:5".to_string()),
                    error: None,
                },
                IngestedCorpusFile {
                    file_id: "f2".to_string(),
                    name: "notes.txt".to_string(),
                    mime_type: "text/markdown".to_string(),
                    size: 11,
                    status: "error".to_string(),
                    gemini_file_uri: None,
                    indexed_at: None,
                    error: Some("boom".to_string()),
                },
            ],
            aggregate_state: DocumentIndexingState::Processing,
        };

        let response = assemble_ingest_response(&ingested_corpus);
        assert_eq!(response["corpusId"], "fileSearchStores/abc123");
        assert_eq!(response["corpusDocumentId"], "corpus-doc-1");
        assert_eq!(response["displayName"], "Climate Corpus");
        assert_eq!(response["documentCount"], 1);
        assert_eq!(response["isActive"], false);
        assert_eq!(response["aggregateState"], "PROCESSING");
        assert_eq!(response["status"], "created");
        assert_eq!(response["files"].as_array().unwrap().len(), 2);
        // IngestedCorpusFile serialises camelCase; `None` keys are omitted.
        assert_eq!(response["files"][0]["fileId"], "f1");
        assert_eq!(response["files"][0]["geminiFileUri"], "files/xyz");
        assert!(response["files"][1].get("geminiFileUri").is_none());
    }
}
