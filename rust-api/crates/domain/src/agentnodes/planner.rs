//! Execution-plan derivation, verification, and the checkpoint state machine.
//!
//! Ports the pure logic of `frontend_v3/app/lib/agentExecution/planner.server.ts`
//! (plus the pure entry `planPortableRun` and the checkpoint-transition math of
//! `advancePortableRun` from `runner.server.ts`) under **equivalent-behavior**
//! parity. The I/O-bound halves of the reference — `executePortableStep`, the
//! `http.server` request context, uploaded `files`, and the async provider calls
//! — belong to the step-execution and HTTP handler units and are deliberately
//! **not** ported here.
//!
//! What this module owns:
//! * [`create_execution_plan`] — the full `createExecutionPlan` validator +
//!   stable linear-scan topological sort (lowest-`order` ready node), not just a
//!   topo pass. Reproduces every distinct plan-derivation error.
//! * [`verify_execution_plan`] — `verifyExecutionPlan`: re-derive from
//!   `plan.request` and compare canonical hashes (`PLAN_CONFLICT` on drift).
//! * [`create_checkpoint`] / [`verify_checkpoint`] / [`advance_on_success`] /
//!   [`advance_on_failure`] — the checkpoint state machine: one step per advance,
//!   `revision == attempts.len()`, `status ∈ {ready, failed, completed}`.
//! * [`materialize_agent`], [`checkpoint_outputs`], [`next_step_inputs`],
//!   [`plan_portable_run`].
//!
//! Parity-critical invariants (see the port plan's "Engine (loud failures)"):
//! * **`planHash` determinism** — both the create and verify sides canonicalize
//!   the plan through the same `serde_json::Value` path, so a legitimate plan
//!   always re-verifies. The bundle is round-tripped through the DTOs before
//!   hashing so absent-vs-defaulted keys (`sources: []`, `bindings: {}`, …) can
//!   never diverge between the two sides.
//! * **`record_agent_output` version bump** — `verify_checkpoint` re-derives each
//!   completed receipt's output-history version exactly as the executor did; any
//!   drift is a `CHECKPOINT_CONFLICT` (409), so every advance would fail.
//! * **topo = stable linear-scan lowest-`order` ready node**, `IndexSet` dedup of
//!   dependencies (never `BTreeSet`).
//! * **`next_step_inputs` attaches the shared sources to *every* layer** (union
//!   of `sharedSourceIds` and the step's own `bindings`).
//!
//! Purity: like the sibling `output_history` unit, this module takes no clock and
//! no RNG. The reference defaults `runId`/`createdAt` via `randomUUID()` /
//! `new Date().toISOString()`; here the caller supplies a [`PlanIdentity`] so the
//! create and verify sides reproduce identical plans. [`PlanIdentity::generate`]
//! is offered for the handler's convenience (it mints a v4 UUID but still takes
//! the timestamp from the caller, keeping the clock outside the domain core).

use std::collections::{HashMap, HashSet};

use axum::http::StatusCode;
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;

use super::dto::{
    AttemptRecord, AttemptStatus, CheckpointStatus, ExecutionCheckpoint, ExecutionLayer,
    ExecutionPlan, ExecutionSource, OutputVersion, PlanRequest, Receipt,
};
use super::error::{AgentExecutionError, stage};
use super::hash::{dedup_preserving_order, hash_canonical_json, hash_value};
use super::output_history::{RecordedOutput, record_agent_output};
use super::validation;

// ---------------------------------------------------------------------------
// Plan identity + model catalog (the two capabilities the pure derivation needs
// from its caller: an already-minted run identity, and a way to resolve models).
// ---------------------------------------------------------------------------

/// The `{ runId, createdAt }` identity a plan is stamped with.
///
/// Mirrors the reference `identity?: { runId, createdAt }` argument of
/// `createExecutionPlan`. Supplied by the caller so plan creation stays pure and
/// so `verify_execution_plan` re-derives with the *same* identity (otherwise the
/// re-derived `runId`/`createdAt` — and therefore the `planHash` — would differ).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanIdentity {
    /// `planSchema.runId` (`identifierSchema`; a v4 UUID satisfies it).
    pub run_id: String,
    /// `planSchema.createdAt` (RFC-3339 datetime with offset).
    pub created_at: String,
}

impl PlanIdentity {
    /// Construct an identity from an explicit run id and creation timestamp.
    pub fn new(run_id: impl Into<String>, created_at: impl Into<String>) -> Self {
        Self {
            run_id: run_id.into(),
            created_at: created_at.into(),
        }
    }

    /// Mint a fresh v4-UUID run id, taking the creation timestamp from the caller.
    ///
    /// The UUID stands in for the reference's `randomUUID()`; the timestamp stays
    /// the caller's responsibility so the (impure) clock never enters the domain.
    pub fn generate(created_at: impl Into<String>) -> Self {
        Self {
            run_id: uuid::Uuid::new_v4().to_string(),
            created_at: created_at.into(),
        }
    }

    fn from_plan(plan: &ExecutionPlan) -> Self {
        Self {
            run_id: plan.run_id.clone(),
            created_at: plan.created_at.clone(),
        }
    }
}

/// Image-generation model ids v1 cuts (`IMAGE_GENERATION_MODELS` keys in
/// `app/lib/modelConfig.ts`). The plan-time model gate short-circuits for these
/// exactly as the reference does — deferring the real `UNSUPPORTED_MODEL`
/// rejection to execute-time — so an image-model step still *plans* successfully.
const IMAGE_GENERATION_MODEL_IDS: [&str; 3] = [
    "gemini-3.1-flash-image-preview",
    "gemini-3-pro-image-preview",
    "gemini-2.5-flash-image",
];

/// `isImageModel(model)` — membership in [`IMAGE_GENERATION_MODEL_IDS`].
pub fn is_image_model(model: &str) -> bool {
    IMAGE_GENERATION_MODEL_IDS.contains(&model)
}

/// Resolves the model-capability facts the plan-time `UNSUPPORTED_MODEL` gate
/// needs (`createExecutionPlan`'s
/// `!isGalileoModel(model) && !isImageModel(model) && !getModelInfo(model)?.maxInputTokens`).
///
/// The pure engine cannot read the process config (which lives in `bootstrap`),
/// so the HTTP handler injects a catalog built from `RuntimeConfiguration`.
/// [`is_image_model`] / [`is_galileo_model`](ModelCatalog::is_galileo_model) have
/// v1-correct defaults; only [`has_known_input_limit`](ModelCatalog::has_known_input_limit)
/// must be supplied. [`StaticModelCatalog`] is the standard backing.
pub trait ModelCatalog {
    /// Mirror of `getModelInfo(model)?.maxInputTokens` truthiness: whether the
    /// engine can resolve a known input limit for `model`. In the Rust design the
    /// resolvable set is the configured available-model list (the plan guarantees
    /// `DEFAULT_MODEL` is always in it, so the default never trips the gate).
    fn has_known_input_limit(&self, model: &str) -> bool;

    /// Mirror of `isImageModel(model)`. Defaults to the reference id set.
    fn is_image_model(&self, model: &str) -> bool {
        is_image_model(model)
    }

    /// Mirror of `isGalileoModel(model)` — **stubbed `false`** (plan C1: force
    /// non-Galileo resolution, never build the gateway path). A `galileo:*` model
    /// therefore falls through to the input-limit check and is rejected with
    /// `UNSUPPORTED_MODEL` at plan time.
    fn is_galileo_model(&self, _model: &str) -> bool {
        false
    }
}

/// A [`ModelCatalog`] backed by a fixed set of resolvable model ids (typically
/// `RuntimeConfiguration::available_model_ids`).
#[derive(Debug, Clone, Default)]
pub struct StaticModelCatalog {
    resolvable: HashSet<String>,
}

impl StaticModelCatalog {
    /// Build a catalog whose resolvable set is `model_ids`.
    pub fn new<I, S>(model_ids: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            resolvable: model_ids.into_iter().map(Into::into).collect(),
        }
    }
}

impl ModelCatalog for StaticModelCatalog {
    fn has_known_input_limit(&self, model: &str) -> bool {
        self.resolvable.contains(model)
    }
}

// ---------------------------------------------------------------------------
// Result carriers
// ---------------------------------------------------------------------------

/// The next step to execute plus the sources bound to it (`nextStepInputs`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NextStepInputs {
    pub step_id: String,
    /// Union of `sharedSourceIds` and this step's `bindings`, filtered to the
    /// bundle's declared sources (shared sources reach **every** layer).
    pub sources: Vec<ExecutionSource>,
}

/// Output of [`plan_portable_run`] (`runner.server.ts` `planPortableRun`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRunResult {
    pub schema_version: u32,
    pub plan: ExecutionPlan,
    pub checkpoint: ExecutionCheckpoint,
    pub next_inputs: Option<NextStepInputs>,
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

/// A zod `.parse` shape failure (wrong type / malformed identifier / bound). Kept
/// byte-for-byte consistent with `validation.rs`'s `schema_error`
/// (`code = "INVALID_INPUT"`, HTTP 400, `stage = "validation"`).
fn schema_error(message: impl Into<String>) -> AgentExecutionError {
    AgentExecutionError::new(
        "INVALID_INPUT",
        message,
        StatusCode::BAD_REQUEST,
        stage::VALIDATION,
    )
}

// ---------------------------------------------------------------------------
// createExecutionPlan
// ---------------------------------------------------------------------------

/// Port of `createExecutionPlan(raw, identity)` — the full plan-derivation
/// validator, not merely a topological sort.
///
/// Steps (mirroring the reference exactly):
/// 1. Parse the `planRequestSchema` (strict; `stepId`/`previousOutputs`
///    identifier checks serde cannot express).
/// 2. `normalizeBundle` (via [`validation::normalize_bundle`]) — the full
///    sources/bindings/skills validator + `selectedModel ?? DEFAULT_MODEL`.
/// 3. Sort layers by `order` (stable, ascending), build `dependencies` from the
///    de-duplicated `referencedSteps` (order-preserving [`dedup_preserving_order`]),
///    reject `DANGLING_REFERENCE`.
/// 4. Fold in the optional graph edges (`INVALID_GRAPH` / `UNSUPPORTED_GRAPH_EDGE`).
/// 5. Stable linear-scan topological sort (lowest-`order` ready node;
///    `CYCLIC_DEPENDENCY` if none).
/// 6. Pinned-output / step-selection checks, then per-selected
///    `validateExecutableLayer`, `UNSUPPORTED_MODEL`, and `MISSING_PREREQUISITE`.
/// 7. Assemble the canonical content, hash it (`planHash`), and return the plan.
///
/// `identity` supplies the `runId`/`createdAt` (see [`PlanIdentity`]). `catalog`
/// resolves the plan-time model gate.
pub fn create_execution_plan(
    raw: &Value,
    identity: &PlanIdentity,
    catalog: &dyn ModelCatalog,
) -> Result<ExecutionPlan, AgentExecutionError> {
    // ---- 1. planRequestSchema.parse(raw) -----------------------------------
    let request: PlanRequest = serde_json::from_value(raw.clone())
        .map_err(|error| schema_error(format!("Invalid plan request: {error}")))?;

    // serde does not validate `z.record(identifierSchema, ...)` keys.
    if let Some(previous_outputs) = raw.get("previousOutputs").and_then(Value::as_object) {
        validation::validate_identifier_map_keys(previous_outputs, "previousOutputs")?;
    }
    if let Some(step_id) = request.step_id.as_deref() {
        if !validation::is_valid_identifier(step_id) {
            return Err(schema_error(format!(
                "stepId '{step_id}' is not a valid identifier."
            )));
        }
    }

    // ---- 2. normalizeBundle(parsed.bundle) ---------------------------------
    // Serialising the parsed bundle first materialises the zod-equivalent
    // defaults (`sources: []`, `bindings: {}`, …) so the canonical shape is
    // identical whether the caller sent them or not — the linchpin of planHash
    // determinism across create/verify. The `agent` field stays opaque, so its
    // exact contents survive untouched into `normalize_bundle`.
    let bundle_value = serde_json::to_value(&request.bundle)
        .map_err(|error| schema_error(format!("Invalid bundle: {error}")))?;
    let normalized = validation::normalize_bundle(&bundle_value)?;
    let agent = normalized
        .get("agent")
        .and_then(Value::as_object)
        .ok_or_else(|| schema_error("normalized bundle is missing its agent."))?;
    let layers_raw = agent
        .get("layers")
        .and_then(Value::as_array)
        .ok_or_else(|| schema_error("agent is missing its layers."))?;

    // ---- 3. sort by order, dependencies, dangling refs ---------------------
    let mut layers: Vec<&Value> = layers_raw.iter().collect();
    // Stable ascending sort on `order ?? 0` — `sort_by` preserves input order
    // for equal keys, matching the reference's stable `Array.prototype.sort`.
    layers.sort_by(|left, right| {
        layer_order(left)
            .partial_cmp(&layer_order(right))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let layer_ids: HashSet<&str> = layers.iter().map(|layer| layer_id(layer)).collect();

    // dependencies[id] = [...new Set(layer.referencedSteps)] for every layer.
    let mut dependencies: IndexMap<String, Vec<String>> = IndexMap::with_capacity(layers.len());
    for layer in &layers {
        dependencies.insert(
            layer_id(layer).to_owned(),
            dedup_preserving_order(layer_referenced_steps(layer)),
        );
    }

    // DANGLING_REFERENCE: every referenced step must exist.
    for layer in &layers {
        for reference in layer_referenced_steps(layer) {
            if !layer_ids.contains(reference.as_str()) {
                return Err(AgentExecutionError::dangling_reference(format!(
                    "Step {} references a missing step.",
                    layer_id(layer)
                )));
            }
        }
    }

    // ---- 4. graph edges ----------------------------------------------------
    if let Some(graph) = normalized.get("graph") {
        if !graph.is_null() {
            apply_graph(graph, &layer_ids, &mut dependencies)?;
        }
    }

    // ---- 5. stable linear-scan topological sort ----------------------------
    let ordered = topological_order(&layers, &dependencies)?;

    // ---- 6. pinned-output / selection / per-selected validation ------------
    let previous_outputs = &request.previous_outputs;
    for step_id in previous_outputs.keys() {
        if !layer_ids.contains(step_id.as_str()) {
            return Err(AgentExecutionError::invalid_pinned_output(
                "Pinned outputs must belong to an existing step.",
            ));
        }
    }
    if let Some(step_id) = request.step_id.as_deref() {
        if !layer_ids.contains(step_id) || previous_outputs.contains_key(step_id) {
            return Err(AgentExecutionError::invalid_step_selection(
                "Select an existing step that is not also pinned.",
            ));
        }
    }

    let selected: Vec<&Value> = layers
        .iter()
        .copied()
        .filter(|layer| match request.step_id.as_deref() {
            Some(step_id) => layer_id(layer) == step_id,
            None => {
                is_layer_active(layer)
                    && !is_layer_frozen(layer)
                    && !previous_outputs.contains_key(layer_id(layer))
            }
        })
        .collect();
    let selected_ids: HashSet<&str> = selected.iter().map(|layer| layer_id(layer)).collect();

    for layer in &selected {
        validation::validate_executable_layer(layer)?;
        let model = layer_selected_model(layer);
        if !catalog.is_galileo_model(model)
            && !catalog.is_image_model(model)
            && !catalog.has_known_input_limit(model)
        {
            return Err(AgentExecutionError::unsupported_model(format!(
                "Step {} has no supported model with known input limits.",
                layer_id(layer)
            )));
        }
        if let Some(deps) = dependencies.get(layer_id(layer)) {
            if deps.iter().any(|reference| {
                !selected_ids.contains(reference.as_str())
                    && !previous_outputs.contains_key(reference)
            }) {
                return Err(AgentExecutionError::missing_prerequisite(format!(
                    "Step {} needs a pinned output for an inactive, frozen or unselected prerequisite.",
                    layer_id(layer)
                )));
            }
        }
    }

    // order = topo order filtered to the selected ids.
    let order: Vec<String> = ordered
        .into_iter()
        .filter(|id| selected_ids.contains(id.as_str()))
        .collect();

    // ---- 7. canonical content + planHash -----------------------------------
    // request = { ...parsed, bundle: normalized } — canonicalised through the DTO
    // so create and verify hash byte-identical structures.
    let mut canonical_request = serde_json::Map::new();
    canonical_request.insert("bundle".to_owned(), normalized.clone());
    if let Some(step_id) = &request.step_id {
        canonical_request.insert("stepId".to_owned(), Value::String(step_id.clone()));
    }
    canonical_request.insert(
        "previousOutputs".to_owned(),
        serde_json::to_value(previous_outputs)
            .map_err(|error| schema_error(format!("Invalid previousOutputs: {error}")))?,
    );
    let request_dto: PlanRequest = serde_json::from_value(Value::Object(canonical_request))
        .map_err(|error| schema_error(format!("Invalid normalized request: {error}")))?;
    let request_value = serde_json::to_value(&request_dto)
        .map_err(|error| schema_error(format!("Invalid request: {error}")))?;

    let mut content = serde_json::Map::new();
    content.insert("schemaVersion".to_owned(), Value::from(1u32));
    content.insert("runId".to_owned(), Value::String(identity.run_id.clone()));
    content.insert("createdAt".to_owned(), Value::String(identity.created_at.clone()));
    content.insert("request".to_owned(), request_value);
    content.insert(
        "order".to_owned(),
        serde_json::to_value(&order)
            .map_err(|error| schema_error(format!("Invalid order: {error}")))?,
    );
    content.insert(
        "dependencies".to_owned(),
        serde_json::to_value(&dependencies)
            .map_err(|error| schema_error(format!("Invalid dependencies: {error}")))?,
    );

    let plan_hash = hash_canonical_json(&Value::Object(content.clone()));
    content.insert("planHash".to_owned(), Value::String(plan_hash));

    serde_json::from_value(Value::Object(content))
        .map_err(|error| schema_error(format!("Invalid plan: {error}")))
}

/// Port of `verifyExecutionPlan(raw)`: parse the frozen plan, re-derive it from
/// its own `request` under the same identity, and compare canonical hashes. Any
/// tampering (or config drift) surfaces as `PLAN_CONFLICT` (409).
pub fn verify_execution_plan(
    raw: &Value,
    catalog: &dyn ModelCatalog,
) -> Result<ExecutionPlan, AgentExecutionError> {
    let plan: ExecutionPlan = serde_json::from_value(raw.clone())
        .map_err(|error| schema_error(format!("Invalid plan: {error}")))?;
    let request_value = serde_json::to_value(&plan.request)
        .map_err(|error| schema_error(format!("Invalid plan request: {error}")))?;
    let expected = create_execution_plan(&request_value, &PlanIdentity::from_plan(&plan), catalog)?;

    let actual_hash =
        hash_value(&plan).map_err(|error| schema_error(format!("hash error: {error}")))?;
    let expected_hash =
        hash_value(&expected).map_err(|error| schema_error(format!("hash error: {error}")))?;
    if actual_hash != expected_hash {
        return Err(AgentExecutionError::plan_conflict(
            "The frozen plan was changed. Create a new plan for changed configuration.",
        ));
    }
    Ok(plan)
}

// ---------------------------------------------------------------------------
// Checkpoint lifecycle
// ---------------------------------------------------------------------------

/// Port of `createCheckpoint(plan)`: a fresh, revision-0 checkpoint —
/// `ready` when there is work to do, `completed` for an empty plan.
pub fn create_checkpoint(plan: &ExecutionPlan) -> ExecutionCheckpoint {
    ExecutionCheckpoint {
        schema_version: 1,
        run_id: plan.run_id.clone(),
        plan_hash: plan.plan_hash.clone(),
        revision: 0,
        status: if plan.order.is_empty() {
            CheckpointStatus::Completed
        } else {
            CheckpointStatus::Ready
        },
        completed: Vec::new(),
        attempts: Vec::new(),
    }
}

/// Port of `checkpointOutputs(plan, checkpoint)`: the pinned previous outputs
/// overlaid with every completed receipt's output (completed wins on collision).
pub fn checkpoint_outputs(
    plan: &ExecutionPlan,
    checkpoint: &ExecutionCheckpoint,
) -> HashMap<String, OutputVersion> {
    let mut outputs = plan.request.previous_outputs.clone();
    for receipt in &checkpoint.completed {
        outputs.insert(receipt.step_id.clone(), receipt.output.clone());
    }
    outputs
}

/// Port of `verifyCheckpoint(raw, plan)`: assert the checkpoint is a consistent,
/// ordered prefix of `plan.order` at the right revision/status, and that each
/// completed receipt's output-history version matches what [`record_agent_output`]
/// would produce. Every mismatch is `CHECKPOINT_CONFLICT` (409).
pub fn verify_checkpoint(
    checkpoint: &ExecutionCheckpoint,
    plan: &ExecutionPlan,
) -> Result<(), AgentExecutionError> {
    if checkpoint.run_id != plan.run_id
        || checkpoint.plan_hash != plan.plan_hash
        || checkpoint.revision as usize != checkpoint.attempts.len()
    {
        return Err(AgentExecutionError::checkpoint_conflict(
            "The checkpoint does not match this plan.",
        ));
    }

    let agent = validation::normalize_agent(&plan.request.bundle.agent, None)?;
    let layers = agent
        .get("layers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let completed_attempts: Vec<&AttemptRecord> = checkpoint
        .attempts
        .iter()
        .filter(|attempt| attempt.status == AttemptStatus::Succeeded)
        .collect();
    let unique_attempt_ids: HashSet<&str> = checkpoint
        .attempts
        .iter()
        .map(|attempt| attempt.attempt_id.as_str())
        .collect();
    if checkpoint.completed.len() > plan.order.len()
        || completed_attempts.len() != checkpoint.completed.len()
        || unique_attempt_ids.len() != checkpoint.attempts.len()
    {
        return Err(AgentExecutionError::checkpoint_conflict(
            "Checkpoint attempts are inconsistent.",
        ));
    }

    // Attempts must appear in execution order; succeeded attempts advance the cursor.
    let mut completion_index = 0usize;
    for attempt in &checkpoint.attempts {
        if plan.order.get(completion_index).map(String::as_str) != Some(attempt.step_id.as_str()) {
            return Err(AgentExecutionError::checkpoint_conflict(
                "Checkpoint attempts are out of execution order.",
            ));
        }
        if attempt.status == AttemptStatus::Succeeded {
            completion_index += 1;
        }
    }

    // Completed receipts are an ordered prefix, each pinned to its succeeded attempt,
    // with a version that re-derives exactly (the loud failure guard).
    for (index, receipt) in checkpoint.completed.iter().enumerate() {
        if plan.order.get(index).map(String::as_str) != Some(receipt.step_id.as_str())
            || completed_attempts
                .get(index)
                .map(|attempt| attempt.attempt_id.as_str())
                != Some(receipt.attempt_id.as_str())
        {
            return Err(AgentExecutionError::checkpoint_conflict(
                "Completed steps must be an ordered prefix of the plan.",
            ));
        }
        let layer_value = layers
            .iter()
            .find(|layer| layer.get("id").and_then(Value::as_str) == Some(receipt.step_id.as_str()))
            .ok_or_else(|| {
                AgentExecutionError::checkpoint_conflict("Completed step is not part of the agent.")
            })?;
        let layer: ExecutionLayer = serde_json::from_value(layer_value.clone())
            .map_err(|error| schema_error(format!("Invalid layer: {error}")))?;
        let recorded = record_agent_output(
            &layer,
            RecordedOutput {
                result: receipt.output.result.clone(),
                image_urls: Some(receipt.output.image_urls.clone()),
            },
            &receipt.output.timestamp,
        );
        let recorded_version = recorded
            .output_history
            .as_ref()
            .and_then(|history| history.last())
            .map(|version| version.version);
        if recorded_version != Some(receipt.output.version) {
            return Err(AgentExecutionError::checkpoint_conflict(
                "Output history version does not match the frozen step.",
            ));
        }
    }

    let expected_status = if checkpoint.completed.len() == plan.order.len() {
        CheckpointStatus::Completed
    } else if checkpoint.attempts.last().map(|attempt| attempt.status)
        == Some(AttemptStatus::Failed)
    {
        CheckpointStatus::Failed
    } else {
        CheckpointStatus::Ready
    };
    if checkpoint.status != expected_status {
        return Err(AgentExecutionError::checkpoint_conflict(
            "Checkpoint status does not match its completed steps.",
        ));
    }
    Ok(())
}

/// Advance the checkpoint by one **succeeded** step (the success branch of
/// `advancePortableRun`): append the receipt + a succeeded attempt, bump the
/// revision, and mark `completed` when the last step lands, else `ready`.
///
/// Preserves the `revision == attempts.len()` invariant. Pure — the caller runs
/// the step (`executePortableStep`) and hands the resulting [`Receipt`] here.
pub fn advance_on_success(
    checkpoint: &ExecutionCheckpoint,
    plan: &ExecutionPlan,
    receipt: Receipt,
    final_inference_attempted: bool,
) -> ExecutionCheckpoint {
    let attempt = AttemptRecord {
        step_id: receipt.step_id.clone(),
        attempt_id: receipt.attempt_id.clone(),
        status: AttemptStatus::Succeeded,
        code: None,
        final_inference_attempted,
    };
    let status = if checkpoint.completed.len() + 1 == plan.order.len() {
        CheckpointStatus::Completed
    } else {
        CheckpointStatus::Ready
    };

    let mut completed = checkpoint.completed.clone();
    completed.push(receipt);
    let mut attempts = checkpoint.attempts.clone();
    attempts.push(attempt);

    ExecutionCheckpoint {
        schema_version: checkpoint.schema_version,
        run_id: checkpoint.run_id.clone(),
        plan_hash: checkpoint.plan_hash.clone(),
        revision: checkpoint.revision + 1,
        status,
        completed,
        attempts,
    }
}

/// Advance the checkpoint by one **failed** step (the failure branch of
/// `advancePortableRun`): append a failed attempt carrying its error `code`, bump
/// the revision, and set `status = failed`. `completed` is left untouched, so the
/// same step is retriable with a new attempt id (`retryFailed`).
pub fn advance_on_failure(
    checkpoint: &ExecutionCheckpoint,
    step_id: impl Into<String>,
    attempt_id: impl Into<String>,
    code: impl Into<String>,
    final_inference_attempted: bool,
) -> ExecutionCheckpoint {
    let attempt = AttemptRecord {
        step_id: step_id.into(),
        attempt_id: attempt_id.into(),
        status: AttemptStatus::Failed,
        code: Some(code.into()),
        final_inference_attempted,
    };
    let mut attempts = checkpoint.attempts.clone();
    attempts.push(attempt);

    ExecutionCheckpoint {
        schema_version: checkpoint.schema_version,
        run_id: checkpoint.run_id.clone(),
        plan_hash: checkpoint.plan_hash.clone(),
        revision: checkpoint.revision + 1,
        status: CheckpointStatus::Failed,
        completed: checkpoint.completed.clone(),
        attempts,
    }
}

/// Port of `materializeAgent(plan, checkpoint)`: the agent with each layer's
/// output folded in. Completed steps get a full [`record_agent_output`]
/// history bump; pinned-but-not-completed steps get only `result`/`imageUrls`
/// spliced on. Returned as an opaque agent [`Value`] (it carries passthrough keys
/// and is never re-hashed), matching the reference's shape.
pub fn materialize_agent(
    plan: &ExecutionPlan,
    checkpoint: &ExecutionCheckpoint,
) -> Result<Value, AgentExecutionError> {
    let agent = validation::normalize_agent(&plan.request.bundle.agent, None)?;
    let outputs = checkpoint_outputs(plan, checkpoint);
    let completed_ids: HashSet<&str> = checkpoint
        .completed
        .iter()
        .map(|receipt| receipt.step_id.as_str())
        .collect();

    let mut agent_object = agent
        .as_object()
        .cloned()
        .ok_or_else(|| schema_error("normalized agent is not an object."))?;
    let layers = agent_object
        .get("layers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut updated_layers = Vec::with_capacity(layers.len());
    for layer_value in &layers {
        let layer_id = layer_value
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match outputs.get(layer_id) {
            None => updated_layers.push(layer_value.clone()),
            Some(output) if completed_ids.contains(layer_id) => {
                let layer: ExecutionLayer = serde_json::from_value(layer_value.clone())
                    .map_err(|error| schema_error(format!("Invalid layer: {error}")))?;
                let recorded = record_agent_output(
                    &layer,
                    RecordedOutput {
                        result: output.result.clone(),
                        image_urls: Some(output.image_urls.clone()),
                    },
                    &output.timestamp,
                );
                updated_layers.push(
                    serde_json::to_value(&recorded)
                        .map_err(|error| schema_error(format!("Invalid layer: {error}")))?,
                );
            }
            Some(output) => {
                // { ...layer, result: output.result, imageUrls: output.imageUrls }.
                let mut object = layer_value
                    .as_object()
                    .cloned()
                    .ok_or_else(|| schema_error("agent layer is not an object."))?;
                object.insert("result".to_owned(), Value::String(output.result.clone()));
                object.insert(
                    "imageUrls".to_owned(),
                    serde_json::to_value(&output.image_urls)
                        .map_err(|error| schema_error(format!("Invalid imageUrls: {error}")))?,
                );
                updated_layers.push(Value::Object(object));
            }
        }
    }

    agent_object.insert("layers".to_owned(), Value::Array(updated_layers));
    Ok(Value::Object(agent_object))
}

/// Port of `nextStepInputs(plan, checkpoint)`: the next unexecuted step (the
/// `completed.len()`-th plan entry) and the sources bound to it — the union of
/// the bundle's `sharedSourceIds` (attached to **every** layer) and the step's
/// own `bindings`. `None` once the run is complete.
pub fn next_step_inputs(
    plan: &ExecutionPlan,
    checkpoint: &ExecutionCheckpoint,
) -> Option<NextStepInputs> {
    let step_id = plan.order.get(checkpoint.completed.len())?.clone();
    let bundle = &plan.request.bundle;

    let mut source_ids: HashSet<&str> =
        bundle.shared_source_ids.iter().map(String::as_str).collect();
    if let Some(bound) = bundle.bindings.get(&step_id) {
        source_ids.extend(bound.iter().map(String::as_str));
    }

    let sources = bundle
        .sources
        .iter()
        .filter(|source| source_ids.contains(source_id(source)))
        .cloned()
        .collect();

    Some(NextStepInputs { step_id, sources })
}

/// Port of `planPortableRun(raw)` (`runner.server.ts`): derive the plan, mint its
/// initial checkpoint, and compute the first step's inputs in one call.
pub fn plan_portable_run(
    raw: &Value,
    identity: &PlanIdentity,
    catalog: &dyn ModelCatalog,
) -> Result<PlanRunResult, AgentExecutionError> {
    let plan = create_execution_plan(raw, identity, catalog)?;
    let checkpoint = create_checkpoint(&plan);
    let next_inputs = next_step_inputs(&plan, &checkpoint);
    Ok(PlanRunResult {
        schema_version: 1,
        plan,
        checkpoint,
        next_inputs,
    })
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Stable linear-scan topological sort: repeatedly take the lowest-`order`
/// pending layer whose dependencies are all resolved. `layers` must already be
/// sorted ascending by `order` (so `Iterator::find` yields the lowest-order ready
/// node). `CYCLIC_DEPENDENCY` when no node is ready but work remains.
fn topological_order(
    layers: &[&Value],
    dependencies: &IndexMap<String, Vec<String>>,
) -> Result<Vec<String>, AgentExecutionError> {
    let mut pending: HashSet<String> = layers
        .iter()
        .map(|layer| layer_id(layer).to_owned())
        .collect();
    let mut ordered: Vec<String> = Vec::with_capacity(layers.len());

    while !pending.is_empty() {
        let next = layers.iter().find(|layer| {
            let id = layer_id(layer);
            pending.contains(id)
                && dependencies
                    .get(id)
                    .map(|deps| deps.iter().all(|reference| !pending.contains(reference)))
                    .unwrap_or(true)
        });
        match next {
            Some(layer) => {
                let id = layer_id(layer).to_owned();
                pending.remove(&id);
                ordered.push(id);
            }
            None => {
                return Err(AgentExecutionError::cyclic_dependency(
                    "Step references and graph edges contain a cycle.",
                ));
            }
        }
    }
    Ok(ordered)
}

/// Validate the optional bundle graph and fold its edges into `dependencies`
/// (`target` gains `source` as a dependency, deduplicated). Reproduces
/// `INVALID_GRAPH` (non-unique node ids / non-unique or dangling step mappings)
/// and `UNSUPPORTED_GRAPH_EDGE` (an edge touching an unmapped node); malformed
/// shapes surface as the schema `400`.
fn apply_graph(
    graph: &Value,
    layer_ids: &HashSet<&str>,
    dependencies: &mut IndexMap<String, Vec<String>>,
) -> Result<(), AgentExecutionError> {
    let graph = graph
        .as_object()
        .ok_or_else(|| schema_error("bundle graph must be an object."))?;
    let nodes = graph
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or_else(|| schema_error("graph nodes must be an array."))?;
    if nodes.len() > 1000 {
        return Err(schema_error("graph nodes exceeds the maximum of 1000."));
    }
    let edges = graph
        .get("edges")
        .and_then(Value::as_array)
        .ok_or_else(|| schema_error("graph edges must be an array."))?;
    if edges.len() > 5000 {
        return Err(schema_error("graph edges exceeds the maximum of 5000."));
    }

    // node.id -> node.data.layerId (None when the node maps to no step).
    let mut node_map: HashMap<&str, Option<&str>> = HashMap::with_capacity(nodes.len());
    for node in nodes {
        let node = node
            .as_object()
            .ok_or_else(|| schema_error("graph node must be an object."))?;
        let id = node
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| schema_error("graph node id is required."))?;
        if !validation::is_valid_identifier(id) {
            return Err(schema_error(format!(
                "graph node id '{id}' is not a valid identifier."
            )));
        }
        let data = node
            .get("data")
            .and_then(Value::as_object)
            .ok_or_else(|| schema_error("graph node data must be an object."))?;
        let mapped_layer = match data.get("layerId") {
            None | Some(Value::Null) => None,
            Some(value) => {
                let layer = value
                    .as_str()
                    .ok_or_else(|| schema_error("graph node data.layerId must be a string."))?;
                if !validation::is_valid_identifier(layer) {
                    return Err(schema_error(format!(
                        "graph node data.layerId '{layer}' is not a valid identifier."
                    )));
                }
                Some(layer)
            }
        };
        node_map.insert(id, mapped_layer);
    }
    // INVALID_GRAPH: node ids must be unique (a collapsed map is shorter).
    if node_map.len() != nodes.len() {
        return Err(AgentExecutionError::invalid_graph(
            "Graph node IDs must be unique.",
        ));
    }

    // INVALID_GRAPH: mapped step ids must be unique and refer to existing steps.
    let mapped: Vec<&str> = node_map.values().filter_map(|layer| *layer).collect();
    let mapped_unique: HashSet<&str> = mapped.iter().copied().collect();
    if mapped.iter().any(|id| !layer_ids.contains(id)) || mapped_unique.len() != mapped.len() {
        return Err(AgentExecutionError::invalid_graph(
            "Graph step mappings must be unique and refer to existing steps.",
        ));
    }

    for edge in edges {
        let edge = edge
            .as_object()
            .ok_or_else(|| schema_error("graph edge must be an object."))?;
        let source_node = edge
            .get("source")
            .and_then(Value::as_str)
            .ok_or_else(|| schema_error("graph edge source is required."))?;
        let target_node = edge
            .get("target")
            .and_then(Value::as_str)
            .ok_or_else(|| schema_error("graph edge target is required."))?;
        if !validation::is_valid_identifier(source_node)
            || !validation::is_valid_identifier(target_node)
        {
            return Err(schema_error(
                "graph edge source/target must be valid identifiers.",
            ));
        }

        let source = node_map.get(source_node).copied().flatten();
        let target = node_map.get(target_node).copied().flatten();
        let (Some(source), Some(target)) = (source, target) else {
            return Err(AgentExecutionError::unsupported_graph_edge(
                "Execution edges must connect mapped steps; bind source nodes explicitly as inputs.",
            ));
        };

        if let Some(deps) = dependencies.get_mut(target) {
            if !deps.iter().any(|existing| existing.as_str() == source) {
                deps.push(source.to_owned());
            }
        }
    }
    Ok(())
}

/// `layer.id` (empty when absent — the caller has already validated shape).
fn layer_id(layer: &Value) -> &str {
    layer.get("id").and_then(Value::as_str).unwrap_or_default()
}

/// `layer.order ?? 0` — the stable sort key.
fn layer_order(layer: &Value) -> f64 {
    layer.get("order").and_then(Value::as_f64).unwrap_or(0.0)
}

/// `layer.referencedSteps` (raw, not de-duplicated), defaulting to empty.
fn layer_referenced_steps(layer: &Value) -> Vec<String> {
    layer
        .get("referencedSteps")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// `layer.selectedModel ?? DEFAULT_MODEL` (normalizeBundle already applied the
/// default, so this is belt-and-suspenders like the reference).
fn layer_selected_model(layer: &Value) -> &str {
    layer
        .get("selectedModel")
        .and_then(Value::as_str)
        .unwrap_or(validation::DEFAULT_MODEL)
}

/// `layer.isActive !== false` — active unless *explicitly* the boolean `false`.
fn is_layer_active(layer: &Value) -> bool {
    !matches!(layer.get("isActive"), Some(Value::Bool(false)))
}

/// `!!layer.isFrozen` (JavaScript truthiness).
fn is_layer_frozen(layer: &Value) -> bool {
    is_truthy(layer.get("isFrozen"))
}

/// JavaScript truthiness for an optional value (empty array/object are truthy;
/// `0`/`""`/`false`/`null`/absent are falsy).
fn is_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().map(|float| float != 0.0).unwrap_or(true),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// The `sourceId` of either source variant.
fn source_id(source: &ExecutionSource) -> &str {
    match source {
        ExecutionSource::Upload { source_id, .. } => source_id,
        ExecutionSource::Text { source_id, .. } => source_id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn catalog() -> StaticModelCatalog {
        // Must include the current `validation::DEFAULT_MODEL` (gemini-2.5-flash):
        // bundles that omit `selectedModel` are stamped with it by normalizeBundle,
        // so a catalog missing it would trip the plan-time UNSUPPORTED_MODEL gate.
        StaticModelCatalog::new(["gemini-2.5-flash", "gemini-3.6-flash", "gemini-3-flash-preview"])
    }

    fn identity() -> PlanIdentity {
        PlanIdentity::new("run-1", "2026-09-23T00:00:00Z")
    }

    /// A plan request wrapping the given layers with no sources/bindings.
    fn request(layers: Value) -> Value {
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
    fn topo_picks_lowest_order_ready_node_not_lowest_order_overall() {
        // `a` has order 0 but depends on `b`; it must not lead the order.
        let raw = request(json!([
            {"id": "a", "name": "A", "userInstruction": "go", "order": 0, "referencedSteps": ["b"]},
            {"id": "b", "name": "B", "userInstruction": "go", "order": 1},
            {"id": "c", "name": "C", "userInstruction": "go", "order": 2}
        ]));
        let plan = create_execution_plan(&raw, &identity(), &catalog()).unwrap();
        assert_eq!(plan.order, vec!["b", "a", "c"]);
        assert_eq!(plan.dependencies["a"], vec!["b"]);
        assert_eq!(plan.plan_hash.len(), 64);
    }

    #[test]
    fn topo_matches_ib_bundle_expected_order() {
        // Mirrors public/workflow-examples/ib-bundle.json's 7-layer DAG.
        let raw = request(json!([
            {"id": "summary", "name": "S", "userInstruction": "x", "order": 0,
             "referencedSteps": ["introduction", "quality", "nonclinical", "human"]},
            {"id": "introduction", "name": "I", "userInstruction": "x", "order": 1},
            {"id": "quality", "name": "Q", "userInstruction": "x", "order": 2},
            {"id": "nonclinical", "name": "N", "userInstruction": "x", "order": 3},
            {"id": "human", "name": "H", "userInstruction": "x", "order": 4},
            {"id": "guidance", "name": "G", "userInstruction": "x", "order": 5,
             "referencedSteps": ["quality", "nonclinical", "human"]},
            {"id": "references", "name": "R", "userInstruction": "x", "order": 6,
             "referencedSteps": ["summary", "guidance"]}
        ]));
        let plan = create_execution_plan(&raw, &identity(), &catalog()).unwrap();
        assert_eq!(
            plan.order,
            vec![
                "introduction",
                "quality",
                "nonclinical",
                "human",
                "summary",
                "guidance",
                "references"
            ]
        );
    }

    #[test]
    fn verify_round_trips_a_created_plan() {
        let raw = request(json!([
            {"id": "a", "name": "A", "userInstruction": "go", "order": 0},
            {"id": "b", "name": "B", "userInstruction": "go", "order": 1, "referencedSteps": ["a"]}
        ]));
        let plan = create_execution_plan(&raw, &identity(), &catalog()).unwrap();
        let plan_value = serde_json::to_value(&plan).unwrap();
        let verified = verify_execution_plan(&plan_value, &catalog()).unwrap();
        assert_eq!(verified.plan_hash, plan.plan_hash);
        assert_eq!(verified.order, plan.order);
    }

    #[test]
    fn verify_rejects_a_tampered_plan() {
        let raw = request(json!([
            {"id": "a", "name": "A", "userInstruction": "go", "order": 0},
            {"id": "b", "name": "B", "userInstruction": "go", "order": 1, "referencedSteps": ["a"]}
        ]));
        let plan = create_execution_plan(&raw, &identity(), &catalog()).unwrap();
        let mut tampered = serde_json::to_value(&plan).unwrap();
        tampered["order"] = json!(["b", "a"]); // reversed, but planHash left stale
        assert!(verify_execution_plan(&tampered, &catalog()).is_err());
    }

    #[test]
    fn cyclic_dependencies_are_rejected() {
        let raw = request(json!([
            {"id": "a", "name": "A", "userInstruction": "go", "referencedSteps": ["b"]},
            {"id": "b", "name": "B", "userInstruction": "go", "referencedSteps": ["a"]}
        ]));
        assert!(create_execution_plan(&raw, &identity(), &catalog()).is_err());
    }

    #[test]
    fn dangling_reference_is_rejected() {
        let raw = request(json!([
            {"id": "a", "name": "A", "userInstruction": "go", "referencedSteps": ["ghost"]}
        ]));
        assert!(create_execution_plan(&raw, &identity(), &catalog()).is_err());
    }

    #[test]
    fn missing_prerequisite_for_frozen_reference_is_rejected() {
        // `a` references `b`; `b` is frozen (unselected) and not pinned.
        let raw = request(json!([
            {"id": "a", "name": "A", "userInstruction": "go", "order": 1, "referencedSteps": ["b"]},
            {"id": "b", "name": "B", "userInstruction": "go", "order": 0, "isFrozen": true}
        ]));
        assert!(create_execution_plan(&raw, &identity(), &catalog()).is_err());
    }

    #[test]
    fn unknown_model_is_rejected_but_image_model_plans() {
        let unknown = request(json!([
            {"id": "a", "name": "A", "userInstruction": "go", "selectedModel": "mystery-model"}
        ]));
        assert!(create_execution_plan(&unknown, &identity(), &catalog()).is_err());

        // Image models pass the plan-time gate (rejected later at execute-time).
        let image = request(json!([
            {"id": "a", "name": "A", "userInstruction": "go", "selectedModel": "gemini-2.5-flash-image"}
        ]));
        assert!(create_execution_plan(&image, &identity(), &catalog()).is_ok());
    }

    #[test]
    fn pinned_output_for_missing_step_is_rejected() {
        let mut raw = request(json!([
            {"id": "a", "name": "A", "userInstruction": "go"}
        ]));
        raw["previousOutputs"] = json!({
            "ghost": { "version": 1, "timestamp": "2026-09-23T00:00:00Z", "result": "x", "imageUrls": [] }
        });
        assert!(create_execution_plan(&raw, &identity(), &catalog()).is_err());
    }

    #[test]
    fn checkpoint_and_advance_state_machine() {
        let raw = request(json!([
            {"id": "a", "name": "A", "userInstruction": "go", "order": 0},
            {"id": "b", "name": "B", "userInstruction": "go", "order": 1, "referencedSteps": ["a"]}
        ]));
        let plan = create_execution_plan(&raw, &identity(), &catalog()).unwrap();

        let checkpoint = create_checkpoint(&plan);
        assert_eq!(checkpoint.status, CheckpointStatus::Ready);
        assert_eq!(checkpoint.revision, 0);
        assert_eq!(next_step_inputs(&plan, &checkpoint).unwrap().step_id, "a");
        verify_checkpoint(&checkpoint, &plan).unwrap();

        let receipt_a = Receipt {
            step_id: "a".into(),
            attempt_id: "att-a".into(),
            output: OutputVersion {
                version: 1,
                timestamp: "2026-09-23T00:00:00Z".into(),
                result: "output a".into(),
                image_urls: vec![],
            },
            diagnostics: json!({}),
            sources: json!([]),
            response_metadata: None,
        };
        let after_a = advance_on_success(&checkpoint, &plan, receipt_a, false);
        assert_eq!(after_a.revision, 1);
        assert_eq!(after_a.completed.len(), 1);
        assert_eq!(after_a.status, CheckpointStatus::Ready);
        verify_checkpoint(&after_a, &plan).unwrap();
        assert_eq!(next_step_inputs(&plan, &after_a).unwrap().step_id, "b");

        let receipt_b = Receipt {
            step_id: "b".into(),
            attempt_id: "att-b".into(),
            output: OutputVersion {
                version: 1,
                timestamp: "2026-09-23T00:01:00Z".into(),
                result: "output b".into(),
                image_urls: vec![],
            },
            diagnostics: json!({}),
            sources: json!([]),
            response_metadata: None,
        };
        let after_b = advance_on_success(&after_a, &plan, receipt_b, false);
        assert_eq!(after_b.revision, 2);
        assert_eq!(after_b.status, CheckpointStatus::Completed);
        verify_checkpoint(&after_b, &plan).unwrap();
        assert!(next_step_inputs(&plan, &after_b).is_none());

        // materializeAgent folds the completed outputs back onto the layers.
        let agent = materialize_agent(&plan, &after_b).unwrap();
        let layers = agent["layers"].as_array().unwrap();
        let layer_a = layers.iter().find(|l| l["id"] == "a").unwrap();
        assert_eq!(layer_a["result"], "output a");
        assert!(layer_a["outputHistory"].is_array());
    }

    #[test]
    fn advance_on_failure_marks_failed_and_keeps_revision_invariant() {
        let raw = request(json!([
            {"id": "a", "name": "A", "userInstruction": "go", "order": 0}
        ]));
        let plan = create_execution_plan(&raw, &identity(), &catalog()).unwrap();
        let checkpoint = create_checkpoint(&plan);

        let failed = advance_on_failure(&checkpoint, "a", "att-a", "EXECUTION_FAILED", true);
        assert_eq!(failed.status, CheckpointStatus::Failed);
        assert_eq!(failed.revision, 1);
        assert_eq!(failed.revision as usize, failed.attempts.len());
        assert!(failed.completed.is_empty());
        verify_checkpoint(&failed, &plan).unwrap();
    }

    #[test]
    fn shared_source_reaches_every_layer() {
        let raw = json!({
            "bundle": {
                "schemaVersion": 1,
                "agent": { "name": "T", "layers": [
                    {"id": "a", "name": "A", "userInstruction": "go", "order": 0},
                    {"id": "b", "name": "B", "userInstruction": "go", "order": 1}
                ], "metadata": {} },
                "sources": [{"sourceId": "shared", "kind": "text", "name": "s", "text": "hi"}],
                "bindings": {},
                "sharedSourceIds": ["shared"],
                "skills": []
            },
            "previousOutputs": {}
        });
        let plan = create_execution_plan(&raw, &identity(), &catalog()).unwrap();
        let checkpoint = create_checkpoint(&plan);

        // First layer sees the shared source.
        let first = next_step_inputs(&plan, &checkpoint).unwrap();
        assert_eq!(first.step_id, "a");
        assert_eq!(first.sources.len(), 1);

        // After completing `a`, the second layer still sees it.
        let receipt = Receipt {
            step_id: "a".into(),
            attempt_id: "att-a".into(),
            output: OutputVersion {
                version: 1,
                timestamp: "2026-09-23T00:00:00Z".into(),
                result: "out".into(),
                image_urls: vec![],
            },
            diagnostics: json!({}),
            sources: json!([]),
            response_metadata: None,
        };
        let advanced = advance_on_success(&checkpoint, &plan, receipt, false);
        let second = next_step_inputs(&plan, &advanced).unwrap();
        assert_eq!(second.step_id, "b");
        assert_eq!(second.sources.len(), 1);
    }

    #[test]
    fn graph_edge_adds_a_dependency() {
        let raw = json!({
            "bundle": {
                "schemaVersion": 1,
                "agent": { "name": "T", "layers": [
                    {"id": "a", "name": "A", "userInstruction": "go", "order": 0},
                    {"id": "b", "name": "B", "userInstruction": "go", "order": 1}
                ], "metadata": {} },
                "sources": [],
                "bindings": {},
                "sharedSourceIds": [],
                "skills": [],
                "graph": {
                    "nodes": [
                        {"id": "n1", "data": {"layerId": "a"}},
                        {"id": "n2", "data": {"layerId": "b"}}
                    ],
                    "edges": [{"source": "n1", "target": "n2"}]
                }
            },
            "previousOutputs": {}
        });
        let plan = create_execution_plan(&raw, &identity(), &catalog()).unwrap();
        // Edge n1->n2 makes `b` depend on `a`; order still [a, b].
        assert_eq!(plan.dependencies["b"], vec!["a"]);
        assert_eq!(plan.order, vec!["a", "b"]);
    }

    #[test]
    fn graph_edge_to_unmapped_node_is_rejected() {
        let raw = json!({
            "bundle": {
                "schemaVersion": 1,
                "agent": { "name": "T", "layers": [
                    {"id": "a", "name": "A", "userInstruction": "go", "order": 0}
                ], "metadata": {} },
                "sources": [],
                "bindings": {},
                "sharedSourceIds": [],
                "skills": [],
                "graph": {
                    "nodes": [
                        {"id": "n1", "data": {"layerId": "a"}},
                        {"id": "n2", "data": {}}
                    ],
                    "edges": [{"source": "n1", "target": "n2"}]
                }
            },
            "previousOutputs": {}
        });
        assert!(create_execution_plan(&raw, &identity(), &catalog()).is_err());
    }

    #[test]
    fn plan_portable_run_bundles_plan_checkpoint_and_next_inputs() {
        let raw = request(json!([
            {"id": "a", "name": "A", "userInstruction": "go", "order": 0}
        ]));
        let run = plan_portable_run(&raw, &identity(), &catalog()).unwrap();
        assert_eq!(run.schema_version, 1);
        assert_eq!(run.checkpoint.status, CheckpointStatus::Ready);
        assert_eq!(run.next_inputs.unwrap().step_id, "a");
    }
}
