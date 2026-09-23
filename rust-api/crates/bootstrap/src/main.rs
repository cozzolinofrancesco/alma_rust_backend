mod config;

use crate::config::{RATE_LIMIT_MAXIMUM_REQUESTS, RATE_LIMIT_WINDOW_SECONDS, RuntimeConfiguration};
use alma_application::ports::ai::ArtificialIntelligencePort;
use alma_application::ports::document_collection::DocumentCollectionPort;
use alma_application::ports::google_drive::GoogleDriveObjectPort;
use alma_application::ports::retrieval::RetrievalPort;
use alma_http::build_complete_router;
use alma_http::categories::rag::collections::RAG_KNOWLEDGE_COLLECTION_NAME;
use alma_http::middleware::{RateLimitingLayer, RequestObservationLayer};
use alma_http::state::ApplicationState;
use alma_infrastructure::ai::{DeterministicEchoingAiAdapter, GeminiAiAdapter};
use alma_infrastructure::document_collection::InMemoryDocumentCollectionStore;
use alma_infrastructure::durable_document_collection::FileBackedDocumentCollectionStore;
use alma_infrastructure::literature::CannedLiteratureSourceAdapter;
use alma_infrastructure::google_drive::{GoogleDriveClient, DEFAULT_GOOGLE_DRIVE_BASE_URL};
use alma_infrastructure::persistence::InMemoryUnitOfWork;
use alma_infrastructure::rag_ingest::GeminiCorpusIngestionAdapter;
use alma_infrastructure::retrieval::{GeminiFileSearchRetrievalAdapter, LexicalRetrievalAdapter};
use alma_infrastructure::storage::InMemoryBlobStorageAdapter;
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tracing_subscriber::EnvFilter;

type FullyResolvedApplicationState = ApplicationState<InMemoryUnitOfWork>;

/// Optional override for the Gemini File Search model. Empty (the default) lets
/// the retrieval adapter resolve its own `DEFAULT_FILE_SEARCH_MODEL`, which is
/// the file-search-capable model rather than the text-generation default.
const FILE_SEARCH_MODEL_VARIABLE: &str = "GEMINI_FILE_SEARCH_MODEL";

#[tokio::main]
async fn main() {
    // Load `.env` / `.env.local` into the process environment BEFORE anything
    // reads it, so the backend simply *receives* its config from the env —
    // exactly like the Next.js reference auto-loads `.env.local`.
    load_environment_files_like_nextjs();

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_missing_directive| EnvFilter::new("info")),
        )
        .init();

    let runtime_configuration = RuntimeConfiguration::resolve_from_environment();

    // Env-driven real-vs-stub adapter selection (plan Phase 0). All three seams
    // are `Arc<dyn Port>`, so the swap is a single branch: a usable
    // `GEMINI_API_KEY` wires the real Gemini generation + File Search retrieval
    // adapters and the file-backed durable document store; its absence falls
    // back to the hermetic echo / lexical / in-memory stubs (no key ⇒ echo /
    // lexical / in-memory).
    // One shared reqwest client for the adapters that make their own outbound
    // calls from the composition root (corpus ingestion; Google Drive).
    let shared_http_client = reqwest::Client::new();

    let (
        artificial_intelligence_adapter,
        retrieval_adapter,
        document_collection,
        corpus_ingestion_adapter,
    ): (
        Arc<dyn ArtificialIntelligencePort>,
        Arc<dyn RetrievalPort>,
        Arc<dyn DocumentCollectionPort>,
        Option<Arc<GeminiCorpusIngestionAdapter>>,
    ) = if let Some(gemini_api_key) = runtime_configuration.gemini_api_key.clone() {
        let artificial_intelligence_adapter: Arc<dyn ArtificialIntelligencePort> =
            Arc::new(GeminiAiAdapter::construct(
                gemini_api_key.clone(),
                runtime_configuration.gemini_base_url.clone(),
                runtime_configuration.default_model_id.clone(),
            ));

        let retrieval_adapter: Arc<dyn RetrievalPort> =
            Arc::new(GeminiFileSearchRetrievalAdapter::construct(
                runtime_configuration.gemini_base_url.clone(),
                gemini_api_key.clone(),
                resolve_file_search_model(),
            ));

        let document_collection: Arc<dyn DocumentCollectionPort> = Arc::new(
            FileBackedDocumentCollectionStore::load_from_directory(
                runtime_configuration.data_directory.clone(),
            )
            .await
            .expect("the durable document store must load from the configured data directory"),
        );

        // Real corpus ingestion (create File Search store → resumable upload →
        // importFile → poll ACTIVE → persist), sharing the durable document store
        // so ingested corpora are visible to retrieval / qc.
        let corpus_ingestion_adapter: Option<Arc<GeminiCorpusIngestionAdapter>> =
            Some(Arc::new(GeminiCorpusIngestionAdapter::construct(
                shared_http_client.clone(),
                gemini_api_key,
                runtime_configuration.gemini_base_url.clone(),
                Arc::clone(&document_collection),
            )));

        tracing::info!(
            data_directory = %runtime_configuration.data_directory.display(),
            "wired the real Gemini generation + File Search retrieval + corpus ingestion adapters and the durable document store"
        );

        (
            artificial_intelligence_adapter,
            retrieval_adapter,
            document_collection,
            corpus_ingestion_adapter,
        )
    } else {
        // The lexical fallback scores the same knowledge collection the RAG
        // handlers write into, so it shares the in-memory document store.
        let document_collection: Arc<dyn DocumentCollectionPort> =
            Arc::new(InMemoryDocumentCollectionStore::construct_empty());

        let retrieval_adapter: Arc<dyn RetrievalPort> = Arc::new(LexicalRetrievalAdapter::construct(
            Arc::clone(&document_collection),
            RAG_KNOWLEDGE_COLLECTION_NAME,
        ));

        let artificial_intelligence_adapter: Arc<dyn ArtificialIntelligencePort> =
            Arc::new(DeterministicEchoingAiAdapter::default());

        tracing::info!(
            "no GEMINI_API_KEY present; wired the hermetic echo / lexical / in-memory stub adapters (corpus ingestion disabled)"
        );

        (
            artificial_intelligence_adapter,
            retrieval_adapter,
            document_collection,
            None,
        )
    };

    // Per-user Google Drive: authenticates with the caller's `Authorization:
    // Bearer` token, so it needs no server credential and is wired unconditionally.
    let google_drive_adapter: Arc<dyn GoogleDriveObjectPort> = Arc::new(
        GoogleDriveClient::construct(shared_http_client.clone(), resolve_google_drive_base_url()),
    );

    let fully_resolved_application_state: FullyResolvedApplicationState =
        ApplicationState::assemble_from_adapters(
            Arc::new(InMemoryBlobStorageAdapter::construct_empty()),
            artificial_intelligence_adapter,
            Arc::new(CannedLiteratureSourceAdapter::default()),
            retrieval_adapter,
            document_collection,
            Arc::new(InMemoryUnitOfWork::construct_empty()),
            corpus_ingestion_adapter,
            google_drive_adapter,
        );

    // API-only server: this is a pure backend, so there is no SPA / static-file
    // serving. Unmatched routes return axum's default 404.
    let assembled_router = build_complete_router::<InMemoryUnitOfWork>()
        .layer(RateLimitingLayer::<
            RATE_LIMIT_WINDOW_SECONDS,
            RATE_LIMIT_MAXIMUM_REQUESTS,
        >::construct())
        .layer(RequestObservationLayer::construct())
        .layer(CorsLayer::permissive())
        .with_state(fully_resolved_application_state);

    let bound_listener = tokio::net::TcpListener::bind(&runtime_configuration.bind_address)
        .await
        .expect("the configured bind address must be available");

    tracing::info!(
        bind_address = %runtime_configuration.bind_address,
        service_key_enforced = runtime_configuration.service_key_is_enforced(),
        "the alma rust api is now accepting connections"
    );

    axum::serve(bound_listener, assembled_router)
        .await
        .expect("the http server terminated unexpectedly");
}

/// Resolve the Gemini File Search model override. An empty result is intentional:
/// the retrieval adapter substitutes its own `DEFAULT_FILE_SEARCH_MODEL`.
fn resolve_file_search_model() -> String {
    read_trimmed_environment_string(FILE_SEARCH_MODEL_VARIABLE).unwrap_or_default()
}

/// Resolve the Google Drive API base URL. Defaults to the real Drive host; an
/// override (`GOOGLE_DRIVE_BASE_URL`) lets tests point the client at a local mock.
fn resolve_google_drive_base_url() -> String {
    read_trimmed_environment_string("GOOGLE_DRIVE_BASE_URL")
        .unwrap_or_else(|| DEFAULT_GOOGLE_DRIVE_BASE_URL.to_string())
}

/// Read an environment variable, treating unset and whitespace-only values as
/// absent so an exported-but-empty override never masks the intended default.
fn read_trimmed_environment_string(variable_name: &str) -> Option<String> {
    std::env::var(variable_name)
        .ok()
        .map(|raw_value| raw_value.trim().to_string())
        .filter(|trimmed_value| !trimmed_value.is_empty())
}

/// Load `.env` then `.env.local` into the process environment, mirroring how the
/// Next.js reference auto-loads env files so the backend merely *receives* the
/// key. Precedence: an already-exported real env var always wins; among files
/// `.env.local` overrides `.env`. Files are discovered by walking up from the
/// process cwd to the filesystem root (so `cargo run` from `rust-api/` still
/// finds the repo-root file); a missing file is non-fatal. Parsing tolerates
/// `KEY = value` (spaces around `=`), an optional `export ` prefix, `#`
/// comments, blank lines, and one pair of surrounding quotes — matching the
/// dotenv/Next.js format the real `.env.local` uses.
fn load_environment_files_like_nextjs() {
    let preexisting_variables: std::collections::HashSet<String> = std::env::vars_os()
        .filter_map(|(key, _value)| key.into_string().ok())
        .collect();
    for file_name in [".env", ".env.local"] {
        if let Some(path) = find_environment_file_upwards(file_name) {
            apply_environment_file(&path, &preexisting_variables);
        }
    }
}

/// Walk up from the current working directory to the filesystem root looking for
/// `file_name`, returning the first match.
fn find_environment_file_upwards(file_name: &str) -> Option<std::path::PathBuf> {
    let mut directory = std::env::current_dir().ok()?;
    loop {
        let candidate = directory.join(file_name);
        if candidate.is_file() {
            return Some(candidate);
        }
        if !directory.pop() {
            return None;
        }
    }
}

/// Parse a dotenv-style file and set each variable absent from the original
/// (pre-existing) environment, so real exported vars win while `.env.local` may
/// still override values that came from `.env`.
fn apply_environment_file(
    path: &std::path::Path,
    preexisting_variables: &std::collections::HashSet<String>,
) {
    let Ok(contents) = std::fs::read_to_string(path) else {
        return;
    };
    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let assignment = line.strip_prefix("export ").unwrap_or(line);
        let Some((raw_key, raw_value)) = assignment.split_once('=') else {
            continue;
        };
        let key = raw_key.trim();
        if key.is_empty() || preexisting_variables.contains(key) {
            continue;
        }
        let value = strip_matching_quotes(raw_value.trim());
        // SAFETY: called once at the very start of `main`, before any worker
        // task reads the environment, so there is no concurrent env access
        // despite `set_var` being `unsafe` under edition 2024.
        unsafe {
            std::env::set_var(key, value);
        }
    }
}

/// Strip a single pair of matching surrounding single or double quotes.
fn strip_matching_quotes(value: &str) -> &str {
    let bytes = value.as_bytes();
    if bytes.len() >= 2 {
        let first_byte = bytes[0];
        let last_byte = bytes[bytes.len() - 1];
        if (first_byte == b'"' && last_byte == b'"')
            || (first_byte == b'\'' && last_byte == b'\'')
        {
            return &value[1..value.len() - 1];
        }
    }
    value
}
