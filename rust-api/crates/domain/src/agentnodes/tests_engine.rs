//! End-to-end engine tests for the `agentnodes` pure core, exercising the
//! seams between [`validation`](super::validation), [`hash`](super::hash) and
//! [`planner`](super::planner) against the two shipped workflow fixtures.
//!
//! Ported from `frontend_v3/app/lib/agentExecution/__tests__/*` (chiefly
//! `planner.test.ts`) under **equivalent-behavior** parity. The fixtures are
//! copied inline verbatim from `frontend_v3/public/workflow-examples/` so the
//! test is hermetic (no filesystem reads) — see [`IB_BUNDLE_JSON`] and
//! [`REPORT_272_INPUT_JSON`].
//!
//! What is covered:
//! * **topological ordering** — the IB bundle plans to the hand-traced order
//!   `[ib-introduction, ib-quality, ib-nonclinical, ib-human, ib-summary,
//!   ib-guidance, ib-references]` despite `ib-summary` carrying `order: 0`
//!   (the port plan's "Fixture reality" line);
//! * **`normalizeBundle` over both fixtures** — the IB bundle is a real bundle
//!   and normalizes (defaulting `selectedModel`); the 272 fixture is a
//!   *compile input*, **not** a bundle (port plan C3), so `normalize_bundle`
//!   rejects it raw — it only becomes plannable after `272/compile` produces a
//!   `.bundle` (that compile→plan path is owned by the `report_creation` unit
//!   and the e2e curl, not this pure-engine unit);
//! * **planHash round-trip** — both a planner-independent canonicalization
//!   round-trip (via `hash` alone) and the real planner's self-consistency
//!   (the stored `planHash` equals the canonical hash of the plan content with
//!   `planHash` removed — exactly the invariant `verify_execution_plan` /
//!   `verifyCheckpoint` rely on; a drift here 409s every `runs/advance`).
//!
//! Assumed planner API (the only cross-unit surface this file touches; the
//! integrator reconciles wiring if names differ):
//! ```ignore
//! super::planner::create_execution_plan(request: &serde_json::Value)
//!     -> Result<super::dto::ExecutionPlan, super::error::AgentExecutionError>
//! ```
//! mirroring `createExecutionPlan(raw)` in `planner.server.ts`: `request` is the
//! `planRequestSchema` value `{ bundle, stepId?, previousOutputs? }`, run id and
//! timestamp are generated internally, and semantic failures surface as
//! `AgentExecutionError`. The assertions read only the public
//! [`ExecutionPlan`](super::dto::ExecutionPlan) fields `order` and `plan_hash`.
#![cfg(test)]

use serde_json::{json, Value};

use super::hash::hash_canonical_json;
use super::validation::{normalize_bundle, DEFAULT_MODEL};

/// `frontend_v3/public/workflow-examples/ib-bundle.json`, copied verbatim.
const IB_BUNDLE_JSON: &str = r#"{
  "schemaVersion": 1,
  "agent": {
    "id": "ib-draft",
    "name": "Synthetic Investigator Brochure Draft",
    "layers": [
      {
        "id": "ib-summary",
        "name": "1. Summary",
        "userInstruction": "Summarize the supplied section outputs. Label this a synthetic incomplete IB draft. Retain missing-information flags. Do not invent findings or investigator guidance.",
        "referencedSteps": ["ib-introduction", "ib-quality", "ib-nonclinical", "ib-human"],
        "order": 0,
        "isActive": true
      },
      {
        "id": "ib-introduction",
        "name": "2. Introduction",
        "userInstruction": "Draft an introduction from the supplied source only. State the investigational product, rationale and scope only when provided. Mark every absent item as not supplied. This is a synthetic incomplete draft.",
        "referencedSteps": [],
        "order": 1,
        "isActive": true
      },
      {
        "id": "ib-quality",
        "name": "3. Physical, Chemical And Pharmaceutical Properties",
        "userInstruction": "Describe only the properties and formulation documented in the supplied source. Keep source identifiers. Missing composition, stability or storage information must remain not supplied; do not invent it.",
        "referencedSteps": [],
        "order": 2,
        "isActive": true
      },
      {
        "id": "ib-nonclinical",
        "name": "4. Nonclinical Studies",
        "userInstruction": "Summarize only supplied nonclinical pharmacology, exposure and toxicology evidence with exact source identifiers. Do not create missing findings, thresholds or interpretations. Mark missing domains not supplied.",
        "referencedSteps": [],
        "order": 3,
        "isActive": true
      },
      {
        "id": "ib-human",
        "name": "5. Effects In Humans",
        "userInstruction": "Summarize only supplied human exposure, pharmacokinetics and safety findings, preserving populations, units and study identifiers. No absent outcome may become zero. Mark missing information not supplied.",
        "referencedSteps": [],
        "order": 4,
        "isActive": true
      },
      {
        "id": "ib-guidance",
        "name": "6. Summary Of Data And Investigator Guidance",
        "userInstruction": "Combine the preceding evidence summaries and reproduce investigator guidance only if explicitly present in approved supplied material. Do not invent dosing, monitoring, risk advice or medical recommendations. List missing approved guidance for qualified review.",
        "referencedSteps": ["ib-quality", "ib-nonclinical", "ib-human"],
        "order": 5,
        "isActive": true
      },
      {
        "id": "ib-references",
        "name": "7. References And Open Items",
        "userInstruction": "List only supplied source identifiers cited by the preceding sections and their unresolved gaps. Do not fabricate bibliography entries. This is an incomplete synthetic drafting example, not an approved IB.",
        "referencedSteps": ["ib-summary", "ib-guidance"],
        "order": 6,
        "isActive": true
      }
    ]
  },
  "sources": [
    {
      "sourceId": "ib-source",
      "kind": "text",
      "name": "synthetic-ib-source-inventory.txt",
      "text": "Synthetic documentation example only. No product identity, quality package, nonclinical findings, clinical results or approved investigator guidance has been supplied. Each section must identify its gaps. This fixture tests workflow structure, not scientific content."
    }
  ],
  "sharedSourceIds": ["ib-source"],
  "bindings": {},
  "skills": []
}"#;

/// `frontend_v3/public/workflow-examples/272-input.json`, copied verbatim.
///
/// This is a `272/compile` **input** (`agentName` + `studies`/`sec3Steps`/
/// `sec1Steps`/`templates`), *not* an `ExecutionBundle` — it has no `agent`
/// with `layers`. `normalize_bundle` therefore rejects it (port plan C3).
const REPORT_272_INPUT_JSON: &str = r#"{
  "agentName": "Synthetic 272 workflow example",
  "sources": [
    {
      "sourceId": "sample-study",
      "kind": "text",
      "name": "sample-study.txt",
      "text": "Synthetic workflow data, not clinical evidence. Study DEMO-001 compares document processing: method A processed ten files in twenty minutes; method B processed ten files in fifteen minutes. No other outcomes were measured."
    }
  ],
  "templates": {
    "study-summary": {
      "id": "study-summary",
      "user_instruction": "Summarize [INSERT STUDY ID] from the supplied source. Preserve counts and units, mark missing information and label the output synthetic."
    }
  },
  "studies": [
    {
      "id": "sample-study",
      "fileName": "sample-study.txt",
      "docTitle": "Synthetic processing comparison",
      "protocolNumber": "DEMO-001",
      "templateId": "study-summary",
      "sourceIds": ["sample-study"]
    }
  ],
  "sec3Steps": [
    {
      "id": "synthesis",
      "name": "Cross-source synthesis",
      "instruction": "Summarize the preceding source-derived findings and list information not supplied. Do not infer clinical findings from this synthetic processing example."
    }
  ],
  "sec1Steps": [
    {
      "id": "overview",
      "name": "Overview",
      "instruction": "Write a short overview of the synthetic findings and unresolved gaps. Do not add missing outcomes, study designs or recommendations."
    }
  ]
}"#;

/// The IB fixture as a `serde_json::Value`.
fn ib_bundle_value() -> Value {
    serde_json::from_str(IB_BUNDLE_JSON).expect("ib-bundle.json fixture is valid JSON")
}

/// The 272 compile-input fixture as a `serde_json::Value`.
fn report_272_input_value() -> Value {
    serde_json::from_str(REPORT_272_INPUT_JSON).expect("272-input.json fixture is valid JSON")
}

/// A `planRequestSchema` value wrapping the IB bundle: `{ bundle: <ib-bundle> }`.
fn ib_plan_request() -> Value {
    json!({ "bundle": ib_bundle_value() })
}

// ---------------------------------------------------------------------------
// normalizeBundle over both fixtures
// ---------------------------------------------------------------------------

#[test]
fn normalize_bundle_accepts_the_ib_bundle_fixture() {
    let normalized = normalize_bundle(&ib_bundle_value())
        .expect("the IB bundle is a valid ExecutionBundle and must normalize");

    let layers = normalized["agent"]["layers"]
        .as_array()
        .expect("the normalized agent keeps its layers array");
    assert_eq!(layers.len(), 7, "all seven IB layers survive normalization");

    // `normalizeBundle` maps `selectedModel ?? DEFAULT_MODEL` over every layer;
    // the fixture omits `selectedModel`, so each layer gets the default model.
    for layer in layers {
        assert_eq!(
            layer["selectedModel"],
            json!(DEFAULT_MODEL),
            "layer {:?} should default to DEFAULT_MODEL",
            layer["id"],
        );
    }

    // The lone shared source is preserved on the returned `{ ...bundle, agent }`.
    assert_eq!(
        normalized["sources"].as_array().map(Vec::len),
        Some(1),
        "the shared IB source is retained",
    );
}

#[test]
fn normalize_bundle_rejects_the_272_compile_input_as_a_raw_bundle() {
    // 272-input.json is a `272/compile` input, not an ExecutionBundle: it has no
    // `agent`/`layers`. It only becomes plannable after `272/compile` emits a
    // `.bundle` (port plan C3 / "Fixture reality" — that compile→plan path is
    // owned by the `report_creation` unit + the e2e curl, not this unit).
    let error = normalize_bundle(&report_272_input_value())
        .expect_err("a compile input is not a bundle and must be rejected");

    // Missing-`agent` is a schema-shape failure → `400 INVALID_INPUT`.
    assert_eq!(
        error.code, "INVALID_INPUT",
        "rejecting a non-bundle is a schema-shape (INVALID_INPUT) failure, got: {error:?}",
    );
}

// ---------------------------------------------------------------------------
// Topological ordering (planner)
// ---------------------------------------------------------------------------

#[test]
fn ib_bundle_topological_order_matches_expected() {
    let plan = super::planner::create_execution_plan(
        &ib_plan_request(),
        &super::planner::PlanIdentity::new("test-run", "2026-01-01T00:00:00.000Z"),
        &super::planner::StaticModelCatalog::new(["gemini-2.5-flash"]),
    )
        .expect("the IB bundle plans directly (all refs resolve, default model has input limits)");

    // Hand-traced deterministic linear-scan topo (lowest-`order` ready node
    // first): `ib-summary` carries `order: 0` but depends on introduction /
    // quality / nonclinical / human, so it lands *after* them — NOT first.
    let expected: Vec<String> = [
        "ib-introduction",
        "ib-quality",
        "ib-nonclinical",
        "ib-human",
        "ib-summary",
        "ib-guidance",
        "ib-references",
    ]
    .iter()
    .map(|id| (*id).to_owned())
    .collect();

    assert_eq!(plan.order, expected);
}

// ---------------------------------------------------------------------------
// planHash round-trip
// ---------------------------------------------------------------------------

#[test]
fn plan_hash_canonicalization_round_trips_via_hash_alone() {
    // Planner-independent anchor: the `planHash` invariant is a canonical-JSON
    // round-trip — hashing the plan content is stable under object-key reordering
    // and sensitive to array (topo) order. This holds even if the planner API
    // drifts, guaranteeing the round-trip property the engine depends on.
    let content = json!({
        "schemaVersion": 1,
        "runId": "run-0000",
        "createdAt": "2026-09-23T00:00:00Z",
        "order": ["a", "b", "c"],
        "dependencies": { "a": [], "b": ["a"], "c": ["a", "b"] },
    });
    let plan_hash = hash_canonical_json(&content);

    // Same content, object keys emitted in a different order → identical digest.
    let key_reordered = json!({
        "dependencies": { "c": ["a", "b"], "b": ["a"], "a": [] },
        "order": ["a", "b", "c"],
        "createdAt": "2026-09-23T00:00:00Z",
        "runId": "run-0000",
        "schemaVersion": 1,
    });
    assert_eq!(
        hash_canonical_json(&key_reordered),
        plan_hash,
        "canonicalization sorts object keys, so key order must not change the digest",
    );

    // Array order (the topo `order`) IS significant — this is why a mutated
    // frozen plan is detectable.
    let array_reordered = json!({
        "schemaVersion": 1,
        "runId": "run-0000",
        "createdAt": "2026-09-23T00:00:00Z",
        "order": ["c", "b", "a"],
        "dependencies": { "a": [], "b": ["a"], "c": ["a", "b"] },
    });
    assert_ne!(
        hash_canonical_json(&array_reordered),
        plan_hash,
        "reordering the topo `order` array must change the digest",
    );
}

#[test]
fn created_plan_hash_equals_recomputed_canonical_hash() {
    // Real planner self-consistency: the stored `planHash` must equal the
    // canonical hash of the plan content with `planHash` removed — the exact
    // check `verify_execution_plan` performs before every `runs/advance`.
    let plan = super::planner::create_execution_plan(
        &ib_plan_request(),
        &super::planner::PlanIdentity::new("test-run", "2026-01-01T00:00:00.000Z"),
        &super::planner::StaticModelCatalog::new(["gemini-2.5-flash"]),
    )
        .expect("the IB bundle plans directly");

    let mut plan_value = serde_json::to_value(&plan).expect("ExecutionPlan serializes to JSON");
    let object = plan_value
        .as_object_mut()
        .expect("a plan serializes to a JSON object");
    let stored_hash = object
        .remove("planHash")
        .expect("the serialized plan carries a planHash field");

    assert_eq!(
        stored_hash.as_str(),
        Some(plan.plan_hash.as_str()),
        "the serialized planHash matches the typed field",
    );
    assert_eq!(
        hash_canonical_json(&plan_value),
        plan.plan_hash,
        "planHash is the canonical hash of the plan content minus planHash",
    );
}
