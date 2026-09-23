//! `GET /api/v1/agentnodes/capabilities` — the portable API capability descriptor.
//!
//! Ports `portableCapabilities` from
//! `frontend_v3/app/lib/agentExecution/capabilities.server.ts` under **equivalent-behavior**
//! parity, adapted to this build's documented v1 cuts. The reference serves this operation
//! behind `withExecutionAuth` (see `app/api/v1/agentnodes/[[...segments]]/route.ts`'s `GET`
//! handler), so this port enforces the same shared-secret perimeter via the
//! `HttpRequestInPipeline<RequestHasBeenAuthorized>` extractor — a `FromRequestParts`
//! extractor, so it is safe on a bodyless `GET`.
//!
//! ## Descriptor content: honest to *this* build, not the reference's constants
//!
//! `capabilities` is a contract a caller reads before choosing a model or an operation, so
//! every value it advertises must match what the rest of the category actually enforces:
//!
//! - **Model catalog.** The reference reports `DEFAULT_MODEL` (`gemini-3.6-flash`) and its
//!   full `AVAILABLE_MODELS`. This port's [`execute_step_handler`](super::execute_step_handler)
//!   instead gates every step against the `GEMINI_DEFAULT_MODEL` / `GEMINI_AVAILABLE_MODELS`
//!   env catalog (defaulting to `gemini-3.5-flash` + the five ids in `bootstrap/config.rs`
//!   `DEFAULT_AVAILABLE_MODELS`). Advertising `gemini-3.6-flash` here would tell callers to
//!   pick a model the executor rejects with `UNSUPPORTED_MODEL`, so `defaults.textModel` and
//!   `models` mirror the executor's own catalog (resolved with the identical env + fallbacks).
//!   Per-model token limits use the reference `getModelInfo` fallback (`maxInputTokens`
//!   1_048_576, `maxOutputTokens` 65_536).
//! - **Image generation (v1 cut).** This build has no image endpoint and `execute_step_handler`
//!   rejects image models. Advertising `IMAGE_GENERATION_MODELS` / `DEFAULT_IMAGE_MODEL` would
//!   be dishonest, so `imageModels` is `[]` and `defaults.imageModel` is `null`.
//! - **Operations.** Enumerates exactly the surface `routes.rs` wires. `272/prepare-source`
//!   and the agent-graph `GET`/`PUT` endpoints are intentionally omitted — `routes.rs`
//!   documents them as not wired in this stage, so advertising them would return `NOT_FOUND`.
//!
//! Provider flags mirror the reference reads (`GEMINI_API_KEY` present ⇒ `geminiConfigured`,
//! `GALILEO_ENABLED == "true"` ⇒ `galileoFlagEnabled`), read from the environment here for the
//! same reason `pipeline/extractor.rs` reads `SERVICE_API_KEY` directly: the resolved
//! `RuntimeConfiguration` lives in `bootstrap`, which depends on this crate.

use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::agentnodes::error::AgentExecutionError;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};

use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;

/// Reference base path the descriptor advertises (`portableCapabilities().basePath`).
const BASE_PATH: &str = "/api/v1/agentnodes";

/// The POST surface this router serves, in the reference's relative order minus the two
/// operations `routes.rs` leaves unwired in this stage (`272/prepare-source` and the
/// agent-graph endpoints). Each entry is advertised as `POST <operation>`.
const POST_OPERATIONS: [&str; 8] = [
    "steps/execute",
    "272/compile",
    "runs/plan",
    "runs/advance",
    "documents/assemble",
    "exports/json",
    "exports/markdown",
    "exports/docx",
];

/// Default text model when `GEMINI_DEFAULT_MODEL` is unset. Mirrors
/// `execute_step_handler::FALLBACK_DEFAULT_MODEL` and `bootstrap/config.rs`
/// `DEFAULT_GENERATION_MODEL` so the advertised default is one the executor accepts.
const FALLBACK_DEFAULT_MODEL: &str = "gemini-3.5-flash";

/// Resolvable model ids when `GEMINI_AVAILABLE_MODELS` is unset. Mirrors
/// `execute_step_handler::FALLBACK_AVAILABLE_MODELS` / `bootstrap/config.rs`
/// `DEFAULT_AVAILABLE_MODELS`.
const FALLBACK_AVAILABLE_MODELS: [&str; 5] = [
    "gemini-2.5-flash",
    "gemini-3.5-flash",
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite",
];

/// 32 MB request cap (`http.server.ts` `MAX_REQUEST_BYTES`).
const MAX_REQUEST_BYTES: u64 = 32 * 1024 * 1024;
/// 30 MB combined-file cap (`fileValidation` `MAX_FILE_SIZE_BYTES`, shared with
/// `execute_step_handler`).
const MAX_COMBINED_FILE_BYTES: u64 = 30 * 1024 * 1024;
/// Request timeout in milliseconds (`http.server.ts` `REQUEST_TIMEOUT_MS`).
const REQUEST_TIMEOUT_MS: u64 = 240_000;
/// Per-step file / page / step limits (`portableCapabilities().limits`).
const FILES_PER_STEP: u64 = 5;
const PDF_PAGES_PER_STEP: u64 = 1000;
const STEPS_PER_AGENT: u64 = 500;

/// Per-model token limits, from the reference `getModelInfo` dynamic-model fallback.
const MODEL_MAX_INPUT_TOKENS: u64 = 1_048_576;
const MODEL_MAX_OUTPUT_TOKENS: u64 = 65_536;

/// `GET /api/v1/agentnodes/capabilities`.
///
/// Enforces the shared-secret perimeter (`_authorized_request`), then returns the portable
/// capability descriptor. `State` is accepted only to keep the category's handler signature
/// uniform (the descriptor performs no I/O); it is otherwise unused.
#[route(method = "GET", path = "/api/v1/agentnodes/capabilities")]
pub async fn capabilities_handler<TransactionalUnitOfWork>(
    State(_application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> Result<Json<Value>, AgentExecutionError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let default_text_model = resolve_default_model();
    let available_models = resolve_available_models(&default_text_model);
    let gemini_configured = read_env_trimmed("GEMINI_API_KEY").is_some();
    let galileo_flag_enabled = std::env::var("GALILEO_ENABLED")
        .map(|raw| raw == "true")
        .unwrap_or(false);

    let descriptor = build_capabilities_descriptor(
        &default_text_model,
        &available_models,
        gemini_configured,
        galileo_flag_enabled,
    );
    Ok(Json(descriptor))
}

/// Build the capability descriptor. Pure over its inputs (no env, no I/O) so it is unit
/// testable; the handler resolves the environment-derived arguments and calls it.
fn build_capabilities_descriptor(
    default_text_model: &str,
    available_models: &[String],
    gemini_configured: bool,
    galileo_flag_enabled: bool,
) -> Value {
    let models: Vec<Value> = available_models
        .iter()
        .map(|model_id| {
            json!({
                "id": model_id,
                "maxInputTokens": MODEL_MAX_INPUT_TOKENS,
                "maxOutputTokens": MODEL_MAX_OUTPUT_TOKENS,
            })
        })
        .collect();

    let mut operations: Vec<String> = Vec::with_capacity(POST_OPERATIONS.len() + 1);
    operations.push(String::from("GET capabilities"));
    operations.extend(POST_OPERATIONS.iter().map(|operation| format!("POST {operation}")));

    json!({
        "schemaVersions": [1],
        "basePath": BASE_PATH,
        "operations": operations,
        "authentication": {
            "compute": "x-api-key",
            "googleSources": "Optional Google OAuth Authorization: Bearer token",
            "browserSessionRequired": false,
        },
        "execution": {
            "mode": "caller-driven",
            "stepsPerAdvance": 1,
            "storage": "caller-owned",
            "backgroundJobs": false,
            "exactlyOnce": false,
        },
        "limits": {
            "requestBytes": MAX_REQUEST_BYTES,
            "combinedFileBytes": MAX_COMBINED_FILE_BYTES,
            "filesPerStep": FILES_PER_STEP,
            "pdfPagesPerStep": PDF_PAGES_PER_STEP,
            "stepsPerAgent": STEPS_PER_AGENT,
            "requestTimeoutMs": REQUEST_TIMEOUT_MS,
        },
        "sources": ["text", "upload", "authorized-corpus"],
        "templates": ["json", "yaml", "authorized-google-sheet"],
        "exports": ["json", "markdown", "docx"],
        "defaults": {
            "textModel": default_text_model,
            // v1 cut: no image-generation path in this build (see execute_step_handler,
            // which rejects image models with UNSUPPORTED_MODEL).
            "imageModel": Value::Null,
        },
        "models": models,
        // v1 cut: image generation is not exposed by this build's router.
        "imageModels": Vec::<String>::new(),
        "providers": {
            "geminiConfigured": gemini_configured,
            "galileoFlagEnabled": galileo_flag_enabled,
            "liveAvailabilityVerified": false,
            "galileoValidation":
                "Catalog, configuration and input compatibility are checked per request.",
        },
    })
}

/// Read a trimmed, non-empty environment variable (mirrors
/// `execute_step_handler::read_env_trimmed` and `config.rs::read_environment_string`:
/// unset and whitespace-only both read as absent).
fn read_env_trimmed(variable_name: &str) -> Option<String> {
    std::env::var(variable_name)
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|trimmed| !trimmed.is_empty())
}

/// Resolve the advertised default text model (mirrors `execute_step_handler::resolve_default_model`).
fn resolve_default_model() -> String {
    read_env_trimmed("GEMINI_DEFAULT_MODEL").unwrap_or_else(|| FALLBACK_DEFAULT_MODEL.to_string())
}

/// Resolve the advertised model catalog (mirrors `execute_step_handler::resolve_model_catalog`):
/// the comma-separated `GEMINI_AVAILABLE_MODELS` env list, or the built-in fallbacks, always
/// with the resolved default model present (prepended if the list omits it).
fn resolve_available_models(default_model: &str) -> Vec<String> {
    let parsed = read_env_trimmed("GEMINI_AVAILABLE_MODELS")
        .map(|raw| {
            raw.split(',')
                .map(|entry| entry.trim().to_string())
                .filter(|entry| !entry.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|parsed| !parsed.is_empty())
        .unwrap_or_else(|| {
            FALLBACK_AVAILABLE_MODELS
                .iter()
                .map(|model| model.to_string())
                .collect()
        });
    ensure_default_present(parsed, default_model)
}

/// Prepend `default_model` to `models` when it is not already present, preserving order.
fn ensure_default_present(mut models: Vec<String>, default_model: &str) -> Vec<String> {
    if !models.iter().any(|model| model == default_model) {
        models.insert(0, default_model.to_string());
    }
    models
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operations_list_advertises_only_the_wired_surface() {
        let descriptor =
            build_capabilities_descriptor("gemini-3.5-flash", &["gemini-3.5-flash".into()], false, false);
        let operations = descriptor["operations"].as_array().expect("operations array");
        // GET capabilities + the eight wired POST operations.
        assert_eq!(operations.len(), POST_OPERATIONS.len() + 1);
        assert_eq!(operations[0], json!("GET capabilities"));
        assert!(operations.iter().any(|op| op == &json!("POST steps/execute")));
        // The unwired reference operation must not be advertised.
        assert!(!operations.iter().any(|op| op == &json!("POST 272/prepare-source")));
    }

    #[test]
    fn execution_semantics_match_the_caller_driven_contract() {
        let descriptor =
            build_capabilities_descriptor("gemini-3.5-flash", &["gemini-3.5-flash".into()], false, false);
        assert_eq!(descriptor["execution"]["stepsPerAdvance"], json!(1));
        assert_eq!(descriptor["execution"]["mode"], json!("caller-driven"));
        assert_eq!(descriptor["execution"]["backgroundJobs"], json!(false));
        assert_eq!(descriptor["basePath"], json!(BASE_PATH));
        assert_eq!(descriptor["schemaVersions"], json!([1]));
    }

    #[test]
    fn image_generation_is_reported_as_a_v1_cut() {
        let descriptor =
            build_capabilities_descriptor("gemini-3.5-flash", &["gemini-3.5-flash".into()], false, false);
        assert_eq!(descriptor["imageModels"], json!([]));
        assert_eq!(descriptor["defaults"]["imageModel"], Value::Null);
    }

    #[test]
    fn models_carry_id_and_token_limits_and_reflect_the_default() {
        let available = vec!["gemini-3.5-flash".to_string(), "gemini-2.5-flash".to_string()];
        let descriptor = build_capabilities_descriptor("gemini-3.5-flash", &available, true, true);
        let models = descriptor["models"].as_array().expect("models array");
        assert_eq!(models.len(), 2);
        assert_eq!(models[0]["id"], json!("gemini-3.5-flash"));
        assert_eq!(models[0]["maxInputTokens"], json!(MODEL_MAX_INPUT_TOKENS));
        assert_eq!(models[0]["maxOutputTokens"], json!(MODEL_MAX_OUTPUT_TOKENS));
        assert_eq!(descriptor["defaults"]["textModel"], json!("gemini-3.5-flash"));
        assert_eq!(descriptor["providers"]["geminiConfigured"], json!(true));
        assert_eq!(descriptor["providers"]["galileoFlagEnabled"], json!(true));
    }

    #[test]
    fn default_model_is_prepended_when_absent_and_kept_when_present() {
        assert_eq!(
            ensure_default_present(vec!["a".into(), "b".into()], "z"),
            vec!["z".to_string(), "a".to_string(), "b".to_string()]
        );
        assert_eq!(
            ensure_default_present(vec!["a".into(), "z".into()], "z"),
            vec!["a".to_string(), "z".to_string()]
        );
    }
}
