//! Drive-free corpus ingestion into a Gemini File Search store.
//!
//! This is the Rust port of the in-memory (local-files) path of
//! `frontend_v3/app/lib/rag/fileSearchStore.ts`
//! (`createFileSearchStoreFromLocalFiles` → `ingestLocalFilesIntoStore` →
//! `processOneFile` → `verifyFileActive`), reduced to what the alma_2 v1 plan
//! keeps:
//!
//! 1. create (or reuse) a File Search store — `getOrCreateFileSearchStore`;
//! 2. for each document, a **resumable upload** to `/upload/v1beta/files`
//!    (`uploadBufferToGemini`) followed by `:importFile` (`importFileToStore`);
//!    the Gemini key is sent via the `x-goog-api-key` header (RUST-SECRET-002),
//!    never in the URL;
//! 3. poll `listStoreDocuments` + `aggregateDocumentStates` until the store's
//!    documents reach `ACTIVE` (bounded ~120 s — the reference's
//!    `verifyFileActive` LRO poll);
//! 4. persist the store resource-name + the ingested `files[]` into the
//!    `rag_corpora` collection via [`DocumentCollectionPort`] (the reference's
//!    `addOrUpdateCorpus` registry write; retrieval fully depends on this).
//!
//! The heavy Drive/PDF/rate-limit/self-heal plumbing of the reference
//! (`splitPdfIfNecessary`, `classifyPdf`, OCR rescue, per-minute rate limiter,
//! job registry) is intentionally cut per the v1 plan: this path accepts
//! **text / markdown + pre-extracted PDF text** and uploads every document as
//! `text/plain` (no PDF splitting).

use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use alma_application::error::ApplicationError;
use alma_application::ports::document_collection::{DocumentCollectionPort, StoredDocument};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use uuid::Uuid;

/// Collection name for persisted corpus records.
///
/// Mirrors `RAG_CORPORA_COLLECTION_NAME` in
/// `crates/http/src/categories/rag/collections.rs`. The infrastructure crate
/// cannot depend on the HTTP crate (that would be a dependency cycle), so the
/// literal is duplicated here; keeping the two in sync means `list_rag_corpora`
/// and the retrieval reader see the documents this adapter writes.
pub const RAG_CORPORA_COLLECTION_NAME: &str = "rag_corpora";

/// Post-import LRO verification budget: wait up to this long for a store's
/// documents to reach `ACTIVE` (reference `RETRY_CONFIG.lroVerifyTimeoutMs`).
const DEFAULT_LRO_VERIFY_TIMEOUT_MS: u64 = 120_000;
/// Poll interval while waiting for `ACTIVE` (reference
/// `RETRY_CONFIG.lroVerifyIntervalMs`).
const DEFAULT_LRO_VERIFY_INTERVAL_MS: u64 = 5_000;
/// Bounded transient retry for `429` / `5xx` responses. The reference uses
/// multi-minute production backoffs; on a single-user local deployment a short
/// bounded retry is the equivalent behaviour.
const MAX_TRANSIENT_RETRIES: u32 = 3;
/// Base delay (doubled per attempt) for the transient retry.
const TRANSIENT_BASE_DELAY_MS: u64 = 1_000;
/// Gemini caps the documents `page_size` at 20.
const DOCUMENTS_PAGE_SIZE: &str = "20";
/// Maximum characters of an upstream error body echoed into an error message.
const ERROR_BODY_CHAR_CAP: usize = 400;

// ---------------------------------------------------------------------------
// Document indexing state (port of app/lib/rag/documentState.ts)
// ---------------------------------------------------------------------------

/// Gemini File Search document indexing state.
///
/// Port of `DocumentState` in `frontend_v3/app/lib/rag/documentState.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentIndexingState {
    Active,
    Processing,
    Failed,
}

impl DocumentIndexingState {
    /// Normalise the raw `state` field of a document as the REST API reports it:
    /// an enum string (`ACTIVE`/`PROCESSING`/`FAILED`/`STATE_*`) or a numeric
    /// code (`1` active, `3` failed). Anything not clearly active/failed is
    /// treated as still processing. A missing state is `ACTIVE` — this matches
    /// `normaliseDocumentState` (`if (!raw) return 'ACTIVE'`).
    pub fn from_wire(raw: Option<&str>) -> Self {
        let Some(raw) = raw else {
            return Self::Active;
        };
        let upper = raw.to_ascii_uppercase();
        if upper == "ACTIVE" || upper == "STATE_ACTIVE" || raw == "1" {
            return Self::Active;
        }
        if upper == "FAILED" || upper == "STATE_FAILED" || raw == "3" {
            return Self::Failed;
        }
        Self::Processing
    }
}

/// Aggregate many per-document states into one: any `FAILED` → `FAILED`; all
/// `ACTIVE` → `ACTIVE`; otherwise `PROCESSING`. An empty set is `PROCESSING`
/// (nothing has been observed yet). Port of `aggregateDocumentStates`.
pub fn aggregate_document_states(states: &[DocumentIndexingState]) -> DocumentIndexingState {
    if states.is_empty() {
        return DocumentIndexingState::Processing;
    }
    if states.iter().any(|state| *state == DocumentIndexingState::Failed) {
        return DocumentIndexingState::Failed;
    }
    if states.iter().all(|state| *state == DocumentIndexingState::Active) {
        return DocumentIndexingState::Active;
    }
    DocumentIndexingState::Processing
}

// ---------------------------------------------------------------------------
// Public input / output types
// ---------------------------------------------------------------------------

/// One document to ingest. The Drive-free equivalent of `LocalRagFile` reduced
/// to text: `text` carries the markdown / plain text / pre-extracted PDF text
/// that is uploaded as `text/plain`.
#[derive(Debug, Clone)]
pub struct CorpusIngestionDocument {
    /// File name; used as the document `pdf_name` and `chunk_name` metadata and
    /// as the display name of the uploaded Gemini file.
    pub name: String,
    /// Caller-declared source mime type, recorded for display. The upload mime
    /// is always `text/plain` regardless of this value (per the v1 plan).
    pub mime_type: String,
    /// The document text / markdown / pre-extracted PDF text.
    pub text: String,
}

/// One ingested file as recorded on the persisted corpus. Serialises to the
/// camelCase shape of the reference `CorpusFile`, so the existing corpus list /
/// retrieval readers can consume it unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestedCorpusFile {
    pub file_id: String,
    pub name: String,
    pub mime_type: String,
    pub size: usize,
    /// `"indexed"` when the file's documents reached `ACTIVE`; `"error"`
    /// otherwise (upload/import failure, `FAILED`, or timed out before
    /// `ACTIVE`).
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gemini_file_uri: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub indexed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Result of an ingestion run: what the caller persists / reports.
#[derive(Debug, Clone)]
pub struct IngestedCorpus {
    /// Identifier of the persisted `rag_corpora` document.
    pub corpus_document_id: String,
    /// The Gemini File Search store resource name (the reference
    /// `CorpusEntry.corpusId`) — what retrieval queries against.
    pub store_name: String,
    /// Human-readable corpus name.
    pub display_name: String,
    /// Per-file ingestion outcomes.
    pub files: Vec<IngestedCorpusFile>,
    /// Aggregate document state across the store when polling ended.
    pub aggregate_state: DocumentIndexingState,
}

impl IngestedCorpus {
    /// Whether every document reached `ACTIVE` (the store is fully queryable /
    /// groundable). Retrieval's `isGrounded` acceptance depends on this.
    pub fn is_active(&self) -> bool {
        self.aggregate_state == DocumentIndexingState::Active
    }
}

/// Errors raised while ingesting a corpus.
#[derive(Debug, Error)]
pub enum CorpusIngestionError {
    #[error("the ingestion request carried no documents")]
    NoDocumentsSupplied,
    #[error("a document was supplied without a name")]
    MissingDocumentName,
    #[error("the HTTP transport to Gemini failed during {context}: {source}")]
    Transport {
        context: String,
        #[source]
        source: reqwest::Error,
    },
    #[error("Gemini returned status {status} during {context}: {body}")]
    GeminiApi {
        context: String,
        status: u16,
        body: String,
    },
    #[error("the resumable upload response omitted the X-Goog-Upload-Url header")]
    MissingUploadUrl,
    #[error("could not parse the Gemini response during {context}: {source}")]
    MalformedResponse {
        context: String,
        #[source]
        source: reqwest::Error,
    },
    #[error("persisting the corpus record failed: {0}")]
    Persistence(#[from] ApplicationError),
}

impl From<CorpusIngestionError> for ApplicationError {
    fn from(error: CorpusIngestionError) -> Self {
        match error {
            CorpusIngestionError::Persistence(application_error) => application_error,
            // Every other variant is a failure of the Gemini File Search API
            // seam; there is no retrieval-specific application error variant, so
            // it is surfaced as an AI-adapter failure (the store lives behind
            // the same Gemini key as generation).
            other => ApplicationError::ArtificialIntelligenceAdapterFailure {
                failure_description: other.to_string(),
            },
        }
    }
}

// ---------------------------------------------------------------------------
// Internal store-document record (port of StoreDocument)
// ---------------------------------------------------------------------------

/// A single Gemini File Search document with the metadata this adapter needs to
/// relate it back to an ingested file. Port of the `StoreDocument` interface.
#[derive(Debug, Clone)]
struct StoreDocumentRecord {
    state: DocumentIndexingState,
    pdf_name: Option<String>,
    chunk_name: Option<String>,
    file_id: Option<String>,
}

/// Whether a store document belongs to the given ingested file. `file_id` is the
/// exact key when both sides carry it; otherwise fall back to `chunk_name`
/// (which encodes the original filename), then `pdf_name`. Port of
/// `documentBelongsToFile`.
fn document_belongs_to_file(
    document: &StoreDocumentRecord,
    file_id: &str,
    file_name: &str,
) -> bool {
    if let Some(document_file_id) = document.file_id.as_deref() {
        if !document_file_id.is_empty() && !file_id.is_empty() {
            return document_file_id == file_id;
        }
    }
    let base = strip_pdf_suffix(file_name);
    if let Some(chunk_name) = document.chunk_name.as_deref() {
        return chunk_name == file_name || chunk_name.starts_with(&format!("{base}_p"));
    }
    if let Some(pdf_name) = document.pdf_name.as_deref() {
        return pdf_name == file_name;
    }
    false
}

/// Strip a trailing `.pdf` (case-insensitive), mirroring `replace(/\.pdf$/i, '')`.
fn strip_pdf_suffix(file_name: &str) -> &str {
    if file_name.len() >= 4 && file_name[file_name.len() - 4..].eq_ignore_ascii_case(".pdf") {
        &file_name[..file_name.len() - 4]
    } else {
        file_name
    }
}

/// Deterministic store resource name from a folder id. Port of
/// `generateStoreName`: lowercase, then map any char outside `[a-z0-9-]` to `-`.
fn generate_store_name(folder_id: &str) -> String {
    let normalized: String = folder_id
        .to_ascii_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-' {
                character
            } else {
                '-'
            }
        })
        .collect();
    format!("fileSearchStores/folder-{normalized}")
}

/// `"unix:<seconds>"` timestamp string, matching the format the corpus store
/// handler writes for `createdAt` so listing / sorting stays consistent.
fn current_unix_timestamp_string() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    format!("unix:{seconds}")
}

/// Milliseconds since the Unix epoch, for the `ingested_at` chunk metadata.
fn current_unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// Char-bounded truncation for error bodies (safe on UTF-8 boundaries).
fn truncate_error_body(body: String) -> String {
    if body.chars().count() > ERROR_BODY_CHAR_CAP {
        body.chars().take(ERROR_BODY_CHAR_CAP).collect()
    } else {
        body
    }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/// Drive-free corpus ingestion adapter over the Gemini File Search REST API.
pub struct GeminiCorpusIngestionAdapter {
    http_client: reqwest::Client,
    gemini_api_key: String,
    gemini_base_url: String,
    document_collection: Arc<dyn DocumentCollectionPort>,
    poll_timeout: Duration,
    poll_interval: Duration,
    embedding_model: Option<String>,
}

impl GeminiCorpusIngestionAdapter {
    /// Construct the adapter. `gemini_base_url` has any trailing slash trimmed
    /// so path concatenation matches the reference (`${GEMINI_BASE_URL}/v1beta/...`).
    pub fn construct(
        http_client: reqwest::Client,
        gemini_api_key: String,
        gemini_base_url: String,
        document_collection: Arc<dyn DocumentCollectionPort>,
    ) -> Self {
        Self {
            http_client,
            gemini_api_key,
            gemini_base_url: gemini_base_url.trim_end_matches('/').to_string(),
            document_collection,
            poll_timeout: Duration::from_millis(DEFAULT_LRO_VERIFY_TIMEOUT_MS),
            poll_interval: Duration::from_millis(DEFAULT_LRO_VERIFY_INTERVAL_MS),
            embedding_model: None,
        }
    }

    /// Pin the embedding model used when a store is created (fixed at creation
    /// time; reference `embedding_config.model`).
    pub fn with_embedding_model(mut self, embedding_model: Option<String>) -> Self {
        self.embedding_model = embedding_model;
        self
    }

    /// Override the `ACTIVE`-poll bounds (default: 120 s budget, 5 s interval).
    pub fn with_poll_bounds(mut self, timeout: Duration, interval: Duration) -> Self {
        self.poll_timeout = timeout;
        self.poll_interval = interval;
        self
    }

    /// Ingest `documents` into a freshly-created File Search store, wait until
    /// the store's documents are `ACTIVE` (bounded), persist the store name +
    /// file records into `rag_corpora`, and return the outcome.
    ///
    /// Port of `createFileSearchStoreFromLocalFiles`. Per-document upload /
    /// import failures do not abort the run — the failing file is recorded with
    /// `status = "error"` and ingestion continues (mirroring `processOneFile`'s
    /// per-file status). A failure to create the store, or to persist the
    /// corpus record, aborts.
    pub async fn ingest_corpus(
        &self,
        display_name: &str,
        owning_account: Option<&str>,
        documents: &[CorpusIngestionDocument],
    ) -> Result<IngestedCorpus, CorpusIngestionError> {
        if documents.is_empty() {
            return Err(CorpusIngestionError::NoDocumentsSupplied);
        }
        for document in documents {
            if document.name.trim().is_empty() {
                return Err(CorpusIngestionError::MissingDocumentName);
            }
        }

        // A fresh, unique folder id per run: the store namespace is flat and
        // shared, so a unique id guarantees a fresh store (the reference uses
        // `local-${Date.now()}-${rand}`).
        let folder_id = format!("local-{}", Uuid::new_v4());
        let store_name = self.get_or_create_store(&folder_id, display_name).await?;

        // Upload + import every document. Track the terminal per-file state so
        // it can be reconciled against the polled document states below.
        struct PendingFile {
            file_id: String,
            name: String,
            mime_type: String,
            size: usize,
            uri: Option<String>,
            error: Option<String>,
        }

        let mut pending_files: Vec<PendingFile> = Vec::with_capacity(documents.len());
        for document in documents {
            let file_id = Uuid::new_v4().to_string();
            let bytes = document.text.as_bytes();
            let size = bytes.len();
            let mut uri = None;
            let mut error = None;

            match self.upload_text(&document.name, bytes).await {
                Ok((file_resource_name, file_uri)) => {
                    uri = Some(file_uri);
                    if let Err(import_error) = self
                        .import_file(&store_name, &file_resource_name, &document.name, &file_id)
                        .await
                    {
                        error = Some(import_error.to_string());
                    }
                }
                Err(upload_error) => {
                    error = Some(upload_error.to_string());
                }
            }

            pending_files.push(PendingFile {
                file_id,
                name: document.name.clone(),
                mime_type: document.mime_type.clone(),
                size,
                uri,
                error,
            });
        }

        // Wait (bounded) for the imported documents to reach ACTIVE.
        let (store_documents, aggregate_state) = self.poll_until_active(&store_name).await?;

        // Reconcile each file's terminal status against the polled documents.
        let files: Vec<IngestedCorpusFile> = pending_files
            .into_iter()
            .map(|pending| {
                if let Some(existing_error) = pending.error {
                    return IngestedCorpusFile {
                        file_id: pending.file_id,
                        name: pending.name,
                        mime_type: pending.mime_type,
                        size: pending.size,
                        status: "error".to_string(),
                        gemini_file_uri: pending.uri,
                        indexed_at: None,
                        error: Some(existing_error),
                    };
                }

                let belonging_states: Vec<DocumentIndexingState> = store_documents
                    .iter()
                    .filter(|document| {
                        document_belongs_to_file(document, &pending.file_id, &pending.name)
                    })
                    .map(|document| document.state)
                    .collect();

                match aggregate_document_states(&belonging_states) {
                    DocumentIndexingState::Active => IngestedCorpusFile {
                        file_id: pending.file_id,
                        name: pending.name,
                        mime_type: pending.mime_type,
                        size: pending.size,
                        status: "indexed".to_string(),
                        gemini_file_uri: pending.uri,
                        indexed_at: Some(current_unix_timestamp_string()),
                        error: None,
                    },
                    DocumentIndexingState::Failed => IngestedCorpusFile {
                        file_id: pending.file_id,
                        name: pending.name,
                        mime_type: pending.mime_type,
                        size: pending.size,
                        status: "error".to_string(),
                        gemini_file_uri: pending.uri,
                        indexed_at: None,
                        error: Some(
                            "Gemini reported this document as FAILED during indexing".to_string(),
                        ),
                    },
                    DocumentIndexingState::Processing => IngestedCorpusFile {
                        file_id: pending.file_id,
                        name: pending.name,
                        mime_type: pending.mime_type,
                        size: pending.size,
                        status: "error".to_string(),
                        gemini_file_uri: pending.uri,
                        indexed_at: None,
                        error: Some(format!(
                            "this document did not reach ACTIVE within {}s",
                            self.poll_timeout.as_secs()
                        )),
                    },
                }
            })
            .collect();

        // Persist the corpus record (store name + files[]) so retrieval can
        // resolve the File Search store and the SPA can list it.
        let corpus_document_id = Uuid::new_v4().to_string();
        self.persist_corpus_record(
            &corpus_document_id,
            display_name,
            owning_account,
            &store_name,
            &folder_id,
            &files,
        )
        .await?;

        Ok(IngestedCorpus {
            corpus_document_id,
            store_name,
            display_name: display_name.to_string(),
            files,
            aggregate_state,
        })
    }

    /// Persist the corpus record into `rag_corpora`. The body is compatible with
    /// the existing corpus list/read handlers (`displayName`, `createdAt`,
    /// `files`, `documentCount`) and carries `corpusId` = the store resource
    /// name (reference `CorpusEntry.corpusId`) for retrieval.
    async fn persist_corpus_record(
        &self,
        corpus_document_id: &str,
        display_name: &str,
        owning_account: Option<&str>,
        store_name: &str,
        folder_id: &str,
        files: &[IngestedCorpusFile],
    ) -> Result<(), CorpusIngestionError> {
        let timestamp = current_unix_timestamp_string();
        let indexed_count = files.iter().filter(|file| file.status == "indexed").count();
        let files_json: Vec<Value> = files
            .iter()
            .map(|file| serde_json::to_value(file).unwrap_or(Value::Null))
            .collect();

        let document_body = json!({
            "displayName": display_name,
            "corpusId": store_name,
            "source": {
                "type": "drive_folder",
                "folderId": folder_id,
                "folderName": display_name,
            },
            "files": files_json,
            "documentCount": indexed_count,
            "createdAt": timestamp,
            "updatedAt": timestamp,
        });

        let stored_document = StoredDocument {
            document_identifier: corpus_document_id.to_string(),
            owning_account: owning_account.map(str::to_string),
            document_body,
        };

        self.document_collection
            .insert_document(RAG_CORPORA_COLLECTION_NAME, stored_document)
            .await?;
        Ok(())
    }

    /// Reuse the deterministic store if it already exists (GET), else create a
    /// new one (POST) and return the server-assigned resource name. Port of
    /// `getOrCreateFileSearchStore`.
    async fn get_or_create_store(
        &self,
        folder_id: &str,
        display_name: &str,
    ) -> Result<String, CorpusIngestionError> {
        let candidate_store_name = generate_store_name(folder_id);

        // Best-effort existence probe: a transport error here is non-fatal (we
        // fall through to create), matching the reference's try/catch.
        let probe = self
            .send_with_retry("store-check", || {
                self.http_client
                    .get(format!("{}/v1beta/{}", self.gemini_base_url, candidate_store_name))
                    // RUST-SECRET-002: key via x-goog-api-key header, not the
                    // query string (reqwest leaks the URL in transport errors).
                    .header("x-goog-api-key", self.gemini_api_key.as_str())
            })
            .await;
        if let Ok(probe_response) = probe {
            if probe_response.status().is_success() {
                return Ok(candidate_store_name);
            }
        }

        let mut create_body = serde_json::Map::new();
        create_body.insert("display_name".to_string(), json!(display_name));
        if let Some(embedding_model) = &self.embedding_model {
            let normalized = embedding_model
                .strip_prefix("models/")
                .unwrap_or(embedding_model);
            create_body.insert(
                "embedding_config".to_string(),
                json!({ "model": format!("models/{normalized}") }),
            );
        }
        let create_body = Value::Object(create_body);

        let response = self
            .send_with_retry("store-create", || {
                self.http_client
                    .post(format!("{}/v1beta/fileSearchStores", self.gemini_base_url))
                    // RUST-SECRET-002: key via x-goog-api-key header, not the
                    // query string (reqwest leaks the URL in transport errors).
                    .header("x-goog-api-key", self.gemini_api_key.as_str())
                    .json(&create_body)
            })
            .await?;
        if !response.status().is_success() {
            return Err(gemini_api_error("store-create", response).await);
        }

        #[derive(Deserialize)]
        struct CreatedStore {
            name: String,
        }
        let created: CreatedStore = response.json().await.map_err(|source| {
            CorpusIngestionError::MalformedResponse {
                context: "store-create".to_string(),
                source,
            }
        })?;
        Ok(created.name)
    }

    /// Resumable upload of `content` (as `text/plain`) and return the uploaded
    /// file's `(resource_name, uri)`. Port of `uploadBufferToGemini`.
    async fn upload_text(
        &self,
        display_name: &str,
        content: &[u8],
    ) -> Result<(String, String), CorpusIngestionError> {
        let file_size = content.len();

        // 1) Start the resumable session.
        let init_response = self
            .send_with_retry("upload-init", || {
                self.http_client
                    .post(format!("{}/upload/v1beta/files", self.gemini_base_url))
                    // RUST-SECRET-002: key via x-goog-api-key header, not the
                    // query string (reqwest leaks the URL in transport errors).
                    .header("x-goog-api-key", self.gemini_api_key.as_str())
                    .header("X-Goog-Upload-Protocol", "resumable")
                    .header("X-Goog-Upload-Command", "start")
                    .header("X-Goog-Upload-Header-Content-Length", file_size.to_string())
                    .header("X-Goog-Upload-Header-Content-Type", "text/plain")
                    .header("Content-Type", "application/json")
                    .json(&json!({ "file": { "display_name": display_name } }))
            })
            .await?;
        if !init_response.status().is_success() {
            return Err(gemini_api_error("upload-init", init_response).await);
        }

        let upload_url = init_response
            .headers()
            .get("X-Goog-Upload-Url")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
            .ok_or(CorpusIngestionError::MissingUploadUrl)?;

        // 2) Upload + finalize the bytes in a single request.
        let content_bytes = content.to_vec();
        let upload_response = self
            .send_with_retry("upload-data", || {
                self.http_client
                    .post(upload_url.as_str())
                    .header("X-Goog-Upload-Offset", "0")
                    .header("X-Goog-Upload-Command", "upload, finalize")
                    .body(content_bytes.clone())
            })
            .await?;
        if !upload_response.status().is_success() {
            return Err(gemini_api_error("upload-data", upload_response).await);
        }

        #[derive(Deserialize)]
        struct UploadEnvelope {
            file: UploadedFile,
        }
        #[derive(Deserialize)]
        struct UploadedFile {
            name: String,
            uri: String,
        }
        let envelope: UploadEnvelope = upload_response.json().await.map_err(|source| {
            CorpusIngestionError::MalformedResponse {
                context: "upload-data".to_string(),
                source,
            }
        })?;
        Ok((envelope.file.name, envelope.file.uri))
    }

    /// Import an uploaded file into the store with citation/filter metadata.
    /// Port of `importFileToStore` (Drive-free: `source = "local_upload"`, a
    /// single `text/plain` document, no chunking config). The empty-`pdf_name`
    /// guard is preserved (an empty `pdf_name` is silently unfilterable).
    async fn import_file(
        &self,
        store_name: &str,
        file_resource_name: &str,
        document_name: &str,
        file_id: &str,
    ) -> Result<(), CorpusIngestionError> {
        if document_name.trim().is_empty() {
            return Err(CorpusIngestionError::MissingDocumentName);
        }

        let custom_metadata = json!([
            { "key": "source", "string_value": "local_upload" },
            { "key": "chunk_name", "string_value": document_name },
            { "key": "pdf_name", "string_value": document_name },
            { "key": "file_id", "string_value": file_id },
            { "key": "ingested_at", "numeric_value": current_unix_millis() },
            { "key": "mime_type", "string_value": "text/plain" },
        ]);
        let import_body = json!({
            "file_name": file_resource_name,
            "custom_metadata": custom_metadata,
        });

        let response = self
            .send_with_retry("import", || {
                self.http_client
                    .post(format!(
                        "{}/v1beta/{}:importFile",
                        self.gemini_base_url, store_name
                    ))
                    // RUST-SECRET-002: key via x-goog-api-key header, not the
                    // query string (reqwest leaks the URL in transport errors).
                    .header("x-goog-api-key", self.gemini_api_key.as_str())
                    .json(&import_body)
            })
            .await?;
        if !response.status().is_success() {
            return Err(gemini_api_error("import", response).await);
        }
        Ok(())
    }

    /// Poll the store's documents until the aggregate state resolves to `ACTIVE`
    /// or `FAILED`, or the poll budget is exhausted. Returns the last-observed
    /// documents and aggregate. Port of the `verifyFileActive` LRO poll, scoped
    /// store-wide (the store is freshly created for this run, so every document
    /// belongs to it).
    async fn poll_until_active(
        &self,
        store_name: &str,
    ) -> Result<(Vec<StoreDocumentRecord>, DocumentIndexingState), CorpusIngestionError> {
        let started_at = Instant::now();
        loop {
            let documents = self.list_store_documents(store_name).await?;
            let states: Vec<DocumentIndexingState> =
                documents.iter().map(|document| document.state).collect();
            let aggregate = aggregate_document_states(&states);

            if aggregate == DocumentIndexingState::Active
                || aggregate == DocumentIndexingState::Failed
                || started_at.elapsed() >= self.poll_timeout
            {
                return Ok((documents, aggregate));
            }

            tokio::time::sleep(self.poll_interval).await;
        }
    }

    /// List every document in a store (paginated at 20/page) with the metadata
    /// this adapter relates to files. Port of `listStoreDocuments`.
    async fn list_store_documents(
        &self,
        store_name: &str,
    ) -> Result<Vec<StoreDocumentRecord>, CorpusIngestionError> {
        let mut collected: Vec<StoreDocumentRecord> = Vec::new();
        let mut page_token: Option<String> = None;

        loop {
            let token_for_page = page_token.clone();
            let response = self
                .send_with_retry("store-docs", || {
                    let mut request = self
                        .http_client
                        .get(format!(
                            "{}/v1beta/{}/documents",
                            self.gemini_base_url, store_name
                        ))
                        // RUST-SECRET-002: key via header; only the non-secret
                        // pageSize param stays in the query string.
                        .header("x-goog-api-key", self.gemini_api_key.as_str())
                        .query(&[("pageSize", DOCUMENTS_PAGE_SIZE)]);
                    if let Some(token) = &token_for_page {
                        request = request.query(&[("pageToken", token.as_str())]);
                    }
                    request
                })
                .await?;
            if !response.status().is_success() {
                return Err(gemini_api_error("store-docs", response).await);
            }

            #[derive(Deserialize)]
            struct DocumentPage {
                #[serde(default)]
                documents: Vec<RawDocument>,
                #[serde(rename = "nextPageToken")]
                next_page_token: Option<String>,
            }
            #[derive(Deserialize)]
            struct RawDocument {
                state: Option<String>,
                #[serde(rename = "customMetadata", default)]
                custom_metadata: Vec<RawMetadata>,
            }
            #[derive(Deserialize)]
            struct RawMetadata {
                key: String,
                #[serde(rename = "stringValue")]
                string_value: Option<String>,
            }

            let page: DocumentPage = response.json().await.map_err(|source| {
                CorpusIngestionError::MalformedResponse {
                    context: "store-docs".to_string(),
                    source,
                }
            })?;

            for raw_document in page.documents {
                let read_string_metadata = |key: &str| {
                    raw_document
                        .custom_metadata
                        .iter()
                        .find(|metadata| metadata.key == key)
                        .and_then(|metadata| metadata.string_value.clone())
                };
                collected.push(StoreDocumentRecord {
                    state: DocumentIndexingState::from_wire(raw_document.state.as_deref()),
                    pdf_name: read_string_metadata("pdf_name"),
                    chunk_name: read_string_metadata("chunk_name"),
                    file_id: read_string_metadata("file_id"),
                });
            }

            match page.next_page_token {
                Some(token) if !token.is_empty() => page_token = Some(token),
                _ => break,
            }
        }

        Ok(collected)
    }

    /// Send a request built by `build`, retrying `429` / `5xx` responses a
    /// bounded number of times with exponential backoff. A transport error is
    /// returned immediately (no body to classify). Equivalent behaviour to
    /// `fetchWithRetry`, with local-scale (short) backoffs.
    async fn send_with_retry(
        &self,
        context: &str,
        build: impl Fn() -> reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, CorpusIngestionError> {
        let mut attempt: u32 = 0;
        loop {
            let response =
                build()
                    .send()
                    .await
                    .map_err(|source| CorpusIngestionError::Transport {
                        context: context.to_string(),
                        source,
                    })?;
            let status = response.status();
            let is_retryable = status.as_u16() == 429 || status.is_server_error();
            if is_retryable && attempt < MAX_TRANSIENT_RETRIES {
                attempt += 1;
                let backoff =
                    Duration::from_millis(TRANSIENT_BASE_DELAY_MS * 2u64.pow(attempt - 1));
                tokio::time::sleep(backoff).await;
                continue;
            }
            return Ok(response);
        }
    }
}

/// Build a [`CorpusIngestionError::GeminiApi`] from a non-success response,
/// reading the body once.
async fn gemini_api_error(context: &str, response: reqwest::Response) -> CorpusIngestionError {
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    CorpusIngestionError::GeminiApi {
        context: context.to_string(),
        status,
        body: truncate_error_body(body),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_wire_maps_active_variants() {
        assert_eq!(
            DocumentIndexingState::from_wire(Some("ACTIVE")),
            DocumentIndexingState::Active
        );
        assert_eq!(
            DocumentIndexingState::from_wire(Some("state_active")),
            DocumentIndexingState::Active
        );
        assert_eq!(
            DocumentIndexingState::from_wire(Some("1")),
            DocumentIndexingState::Active
        );
        // Missing state normalises to ACTIVE (reference behaviour).
        assert_eq!(
            DocumentIndexingState::from_wire(None),
            DocumentIndexingState::Active
        );
    }

    #[test]
    fn from_wire_maps_failed_and_processing() {
        assert_eq!(
            DocumentIndexingState::from_wire(Some("FAILED")),
            DocumentIndexingState::Failed
        );
        assert_eq!(
            DocumentIndexingState::from_wire(Some("3")),
            DocumentIndexingState::Failed
        );
        assert_eq!(
            DocumentIndexingState::from_wire(Some("PROCESSING")),
            DocumentIndexingState::Processing
        );
        assert_eq!(
            DocumentIndexingState::from_wire(Some("whatever")),
            DocumentIndexingState::Processing
        );
    }

    #[test]
    fn aggregate_states_follows_reference_rules() {
        use DocumentIndexingState::*;
        assert_eq!(aggregate_document_states(&[]), Processing);
        assert_eq!(aggregate_document_states(&[Active, Active]), Active);
        assert_eq!(aggregate_document_states(&[Active, Processing]), Processing);
        assert_eq!(aggregate_document_states(&[Active, Failed]), Failed);
        // FAILED dominates even alongside PROCESSING.
        assert_eq!(aggregate_document_states(&[Processing, Failed]), Failed);
    }

    #[test]
    fn generate_store_name_normalizes() {
        assert_eq!(
            generate_store_name("local-ABC_123.def"),
            "fileSearchStores/folder-local-abc-123-def"
        );
    }

    #[test]
    fn strip_pdf_suffix_is_case_insensitive() {
        assert_eq!(strip_pdf_suffix("report.pdf"), "report");
        assert_eq!(strip_pdf_suffix("report.PDF"), "report");
        assert_eq!(strip_pdf_suffix("notes.md"), "notes.md");
        assert_eq!(strip_pdf_suffix(".pdf"), "");
    }

    fn document(
        state: DocumentIndexingState,
        pdf_name: Option<&str>,
        chunk_name: Option<&str>,
        file_id: Option<&str>,
    ) -> StoreDocumentRecord {
        StoreDocumentRecord {
            state,
            pdf_name: pdf_name.map(str::to_string),
            chunk_name: chunk_name.map(str::to_string),
            file_id: file_id.map(str::to_string),
        }
    }

    #[test]
    fn document_belongs_by_file_id_when_present() {
        let doc = document(DocumentIndexingState::Active, None, None, Some("fid-1"));
        assert!(document_belongs_to_file(&doc, "fid-1", "any.txt"));
        // Both file ids present but different → belongs returns false (does not
        // fall through to name matching).
        let other = document(
            DocumentIndexingState::Active,
            Some("any.txt"),
            Some("any.txt"),
            Some("fid-2"),
        );
        assert!(!document_belongs_to_file(&other, "fid-1", "any.txt"));
    }

    #[test]
    fn document_belongs_by_chunk_name_and_pdf_name() {
        // No usable file id → fall back to chunk name (exact or `_p` prefix).
        let exact = document(DocumentIndexingState::Active, None, Some("guide.pdf"), None);
        assert!(document_belongs_to_file(&exact, "", "guide.pdf"));

        let paged = document(
            DocumentIndexingState::Active,
            None,
            Some("guide_p1-3.pdf"),
            None,
        );
        assert!(document_belongs_to_file(&paged, "", "guide.pdf"));

        // No chunk name → pdf name exact match.
        let by_pdf = document(DocumentIndexingState::Active, Some("guide.pdf"), None, None);
        assert!(document_belongs_to_file(&by_pdf, "", "guide.pdf"));

        // Nothing matches.
        let unrelated = document(DocumentIndexingState::Active, Some("other.pdf"), None, None);
        assert!(!document_belongs_to_file(&unrelated, "", "guide.pdf"));
    }

    #[test]
    fn ingestion_error_maps_to_ai_adapter_failure() {
        let error = CorpusIngestionError::MissingUploadUrl;
        let mapped: ApplicationError = error.into();
        assert!(matches!(
            mapped,
            ApplicationError::ArtificialIntelligenceAdapterFailure { .. }
        ));
    }

    #[test]
    fn ingestion_error_passes_through_persistence() {
        let error = CorpusIngestionError::Persistence(ApplicationError::DocumentCollectionFailure {
            failure_description: "boom".to_string(),
        });
        let mapped: ApplicationError = error.into();
        assert!(matches!(
            mapped,
            ApplicationError::DocumentCollectionFailure { .. }
        ));
    }

    #[test]
    fn ingested_corpus_file_serializes_camel_case() {
        let file = IngestedCorpusFile {
            file_id: "fid".to_string(),
            name: "n.txt".to_string(),
            mime_type: "text/markdown".to_string(),
            size: 12,
            status: "indexed".to_string(),
            gemini_file_uri: Some("files/abc".to_string()),
            indexed_at: Some("unix:5".to_string()),
            error: None,
        };
        let value = serde_json::to_value(&file).unwrap();
        assert_eq!(value.get("fileId").unwrap(), "fid");
        assert_eq!(value.get("mimeType").unwrap(), "text/markdown");
        assert_eq!(value.get("geminiFileUri").unwrap(), "files/abc");
        assert_eq!(value.get("indexedAt").unwrap(), "unix:5");
        // None error is omitted.
        assert!(value.get("error").is_none());
    }
}
