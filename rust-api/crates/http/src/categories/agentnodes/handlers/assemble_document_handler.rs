//! `POST /api/v1/agentnodes/documents/assemble` — assemble a portable report document.
//!
//! Ports `assemblePortableDocument` from
//! `frontend_v3/app/lib/agentExecution/documents.server.ts` under **equivalent-behavior**
//! parity. Given a portable agent plus a per-step output selection (direct `outputs`, pinned
//! history `outputVersions`, or manual `edits`), it resolves each active step's output, folds
//! it onto the layer, and produces the `StructuredDoc` the canvas-272 exporters consume, with a
//! provenance record.
//!
//! ## The blank-and-set contract (parity trap C4)
//!
//! `assemblePortableDocument` rewrites every layer to `{ ...layer, result: <text>, output: '',
//! assistantResponse: '', response: '', text: '', completion: '', answer: '', imageUrls }`.
//! This is load-bearing: `getLayerOutputText` (see `export::layer_output`) probes
//! `result, output, assistantResponse, response, text, completion, answer` in order and returns
//! the first non-blank one. Blanking the six later candidates forces the resolved output to win
//! and prevents a stale field (e.g. a leftover `answer`) from leaking into the export. In the
//! Rust DTO, `output`/`assistantResponse` are typed fields; `response`/`text`/`completion`/
//! `answer` live in the layer's `passthrough` bag, so they are blanked there.
//!
//! Pure logic lives in [`assemble_portable_document`]; the axum handler is a thin wrapper that
//! enforces the auth perimeter and marshals the JSON body.

use std::collections::{BTreeMap, HashMap, HashSet};

use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::agentnodes::dto::{OutputVersion, PortableAgent};
use alma_domain::agentnodes::error::{AgentExecutionError, stage};
use alma_domain::agentnodes::export::structured_doc::{
    StructuredDocSection, StructuredDocStep, build_structured_doc,
};
use alma_domain::agentnodes::hash::hash_value;
use alma_domain::agentnodes::validation::{is_valid_identifier, normalize_agent};
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;

/// `assembleSchema` (`documents.server.ts`), a strict object with defaulted maps.
///
/// `agent` is `z.unknown()` (may be absent → `Value::Null`, then rejected by
/// `normalize_agent`). The three record fields default to empty maps; their identifier-shaped
/// keys are validated after deserialization (serde does not validate map keys).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssembleDocumentRequest {
    #[serde(default)]
    agent: Value,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    outputs: BTreeMap<String, OutputVersion>,
    #[serde(default)]
    output_versions: BTreeMap<String, u32>,
    #[serde(default)]
    edits: BTreeMap<String, String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    allow_partial: bool,
}

/// `POST /api/v1/agentnodes/documents/assemble`.
///
/// Enforces the shared auth perimeter (the `HttpRequestInPipeline<RequestHasBeenAuthorized>`
/// extractor) and delegates to the pure [`assemble_portable_document`]. The operation is pure
/// (no I/O), so `State` is accepted only to keep the handler shape uniform with the rest of the
/// category and is otherwise unused.
#[route(method = "POST", path = "/api/v1/agentnodes/documents/assemble")]
pub async fn assemble_document_handler<TransactionalUnitOfWork>(
    State(_application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, AgentExecutionError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let assembled_document = assemble_portable_document(submitted_body)?;
    Ok(Json(assembled_document))
}

/// Pure port of `assemblePortableDocument(raw)`.
///
/// Returns the `{ schemaVersion, doc, provenance }` body on success, or the matching
/// [`AgentExecutionError`] (`INVALID_OUTPUT_SELECTION` / `AMBIGUOUS_OUTPUT_SELECTION` /
/// `OUTPUT_VERSION_NOT_FOUND` / `MISSING_OUTPUT`, plus `INVALID_INPUT` for malformed requests).
fn assemble_portable_document(raw: Value) -> Result<Value, AgentExecutionError> {
    let input: AssembleDocumentRequest = serde_json::from_value(raw)
        .map_err(|error| schema_error(format!("Invalid assemble request: {error}")))?;

    // zod `record(identifierSchema, ...)` validates map keys at parse time.
    validate_identifier_map_keys(input.outputs.keys(), "outputs")?;
    validate_identifier_map_keys(input.output_versions.keys(), "outputVersions")?;
    validate_identifier_map_keys(input.edits.keys(), "edits")?;
    // `z.number().int().positive()` on outputVersions values (u32 already excludes negatives).
    for (step_id, version) in &input.output_versions {
        if *version < 1 {
            return Err(schema_error(format!(
                "outputVersions[{step_id}] must be a positive integer."
            )));
        }
    }

    // normalizeAgent(input.agent, input.version) — inline-agent path.
    let normalized_agent = normalize_agent(&input.agent, input.version.as_deref())?;
    let agent: PortableAgent = serde_json::from_value(normalized_agent)
        .map_err(|error| schema_error(format!("Invalid agent: {error}")))?;

    let layer_ids: HashSet<&str> = agent.layers.iter().map(|layer| layer.id.as_str()).collect();

    // selected := { ...input.outputs }; history versions are resolved in below.
    let mut selected: BTreeMap<String, OutputVersion> = input.outputs.clone();

    // Every referenced step id must belong to the agent (`INVALID_OUTPUT_SELECTION`).
    for step_id in input
        .outputs
        .keys()
        .chain(input.output_versions.keys())
        .chain(input.edits.keys())
    {
        if !layer_ids.contains(step_id.as_str()) {
            return Err(AgentExecutionError::invalid_output_selection(format!(
                "Unknown output step {step_id}."
            )));
        }
    }

    // Resolve each pinned history version to exactly one OutputVersion from the layer history.
    for (step_id, version) in &input.output_versions {
        if selected.contains_key(step_id) {
            return Err(AgentExecutionError::ambiguous_output_selection(format!(
                "Select an output or a history version for {step_id}, not both."
            )));
        }
        let history_matches: Vec<&OutputVersion> = agent
            .layers
            .iter()
            .find(|layer| &layer.id == step_id)
            .and_then(|layer| layer.output_history.as_ref())
            .map(|history| {
                history
                    .iter()
                    .filter(|output| output.version == *version)
                    .collect()
            })
            .unwrap_or_default();
        if history_matches.len() != 1 {
            return Err(AgentExecutionError::output_version_not_found(format!(
                "Output version {version} for {step_id} is missing or ambiguous."
            )));
        }
        selected.insert(step_id.clone(), history_matches[0].clone());
    }

    // Active steps (isActive !== false) without a selected output are "missing".
    let missing: Vec<String> = agent
        .layers
        .iter()
        .filter(|layer| layer.is_active != Some(false) && !selected.contains_key(&layer.id))
        .map(|layer| layer.id.clone())
        .collect();
    let is_partial = !missing.is_empty();
    if is_partial && !input.allow_partial {
        return Err(AgentExecutionError::missing_output(format!(
            "Select an output version for: {}.",
            missing.join(", ")
        )));
    }

    // Provenance hashes are taken over the pre-blanked agent + resolved selection + edits.
    let configuration_hash = hash_value(&agent)
        .map_err(|error| AgentExecutionError::export_failed(format!("hash error: {error}")))?;
    let outputs_hash = hash_value(&selected)
        .map_err(|error| AgentExecutionError::export_failed(format!("hash error: {error}")))?;
    let edits_hash = hash_value(&input.edits)
        .map_err(|error| AgentExecutionError::export_failed(format!("hash error: {error}")))?;

    // Blank the later output candidates and set `result` (the C4 parity trap). An edit must
    // identify a source output version, mirroring the reference `MISSING_OUTPUT` guard.
    let mut assembled_agent = agent.clone();
    for layer in &mut assembled_agent.layers {
        let output = selected.get(&layer.id).cloned();
        let has_edit = input.edits.contains_key(&layer.id);
        if has_edit && output.is_none() {
            return Err(AgentExecutionError::missing_output(format!(
                "An edit for {} must identify its source output version.",
                layer.id
            )));
        }
        let text = if has_edit {
            input.edits.get(&layer.id).cloned().unwrap_or_default()
        } else {
            output
                .as_ref()
                .map(|resolved| resolved.result.clone())
                .unwrap_or_default()
        };
        layer.result = Some(text);
        layer.output = Some(String::new());
        layer.assistant_response = Some(String::new());
        layer.image_urls = Some(
            output
                .as_ref()
                .map(|resolved| resolved.image_urls.clone())
                .unwrap_or_default(),
        );
        for candidate_key in ["response", "text", "completion", "answer"] {
            layer
                .passthrough
                .insert(candidate_key.to_string(), Value::String(String::new()));
        }
    }

    // buildStructuredDoc({ ...agent, layers }, {}) — the sidecar edit map is empty because the
    // edits are already baked into each layer's `result` above.
    let empty_sidecar: HashMap<String, String> = HashMap::new();
    let mut doc = build_structured_doc(&assembled_agent, &empty_sidecar);
    if let Some(title) = &input.title {
        doc.title = title.clone();
    }
    if is_partial {
        doc.title = format!("[Partial] {}", doc.title);
        doc.sections.insert(
            0,
            StructuredDocSection {
                heading: None,
                steps: vec![StructuredDocStep {
                    number: "0".to_string(),
                    name: "Partial report".to_string(),
                    output: format!(
                        "Partial report. Missing step outputs: {}.",
                        missing.join(", ")
                    ),
                }],
                tag: None,
            },
        );
    }

    // provenance.outputVersions = { stepId: { version, timestamp } } for each selection.
    let mut output_versions_provenance = Map::new();
    for (step_id, output) in &selected {
        output_versions_provenance.insert(
            step_id.clone(),
            json!({ "version": output.version, "timestamp": output.timestamp }),
        );
    }

    let doc_value = serde_json::to_value(&doc).map_err(|error| {
        AgentExecutionError::export_failed(format!("document serialization error: {error}"))
    })?;

    Ok(json!({
        "schemaVersion": 1,
        "doc": doc_value,
        "provenance": {
            "configurationHash": configuration_hash,
            "outputsHash": outputs_hash,
            "editsHash": edits_hash,
            "outputVersions": Value::Object(output_versions_provenance),
            "missingStepIds": missing,
            "partial": is_partial,
            "verifiedAuditRecord": false,
        }
    }))
}

/// A zod `.parse` shape failure (malformed body / identifier / bound): `INVALID_INPUT`, HTTP
/// 400, `stage = "validation"`. Kept consistent with the planner's `schema_error`.
fn schema_error(message: impl Into<String>) -> AgentExecutionError {
    AgentExecutionError::new(
        "INVALID_INPUT",
        message,
        StatusCode::BAD_REQUEST,
        stage::VALIDATION,
    )
}

/// Validate that every map key satisfies `identifierSchema` (mirrors zod `record` key checks).
fn validate_identifier_map_keys<'a>(
    keys: impl Iterator<Item = &'a String>,
    field_name: &str,
) -> Result<(), AgentExecutionError> {
    for key in keys {
        if !is_valid_identifier(key) {
            return Err(schema_error(format!(
                "{field_name} key '{key}' is not a valid identifier."
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn old_output() -> Value {
        json!({ "version": 1, "timestamp": "2026-09-14T00:00:00Z", "result": "Pinned old output", "imageUrls": [] })
    }

    fn new_output() -> Value {
        json!({ "version": 2, "timestamp": "2026-09-15T00:00:00Z", "result": "Latest output", "imageUrls": [] })
    }

    fn agent() -> Value {
        json!({
            "name": "Report",
            "layers": [{
                "id": "study",
                "name": "Study",
                "result": "Latest output",
                "answer": "Hidden stale answer",
                "outputHistory": [old_output(), new_output()],
            }],
        })
    }

    #[test]
    fn assembles_pinned_historical_output_and_records_provenance() {
        let result =
            assemble_portable_document(json!({ "agent": agent(), "outputVersions": { "study": 1 } }))
                .expect("assembles");
        assert_eq!(
            result["doc"]["sections"][0]["steps"][0]["output"],
            "Pinned old output"
        );
        assert_eq!(result["provenance"]["partial"], json!(false));
        assert_eq!(result["provenance"]["verifiedAuditRecord"], json!(false));
        assert_eq!(result["provenance"]["outputVersions"]["study"]["version"], json!(1));
        assert_eq!(
            result["provenance"]["outputVersions"]["study"]["timestamp"],
            "2026-09-14T00:00:00Z"
        );
    }

    #[test]
    fn empty_edit_is_preserved_without_falling_back_to_a_stale_field() {
        // `answer: 'Hidden stale answer'` must NOT leak — the C4 blank-and-set contract.
        let result = assemble_portable_document(
            json!({ "agent": agent(), "outputVersions": { "study": 1 }, "edits": { "study": "" } }),
        )
        .expect("assembles");
        assert_eq!(result["doc"]["sections"][0]["steps"][0]["output"], "");
    }

    #[test]
    fn missing_selection_is_rejected() {
        let error = assemble_portable_document(json!({ "agent": agent() })).unwrap_err();
        assert_eq!(error.code, "MISSING_OUTPUT");
        assert!(
            error.message.contains("Select an output"),
            "message: {}",
            error.message
        );
    }

    #[test]
    fn ambiguous_selection_is_rejected() {
        let error = assemble_portable_document(json!({
            "agent": agent(),
            "outputs": { "study": old_output() },
            "outputVersions": { "study": 2 },
        }))
        .unwrap_err();
        assert_eq!(error.code, "AMBIGUOUS_OUTPUT_SELECTION");
        assert!(error.message.contains("not both"), "message: {}", error.message);
    }

    #[test]
    fn unknown_history_version_is_rejected_with_conflict() {
        let error =
            assemble_portable_document(json!({ "agent": agent(), "outputVersions": { "study": 99 } }))
                .unwrap_err();
        assert_eq!(error.code, "OUTPUT_VERSION_NOT_FOUND");
        assert_eq!(error.http_status, StatusCode::CONFLICT);
        assert!(
            error.message.contains("missing or ambiguous"),
            "message: {}",
            error.message
        );
    }

    #[test]
    fn unknown_output_step_is_rejected() {
        let error = assemble_portable_document(json!({
            "agent": agent(),
            "outputs": { "ghost": old_output() },
        }))
        .unwrap_err();
        assert_eq!(error.code, "INVALID_OUTPUT_SELECTION");
    }

    #[test]
    fn allow_partial_labels_the_title_and_prepends_a_missing_section() {
        let result =
            assemble_portable_document(json!({ "agent": agent(), "allowPartial": true }))
                .expect("assembles a partial report");
        let title = result["doc"]["title"].as_str().unwrap();
        assert!(title.contains("[Partial]"), "title: {title}");
        let first_output = result["doc"]["sections"][0]["steps"][0]["output"]
            .as_str()
            .unwrap();
        assert!(
            first_output.contains("Missing step outputs: study"),
            "first output: {first_output}"
        );
        assert_eq!(result["provenance"]["partial"], json!(true));
        assert_eq!(result["provenance"]["missingStepIds"], json!(["study"]));
    }

    #[test]
    fn images_pair_with_the_selected_output_not_the_layer_image() {
        let selected = json!({
            "version": 1, "timestamp": "2026-09-14T00:00:00Z", "result": "Pinned old output",
            "imageUrls": ["data:image/png;base64,YWJj"],
        });
        let agent_with_layer_image = json!({
            "name": "Report",
            "layers": [{
                "id": "study", "name": "Study", "result": "Latest output",
                "answer": "Hidden stale answer",
                "outputHistory": [old_output(), new_output()],
                "imageUrls": ["data:image/png;base64,ZGVm"],
            }],
        });
        let result = assemble_portable_document(json!({
            "agent": agent_with_layer_image,
            "outputs": { "study": selected },
        }))
        .expect("assembles");
        let output = result["doc"]["sections"][0]["steps"][0]["output"]
            .as_str()
            .unwrap();
        assert!(output.contains("YWJj"), "output: {output}");
        assert!(!output.contains("ZGVm"), "output: {output}");
    }
}
