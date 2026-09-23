//! Data-transfer objects for the portable agent-execution engine.
//!
//! Ported from `frontend_v3/app/lib/agentExecution/schema.ts` (the zod schema
//! module) under **equivalent-behavior** parity. Serde field naming is
//! `camelCase` to match the TypeScript wire format exactly.
//!
//! Strictness mapping (see the port plan, "DTOs"):
//! * zod `.strict()` objects            -> `#[serde(deny_unknown_fields)]`
//! * zod `.passthrough()` objects       -> a `#[serde(flatten)]` [`Passthrough`]
//!   bag (`serde_json::Map<String, Value>`). serde forbids `flatten` +
//!   `deny_unknown_fields` on the same struct, so the two are never combined.
//! * zod `z.object({...})` (strip mode) -> a plain struct (serde ignores unknown
//!   fields by default, matching zod's strip behaviour).
//!
//! The following stay opaque as [`serde_json::Value`] (port-plan directive):
//! `bundle.agent`, `receipt.diagnostics` / `sources` / `responseMetadata`,
//! `layer.ragKnowledge`, `metadata.skillRefs` / `corpusRefs`, `graph.node.data`.
//!
//! Deep validation that serde cannot express is **deliberately deferred** to the
//! `agentnodes::validation` pass and applied after deserialization: the
//! `identifierSchema` regex (`^[A-Za-z0-9_-]+$`) plus reserved-word rejection,
//! the `digest` shape (`^[a-f0-9]{64}$`), **map-key** regex validation (serde
//! does not validate map keys), `.literal(1)` asserts, and every array/string
//! length bound. Consequently, identifier-typed fields are plain `String` here.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// JSON overflow bag holding the extra keys of a zod `.passthrough()` object.
///
/// These keys are load-bearing downstream: executability checks and the export
/// subtree read passthrough-only keys such as `toolCall` / `functionCall` /
/// `condition` / `inputUrl`. Typed extracts (e.g. `result` / `output` / `tag`)
/// live in named fields, not here.
pub type Passthrough = Map<String, Value>;

fn schema_version_one() -> u32 {
    1
}

fn default_agent_id() -> String {
    "portable-agent".to_string()
}

/// A single versioned step output (`outputVersionSchema`).
///
/// zod strip-mode object: unknown keys are ignored, mirroring serde's default.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputVersion {
    /// `z.number().int().positive()`.
    pub version: u32,
    /// RFC-3339 datetime with offset (`z.string().datetime({ offset: true })`).
    pub timestamp: String,
    /// `textSchema` (max 2_000_000 chars, bound checked in validation).
    pub result: String,
    /// `z.array(imageUrlSchema).max(8).default([])`.
    #[serde(default)]
    pub image_urls: Vec<String>,
}

/// Optional model reasoning-effort hint (`layer.thinkingLevel`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ThinkingLevel {
    Minimal,
    Low,
    Medium,
    High,
}

/// Step output rendering mode (`layer.outputType`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OutputType {
    Basic,
    Code,
}

/// A discriminated execution source (`sourceSchema`, `discriminatedUnion('kind')`).
///
/// Both variants are `.strict()`. Internally-tagged on `kind`; serde enforces
/// `deny_unknown_fields` for the struct variants (the `kind` tag is consumed and
/// never counts as an unknown field).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ExecutionSource {
    /// Uploaded binary referenced by content digest.
    #[serde(rename_all = "camelCase")]
    Upload {
        source_id: String,
        name: String,
        mime_type: String,
        /// `digestSchema` — 64 lowercase hex chars (shape checked in validation).
        sha256: String,
    },
    /// Inline text source.
    #[serde(rename_all = "camelCase")]
    Text {
        source_id: String,
        name: String,
        /// `textSchema.min(1)`.
        text: String,
    },
}

/// A reusable skill snippet (`skillSchema`, `.strict()`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Skill {
    pub id: String,
    /// `textSchema.min(1)`.
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// A single agent step / layer (`layerSchema`, `.passthrough()`).
///
/// Typed fields cover the keys the engine reads directly; every other key of the
/// passthrough object is preserved in [`ExecutionLayer::passthrough`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionLayer {
    pub id: String,
    /// `z.string().min(1).max(1000)`.
    pub name: String,
    /// `textSchema.default('')`.
    #[serde(default)]
    pub user_instruction: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_instruction: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_input: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_type: Option<OutputType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_model: Option<String>,
    /// `z.number().int().positive()`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    /// `z.number().min(0).max(2)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<ThinkingLevel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_thoughts: Option<bool>,
    /// `z.array(identifierSchema).max(500).default([])`.
    #[serde(default)]
    pub referenced_steps: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_active: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_frozen: Option<bool>,
    /// `z.number().finite()` — used as the stable topo/export sort key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assistant_response: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_urls: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_history: Option<Vec<OutputVersion>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub corpus_id: Option<String>,
    /// `stepCorpusInputSchema.shape.documentSelections`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_selections: Option<Vec<String>>,
    /// `stepCorpusInputSchema.shape.metadataFilter`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata_filter: Option<String>,
    /// `ragKnowledge` (array of passthrough objects) kept opaque per port plan.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rag_knowledge: Option<Value>,
    /// zod `.passthrough()` overflow (`toolCall` / `functionCall` / `condition`
    /// / `inputUrl` / candidate output keys like `response` / `text` / …).
    #[serde(flatten)]
    pub passthrough: Passthrough,
}

/// Agent metadata (`agentSchema.metadata`, `.passthrough().default({})`).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_ids: Option<Vec<String>>,
    /// `skillRefs` kept opaque per port plan.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_refs: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_ids: Option<Vec<String>>,
    /// `corpusRefs` kept opaque per port plan.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub corpus_refs: Option<Value>,
    #[serde(flatten)]
    pub passthrough: Passthrough,
}

/// A saved/portable agent (`agentSchema`, `.passthrough()`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableAgent {
    /// `identifierSchema.default('portable-agent')`.
    #[serde(default = "default_agent_id")]
    pub id: String,
    /// `z.string().min(1).max(1000)`.
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_version: Option<String>,
    /// `z.array(layerSchema).min(1).max(500)` (bounds checked in validation).
    pub layers: Vec<ExecutionLayer>,
    #[serde(default)]
    pub metadata: AgentMetadata,
    #[serde(flatten)]
    pub passthrough: Passthrough,
}

/// One node of the optional bundle graph (`graph.nodes[]`, `.passthrough()`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    /// `node.data` kept opaque per port plan (inner `.passthrough()` object).
    pub data: Value,
    #[serde(flatten)]
    pub passthrough: Passthrough,
}

/// One edge of the optional bundle graph (`graph.edges[]`, `.passthrough()`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    #[serde(flatten)]
    pub passthrough: Passthrough,
}

/// The optional bundle graph (`bundleSchema.graph`, `.passthrough()`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphSpec {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    #[serde(flatten)]
    pub passthrough: Passthrough,
}

/// A complete execution bundle (`bundleSchema`, `.strict()`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionBundle {
    /// `z.literal(1).default(1)` (value asserted in validation).
    #[serde(default = "schema_version_one")]
    pub schema_version: u32,
    /// `z.unknown()` — opaque, normalized on the plan path.
    #[serde(default)]
    pub agent: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// `z.array(sourceSchema).max(1000).default([])`.
    #[serde(default)]
    pub sources: Vec<ExecutionSource>,
    /// `z.record(identifierSchema, z.array(identifierSchema).max(5)).default({})`.
    #[serde(default)]
    pub bindings: HashMap<String, Vec<String>>,
    /// `z.array(identifierSchema).max(5).default([])`.
    #[serde(default)]
    pub shared_source_ids: Vec<String>,
    /// `z.array(skillSchema).max(100).default([])`.
    #[serde(default)]
    pub skills: Vec<Skill>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graph: Option<GraphSpec>,
}

/// Per-step corpus reference (`stepCorpusInputSchema`).
///
/// zod strip-mode object (`agentCorpusRefSchema.extend(...)`): unknown keys are
/// ignored, matching serde's default.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepCorpusInput {
    /// `z.string().min(1).max(256)`.
    pub corpus_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// `driveFileIdSchema`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    /// `z.array(z.string().min(1).max(512)).max(10000)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_selections: Option<Vec<String>>,
    /// `z.string().max(20000)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata_filter: Option<String>,
}

/// Standalone single-step execution request (`stepExecuteSchema`, `.strict()`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StepExecuteInput {
    #[serde(default = "schema_version_one")]
    pub schema_version: u32,
    pub step: ExecutionLayer,
    /// `z.array(sourceSchema).max(5).default([])`.
    #[serde(default)]
    pub sources: Vec<ExecutionSource>,
    #[serde(default)]
    pub skills: Vec<Skill>,
    /// `z.record(identifierSchema, outputVersionSchema).default({})`.
    #[serde(default)]
    pub previous_outputs: HashMap<String, OutputVersion>,
    /// `z.record(identifierSchema, z.string().max(1000)).default({})`.
    #[serde(default)]
    pub reference_names: HashMap<String, String>,
    /// `z.array(stepCorpusInputSchema).max(50).default([])`.
    #[serde(default)]
    pub corpora: Vec<StepCorpusInput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
}

/// Request to build an execution plan (`planRequestSchema`, `.strict()`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanRequest {
    pub bundle: ExecutionBundle,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
    #[serde(default)]
    pub previous_outputs: HashMap<String, OutputVersion>,
}

/// A materialized execution plan (`planSchema`, `.strict()`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionPlan {
    #[serde(default = "schema_version_one")]
    pub schema_version: u32,
    pub run_id: String,
    /// RFC-3339 datetime with offset.
    pub created_at: String,
    pub request: PlanRequest,
    /// Topologically ordered, selection-filtered step ids.
    pub order: Vec<String>,
    /// Order-preserving dependency lists for all layers.
    pub dependencies: HashMap<String, Vec<String>>,
    /// `digestSchema` — sha256 hex of the canonical plan content minus this field.
    pub plan_hash: String,
}

/// The record produced by a successful step execution (`receiptSchema`, `.strict()`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub step_id: String,
    pub attempt_id: String,
    pub output: OutputVersion,
    /// `z.record(z.unknown())` kept opaque (`inputHash` / `retrievalHash` / …).
    pub diagnostics: Value,
    /// `z.array(z.unknown()).max(10000)` kept opaque (retrieved sources).
    pub sources: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_metadata: Option<Value>,
}

/// Outcome of a single execution attempt (`checkpointSchema.attempts[]`, `.strict()`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AttemptStatus {
    Succeeded,
    Failed,
}

/// One attempt entry (`checkpointSchema.attempts[]`, `.strict()`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttemptRecord {
    pub step_id: String,
    pub attempt_id: String,
    pub status: AttemptStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub final_inference_attempted: bool,
}

/// Overall run lifecycle status (`checkpointSchema.status`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckpointStatus {
    Ready,
    Completed,
    Failed,
}

/// Durable run checkpoint (`checkpointSchema`, `.strict()`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionCheckpoint {
    #[serde(default = "schema_version_one")]
    pub schema_version: u32,
    pub run_id: String,
    pub plan_hash: String,
    /// `z.number().int().nonnegative()`; invariant: `revision == attempts.len()`.
    pub revision: u32,
    pub status: CheckpointStatus,
    /// Ordered prefix of `plan.order` (`z.array(receiptSchema).max(500)`).
    #[serde(default)]
    pub completed: Vec<Receipt>,
    /// `z.array(...).max(2000)`.
    #[serde(default)]
    pub attempts: Vec<AttemptRecord>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn execution_source_is_tagged_on_kind() {
        let upload: ExecutionSource = serde_json::from_value(json!({
            "kind": "upload",
            "sourceId": "src-1",
            "name": "doc.pdf",
            "mimeType": "application/pdf",
            "sha256": "a".repeat(64),
        }))
        .expect("upload source deserializes");
        assert!(matches!(upload, ExecutionSource::Upload { .. }));

        let text: ExecutionSource = serde_json::from_value(json!({
            "kind": "text",
            "sourceId": "src-2",
            "name": "inline",
            "text": "hello",
        }))
        .expect("text source deserializes");
        assert!(matches!(text, ExecutionSource::Text { .. }));

        // camelCase round-trips and the tag is emitted.
        let value = serde_json::to_value(&text).unwrap();
        assert_eq!(value["kind"], "text");
        assert_eq!(value["sourceId"], "src-2");
    }

    #[test]
    fn layer_captures_unknown_keys_in_passthrough_bag() {
        let layer: ExecutionLayer = serde_json::from_value(json!({
            "id": "layer-1",
            "name": "Intro",
            "userInstruction": "write",
            "order": 0,
            "toolCall": { "name": "search" },
            "condition": "always",
        }))
        .expect("layer deserializes");

        // Typed fields are extracted...
        assert_eq!(layer.id, "layer-1");
        assert_eq!(layer.order, Some(0.0));
        // ...and unknown keys land in the passthrough bag, preserved on re-emit.
        assert!(layer.passthrough.contains_key("toolCall"));
        assert!(layer.passthrough.contains_key("condition"));
        let round_tripped = serde_json::to_value(&layer).unwrap();
        assert_eq!(round_tripped["condition"], "always");
        assert_eq!(round_tripped["toolCall"]["name"], "search");
    }

    #[test]
    fn bundle_applies_defaults() {
        let bundle: ExecutionBundle = serde_json::from_value(json!({
            "agent": { "name": "a" },
        }))
        .expect("minimal bundle deserializes");
        assert_eq!(bundle.schema_version, 1);
        assert!(bundle.sources.is_empty());
        assert!(bundle.bindings.is_empty());
        assert!(bundle.graph.is_none());
    }

    #[test]
    fn portable_agent_defaults_id_and_metadata() {
        let agent: PortableAgent = serde_json::from_value(json!({
            "name": "Report agent",
            "layers": [{ "id": "l1", "name": "Step 1" }],
        }))
        .expect("agent deserializes");
        assert_eq!(agent.id, "portable-agent");
        assert_eq!(agent.metadata, AgentMetadata::default());
        assert_eq!(agent.layers.len(), 1);
    }
}
