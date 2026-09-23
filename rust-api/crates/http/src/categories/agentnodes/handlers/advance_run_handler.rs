//! `POST /api/v1/agentnodes/runs/advance` — execute the next step of a portable run.
//!
//! Ports `advancePortableRun` from
//! `frontend_v3/app/lib/agentExecution/runner.server.ts` under **equivalent-behavior**
//! parity. Given a frozen `{ plan, checkpoint }` pair (plus an optional `attemptId` and a
//! `retryFailed` flag), it verifies the plan/checkpoint are consistent, executes the single
//! next step through the shared execution core (`execute_portable_step`), and returns the
//! **advanced** checkpoint (revision bumped) alongside the materialized agent and the inputs
//! for the following step.
//!
//! The pure engine (plan/checkpoint verification, `nextStepInputs`, `checkpointOutputs`,
//! `advanceOnSuccess`/`advanceOnFailure`, `materializeAgent`) lives in
//! `alma_domain::agentnodes::planner`; step execution is reused verbatim from the
//! `steps/execute` unit via [`execute_portable_step`]. This handler is the thin orchestration
//! that mirrors the reference control flow:
//!
//! 1. Parse the strict `advanceSchema` body.
//! 2. `verify_execution_plan` (re-derive + hash-compare → `PLAN_CONFLICT`).
//! 3. `verify_checkpoint` (ordered-prefix / revision / status checks → `CHECKPOINT_CONFLICT`).
//! 4. `next_step_inputs`; when the run is already complete, return the replayed `completed`
//!    envelope (the JSON transport carries no files, so the reference's `UNEXPECTED_FILE`
//!    guard has nothing to trip).
//! 5. `RUN_FAILED` gate (a failed checkpoint requires an explicit `retryFailed`).
//! 6. Resolve the effective attempt id and reject a reused one (`ATTEMPT_CONFLICT`).
//! 7. Build the `stepExecuteSchema` input for the next step and run it.
//!    * **success** → record the receipt, `advance_on_success`, and return the ready/completed
//!      envelope with the next step's inputs.
//!    * **failure** → `advance_on_failure` (revision bumped, `status = failed`) and return the
//!      failure envelope **carrying the advanced checkpoint** so the caller can persist it and
//!      retry with a fresh attempt id, exactly as the reference does.
//!
//! ## Return-type note (parity boundary)
//!
//! The reference returns the failure envelope with the underlying error's HTTP status (e.g.
//! 502) rather than throwing a bare error, because the checkpoint has legitimately advanced
//! into a `failed` revision that the caller must save. To preserve that contract the handler's
//! `Ok` arm is `(StatusCode, Json<Value>)`: pre-execution validation failures still surface as
//! `Err(AgentExecutionError)` (rendered by its `IntoResponse`), while a step-execution failure
//! returns `Ok((error_status, Json(envelope)))` so the advanced checkpoint reaches the client.

use crate::categories::agentnodes::handlers::execute_step_handler::execute_portable_step;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::agentnodes::dto::{ExecutionCheckpoint, ExecutionPlan, Receipt};
use alma_domain::agentnodes::error::{AgentExecutionError, stage};
use alma_domain::agentnodes::planner::{
    NextStepInputs, StaticModelCatalog, advance_on_failure, advance_on_success, checkpoint_outputs,
    materialize_agent, next_step_inputs, verify_checkpoint, verify_execution_plan,
};
use alma_domain::agentnodes::validation::{is_valid_identifier, normalize_agent};
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use uuid::Uuid;

/// Default text-generation model id (mirrors `execute_step_handler`'s `FALLBACK_DEFAULT_MODEL`
/// and `bootstrap/config.rs` `DEFAULT_GENERATION_MODEL`). The advance path re-derives the plan
/// inside [`verify_execution_plan`], which runs the plan-time model gate through a
/// [`StaticModelCatalog`]; the catalog must resolve identically to the one used when the plan
/// was minted or the re-derived `planHash` would drift and surface as `PLAN_CONFLICT`.
const FALLBACK_DEFAULT_MODEL: &str = "gemini-3.5-flash";

/// Resolvable (non-image, non-galileo) model ids (mirrors `execute_step_handler`'s
/// `FALLBACK_AVAILABLE_MODELS` and `bootstrap/config.rs` `DEFAULT_AVAILABLE_MODELS`).
const FALLBACK_AVAILABLE_MODELS: [&str; 5] = [
    "gemini-2.5-flash",
    "gemini-3.5-flash",
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite",
];

/// Strict `advanceSchema` body (`planner.server.ts`): the frozen plan + checkpoint, an optional
/// caller-supplied attempt id, and the `retryFailed` opt-in (default `false`).
///
/// `plan` stays a [`Value`] so [`verify_execution_plan`] owns its full re-derivation (parsing a
/// malformed plan there yields the same `400`/validation failure the reference's `planSchema`
/// parse does). `checkpoint` deserializes straight into the strict [`ExecutionCheckpoint`] DTO.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AdvanceRunRequest {
    plan: Value,
    checkpoint: ExecutionCheckpoint,
    #[serde(default)]
    attempt_id: Option<String>,
    #[serde(default)]
    retry_failed: bool,
}

#[route(method = "POST", path = "/api/v1/agentnodes/runs/advance")]
pub async fn advance_run_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<(StatusCode, Json<Value>), AgentExecutionError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // 1. advanceSchema.parse(raw) — a shape failure mirrors the reference's ZodError branch
    //    (`INVALID_REQUEST`, 400, validation).
    let input: AdvanceRunRequest = serde_json::from_value(submitted_body).map_err(|error| {
        AgentExecutionError::invalid_request(format!("Invalid advance request: {error}"))
    })?;

    // A caller-supplied attempt id must satisfy identifierSchema (advanceSchema's regex).
    if let Some(candidate) = input.attempt_id.as_deref() {
        if !is_valid_identifier(candidate) {
            return Err(AgentExecutionError::invalid_request(
                "attemptId must match ^[A-Za-z0-9_-]+$ and be 1-128 characters.",
            ));
        }
    }

    // 2. verifyExecutionPlan(input.plan) — re-derive under the plan's own identity + the
    //    process model catalog; a mismatch is PLAN_CONFLICT (409).
    let catalog = resolve_model_catalog(&resolve_default_model());
    let plan = verify_execution_plan(&input.plan, &catalog)?;

    // 3. verifyCheckpoint(input.checkpoint, plan) — ordered-prefix / revision / status checks.
    let checkpoint = input.checkpoint;
    verify_checkpoint(&checkpoint, &plan)?;

    // 4. nextStepInputs(plan, checkpoint) — None once the run is complete.
    let next_inputs = match next_step_inputs(&plan, &checkpoint) {
        Some(next_inputs) => next_inputs,
        None => {
            // A completed run replays its terminal state. The JSON transport carries no files,
            // so the reference's `UNEXPECTED_FILE` guard has nothing to check.
            let body = json!({
                "schemaVersion": 1,
                "status": "completed",
                "replayed": true,
                "checkpoint": serde_json::to_value(&checkpoint).map_err(serialization_error)?,
                "updatedAgent": materialize_agent(&plan, &checkpoint)?,
                "nextInputs": Value::Null,
            });
            return Ok((StatusCode::OK, Json(body)));
        }
    };

    // 5. A failed checkpoint requires an explicit opt-in before another attempt (409).
    if checkpoint.status == alma_domain::agentnodes::dto::CheckpointStatus::Failed
        && !input.retry_failed
    {
        return Err(AgentExecutionError::run_failed(
            "Review the failure, then send retryFailed: true with a new attemptId to retry.",
        ));
    }

    // 6. Resolve the effective attempt id (caller-supplied, else a fresh UUID) and reject reuse.
    let attempt_id = resolve_effective_attempt_id(input.attempt_id.as_deref());
    if checkpoint
        .attempts
        .iter()
        .any(|attempt| attempt.attempt_id == attempt_id)
    {
        return Err(AgentExecutionError::attempt_conflict(
            "Use a new attemptId for a new execution attempt.",
        ));
    }

    // 7. Locate the next step's layer and assemble its stepExecuteSchema input.
    let agent = normalize_agent(&plan.request.bundle.agent, None)?;
    let step_value = find_agent_layer(&agent, &next_inputs.step_id).ok_or_else(|| {
        AgentExecutionError::checkpoint_conflict("The next step is not part of the agent.")
    })?;
    let step_execute_body =
        build_step_execute_body(&agent, &plan, &checkpoint, &next_inputs, step_value, &attempt_id)?;

    // 8. Run the single step through the shared execution core.
    match execute_portable_step(
        &application_state.artificial_intelligence_adapter,
        &application_state.retrieval_adapter,
        &step_execute_body,
    )
    .await
    {
        // ── success ──────────────────────────────────────────────────────────────────────
        Ok(result) => {
            let receipt = receipt_from_execution_result(&result)?;
            let final_inference_attempted = final_inference_from_result(&result);
            let updated =
                advance_on_success(&checkpoint, &plan, receipt.clone(), final_inference_attempted);
            let body = json!({
                "schemaVersion": 1,
                "status": serde_json::to_value(&updated.status).map_err(serialization_error)?,
                "replayed": false,
                "checkpoint": serde_json::to_value(&updated).map_err(serialization_error)?,
                "result": serde_json::to_value(&receipt).map_err(serialization_error)?,
                "updatedAgent": materialize_agent(&plan, &updated)?,
                "nextInputs": serde_json::to_value(next_step_inputs(&plan, &updated))
                    .map_err(serialization_error)?,
            });
            Ok((StatusCode::OK, Json(body)))
        }
        // ── failure ──────────────────────────────────────────────────────────────────────
        // The checkpoint still advances (revision bumped, status = failed) so the caller can
        // persist it and retry. Returned with the error's status but a full envelope body.
        Err(execution_error) => {
            let error_code = execution_error.code;
            let error_message = execution_error.message.clone();
            let error_stage = execution_error.stage;
            let error_status = execution_error.http_status;
            let final_inference_attempted = error_stage == stage::INFERENCE;

            let updated = advance_on_failure(
                &checkpoint,
                next_inputs.step_id.clone(),
                attempt_id.clone(),
                error_code,
                final_inference_attempted,
            );
            let error_body = json!({
                "code": error_code,
                "message": error_message,
                "stage": error_stage,
                "attemptId": attempt_id,
                "finalInferenceAttempted": final_inference_attempted,
                "outcome": failure_outcome(final_inference_attempted),
                "retryable": false,
            });
            let body = json!({
                "schemaVersion": 1,
                "status": "failed",
                "error": error_body,
                "checkpoint": serde_json::to_value(&updated).map_err(serialization_error)?,
                "updatedAgent": materialize_agent(&plan, &updated)?,
                "nextInputs": serde_json::to_value(&next_inputs).map_err(serialization_error)?,
            });
            Ok((error_status, Json(body)))
        }
    }
}

/// `context.attemptId = input.attemptId ?? context.attemptId` — the caller's id, or a fresh
/// v4 UUID standing in for the reference's per-request `randomUUID()`.
fn resolve_effective_attempt_id(provided: Option<&str>) -> String {
    provided
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string())
}

/// `agent.layers.find(layer => layer.id === stepId)` over the normalized agent value.
fn find_agent_layer<'a>(agent: &'a Value, step_id: &str) -> Option<&'a Value> {
    agent
        .get("layers")
        .and_then(Value::as_array)?
        .iter()
        .find(|layer| layer.get("id").and_then(Value::as_str) == Some(step_id))
}

/// Assemble the `stepExecuteSchema` (`StepExecuteInput`) body for the next step, mirroring the
/// argument object `advancePortableRun` hands to `executePortableStep`:
/// `{ step, sources, previousOutputs, referenceNames, skills, corpora, projectId, attemptId }`.
///
/// The raw layer [`Value`] is passed through untouched so its passthrough keys survive into the
/// executability validator; `referenceNames` is the `{ id: name }` map of every agent layer and
/// `corpora` is `agent.metadata.corpusRefs ?? []`.
fn build_step_execute_body(
    agent: &Value,
    plan: &ExecutionPlan,
    checkpoint: &ExecutionCheckpoint,
    next_inputs: &NextStepInputs,
    step_value: &Value,
    attempt_id: &str,
) -> Result<Value, AgentExecutionError> {
    let reference_names = build_reference_names(agent);
    let corpora = agent
        .get("metadata")
        .and_then(|metadata| metadata.get("corpusRefs"))
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));

    Ok(json!({
        "schemaVersion": 1,
        "step": step_value.clone(),
        "sources": serde_json::to_value(&next_inputs.sources).map_err(serialization_error)?,
        "skills": serde_json::to_value(&plan.request.bundle.skills).map_err(serialization_error)?,
        "previousOutputs": serde_json::to_value(checkpoint_outputs(plan, checkpoint))
            .map_err(serialization_error)?,
        "referenceNames": Value::Object(reference_names),
        "corpora": corpora,
        "projectId": plan.request.bundle.project_id,
        "attemptId": attempt_id,
    }))
}

/// `Object.fromEntries(agent.layers.map(layer => [layer.id, layer.name]))`.
fn build_reference_names(agent: &Value) -> Map<String, Value> {
    let mut reference_names = Map::new();
    if let Some(layers) = agent.get("layers").and_then(Value::as_array) {
        for layer in layers {
            if let (Some(id), Some(name)) = (
                layer.get("id").and_then(Value::as_str),
                layer.get("name").and_then(Value::as_str),
            ) {
                reference_names.insert(id.to_string(), Value::String(name.to_string()));
            }
        }
    }
    reference_names
}

/// `receiptSchema.parse({ stepId, attemptId, output, diagnostics, sources, responseMetadata })`
/// applied to the succeeded-step response body from [`execute_portable_step`].
fn receipt_from_execution_result(result: &Value) -> Result<Receipt, AgentExecutionError> {
    let receipt_input = json!({
        "stepId": result.get("stepId").cloned().unwrap_or(Value::Null),
        "attemptId": result.get("attemptId").cloned().unwrap_or(Value::Null),
        "output": result.get("output").cloned().unwrap_or(Value::Null),
        "diagnostics": result.get("diagnostics").cloned().unwrap_or(Value::Null),
        "sources": result.get("sources").cloned().unwrap_or(Value::Null),
        "responseMetadata": result.get("responseMetadata").cloned().unwrap_or(Value::Null),
    });
    serde_json::from_value(receipt_input).map_err(|error| {
        AgentExecutionError::execution_failed(format!("The step returned an invalid receipt: {error}"))
    })
}

/// Read `diagnostics.finalInferenceAttempted` from a succeeded-step result. `execute_portable_step`
/// always sets it `true` on success (the model call is required); default `true` if absent.
fn final_inference_from_result(result: &Value) -> bool {
    result
        .get("diagnostics")
        .and_then(|diagnostics| diagnostics.get("finalInferenceAttempted"))
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

/// `context.finalInferenceAttempted ? 'unknown' : 'not_completed'` (`executionFailure`).
fn failure_outcome(final_inference_attempted: bool) -> &'static str {
    if final_inference_attempted {
        "unknown"
    } else {
        "not_completed"
    }
}

/// Read a trimmed, non-empty environment variable (mirrors `execute_step_handler::read_env_trimmed`
/// and the `pipeline/extractor.rs` precedent: process config lives in bootstrap, not state).
fn read_env_trimmed(variable_name: &str) -> Option<String> {
    std::env::var(variable_name)
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|trimmed| !trimmed.is_empty())
}

/// Default generation model, honouring `GEMINI_DEFAULT_MODEL` (mirrors `execute_step_handler`).
fn resolve_default_model() -> String {
    read_env_trimmed("GEMINI_DEFAULT_MODEL").unwrap_or_else(|| FALLBACK_DEFAULT_MODEL.to_string())
}

/// Build the plan-time model catalog from `GEMINI_AVAILABLE_MODELS`, always including the default
/// model (mirrors `execute_step_handler::resolve_model_catalog` so `verify_execution_plan`
/// re-derives the same `planHash`).
fn resolve_model_catalog(default_model: &str) -> StaticModelCatalog {
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
    if !models.iter().any(|model| model == default_model) {
        models.insert(0, default_model.to_string());
    }
    StaticModelCatalog::new(models)
}

fn serialization_error(error: serde_json::Error) -> AgentExecutionError {
    AgentExecutionError::execution_failed(format!("Failed to serialize the advance result: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effective_attempt_id_prefers_caller_value() {
        assert_eq!(resolve_effective_attempt_id(Some("attempt-1")), "attempt-1");
    }

    #[test]
    fn effective_attempt_id_generates_uuid_when_absent() {
        let generated = resolve_effective_attempt_id(None);
        // A v4 UUID is 36 chars and satisfies identifierSchema (hyphen-delimited hex).
        assert_eq!(generated.len(), 36);
        assert!(is_valid_identifier(&generated));
    }

    #[test]
    fn failure_outcome_maps_on_inference_flag() {
        assert_eq!(failure_outcome(true), "unknown");
        assert_eq!(failure_outcome(false), "not_completed");
    }

    #[test]
    fn build_reference_names_maps_id_to_name() {
        let agent = json!({
            "layers": [
                { "id": "l1", "name": "Intro" },
                { "id": "l2", "name": "Body" },
                { "id": "l3" }, // missing name is skipped
            ]
        });
        let names = build_reference_names(&agent);
        assert_eq!(names.get("l1").and_then(Value::as_str), Some("Intro"));
        assert_eq!(names.get("l2").and_then(Value::as_str), Some("Body"));
        assert!(!names.contains_key("l3"));
    }

    #[test]
    fn find_agent_layer_matches_on_id() {
        let agent = json!({ "layers": [ { "id": "a", "name": "A" }, { "id": "b", "name": "B" } ] });
        assert_eq!(
            find_agent_layer(&agent, "b").and_then(|layer| layer.get("name")),
            Some(&json!("B"))
        );
        assert!(find_agent_layer(&agent, "missing").is_none());
    }

    #[test]
    fn final_inference_from_result_reads_diagnostics_flag() {
        assert!(final_inference_from_result(
            &json!({ "diagnostics": { "finalInferenceAttempted": true } })
        ));
        assert!(!final_inference_from_result(
            &json!({ "diagnostics": { "finalInferenceAttempted": false } })
        ));
        // Absent → defaults to true (success implies the model call happened).
        assert!(final_inference_from_result(&json!({ "diagnostics": {} })));
    }

    #[test]
    fn receipt_from_execution_result_parses_succeeded_body() {
        let result = json!({
            "schemaVersion": 1,
            "status": "succeeded",
            "stepId": "step-1",
            "attemptId": "attempt-1",
            "output": { "version": 1, "timestamp": "2026-01-01T00:00:00.000Z", "result": "hi", "imageUrls": [] },
            "updatedStep": { "id": "step-1", "name": "Step" },
            "sources": [],
            "responseMetadata": {},
            "diagnostics": { "finalInferenceAttempted": true },
        });
        let receipt = receipt_from_execution_result(&result).expect("valid receipt");
        assert_eq!(receipt.step_id, "step-1");
        assert_eq!(receipt.attempt_id, "attempt-1");
        assert_eq!(receipt.output.version, 1);
        assert_eq!(receipt.output.result, "hi");
    }
}
