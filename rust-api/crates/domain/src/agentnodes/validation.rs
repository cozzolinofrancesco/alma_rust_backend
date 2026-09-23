//! Post-deserialize validation pass for the portable agent-execution engine.
//!
//! Ports the semantic validators from the reference Next.js repo that serde/`dto.rs`
//! cannot express on their own:
//!
//! * `app/lib/agentExecution/schema.ts`     — `identifierSchema`, `digestSchema`, the strict
//!                                            array/string bounds, and the map-key (`z.record`)
//!                                            checks (serde never validates map *keys*).
//! * `app/lib/agentExecution/planner.server.ts` — `normalizeBundle` + `normalizeAgent`.
//! * `app/lib/agentExecution/validation.ts` — `validateExecutableLayer`.
//!
//! Design note — why this pass runs over [`serde_json::Value`] rather than the typed
//! DTOs from `dto.rs`: the layer / agent / graph objects are `.passthrough()` in zod and
//! are represented in `dto.rs` as passthrough bags, and `bundle.agent` is deliberately kept
//! as an untyped `Value`. The reference `normalizeBundle`/`validateExecutableLayer` code
//! reaches for many *dynamic* keys (`layer.fileIds`, `step.toolCall`, `step.urlContent`, …)
//! that only live in those bags. Validating over `Value` mirrors that dynamic access exactly
//! and keeps this unit decoupled from the precise Rust field names chosen in `dto.rs`.
//! A caller may pass either the raw request `Value` or a `serde_json::to_value(dto)` round-trip;
//! optional fields that carry zod `.default(...)` are treated as their default when absent.
//!
//! Everything here is `stage = "validation"`; statuses default to `422` except where the
//! reference overrides them (`INACTIVE_STEP` → 409, `INPUT_TOO_LARGE` → 413, the
//! version-mismatch guard → 409). Schema-shape failures (the zod `.parse` throwing before
//! `normalizeBundle` even runs) surface as a `400` `INVALID_INPUT`, matching how a `ZodError`
//! is rendered upstream.

use std::collections::HashSet;

use axum::http::StatusCode;
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

use super::error::{AgentExecutionError, stage};

/// Default model applied to any layer that omits `selectedModel`, mirroring
/// `DEFAULT_MODEL` in `app/lib/modelConfig.ts` (`normalizeBundle` sets
/// `layer.selectedModel ?? DEFAULT_MODEL`). Re-exported so `planner.rs` uses the same
/// value in `createExecutionPlan`. If the integrator centralises model config elsewhere,
/// dedupe against that source.
pub const DEFAULT_MODEL: &str = "gemini-2.5-flash";

/// Prototype-pollution guard from `identifierSchema.refine(...)`.
const RESERVED_IDENTIFIERS: [&str; 3] = ["__proto__", "constructor", "prototype"];
/// `identifierSchema = z.string().min(1).max(128)`.
const IDENTIFIER_MAX_LEN: usize = 128;
/// `digestSchema = z.string().regex(/^[a-f0-9]{64}$/)`.
const DIGEST_LEN: usize = 64;

// ---------------------------------------------------------------------------
// Error helpers
//
// The reference `AgentExecutionError` constructor is `(code, message, status = 422,
// stage = 'validation')`. Every error raised in this module keeps `stage = 'validation'`,
// so we only need the default constructor plus a status override. These two helpers localise
// the assumed `AgentExecutionError` API (built by the sibling `error.rs` unit) to one place.
// ---------------------------------------------------------------------------

fn agent_error(code: &'static str, message: impl Into<String>) -> AgentExecutionError {
    AgentExecutionError::new(
        code,
        message,
        StatusCode::UNPROCESSABLE_ENTITY,
        stage::VALIDATION,
    )
}

fn agent_error_status(
    code: &'static str,
    message: impl Into<String>,
    status: u16,
) -> AgentExecutionError {
    let http_status =
        StatusCode::from_u16(status).unwrap_or(StatusCode::UNPROCESSABLE_ENTITY);
    AgentExecutionError::new(code, message, http_status, stage::VALIDATION)
}

/// A zod `.parse` shape failure (wrong type, out-of-bounds, malformed identifier/digest).
/// Rendered as a `400` upstream, distinct from the semantic `422` engine errors.
fn schema_error(message: impl Into<String>) -> AgentExecutionError {
    AgentExecutionError::new(
        "INVALID_INPUT",
        message,
        StatusCode::BAD_REQUEST,
        stage::VALIDATION,
    )
}

// ---------------------------------------------------------------------------
// Identifier newtype + digest predicate
// ---------------------------------------------------------------------------

/// Returns whether `value` satisfies `identifierSchema`:
/// `^[A-Za-z0-9_-]+$`, length `1..=128`, and not a reserved (`__proto__`/`constructor`/
/// `prototype`) key. All permitted characters are ASCII, so byte- and char-length agree.
pub fn is_valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= IDENTIFIER_MAX_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        && !RESERVED_IDENTIFIERS.contains(&value)
}

/// Returns whether `value` satisfies `digestSchema` (`^[a-f0-9]{64}$`).
pub fn is_valid_digest(value: &str) -> bool {
    value.len() == DIGEST_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Validated identifier, the Rust equivalent of `identifierSchema`. Parsing enforces the
/// regex, the length bound, and the reserved-word refinement in one place so DTO fields and
/// map keys can share it. Serialises transparently as its inner string; deserialising a value
/// that fails validation is a hard serde error.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Identifier(String);

impl Identifier {
    /// Validates `raw` against `identifierSchema`. Returns a `400 INVALID_INPUT`
    /// [`AgentExecutionError`] on failure (mirroring an upstream `ZodError`).
    pub fn parse(raw: impl AsRef<str>) -> Result<Self, AgentExecutionError> {
        let raw = raw.as_ref();
        if RESERVED_IDENTIFIERS.contains(&raw) {
            return Err(schema_error(format!("Reserved identifier '{raw}'.")));
        }
        if !is_valid_identifier(raw) {
            return Err(schema_error(format!(
                "Invalid identifier '{raw}': must match ^[A-Za-z0-9_-]+$ and be 1-{IDENTIFIER_MAX_LEN} characters."
            )));
        }
        Ok(Self(raw.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_inner(self) -> String {
        self.0
    }
}

impl core::fmt::Display for Identifier {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl AsRef<str> for Identifier {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl From<Identifier> for String {
    fn from(identifier: Identifier) -> Self {
        identifier.0
    }
}

impl TryFrom<String> for Identifier {
    type Error = AgentExecutionError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Identifier::parse(value)
    }
}

impl TryFrom<&str> for Identifier {
    type Error = AgentExecutionError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Identifier::parse(value)
    }
}

impl Serialize for Identifier {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for Identifier {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Identifier::parse(&raw).map_err(|_| {
            D::Error::custom(format!(
                "invalid identifier '{raw}': expected ^[A-Za-z0-9_-]+$ (1-{IDENTIFIER_MAX_LEN} chars, non-reserved)"
            ))
        })
    }
}

// ---------------------------------------------------------------------------
// Low-level Value accessors (schema-shape enforcement)
// ---------------------------------------------------------------------------

/// JavaScript truthiness, needed to mirror `if (step[field])` / `step.isFrozen` checks.
/// Note the quirks preserved deliberately: empty array `[]` and empty object `{}` are
/// **truthy** in JS, while `0`, `""`, `false`, `null` are falsy.
fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().map(|float| float != 0.0).unwrap_or(true),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn require_object<'a>(
    value: &'a Value,
    what: &str,
) -> Result<&'a Map<String, Value>, AgentExecutionError> {
    value
        .as_object()
        .ok_or_else(|| schema_error(format!("{what} must be an object.")))
}

fn require_array<'a>(
    value: &'a Value,
    what: &str,
) -> Result<&'a Vec<Value>, AgentExecutionError> {
    value
        .as_array()
        .ok_or_else(|| schema_error(format!("{what} must be an array.")))
}

fn require_non_empty_string<'a>(
    parent: &'a Map<String, Value>,
    field: &str,
    max: usize,
    what: &str,
) -> Result<&'a str, AgentExecutionError> {
    let text = parent
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| schema_error(format!("{what} is required and must be a string.")))?;
    if text.is_empty() {
        return Err(schema_error(format!("{what} must not be empty.")));
    }
    if text.chars().count() > max {
        return Err(schema_error(format!(
            "{what} exceeds the maximum length of {max} characters."
        )));
    }
    Ok(text)
}

/// Validates an identifier held at `field` on `parent`; returns its string form.
fn require_identifier<'a>(
    parent: &'a Map<String, Value>,
    field: &str,
    what: &str,
) -> Result<&'a str, AgentExecutionError> {
    let raw = parent
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| schema_error(format!("{what} is required and must be a string.")))?;
    if !is_valid_identifier(raw) {
        return Err(schema_error(format!(
            "{what} '{raw}' is not a valid identifier (^[A-Za-z0-9_-]+$, 1-{IDENTIFIER_MAX_LEN}, non-reserved)."
        )));
    }
    Ok(raw)
}

/// Validates every element of an identifier array (`z.array(identifierSchema).max(bound)`).
fn validate_identifier_array(
    value: &Value,
    bound: usize,
    what: &str,
) -> Result<Vec<String>, AgentExecutionError> {
    let items = require_array(value, what)?;
    if items.len() > bound {
        return Err(schema_error(format!(
            "{what} exceeds the maximum length of {bound} entries."
        )));
    }
    let mut collected = Vec::with_capacity(items.len());
    for item in items {
        let raw = item
            .as_str()
            .ok_or_else(|| schema_error(format!("{what} entries must be strings.")))?;
        if !is_valid_identifier(raw) {
            return Err(schema_error(format!(
                "{what} contains an invalid identifier '{raw}'."
            )));
        }
        collected.push(raw.to_owned());
    }
    Ok(collected)
}

/// Enforces the `z.record(identifierSchema, ...)` key contract that serde skips entirely.
/// Exported so the planner/step units can apply it to `previousOutputs` and `referenceNames`.
pub fn validate_identifier_map_keys(
    map: &Map<String, Value>,
    what: &str,
) -> Result<(), AgentExecutionError> {
    for key in map.keys() {
        if !is_valid_identifier(key) {
            return Err(schema_error(format!(
                "{what} key '{key}' is not a valid identifier (^[A-Za-z0-9_-]+$, 1-{IDENTIFIER_MAX_LEN}, non-reserved)."
            )));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// validateExecutableLayer  (validation.ts)
// ---------------------------------------------------------------------------

/// Port of `validateExecutableLayer(step)` from `app/lib/agentExecution/validation.ts`.
///
/// * empty `userInstruction` (after trim)        → `MISSING_INSTRUCTION` (422)
/// * `isActive === false` **or** truthy `isFrozen` → `INACTIVE_STEP` (409)
/// * truthy `toolCall`/`functionCall`/`condition`/`inputUrl` → `UNSUPPORTED_STEP_BEHAVIOR` (422)
/// * non-empty `urlContent` array                → `UNBOUND_INPUT` (422)
pub fn validate_executable_layer(step: &Value) -> Result<(), AgentExecutionError> {
    let step = require_object(step, "step")?;
    let step_id = step.get("id").and_then(Value::as_str).unwrap_or_default();

    // `userInstruction` carries a `.default('')`; treat absent/non-string as empty.
    let user_instruction = step
        .get("userInstruction")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if user_instruction.trim().is_empty() {
        return Err(agent_error(
            "MISSING_INSTRUCTION",
            format!("Step {step_id} needs a user instruction."),
        ));
    }

    let is_inactive = matches!(step.get("isActive"), Some(Value::Bool(false)));
    let is_frozen = step.get("isFrozen").map(is_truthy).unwrap_or(false);
    if is_inactive || is_frozen {
        return Err(agent_error_status(
            "INACTIVE_STEP",
            format!("Activate and unfreeze step {step_id} before executing it."),
            409,
        ));
    }

    for field in ["toolCall", "functionCall", "condition", "inputUrl"] {
        if step.get(field).map(is_truthy).unwrap_or(false) {
            return Err(agent_error(
                "UNSUPPORTED_STEP_BEHAVIOR",
                format!("Step {step_id} uses {field}; supply explicit inputs instead."),
            ));
        }
    }

    if let Some(Value::Array(url_content)) = step.get("urlContent") {
        if !url_content.is_empty() {
            return Err(agent_error(
                "UNBOUND_INPUT",
                "Supply URL content as an explicit text source.",
            ));
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// normalizeAgent  (planner.server.ts) — inline agents only (C10, skip versionUtils)
// ---------------------------------------------------------------------------

/// Port of `normalizeAgent(raw, selectedVersion)` for the **inline-agent** path only.
///
/// Saved-agent versioning (`versionUtils`) is a v1 cut — the SPA always sends inline agents.
/// A versioned payload (`isVersionedAgent`: has `agentName` + `versions[]`) is therefore
/// rejected instead of silently mishandled. Otherwise this validates the `agentSchema` shape
/// (identifiers, layer bounds, metadata) and enforces the inline version guard:
/// `selectedVersion && selectedVersion !== (agent.version ?? agent.currentVersion)` →
/// `VERSION_NOT_FOUND` (409). Returns the agent unchanged; `normalize_bundle` applies the
/// `selectedModel` defaults afterwards, exactly as the reference does.
pub fn normalize_agent(
    raw: &Value,
    selected_version: Option<&str>,
) -> Result<Value, AgentExecutionError> {
    let agent = require_object(raw, "agent")?;

    if agent.contains_key("agentName")
        && agent.get("versions").map(Value::is_array).unwrap_or(false)
    {
        return Err(agent_error_status(
            "UNSUPPORTED_AGENT",
            "Saved-agent versioning is not supported; supply an inline agent.",
            422,
        ));
    }

    // agentSchema shape.
    if let Some(id) = agent.get("id") {
        if !id.is_null() {
            let raw_id = id
                .as_str()
                .ok_or_else(|| schema_error("agent id must be a string."))?;
            if !is_valid_identifier(raw_id) {
                return Err(schema_error(format!(
                    "agent id '{raw_id}' is not a valid identifier."
                )));
            }
        }
    }
    require_non_empty_string(agent, "name", 1000, "agent name")?;

    let layers_value = agent
        .get("layers")
        .ok_or_else(|| schema_error("agent must include layers."))?;
    let layers = require_array(layers_value, "agent layers")?;
    if layers.is_empty() {
        return Err(schema_error("agent must include at least one layer."));
    }
    if layers.len() > 500 {
        return Err(schema_error("agent exceeds the maximum of 500 layers."));
    }
    for layer in layers {
        validate_layer_shape(layer)?;
    }

    validate_agent_metadata(agent)?;

    let version = agent_version(agent);
    if let (Some(selected), version) = (selected_version, version.as_deref()) {
        if version != Some(selected) {
            return Err(agent_error_status(
                "VERSION_NOT_FOUND",
                "The inline agent does not contain the requested version.",
                409,
            ));
        }
    }

    Ok(Value::Object(agent.clone()))
}

/// `agent.version ?? agent.currentVersion`.
fn agent_version(agent: &Map<String, Value>) -> Option<String> {
    agent
        .get("version")
        .and_then(Value::as_str)
        .or_else(|| agent.get("currentVersion").and_then(Value::as_str))
        .map(str::to_owned)
}

/// Validates the identifier-typed and bounded parts of `layerSchema` that serde cannot.
/// Field-level type/enum/string-length checks on the typed layer fields are left to the
/// `dto.rs` serde layer; here we cover `id` (identifier), `name` (required, ≤1000), and
/// `referencedSteps` (identifier array, ≤500).
fn validate_layer_shape(layer: &Value) -> Result<(), AgentExecutionError> {
    let layer = require_object(layer, "layer")?;
    require_identifier(layer, "id", "layer id")?;
    require_non_empty_string(layer, "name", 1000, "layer name")?;
    if let Some(referenced) = layer.get("referencedSteps") {
        if !referenced.is_null() {
            validate_identifier_array(referenced, 500, "layer referencedSteps")?;
        }
    }
    Ok(())
}

/// Validates `agentSchema.metadata` identifier arrays + `skillRefs` shape.
fn validate_agent_metadata(agent: &Map<String, Value>) -> Result<(), AgentExecutionError> {
    let metadata = match agent.get("metadata") {
        None | Some(Value::Null) => return Ok(()), // `.default({})`
        Some(other) => require_object(other, "agent metadata")?,
    };

    if let Some(skill_ids) = metadata.get("skillIds") {
        if !skill_ids.is_null() {
            validate_identifier_array(skill_ids, 100, "metadata skillIds")?;
        }
    }
    if let Some(file_ids) = metadata.get("fileIds") {
        if !file_ids.is_null() {
            validate_identifier_array(file_ids, 1000, "metadata fileIds")?;
        }
    }
    if let Some(skill_refs) = metadata.get("skillRefs") {
        if !skill_refs.is_null() {
            let refs = require_array(skill_refs, "metadata skillRefs")?;
            if refs.len() > 100 {
                return Err(schema_error(
                    "metadata skillRefs exceeds the maximum of 100 entries.",
                ));
            }
            for reference in refs {
                let reference = require_object(reference, "metadata skillRef")?;
                require_identifier(reference, "skillId", "metadata skillRef skillId")?;
                let version_ok = reference
                    .get("version")
                    .and_then(Value::as_u64)
                    .map(|version| version >= 1)
                    .unwrap_or(false);
                if !version_ok {
                    return Err(schema_error(
                        "metadata skillRef version must be a positive integer.",
                    ));
                }
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// normalizeBundle  (planner.server.ts)
// ---------------------------------------------------------------------------

/// Port of `normalizeBundle(raw)` from `app/lib/agentExecution/planner.server.ts`.
///
/// Runs in two phases, mirroring `bundleSchema.parse(raw)` then the imperative checks:
/// 1. **schema phase** — identifier/digest regexes, map-key regex on `bindings`, discriminated
///    `source.kind`, and the strict array bounds (all invisible to serde);
/// 2. **normalize phase** — `normalizeAgent`, apply `selectedModel ?? DEFAULT_MODEL`, then the
///    uniqueness / binding / unbound / size / skill checks.
///
/// Returns the bundle with its normalized agent spliced back in (`{ ...bundle, agent }`),
/// ready for `createExecutionPlan`.
///
/// Error conditions reproduced: `DUPLICATE_STEP`, `DUPLICATE_SOURCE`, `INVALID_SOURCE_BINDING`,
/// `UNBOUND_FILE`, `UNBOUND_SOURCE`, `INPUT_TOO_LARGE` (413), `DUPLICATE_SKILL`,
/// `UNRESOLVED_SKILL` — plus the schema-phase `400 INVALID_INPUT` failures.
pub fn normalize_bundle(raw: &Value) -> Result<Value, AgentExecutionError> {
    let bundle = require_object(raw, "bundle")?;

    // schemaVersion: z.literal(1).default(1).
    if let Some(schema_version) = bundle.get("schemaVersion") {
        if !schema_version.is_null() && schema_version.as_i64() != Some(1) {
            return Err(schema_error("bundle schemaVersion must be 1."));
        }
    }

    // ---- schema phase: sources -------------------------------------------------
    let sources = optional_array(bundle, "sources")?;
    if sources.len() > 1000 {
        return Err(schema_error("bundle sources exceeds the maximum of 1000."));
    }
    let mut source_ids: Vec<String> = Vec::with_capacity(sources.len());
    for source in &sources {
        let source = require_object(source, "source")?;
        let source_id = require_identifier(source, "sourceId", "source sourceId")?;
        require_non_empty_string(source, "name", 512, "source name")?;
        match source.get("kind").and_then(Value::as_str) {
            Some("upload") => {
                require_non_empty_string(source, "mimeType", 128, "source mimeType")?;
                let sha256 = source
                    .get("sha256")
                    .and_then(Value::as_str)
                    .ok_or_else(|| schema_error("upload source requires a sha256 digest."))?;
                if !is_valid_digest(sha256) {
                    return Err(schema_error(format!(
                        "source sha256 '{sha256}' must match ^[a-f0-9]{{64}}$."
                    )));
                }
            }
            Some("text") => {
                require_non_empty_string(source, "text", 2_000_000, "text source text")?;
            }
            Some(other) => {
                return Err(schema_error(format!("Unsupported source kind '{other}'.")));
            }
            None => return Err(schema_error("source is missing its 'kind' discriminator.")),
        }
        source_ids.push(source_id.to_owned());
    }

    // ---- schema phase: bindings (map-key regex + value identifiers + bounds) ----
    let bindings = optional_object(bundle, "bindings")?;
    validate_identifier_map_keys(&bindings, "bindings")?;
    for source_ids_value in bindings.values() {
        // value shape/identifiers/`.max(5)` here; uniqueness + membership run in the
        // normalize phase below, matching the reference ordering.
        validate_identifier_array(source_ids_value, 5, "bindings entry")?;
    }

    // ---- schema phase: sharedSourceIds + skills --------------------------------
    let shared_source_ids = match bundle.get("sharedSourceIds") {
        None | Some(Value::Null) => Vec::new(),
        Some(value) => validate_identifier_array(value, 5, "sharedSourceIds")?,
    };

    let skills = optional_array(bundle, "skills")?;
    if skills.len() > 100 {
        return Err(schema_error("bundle skills exceeds the maximum of 100."));
    }
    for skill in &skills {
        let skill = require_object(skill, "skill")?;
        require_identifier(skill, "id", "skill id")?;
        require_non_empty_string(skill, "text", 2_000_000, "skill text")?;
        if let Some(version) = skill.get("version") {
            if !version.is_null() {
                let version = version
                    .as_str()
                    .ok_or_else(|| schema_error("skill version must be a string."))?;
                if version.chars().count() > 128 {
                    return Err(schema_error("skill version exceeds 128 characters."));
                }
            }
        }
    }

    // graph shape validation (nodes/edges identifiers) is owned by the planner unit
    // (`createExecutionPlan`), which is where the graph is consumed.

    // ---- normalize phase -------------------------------------------------------
    let version = bundle
        .get("version")
        .and_then(Value::as_str)
        .filter(|version| !version.is_empty());
    let agent_value = bundle
        .get("agent")
        .ok_or_else(|| schema_error("bundle must include an agent."))?;
    let mut agent = normalize_agent(agent_value, version)?;

    // agent.layers = layers.map(l => ({ ...l, selectedModel: l.selectedModel ?? DEFAULT_MODEL }))
    apply_selected_model_defaults(&mut agent);

    let agent_object = agent
        .as_object()
        .expect("normalize_agent always returns an object");
    let layers = agent_object
        .get("layers")
        .and_then(Value::as_array)
        .expect("agentSchema guarantees a layers array");

    // DUPLICATE_STEP: layer ids must be unique.
    let layer_ids: HashSet<&str> = layers
        .iter()
        .filter_map(|layer| layer.get("id").and_then(Value::as_str))
        .collect();
    if layer_ids.len() != layers.len() {
        return Err(agent_error("DUPLICATE_STEP", "Step IDs must be unique."));
    }

    // DUPLICATE_SOURCE: source ids must be unique.
    let source_id_set: HashSet<&str> = source_ids.iter().map(String::as_str).collect();
    if source_id_set.len() != source_ids.len() {
        return Err(agent_error("DUPLICATE_SOURCE", "Source IDs must be unique."));
    }

    // INVALID_SOURCE_BINDING: each binding must map an existing step to existing, unique sources.
    for (step_id, source_ids_value) in &bindings {
        let bound: Vec<&str> = source_ids_value
            .as_array()
            .map(|items| items.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let unique: HashSet<&str> = bound.iter().copied().collect();
        if !layer_ids.contains(step_id.as_str())
            || bound.iter().any(|id| !source_id_set.contains(id))
            || unique.len() != bound.len()
        {
            return Err(agent_error(
                "INVALID_SOURCE_BINDING",
                format!("Invalid source bindings for {step_id}."),
            ));
        }
    }

    // INVALID_SOURCE_BINDING: sharedSourceIds must be unique and refer to existing sources.
    let shared_unique: HashSet<&str> = shared_source_ids.iter().map(String::as_str).collect();
    if shared_unique.len() != shared_source_ids.len()
        || shared_source_ids
            .iter()
            .any(|id| !source_id_set.contains(id.as_str()))
    {
        return Err(agent_error(
            "INVALID_SOURCE_BINDING",
            "Invalid shared source IDs.",
        ));
    }

    // UNBOUND_FILE: agent.metadata.fileIds must all be present in sharedSourceIds.
    if let Some(file_ids) = agent_object
        .get("metadata")
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get("fileIds"))
        .and_then(Value::as_array)
    {
        if file_ids
            .iter()
            .filter_map(Value::as_str)
            .any(|file_id| !shared_source_ids.iter().any(|shared| shared == file_id))
        {
            return Err(agent_error(
                "UNBOUND_FILE",
                "Download shared Drive files and supply matching source IDs in sharedSourceIds.",
            ));
        }
    }

    // UNBOUND_SOURCE: every source must be reachable via sharedSourceIds or a binding.
    let mut used: HashSet<&str> = shared_source_ids.iter().map(String::as_str).collect();
    for source_ids_value in bindings.values() {
        if let Some(items) = source_ids_value.as_array() {
            used.extend(items.iter().filter_map(Value::as_str));
        }
    }
    if source_ids.iter().any(|id| !used.contains(id.as_str())) {
        return Err(agent_error(
            "UNBOUND_SOURCE",
            "Every source must be bound explicitly.",
        ));
    }

    // INPUT_TOO_LARGE (413) + per-layer UNBOUND_FILE.
    for layer in layers {
        let layer_id = layer.get("id").and_then(Value::as_str).unwrap_or_default();
        let mut effective: HashSet<&str> = shared_source_ids.iter().map(String::as_str).collect();
        if let Some(bound) = bindings.get(layer_id).and_then(Value::as_array) {
            effective.extend(bound.iter().filter_map(Value::as_str));
        }
        if effective.len() > 5 {
            return Err(agent_error_status(
                "INPUT_TOO_LARGE",
                format!("Step {layer_id} exceeds five combined files."),
                413,
            ));
        }
        if let Some(Value::Array(layer_file_ids)) = layer.get("fileIds") {
            let unbound = layer_file_ids.iter().any(|file_id| {
                file_id
                    .as_str()
                    .map(|id| !effective.contains(id))
                    .unwrap_or(true) // non-string entry ⇒ unbound (mirrors `typeof !== 'string'`)
            });
            if unbound {
                return Err(agent_error(
                    "UNBOUND_FILE",
                    format!("Bind files explicitly for {layer_id}."),
                ));
            }
        }
    }

    // DUPLICATE_SKILL + UNRESOLVED_SKILL.
    let skill_ids: HashSet<&str> = skills
        .iter()
        .filter_map(|skill| skill.get("id").and_then(Value::as_str))
        .collect();
    if skill_ids.len() != skills.len() {
        return Err(agent_error("DUPLICATE_SKILL", "Skill IDs must be unique."));
    }
    let metadata = agent_object.get("metadata").and_then(Value::as_object);
    if let Some(metadata) = metadata {
        if let Some(required) = metadata.get("skillIds").and_then(Value::as_array) {
            for skill_id in required.iter().filter_map(Value::as_str) {
                if !skill_ids.contains(skill_id) {
                    return Err(agent_error(
                        "UNRESOLVED_SKILL",
                        format!("Supply resolved text for skill {skill_id}."),
                    ));
                }
            }
        }
        if let Some(refs) = metadata.get("skillRefs").and_then(Value::as_array) {
            for reference in refs {
                let skill_id = reference.get("skillId").and_then(Value::as_str);
                let required_version = reference.get("version").and_then(Value::as_u64);
                let (Some(skill_id), Some(required_version)) = (skill_id, required_version) else {
                    return Err(agent_error(
                        "UNRESOLVED_SKILL",
                        "Supply the pinned version of the referenced skill.",
                    ));
                };
                // skills.get(skillId)?.version !== String(reference.version)
                let resolved_version = skills
                    .iter()
                    .find(|skill| skill.get("id").and_then(Value::as_str) == Some(skill_id))
                    .and_then(|skill| skill.get("version"))
                    .and_then(Value::as_str);
                if resolved_version != Some(required_version.to_string().as_str()) {
                    return Err(agent_error(
                        "UNRESOLVED_SKILL",
                        format!("Supply the pinned version of skill {skill_id}."),
                    ));
                }
            }
        }
    }

    // Return `{ ...bundle, agent }`.
    let mut normalized = bundle.clone();
    normalized.insert("agent".to_owned(), agent);
    Ok(Value::Object(normalized))
}

/// `bundle.<field>` as an array, treating absent/null as the zod `.default([])`.
fn optional_array(
    bundle: &Map<String, Value>,
    field: &str,
) -> Result<Vec<Value>, AgentExecutionError> {
    match bundle.get(field) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(value) => require_array(value, field).map(|items| items.clone()),
    }
}

/// `bundle.<field>` as an object, treating absent/null as the zod `.default({})`.
fn optional_object(
    bundle: &Map<String, Value>,
    field: &str,
) -> Result<Map<String, Value>, AgentExecutionError> {
    match bundle.get(field) {
        None | Some(Value::Null) => Ok(Map::new()),
        Some(value) => require_object(value, field).map(|map| map.clone()),
    }
}

/// Applies `selectedModel ?? DEFAULT_MODEL` to every layer in the (already object-typed) agent.
fn apply_selected_model_defaults(agent: &mut Value) {
    let Some(layers) = agent
        .as_object_mut()
        .and_then(|object| object.get_mut("layers"))
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for layer in layers {
        let Some(layer) = layer.as_object_mut() else {
            continue;
        };
        let needs_default = match layer.get("selectedModel") {
            None | Some(Value::Null) => true,
            Some(_) => false,
        };
        if needs_default {
            layer.insert(
                "selectedModel".to_owned(),
                Value::String(DEFAULT_MODEL.to_owned()),
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Tests — pure predicates + branch coverage (is_ok/is_err, decoupled from the
// AgentExecutionError internals so they hold regardless of the sibling error.rs API).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn identifier_accepts_valid_and_rejects_invalid() {
        assert!(is_valid_identifier("step-1_A"));
        assert!(is_valid_identifier("a"));
        assert!(!is_valid_identifier(""));
        assert!(!is_valid_identifier("has space"));
        assert!(!is_valid_identifier("dots.not.allowed"));
        assert!(!is_valid_identifier(&"x".repeat(129)));
        assert!(is_valid_identifier(&"x".repeat(128)));
    }

    #[test]
    fn identifier_rejects_reserved_keys() {
        for reserved in ["__proto__", "constructor", "prototype"] {
            assert!(!is_valid_identifier(reserved));
            assert!(Identifier::parse(reserved).is_err());
        }
        assert_eq!(Identifier::parse("safe").unwrap().as_str(), "safe");
    }

    #[test]
    fn digest_regex_matches_only_64_hex_lowercase() {
        assert!(is_valid_digest(&"a".repeat(64)));
        assert!(is_valid_digest(&"0123456789abcdef".repeat(4)));
        assert!(!is_valid_digest(&"a".repeat(63)));
        assert!(!is_valid_digest(&"A".repeat(64))); // uppercase not allowed
        assert!(!is_valid_digest(&"g".repeat(64))); // out of [a-f]
    }

    fn minimal_bundle() -> Value {
        json!({
            "schemaVersion": 1,
            "agent": {
                "name": "Test",
                "layers": [
                    {"id": "a", "name": "A", "userInstruction": "do a"},
                    {"id": "b", "name": "B", "userInstruction": "do b", "referencedSteps": ["a"]}
                ],
                "metadata": {}
            },
            "sources": [{"sourceId": "s1", "kind": "text", "name": "src", "text": "hello"}],
            "bindings": {"a": ["s1"]},
            "sharedSourceIds": [],
            "skills": []
        })
    }

    #[test]
    fn normalize_bundle_accepts_a_valid_bundle_and_defaults_selected_model() {
        let normalized = normalize_bundle(&minimal_bundle()).expect("valid bundle");
        let layers = normalized["agent"]["layers"].as_array().unwrap();
        for layer in layers {
            assert_eq!(layer["selectedModel"], json!(DEFAULT_MODEL));
        }
    }

    #[test]
    fn normalize_bundle_preserves_explicit_selected_model() {
        let mut bundle = minimal_bundle();
        bundle["agent"]["layers"][0]["selectedModel"] = json!("custom-model");
        let normalized = normalize_bundle(&bundle).unwrap();
        assert_eq!(normalized["agent"]["layers"][0]["selectedModel"], json!("custom-model"));
        assert_eq!(normalized["agent"]["layers"][1]["selectedModel"], json!(DEFAULT_MODEL));
    }

    #[test]
    fn duplicate_step_ids_are_rejected() {
        let mut bundle = minimal_bundle();
        bundle["agent"]["layers"][1]["id"] = json!("a");
        // keep bindings/refs valid so DUPLICATE_STEP is the first failure
        bundle["agent"]["layers"][1]["referencedSteps"] = json!([]);
        assert!(normalize_bundle(&bundle).is_err());
    }

    #[test]
    fn duplicate_source_ids_are_rejected() {
        let mut bundle = minimal_bundle();
        bundle["sources"] = json!([
            {"sourceId": "s1", "kind": "text", "name": "a", "text": "x"},
            {"sourceId": "s1", "kind": "text", "name": "b", "text": "y"}
        ]);
        bundle["bindings"] = json!({"a": ["s1"]});
        assert!(normalize_bundle(&bundle).is_err());
    }

    #[test]
    fn binding_to_unknown_step_is_rejected() {
        let mut bundle = minimal_bundle();
        bundle["bindings"] = json!({"ghost": ["s1"]});
        assert!(normalize_bundle(&bundle).is_err());
    }

    #[test]
    fn unbound_source_is_rejected() {
        let mut bundle = minimal_bundle();
        bundle["bindings"] = json!({}); // s1 now bound nowhere
        assert!(normalize_bundle(&bundle).is_err());
    }

    #[test]
    fn more_than_five_combined_sources_is_input_too_large() {
        let bundle = json!({
            "agent": {
                "name": "Test",
                "layers": [{"id": "L", "name": "L", "userInstruction": "go"}],
                "metadata": {}
            },
            "sources": [
                {"sourceId": "x", "kind": "text", "name": "n", "text": "t"},
                {"sourceId": "y", "kind": "text", "name": "n", "text": "t"},
                {"sourceId": "z", "kind": "text", "name": "n", "text": "t"},
                {"sourceId": "p", "kind": "text", "name": "n", "text": "t"},
                {"sourceId": "q", "kind": "text", "name": "n", "text": "t"},
                {"sourceId": "r", "kind": "text", "name": "n", "text": "t"}
            ],
            "bindings": {"L": ["p", "q", "r"]},
            "sharedSourceIds": ["x", "y", "z"],
            "skills": []
        });
        assert!(normalize_bundle(&bundle).is_err());
    }

    #[test]
    fn unresolved_skill_reference_is_rejected() {
        let mut bundle = minimal_bundle();
        bundle["agent"]["metadata"] = json!({"skillIds": ["missing-skill"]});
        assert!(normalize_bundle(&bundle).is_err());
    }

    #[test]
    fn duplicate_skill_ids_are_rejected() {
        let mut bundle = minimal_bundle();
        bundle["skills"] = json!([
            {"id": "k", "text": "one"},
            {"id": "k", "text": "two"}
        ]);
        assert!(normalize_bundle(&bundle).is_err());
    }

    #[test]
    fn upload_source_requires_a_valid_digest() {
        let mut bundle = minimal_bundle();
        bundle["sources"] = json!([
            {"sourceId": "s1", "kind": "upload", "name": "f", "mimeType": "text/plain", "sha256": "not-a-digest"}
        ]);
        assert!(normalize_bundle(&bundle).is_err());

        bundle["sources"][0]["sha256"] = json!("a".repeat(64));
        assert!(normalize_bundle(&bundle).is_ok());
    }

    #[test]
    fn binding_map_key_must_be_a_valid_identifier() {
        let mut bundle = minimal_bundle();
        bundle["bindings"] = json!({"bad key": ["s1"]});
        assert!(normalize_bundle(&bundle).is_err());
    }

    #[test]
    fn versioned_agent_payload_is_rejected() {
        let versioned = json!({
            "agentName": "saved",
            "versions": [{"version": "v1", "layers": []}]
        });
        assert!(normalize_agent(&versioned, None).is_err());
    }

    #[test]
    fn version_mismatch_is_rejected() {
        let agent = json!({
            "name": "A",
            "version": "v1",
            "layers": [{"id": "a", "name": "A", "userInstruction": "x"}],
            "metadata": {}
        });
        assert!(normalize_agent(&agent, Some("v2")).is_err());
        assert!(normalize_agent(&agent, Some("v1")).is_ok());
        assert!(normalize_agent(&agent, None).is_ok());
    }

    #[test]
    fn validate_executable_layer_covers_each_branch() {
        // happy path
        assert!(validate_executable_layer(&json!({"id": "a", "userInstruction": "go"})).is_ok());
        // MISSING_INSTRUCTION
        assert!(validate_executable_layer(&json!({"id": "a", "userInstruction": "   "})).is_err());
        assert!(validate_executable_layer(&json!({"id": "a"})).is_err());
        // INACTIVE_STEP (isActive === false)
        assert!(validate_executable_layer(&json!({"id": "a", "userInstruction": "go", "isActive": false})).is_err());
        // INACTIVE_STEP (isFrozen truthy)
        assert!(validate_executable_layer(&json!({"id": "a", "userInstruction": "go", "isFrozen": true})).is_err());
        // isActive true must NOT trip it
        assert!(validate_executable_layer(&json!({"id": "a", "userInstruction": "go", "isActive": true})).is_ok());
        // UNSUPPORTED_STEP_BEHAVIOR
        for field in ["toolCall", "functionCall", "condition", "inputUrl"] {
            let mut layer = json!({"id": "a", "userInstruction": "go"});
            layer[field] = json!({"anything": 1});
            assert!(validate_executable_layer(&layer).is_err(), "expected {field} to trip");
        }
        // UNBOUND_INPUT (non-empty urlContent array)
        assert!(validate_executable_layer(&json!({"id": "a", "userInstruction": "go", "urlContent": ["http://x"]})).is_err());
        // empty urlContent array is fine
        assert!(validate_executable_layer(&json!({"id": "a", "userInstruction": "go", "urlContent": []})).is_ok());
    }
}
