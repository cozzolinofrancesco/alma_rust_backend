//! `POST /api/v1/agentnodes/runs/plan` — derive a portable execution plan, mint its
//! initial checkpoint, persist the durable run record, and return the first step's inputs.
//!
//! Ports `planPortableRun` from `frontend_v3/app/lib/agentExecution/runner.server.ts`:
//!
//! ```ts
//! export function planPortableRun(raw: unknown) {
//!   const plan = createExecutionPlan(raw);
//!   const checkpoint = createCheckpoint(plan);
//!   return { schemaVersion: 1, plan, checkpoint, nextInputs: nextStepInputs(plan, checkpoint) };
//! }
//! ```
//!
//! The pure plan derivation (validation, topological ordering, plan hashing, checkpoint
//! minting, next-step inputs) lives in [`alma_domain::agentnodes::planner`]; this handler is
//! the thin orchestration around it: resolve the plan-time model catalog + run identity,
//! call [`plan_portable_run`], then persist the `{ runId, createdAt, revision, plan,
//! checkpoint }` run record to the [`AGENT_RUNS_COLLECTION_NAME`] collection so `runs/advance`
//! can resume and revision-check it (see `collections.rs`).
//!
//! ## Model-catalog correctness (why the domain default must be resolvable)
//!
//! `createExecutionPlan` normalizes the bundle with `selectedModel ?? DEFAULT_MODEL`, so any
//! layer that omits `selectedModel` is stamped with the **domain** default
//! ([`alma_domain::agentnodes::validation::DEFAULT_MODEL`] = `gemini-3.6-flash`). The plan-time
//! `UNSUPPORTED_MODEL` gate then checks that model against the injected [`ModelCatalog`].
//! The configured available-model set (`GEMINI_AVAILABLE_MODELS` / `config.rs`
//! `DEFAULT_AVAILABLE_MODELS`) is built around the *generation* default `gemini-3.5-flash`
//! and does not contain `gemini-3.6-flash`; a catalog built from config alone would therefore
//! reject every unspecified-model step at plan time. [`resolve_plan_model_catalog`] guarantees
//! both the configured generation default and the domain default are resolvable so plans with
//! implicit models (the 272 / IB bundles) plan cleanly.

use crate::categories::agentnodes::collections::AGENT_RUNS_COLLECTION_NAME;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::ports::document_collection::{DocumentCollectionPort, StoredDocument};
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::agentnodes::dto::{ExecutionCheckpoint, ExecutionPlan};
use alma_domain::agentnodes::error::{AgentExecutionError, stage};
use alma_domain::agentnodes::planner::{PlanIdentity, StaticModelCatalog, plan_portable_run};
use alma_domain::agentnodes::validation::DEFAULT_MODEL as DOMAIN_DEFAULT_MODEL;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// Configured generation default id, mirroring `bootstrap/config.rs`
/// `DEFAULT_GENERATION_MODEL` and `execute_step_handler`'s `FALLBACK_DEFAULT_MODEL`. Used only
/// to keep the plan-time catalog aligned with what execute-time will accept.
const FALLBACK_DEFAULT_MODEL: &str = "gemini-3.5-flash";

/// Configured resolvable model ids, mirroring `bootstrap/config.rs` `DEFAULT_AVAILABLE_MODELS`.
/// Backs the plan-time `getModelInfo(model)?.maxInputTokens` gate when `GEMINI_AVAILABLE_MODELS`
/// is unset.
const FALLBACK_AVAILABLE_MODELS: [&str; 5] = [
    "gemini-2.5-flash",
    "gemini-3.5-flash",
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite",
];

#[route(method = "POST", path = "/api/v1/agentnodes/runs/plan")]
pub async fn plan_run_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, AgentExecutionError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // Mint a fresh run identity (v4 UUID runId + RFC-3339 createdAt) and resolve the plan-time
    // model catalog, then run the pure plan derivation (`planPortableRun`).
    let identity = PlanIdentity::generate(now_rfc3339());
    let catalog = resolve_plan_model_catalog();
    let plan_run_result = plan_portable_run(&submitted_body, &identity, &catalog)?;

    // Persist the durable run record so `runs/advance` can resume and revision-check it.
    persist_run_record(
        &application_state.document_collection,
        authorized_request.authorized_principal().as_str(),
        &plan_run_result.plan,
        &plan_run_result.checkpoint,
    )
    .await?;

    // `{ schemaVersion, plan, checkpoint, nextInputs }` (camelCase via `PlanRunResult`).
    let response_body = serde_json::to_value(&plan_run_result).map_err(serialization_error)?;
    Ok(Json(response_body))
}

/// Persist the `{ runId, createdAt, revision, plan, checkpoint }` run record keyed by `runId`.
///
/// Mirrors the `collections.rs` contract for [`AGENT_RUNS_COLLECTION_NAME`]. The run is bound to
/// the authorized principal for auditing (the schemaless store keeps `owning_account` separate
/// from the opaque body). A durable-store write failure surfaces as `RUN_PERSISTENCE_FAILED`
/// (500) — the plan derivation itself already succeeded, but the run would not be resumable.
async fn persist_run_record(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    owning_account: &str,
    plan: &ExecutionPlan,
    checkpoint: &ExecutionCheckpoint,
) -> Result<(), AgentExecutionError> {
    let plan_value = serde_json::to_value(plan).map_err(serialization_error)?;
    let checkpoint_value = serde_json::to_value(checkpoint).map_err(serialization_error)?;

    let run_document = StoredDocument {
        document_identifier: plan.run_id.clone(),
        owning_account: Some(owning_account.to_string()),
        document_body: json!({
            "kind": "agent_run",
            "runId": plan.run_id.clone(),
            "createdAt": plan.created_at.clone(),
            "revision": checkpoint.revision,
            "plan": plan_value,
            "checkpoint": checkpoint_value,
        }),
    };

    document_collection
        .insert_document(AGENT_RUNS_COLLECTION_NAME, run_document)
        .await
        .map_err(|error| {
            AgentExecutionError::new(
                "RUN_PERSISTENCE_FAILED",
                format!("Could not persist the run record. Retry the run. ({error})"),
                StatusCode::INTERNAL_SERVER_ERROR,
                stage::INPUT,
            )
        })
}

/// Build the plan-time [`StaticModelCatalog`] whose resolvable set is the configured available
/// models plus both the configured generation default and the domain default (see the module
/// docs — the domain default backs every layer that omits `selectedModel`, so it must resolve).
fn resolve_plan_model_catalog() -> StaticModelCatalog {
    let mut models: Vec<String> = read_env_trimmed("GEMINI_AVAILABLE_MODELS")
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

    // The configured generation default must resolve (config.rs guarantees it is in the
    // available set; mirror that here for env-only overrides that omit it).
    let configured_default =
        read_env_trimmed("GEMINI_DEFAULT_MODEL").unwrap_or_else(|| FALLBACK_DEFAULT_MODEL.to_string());
    ensure_model_present(&mut models, configured_default);

    // The domain default (`selectedModel ?? DEFAULT_MODEL`) must resolve, or steps that omit a
    // model are wrongly rejected `UNSUPPORTED_MODEL` at plan time.
    ensure_model_present(&mut models, DOMAIN_DEFAULT_MODEL.to_string());

    StaticModelCatalog::new(models)
}

/// Append `model` to `models` when it is not already present (order-preserving).
fn ensure_model_present(models: &mut Vec<String>, model: String) {
    if !models.iter().any(|existing| existing == &model) {
        models.push(model);
    }
}

/// Read a trimmed, non-empty environment variable (mirrors `execute_step_handler`'s
/// `read_env_trimmed`: process config lives in bootstrap/env, not in `ApplicationState`).
fn read_env_trimmed(variable_name: &str) -> Option<String> {
    std::env::var(variable_name)
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|trimmed| !trimmed.is_empty())
}

fn serialization_error(error: serde_json::Error) -> AgentExecutionError {
    AgentExecutionError::execution_failed(format!("Failed to serialize the run result: {error}"))
}

/// UTC RFC-3339 timestamp with millisecond precision and a `Z` offset (the http crate carries
/// no chrono/time dependency). Uses Howard Hinnant's days→civil algorithm — identical to the
/// helper in `execute_step_handler`, kept local so this unit stays self-contained.
fn now_rfc3339() -> String {
    let since_epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let total_seconds = since_epoch.as_secs() as i64;
    let millis = since_epoch.subsec_millis();
    let days = total_seconds.div_euclid(86_400);
    let seconds_of_day = total_seconds.rem_euclid(86_400);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_portion = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_portion + 2) / 5 + 1;
    let month = if month_portion < 10 {
        month_portion + 3
    } else {
        month_portion - 9
    };
    let civil_year = if month <= 2 { year + 1 } else { year };

    format!("{civil_year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

#[cfg(test)]
mod tests {
    use super::*;
    use alma_domain::agentnodes::dto::CheckpointStatus;
    use alma_domain::agentnodes::planner::ModelCatalog;

    fn minimal_plan_request(layers: Value) -> Value {
        json!({
            "bundle": {
                "schemaVersion": 1,
                "agent": { "name": "T", "layers": layers, "metadata": {} },
                "sources": [],
                "bindings": {},
                "sharedSourceIds": [],
                "skills": []
            },
            "previousOutputs": {}
        })
    }

    #[test]
    fn rfc3339_has_the_expected_shape() {
        let stamp = now_rfc3339();
        assert_eq!(stamp.len(), 24, "YYYY-MM-DDTHH:MM:SS.mmmZ");
        assert!(stamp.ends_with('Z'));
        assert_eq!(&stamp[4..5], "-");
        assert_eq!(&stamp[10..11], "T");
    }

    #[test]
    fn ensure_model_present_appends_only_when_missing() {
        let mut models = vec!["a".to_string(), "b".to_string()];
        ensure_model_present(&mut models, "b".to_string());
        ensure_model_present(&mut models, "c".to_string());
        assert_eq!(models, vec!["a".to_string(), "b".to_string(), "c".to_string()]);
    }

    #[test]
    fn catalog_resolves_both_defaults() {
        // The plan-time catalog MUST include the domain default (backs `selectedModel ??
        // DEFAULT_MODEL`) and the configured generation default, else valid steps are rejected.
        let catalog = resolve_plan_model_catalog();
        assert!(
            catalog.has_known_input_limit(DOMAIN_DEFAULT_MODEL),
            "domain default {DOMAIN_DEFAULT_MODEL} must resolve"
        );
        assert!(
            catalog.has_known_input_limit(FALLBACK_DEFAULT_MODEL),
            "configured generation default must resolve"
        );
    }

    #[test]
    fn plans_a_step_that_omits_its_model() {
        // Regression: a layer without `selectedModel` gets the domain default; the plan-time
        // gate must accept it against the catalog `resolve_plan_model_catalog` builds.
        let raw = minimal_plan_request(json!([
            { "id": "a", "name": "A", "userInstruction": "go", "order": 0 }
        ]));
        let identity = PlanIdentity::new("run-1", "2026-09-23T00:00:00Z");
        let catalog = resolve_plan_model_catalog();
        let result = plan_portable_run(&raw, &identity, &catalog).expect("plans cleanly");

        assert_eq!(result.schema_version, 1);
        assert_eq!(result.plan.order, vec!["a".to_string()]);
        assert_eq!(result.checkpoint.status, CheckpointStatus::Ready);
        assert_eq!(result.checkpoint.revision, 0);
        let next = result.next_inputs.expect("a ready run has a next step");
        assert_eq!(next.step_id, "a");
    }
}
