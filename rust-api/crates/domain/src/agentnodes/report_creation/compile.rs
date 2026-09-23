//! 272 portable-report **compilation** — the `compilePortableReport` core.
//!
//! Ported (equivalent-behavior parity) from `compilePortableReport` in
//! `frontend_v3/app/lib/reportCreation/api.server.ts`. This unit turns a 272
//! authoring request (studies + section/meta steps + templates + sources) into a
//! **portable execution bundle** ready for `runs/plan` — it does **not** produce
//! markdown. Markdown comes later, via `plan → advance → assemble → export`
//! (see the port plan, correction C3: `272/compile` returns `{bundle,
//! requiredSources}`, a bundle, not a rendered report).
//!
//! [`compile_portable_report`] validates the request, resolves the template
//! snapshot, computes per-step source **bindings**, hands the assembled input to
//! [`build_report_creation_agent`] (the `rc_builder` sibling), stamps the
//! `templateSnapshot` / `templateHash` onto the agent metadata, and returns a
//! [`CompiledReport`] `{ schemaVersion, bundle, requiredSources }`.
//!
//! ## What is ported here vs. elsewhere
//!
//! Mirroring the reference file split, this module owns only the *compile* schema
//! + orchestration (the reference's `compileSchema` + `compilePortableReport`).
//! The agent construction (`buildReportCreationAgent`/`compiler.ts`) lives in the
//! `rc_builder` sibling; referenced-step wiring in [`super::layer_refs`];
//! meta-step templates in [`super::meta_steps`]; synthesis-corpus sanitisation in
//! [`super::sanitize`]. The reference's `preparePortableSource` (`272/prepare-
//! source`) is **not** ported here — it drives `executePortableStep` (the step
//! executor unit) and reuses [`super::source_summary`]; it belongs to the
//! prepare-source handler unit, not the compile core.
//!
//! ## v1 cut — Google Sheets templates
//!
//! The reference resolves `templatesSheetId` through the Sheets API v4 with a
//! Google OAuth Bearer token (`context.google.accessToken`). v1 has no OAuth
//! (see the port plan's "v1 explicit cuts"), so a `templatesSheetId` request
//! deterministically yields `GOOGLE_AUTH_REQUIRED` — exactly what the reference
//! throws when no access token is present. Real 272 prompts arrive instead as an
//! inline `templates` object or `templatesYamlText` (parsed with `serde_yaml`,
//! the only place YAML touches the compile path).
//!
//! ## Assumed `rc_builder` API (integration contract)
//!
//! This unit depends on the `rc_builder` sibling (the `compiler.ts` port), built
//! in the same phase. It is imported, not recreated. The assumed public surface,
//! mirroring `compiler.ts` one-to-one (camelCase → snake_case), is:
//!
//! ```ignore
//! pub struct ReportStudy { id, file_name, doc_title, summary, keywords: String,
//!     study_type, template_id, selected: bool, protocol_number: Option<String>,
//!     user_input: Option<String> }
//! pub struct ReportSectionStep { id, name, instruction, user_input: Option<String>,
//!     selected: Option<bool> }
//! pub struct ReportMetaFile { id, name, meta_step_id: Option<String>,
//!     user_input: Option<String> }
//! pub struct ReportCreationInput { agent_name: String, studies: Vec<ReportStudy>,
//!     sec3_steps: Option<Vec<ReportSectionStep>>, sec1_steps: Option<Vec<ReportSectionStep>>,
//!     meta_files: Option<Vec<ReportMetaFile>>, meta_corpus_id: Option<String>,
//!     meta_corpus_name: Option<String>, model: Option<String>, corpus_id: Option<String>,
//!     corpus_name: Option<String>, shared_meta_instruction: Option<String>,
//!     report_creation_display_name: Option<String>, biomaterial_skipped: bool }
//! pub struct BuildAgentOptions { local_meta_sources: bool, timestamp: Option<String> }
//! pub fn build_report_creation_agent(
//!     input: &ReportCreationInput, templates: &serde_json::Map<String, serde_json::Value>,
//!     meta_step_rows: &[Sect1MetaStepRow], options: &BuildAgentOptions,
//! ) -> Result<serde_json::Value, AgentExecutionError>;
//! ```
//!
//! If the delivered `rc_builder` differs, the integrator reconciles the boundary
//! — every rc_builder construction is isolated in [`to_report_creation_input`]
//! and the single [`build_report_creation_agent`] call.
//!
//! **Cargo note:** this file uses `serde_yaml` (a workspace dependency already
//! declared in the root `Cargo.toml`). The integrator must add
//! `serde_yaml = { workspace = true }` to `crates/domain/Cargo.toml`'s
//! `[dependencies]` (per the port plan, Phase 0) — the domain crate does not yet
//! list it.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::agentnodes::dto::{ExecutionBundle, ExecutionSource, Skill};
use crate::agentnodes::error::AgentExecutionError;
use crate::agentnodes::hash::hash_value;
use crate::agentnodes::report_creation::meta_steps::Sect1MetaStepRow;
use crate::agentnodes::report_creation::agent_builder::{
    build_report_creation_agent, BuildOptions, ReportCreationInput, ReportMetaFile,
    ReportSectionStep, ReportStudy, ReportTemplate,
};
use crate::agentnodes::validation::{is_valid_digest, is_valid_identifier, DEFAULT_MODEL};

// ---------------------------------------------------------------------------
// serde defaults
// ---------------------------------------------------------------------------

fn schema_version_one() -> u32 {
    1
}

fn default_true() -> bool {
    true
}

fn default_model() -> String {
    DEFAULT_MODEL.to_string()
}

// ---------------------------------------------------------------------------
// Request DTOs (`compileSchema` and friends, `#[serde(rename_all = "camelCase")]`)
//
// The reference schemas are `.strict()` → `#[serde(deny_unknown_fields)]`. Deep
// checks serde cannot express (`identifierSchema` regex, digest shape, `.min`/
// `.max` bounds, `textSchema.min(1)`, the templatesSchema refinement) run in the
// post-deserialize [`validate_schema`] pass, mirroring the sibling `validation`
// unit's design. camelCase matches the TypeScript wire format exactly.
// ---------------------------------------------------------------------------

/// `studies[]` entry (`compileSchema.studies`, `.strict()`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompileStudy {
    /// `identifierSchema`.
    id: String,
    /// `z.string().min(1).max(512)`.
    file_name: String,
    /// `z.string().max(5000)`.
    doc_title: String,
    /// `textSchema.default('')`.
    #[serde(default)]
    summary: String,
    /// `z.union([string, string[]]).default('').transform(join)` — normalised to a
    /// single string by [`KeywordsInput::into_joined`].
    #[serde(default)]
    keywords: KeywordsInput,
    /// `z.string().max(1000).default('')`.
    #[serde(default)]
    study_type: String,
    /// `z.string().min(1).max(512)`.
    template_id: String,
    /// `z.boolean().default(true)`.
    #[serde(default = "default_true")]
    selected: bool,
    /// `z.string().max(1000).optional()`.
    #[serde(default)]
    protocol_number: Option<String>,
    /// `textSchema.optional()`.
    #[serde(default)]
    user_input: Option<String>,
    /// `z.array(identifierSchema).max(5).default([])`.
    #[serde(default)]
    source_ids: Vec<String>,
}

/// `metaFiles[]` entry (`compileSchema.metaFiles`, `.strict()`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompileMetaFile {
    /// `identifierSchema`.
    id: String,
    /// `z.string().min(1).max(512)`.
    name: String,
    /// `identifierSchema.optional()`.
    #[serde(default)]
    meta_step_id: Option<String>,
    /// `textSchema.optional()`.
    #[serde(default)]
    user_input: Option<String>,
    /// `z.array(identifierSchema).max(5).default([])`.
    #[serde(default)]
    source_ids: Vec<String>,
}

/// `sec1Steps[]` / `sec3Steps[]` entry (`sectionStepSchema`, `.strict()`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompileSectionStep {
    /// `identifierSchema`.
    id: String,
    /// `z.string().min(1).max(1000)`.
    name: String,
    /// `textSchema.min(1)`.
    instruction: String,
    /// `textSchema.optional()`.
    #[serde(default)]
    user_input: Option<String>,
    /// `z.boolean().default(true)`.
    #[serde(default = "default_true")]
    selected: bool,
}

/// `sect1MetaSteps[]` entry (`metaStepSchema`, `.strict()`).
///
/// Structurally identical to [`Sect1MetaStepRow`] but with `keywords` defaulting
/// to `[]` (`metaStepSchema.keywords.default([])`), which the row type does not
/// default. Converted to a [`Sect1MetaStepRow`] via [`to_meta_row`] for the
/// builder and the template snapshot.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompileMetaStep {
    /// `identifierSchema`.
    id: String,
    /// `z.string().min(1).max(1000)`.
    type_name: String,
    /// `textSchema.min(1)`.
    instruction: String,
    /// `z.array(z.string().max(512)).max(100).default([])`.
    #[serde(default)]
    keywords: Vec<String>,
    /// `textSchema.optional()`.
    #[serde(default)]
    user_input: Option<String>,
}

/// A study's `keywords` field: the `z.union([string, string[]])` input.
///
/// Untagged so a JSON string deserialises to [`KeywordsInput::Text`] and a JSON
/// array to [`KeywordsInput::List`]; any other JSON type fails deserialisation
/// (→ `INVALID_REQUEST`), matching the zod union. Absent → the `''` default.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum KeywordsInput {
    Text(String),
    List(Vec<String>),
}

impl Default for KeywordsInput {
    fn default() -> Self {
        KeywordsInput::Text(String::new())
    }
}

impl KeywordsInput {
    /// `Array.isArray(value) ? value.join(', ') : value` — the schema transform.
    fn into_joined(self) -> String {
        match self {
            KeywordsInput::Text(text) => text,
            KeywordsInput::List(items) => items.join(", "),
        }
    }
}

/// The full 272 compile request (`compileSchema`, `.strict()`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompileRequest {
    /// `z.literal(1).default(1)` (value asserted in [`validate_schema`]).
    #[serde(default = "schema_version_one")]
    schema_version: u32,
    /// `z.string().trim().min(1).max(240)` (trimmed before it reaches the builder).
    agent_name: String,
    /// `z.array(...).min(1).max(200)`.
    studies: Vec<CompileStudy>,
    /// `z.array(...).max(200).default([])`.
    #[serde(default)]
    meta_files: Vec<CompileMetaFile>,
    /// `z.array(sectionStepSchema).max(100).default([])`.
    #[serde(default)]
    sec1_steps: Vec<CompileSectionStep>,
    /// `z.array(sectionStepSchema).max(100).default([])`.
    #[serde(default)]
    sec3_steps: Vec<CompileSectionStep>,
    /// `z.array(metaStepSchema).max(100).default([])`.
    #[serde(default)]
    sect1_meta_steps: Vec<CompileMetaStep>,
    /// `z.array(sourceSchema).max(1000).default([])`.
    #[serde(default)]
    sources: Vec<ExecutionSource>,
    /// `z.array(skillSchema).max(100).default([])`.
    #[serde(default)]
    skills: Vec<Skill>,
    /// `templatesSchema.optional()` — validated in [`validate_schema`] (inline path).
    #[serde(default)]
    templates: Option<Map<String, Value>>,
    /// `textSchema.optional()` — parsed with `serde_yaml` in the resolve step.
    #[serde(default)]
    templates_yaml_text: Option<String>,
    /// `z.string().min(1).max(512).optional()` — Sheets path (cut → OAuth error).
    #[serde(default)]
    templates_sheet_id: Option<String>,
    /// `z.string().min(1).max(512).default(DEFAULT_MODEL)`.
    #[serde(default = "default_model")]
    model: String,
    /// `z.string().min(1).max(512).optional()`.
    #[serde(default)]
    corpus_id: Option<String>,
    /// `z.string().max(512).optional()`.
    #[serde(default)]
    corpus_name: Option<String>,
    /// `z.string().min(1).max(512).optional()`.
    #[serde(default)]
    meta_corpus_id: Option<String>,
    /// `z.string().max(512).optional()`.
    #[serde(default)]
    meta_corpus_name: Option<String>,
    /// `z.string().min(1).max(256).optional()`.
    #[serde(default)]
    project_id: Option<String>,
    /// `textSchema.optional()`.
    #[serde(default)]
    shared_meta_instruction: Option<String>,
    /// `z.string().max(1000).optional()`.
    #[serde(default)]
    report_creation_display_name: Option<String>,
    /// `z.boolean().default(false)`.
    #[serde(default)]
    biomaterial_skipped: bool,
}

// ---------------------------------------------------------------------------
// Result DTO
// ---------------------------------------------------------------------------

/// The compile result — `{ schemaVersion, bundle, requiredSources }`.
///
/// `bundle` is the portable [`ExecutionBundle`] ready for `runs/plan`;
/// `requiredSources` is the per-step source-binding map (insertion-ordered:
/// study layers first, then meta layers), the same object the reference returns
/// alongside the bundle. `schemaVersion` is the literal `1`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledReport {
    pub schema_version: u32,
    pub bundle: ExecutionBundle,
    pub required_sources: IndexMap<String, Vec<String>>,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// Compile a 272 portable report request into an execution bundle.
///
/// Ports `compilePortableReport`: validate the request, resolve exactly one
/// template source, compute source bindings, build the report-creation agent,
/// stamp the template snapshot + hash, and return the bundle. Returns the
/// portable [`AgentExecutionError`] variants the reference throws
/// (`TEMPLATES_REQUIRED`, `INVALID_TEMPLATES`, `DUPLICATE_TEMPLATE`,
/// `DUPLICATE_SOURCE`, `AMBIGUOUS_SOURCE_MODE`, `MISSING_SOURCE`,
/// `INVALID_SOURCE_BINDING`, `TEMPLATE_NOT_FOUND`, `UNBOUND_SOURCE`,
/// `GOOGLE_AUTH_REQUIRED`, plus the builder's `INVALID_REPORT` /
/// `BIOMATERIAL_REQUIRED` / `INVALID_BIOMATERIAL_SELECTION`). Any request that
/// fails the schema shape surfaces as `INVALID_REQUEST`, matching how a
/// `ZodError` is rendered upstream (`http.server.ts`).
pub fn compile_portable_report(raw: Value) -> Result<CompiledReport, AgentExecutionError> {
    // 1. `compileSchema.parse(raw)` — deserialize + semantic validation.
    let request: CompileRequest = serde_json::from_value(raw).map_err(|error| {
        AgentExecutionError::invalid_request(format!("Invalid report compile request: {error}"))
    })?;
    validate_schema(&request)?;

    // 2. Exactly one of `templates` / `templatesYamlText` / `templatesSheetId`.
    let provided = [
        request.templates.is_some(),
        request.templates_yaml_text.is_some(),
        request.templates_sheet_id.is_some(),
    ]
    .iter()
    .filter(|present| **present)
    .count();
    if provided != 1 {
        return Err(AgentExecutionError::templates_required(
            "Supply exactly one templates object, templatesYamlText, or authorized templatesSheetId.",
        ));
    }

    // 3. Resolve the template snapshot from whichever source was supplied.
    let templates: Map<String, Value> = if let Some(inline) = &request.templates {
        // Already validated against templatesSchema in `validate_schema`.
        inline.clone()
    } else if let Some(yaml) = &request.templates_yaml_text {
        parse_yaml_templates(yaml)?
    } else {
        // `templatesSheetId` requires Google OAuth (Sheets API v4); cut in v1.
        return Err(AgentExecutionError::google_auth_required(
            "Google OAuth is required to read a template sheet.",
        ));
    };

    // 4. At least one template must survive resolution.
    if templates.is_empty() {
        return Err(AgentExecutionError::templates_required(
            "At least one template is required.",
        ));
    }

    // 5. Template ids (the `.id` field of each template) must be unique.
    let template_ids = collect_template_ids(&templates);
    let template_id_set: HashSet<&str> = template_ids.iter().map(String::as_str).collect();
    if template_id_set.len() != template_ids.len() {
        return Err(AgentExecutionError::duplicate_template(
            "Template IDs must be unique.",
        ));
    }

    // 6. Source ids must be unique.
    let source_id_set: HashSet<&str> = request.sources.iter().map(source_id).collect();
    if source_id_set.len() != request.sources.len() {
        return Err(AgentExecutionError::duplicate_source(
            "Source IDs must be unique.",
        ));
    }

    // 7. Filter to *selected* studies / section steps (meta files are not filtered).
    let studies: Vec<&CompileStudy> = request.studies.iter().filter(|s| s.selected).collect();
    let sec1_steps: Vec<&CompileSectionStep> =
        request.sec1_steps.iter().filter(|s| s.selected).collect();
    let sec3_steps: Vec<&CompileSectionStep> =
        request.sec3_steps.iter().filter(|s| s.selected).collect();

    // 8. Compute per-step bindings (+ per-step template existence checks).
    let meta_step_id_set: HashSet<&str> =
        request.sect1_meta_steps.iter().map(|m| m.id.as_str()).collect();
    let bindings = build_bindings(
        &studies,
        &request.meta_files,
        &source_id_set,
        request.corpus_id.as_deref(),
        request.meta_corpus_id.as_deref(),
        &template_id_set,
        &meta_step_id_set,
    )?;

    // 9. Every supplied source must be bound to some selected study / meta step.
    let bound: HashSet<&str> = bindings.values().flatten().map(String::as_str).collect();
    if request.sources.iter().any(|s| !bound.contains(source_id(s))) {
        return Err(AgentExecutionError::unbound_source(
            "Remove sources that are not bound to a selected study or biomaterial step.",
        ));
    }

    // 10. Build the report-creation agent (the `rc_builder` boundary).
    let meta_rows: Vec<Sect1MetaStepRow> = request.sect1_meta_steps.iter().map(to_meta_row).collect();
    let report_input = to_report_creation_input(&request, &studies, &sec1_steps, &sec3_steps);
    let options = BuildOptions {
        local_meta_sources: !request.meta_files.is_empty() && request.meta_corpus_id.is_none(),
        timestamp: None,
    };
    // The builder wants strongly-typed templates; the compile input carries them
    // as a serde_json object (inline `templates` or parsed `templatesYamlText`).
    // Every ReportTemplate field is optional, so a malformed entry degrades to an
    // empty template rather than failing the compile.
    let typed_templates: std::collections::HashMap<String, ReportTemplate> = templates
        .iter()
        .map(|(name, value)| {
            (
                name.clone(),
                serde_json::from_value(value.clone()).unwrap_or_default(),
            )
        })
        .collect();
    let mut agent =
        build_report_creation_agent(&report_input, &typed_templates, &meta_rows, &options)?;

    // 11. Stamp `templateSnapshot` + `templateHash` onto the agent metadata.
    let snapshot = json!({
        "templates": Value::Object(templates.clone()),
        "sect1MetaSteps": serde_json::to_value(&meta_rows)
            .expect("serializing meta-step rows to JSON is infallible"),
    });
    let template_hash =
        hash_value(&snapshot).expect("hashing a serde_json::Value is infallible");
    inject_template_metadata(&mut agent, snapshot, template_hash)?;

    // 12. Assemble the bundle and return `{ schemaVersion, bundle, requiredSources }`.
    //     Constructing the typed `ExecutionBundle` directly mirrors
    //     `bundleSchema.parse(...)`: its `sources` / `skills` / `bindings` were
    //     already validated by the compile schema, and it applies the same
    //     defaults (`schemaVersion: 1`, `sharedSourceIds: []`).
    let bundle_bindings: HashMap<String, Vec<String>> = bindings
        .iter()
        .map(|(step_id, source_ids)| (step_id.clone(), source_ids.clone()))
        .collect();
    let bundle = ExecutionBundle {
        schema_version: 1,
        agent,
        version: None,
        sources: request.sources,
        bindings: bundle_bindings,
        shared_source_ids: Vec::new(),
        skills: request.skills,
        project_id: request.project_id.clone(),
        graph: None,
    };

    Ok(CompiledReport {
        schema_version: 1,
        bundle,
        required_sources: bindings,
    })
}

// ---------------------------------------------------------------------------
// Bindings (`bind` / the study + meta-file loops)
// ---------------------------------------------------------------------------

/// Compute the `stepId -> sourceIds` bindings for a compile request.
///
/// Ports the two `forEach` loops + the `bind` closure of `compilePortableReport`:
/// selected study `i` (0-based) binds under `layer-{i+1}`, meta file `i` under
/// `meta-layer-{i+1}`. A step is bound to supplied files **or** a corpus, never
/// both; a step with neither is an error. Corpus-bound steps get **no** entry
/// (they carry no `sourceIds`). Preserves insertion order (studies then meta).
fn build_bindings(
    studies: &[&CompileStudy],
    meta_files: &[CompileMetaFile],
    source_id_set: &HashSet<&str>,
    corpus_id: Option<&str>,
    meta_corpus_id: Option<&str>,
    template_id_set: &HashSet<&str>,
    meta_step_id_set: &HashSet<&str>,
) -> Result<IndexMap<String, Vec<String>>, AgentExecutionError> {
    let mut bindings: IndexMap<String, Vec<String>> = IndexMap::new();

    for (index, study) in studies.iter().enumerate() {
        if !template_id_set.contains(study.template_id.as_str()) {
            return Err(AgentExecutionError::template_not_found(format!(
                "Template {} is not in the supplied snapshot.",
                study.template_id
            )));
        }
        bind(
            &mut bindings,
            source_id_set,
            format!("layer-{}", index + 1),
            &study.source_ids,
            corpus_id,
        )?;
    }

    for (index, file) in meta_files.iter().enumerate() {
        if let Some(meta_step_id) = &file.meta_step_id {
            if !meta_step_id_set.contains(meta_step_id.as_str()) {
                return Err(AgentExecutionError::template_not_found(format!(
                    "Biomaterial template {meta_step_id} is not in the supplied snapshot."
                )));
            }
        }
        bind(
            &mut bindings,
            source_id_set,
            format!("meta-layer-{}", index + 1),
            &file.source_ids,
            meta_corpus_id,
        )?;
    }

    Ok(bindings)
}

/// The `bind` closure: validate one step's source group and record it.
///
/// * corpus **and** files → `AMBIGUOUS_SOURCE_MODE`;
/// * neither → `MISSING_SOURCE`;
/// * duplicate or unknown source ids → `INVALID_SOURCE_BINDING`;
/// * only file-bound steps produce a `bindings` entry (a non-empty `sourceIds`).
///
/// `corpus_id` is "present" only when a non-empty string (JS truthiness); the
/// compile schema already guarantees a supplied corpus id is non-empty.
fn bind(
    bindings: &mut IndexMap<String, Vec<String>>,
    source_id_set: &HashSet<&str>,
    step_id: String,
    source_ids: &[String],
    corpus_id: Option<&str>,
) -> Result<(), AgentExecutionError> {
    let has_corpus = corpus_id.is_some_and(|value| !value.is_empty());

    if has_corpus && !source_ids.is_empty() {
        return Err(AgentExecutionError::ambiguous_source_mode(
            "Choose supplied files or corpus documents for each source group, not both.",
        ));
    }
    if !has_corpus && source_ids.is_empty() {
        return Err(AgentExecutionError::missing_source(format!(
            "Source bindings are required for {step_id}."
        )));
    }

    let unique: HashSet<&str> = source_ids.iter().map(String::as_str).collect();
    if unique.len() != source_ids.len()
        || source_ids.iter().any(|id| !source_id_set.contains(id.as_str()))
    {
        return Err(AgentExecutionError::invalid_source_binding(format!(
            "Invalid sources for {step_id}."
        )));
    }

    if !source_ids.is_empty() {
        bindings.insert(step_id, source_ids.to_vec());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/// Parse + validate an inline `templatesYamlText` document.
///
/// Ports `z.object({ templates: templatesSchema }).parse(load(yaml, { schema:
/// JSON_SCHEMA }))`: parse the YAML into a JSON-shaped value, require a top-level
/// `templates` object, and validate it against `templatesSchema`. Any failure
/// collapses to `INVALID_TEMPLATES`, exactly as the reference's `try/catch` does.
fn parse_yaml_templates(yaml: &str) -> Result<Map<String, Value>, AgentExecutionError> {
    let invalid = || AgentExecutionError::invalid_templates("The supplied template YAML is invalid.");

    let value: Value = serde_yaml::from_str(yaml).map_err(|_| invalid())?;
    let templates_value = value.as_object().and_then(|obj| obj.get("templates")).ok_or_else(invalid)?;
    let templates_map = templates_value.as_object().ok_or_else(invalid)?.clone();
    validate_templates_record(&templates_map).map_err(|_| invalid())?;
    Ok(templates_map)
}

/// Validate a templates record against `templatesSchema` / `templateSchema`.
///
/// Each value must be an object with a non-empty `id` (`≤512` chars), a
/// `user_instruction` that is non-empty after trimming (`textSchema.refine`), and
/// an optional string `user_input`. Extra keys are kept (`.passthrough()`).
/// Returns `Err(reason)`; the caller maps it to the path-appropriate code
/// (`INVALID_REQUEST` for the inline path, `INVALID_TEMPLATES` for YAML).
fn validate_templates_record(templates: &Map<String, Value>) -> Result<(), String> {
    for (key, value) in templates {
        if char_len(key) > 512 {
            return Err(format!("template key '{key}' exceeds 512 characters"));
        }
        let object = value
            .as_object()
            .ok_or_else(|| format!("template '{key}' must be an object"))?;

        let id = object
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("template '{key}' is missing a string id"))?;
        if id.is_empty() || char_len(id) > 512 {
            return Err(format!("template '{key}' id must be 1-512 characters"));
        }

        let user_instruction = object
            .get("user_instruction")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("template '{key}' is missing user_instruction"))?;
        if user_instruction.trim().is_empty() {
            return Err(format!("template '{key}' instruction is required"));
        }

        if let Some(user_input) = object.get("user_input") {
            if !user_input.is_string() {
                return Err(format!("template '{key}' user_input must be a string"));
            }
        }
    }
    Ok(())
}

/// Collect the `.id` of every template value (`Object.values(templates).map(t => t.id)`).
///
/// Runs after [`validate_templates_record`], so every value is guaranteed to be
/// an object carrying a string `id`; any that somehow lacks one is skipped rather
/// than panicking.
fn collect_template_ids(templates: &Map<String, Value>) -> Vec<String> {
    templates
        .values()
        .filter_map(|value| value.get("id").and_then(Value::as_str).map(str::to_string))
        .collect()
}

// ---------------------------------------------------------------------------
// rc_builder boundary — input construction (isolated for easy reconciliation)
// ---------------------------------------------------------------------------

/// Build the [`ReportCreationInput`] passed to [`build_report_creation_agent`].
///
/// Mirrors `buildReportCreationAgent({ ...input, studies, sec1Steps, sec3Steps },
/// ...)`: the *filtered* selected studies / section steps and the raw meta files,
/// with the agent name trimmed (the schema's `.trim()`). All rc_builder-typed
/// construction is confined to this function and its `to_report_*` helpers.
fn to_report_creation_input(
    request: &CompileRequest,
    studies: &[&CompileStudy],
    sec1_steps: &[&CompileSectionStep],
    sec3_steps: &[&CompileSectionStep],
) -> ReportCreationInput {
    ReportCreationInput {
        agent_name: request.agent_name.trim().to_string(),
        studies: studies.iter().map(|study| to_report_study(study)).collect(),
        sec1_steps: Some(sec1_steps.iter().map(|step| to_report_section_step(step)).collect()),
        sec3_steps: Some(sec3_steps.iter().map(|step| to_report_section_step(step)).collect()),
        meta_files: Some(request.meta_files.iter().map(to_report_meta_file).collect()),
        meta_corpus_id: request.meta_corpus_id.clone(),
        meta_corpus_name: request.meta_corpus_name.clone(),
        model: Some(request.model.clone()),
        corpus_id: request.corpus_id.clone(),
        corpus_name: request.corpus_name.clone(),
        shared_meta_instruction: request.shared_meta_instruction.clone(),
        report_creation_display_name: request.report_creation_display_name.clone(),
        biomaterial_skipped: Some(request.biomaterial_skipped),
    }
}

fn to_report_study(study: &CompileStudy) -> ReportStudy {
    ReportStudy {
        id: study.id.clone(),
        file_name: study.file_name.clone(),
        doc_title: study.doc_title.clone(),
        summary: study.summary.clone(),
        keywords: study.keywords.clone().into_joined(),
        study_type: study.study_type.clone(),
        template_id: study.template_id.clone(),
        selected: study.selected,
        protocol_number: study.protocol_number.clone(),
        user_input: study.user_input.clone(),
    }
}

fn to_report_section_step(step: &CompileSectionStep) -> ReportSectionStep {
    ReportSectionStep {
        id: step.id.clone(),
        name: step.name.clone(),
        instruction: step.instruction.clone(),
        user_input: step.user_input.clone(),
        selected: Some(step.selected),
    }
}

fn to_report_meta_file(file: &CompileMetaFile) -> ReportMetaFile {
    ReportMetaFile {
        id: file.id.clone(),
        name: file.name.clone(),
        meta_step_id: file.meta_step_id.clone(),
        user_input: file.user_input.clone(),
    }
}

/// Convert a parsed `sect1MetaSteps` entry into a [`Sect1MetaStepRow`] for the
/// builder and the template snapshot (the two share the metaStepSchema shape).
fn to_meta_row(step: &CompileMetaStep) -> Sect1MetaStepRow {
    Sect1MetaStepRow {
        id: step.id.clone(),
        type_name: step.type_name.clone(),
        instruction: step.instruction.clone(),
        keywords: step.keywords.clone(),
        user_input: step.user_input.clone(),
    }
}

/// Merge `templateSnapshot` + `templateHash` into the agent's `metadata` object,
/// mirroring `{ ...agent, metadata: { ...agent.metadata, templateSnapshot,
/// templateHash } }`. Creates `metadata` if absent. The type guards are
/// defensive — the builder always returns an object agent with object metadata.
fn inject_template_metadata(
    agent: &mut Value,
    snapshot: Value,
    template_hash: String,
) -> Result<(), AgentExecutionError> {
    let agent_object = agent.as_object_mut().ok_or_else(|| {
        AgentExecutionError::invalid_report("The report-creation agent must be a JSON object.")
    })?;
    let metadata = agent_object
        .entry("metadata")
        .or_insert_with(|| Value::Object(Map::new()));
    let metadata_object = metadata.as_object_mut().ok_or_else(|| {
        AgentExecutionError::invalid_report("The report-creation agent metadata must be a JSON object.")
    })?;
    metadata_object.insert("templateSnapshot".to_string(), snapshot);
    metadata_object.insert("templateHash".to_string(), Value::String(template_hash));
    Ok(())
}

// ---------------------------------------------------------------------------
// Schema validation pass (`compileSchema.parse` refinements serde cannot express)
// ---------------------------------------------------------------------------

/// Character count (Unicode scalar values) — the equivalent-behavior stand-in for
/// JS UTF-16 `.length` used by the schema's `.max()`/`.min()` bounds (the port
/// plan's parity bar does not require UTF-16-unit counting).
#[inline]
fn char_len(s: &str) -> usize {
    s.chars().count()
}

/// Validate one identifier field against `identifierSchema`, mapping failure to
/// `INVALID_REQUEST` (the code a `ZodError` renders as upstream).
fn check_id(value: &str, label: &str) -> Result<(), AgentExecutionError> {
    if is_valid_identifier(value) {
        Ok(())
    } else {
        Err(AgentExecutionError::invalid_request(format!(
            "Invalid identifier for {label}: '{value}'."
        )))
    }
}

/// A supplied-only string that the schema constrains with `.min(1)`.
fn check_optional_non_empty(value: Option<&str>, label: &str) -> Result<(), AgentExecutionError> {
    if let Some(inner) = value {
        if inner.is_empty() {
            return Err(AgentExecutionError::invalid_request(format!(
                "{label} must not be empty when provided."
            )));
        }
    }
    Ok(())
}

/// The `compileSchema.parse` refinements serde cannot express: the `.literal(1)`
/// assert, `identifierSchema` regexes, `digestSchema`, the array/string bounds,
/// `textSchema.min(1)` on instructions, and the inline `templatesSchema`
/// refinement. Every failure surfaces as `INVALID_REQUEST`.
fn validate_schema(request: &CompileRequest) -> Result<(), AgentExecutionError> {
    if request.schema_version != 1 {
        return Err(AgentExecutionError::invalid_request("schemaVersion must be 1."));
    }

    let agent_name = request.agent_name.trim();
    if agent_name.is_empty() || char_len(agent_name) > 240 {
        return Err(AgentExecutionError::invalid_request(
            "agentName must be 1-240 characters after trimming.",
        ));
    }

    if request.studies.is_empty() || request.studies.len() > 200 {
        return Err(AgentExecutionError::invalid_request(
            "studies must contain between 1 and 200 entries.",
        ));
    }
    for study in &request.studies {
        check_id(&study.id, "study id")?;
        if study.file_name.is_empty() || char_len(&study.file_name) > 512 {
            return Err(AgentExecutionError::invalid_request(
                "study fileName must be 1-512 characters.",
            ));
        }
        if char_len(&study.doc_title) > 5000 {
            return Err(AgentExecutionError::invalid_request(
                "study docTitle must be at most 5000 characters.",
            ));
        }
        if study.template_id.is_empty() || char_len(&study.template_id) > 512 {
            return Err(AgentExecutionError::invalid_request(
                "study templateId must be 1-512 characters.",
            ));
        }
        if study.source_ids.len() > 5 {
            return Err(AgentExecutionError::invalid_request(
                "a study may bind at most 5 sources.",
            ));
        }
        for source in &study.source_ids {
            check_id(source, "study sourceId")?;
        }
    }

    if request.meta_files.len() > 200 {
        return Err(AgentExecutionError::invalid_request(
            "metaFiles must contain at most 200 entries.",
        ));
    }
    for file in &request.meta_files {
        check_id(&file.id, "metaFile id")?;
        if file.name.is_empty() || char_len(&file.name) > 512 {
            return Err(AgentExecutionError::invalid_request(
                "metaFile name must be 1-512 characters.",
            ));
        }
        if let Some(meta_step_id) = &file.meta_step_id {
            check_id(meta_step_id, "metaFile metaStepId")?;
        }
        if file.source_ids.len() > 5 {
            return Err(AgentExecutionError::invalid_request(
                "a metaFile may bind at most 5 sources.",
            ));
        }
        for source in &file.source_ids {
            check_id(source, "metaFile sourceId")?;
        }
    }

    if request.sec1_steps.len() > 100 || request.sec3_steps.len() > 100 {
        return Err(AgentExecutionError::invalid_request(
            "sec1Steps/sec3Steps may contain at most 100 entries each.",
        ));
    }
    for step in request.sec1_steps.iter().chain(&request.sec3_steps) {
        check_id(&step.id, "section step id")?;
        if step.name.is_empty() || char_len(&step.name) > 1000 {
            return Err(AgentExecutionError::invalid_request(
                "section step name must be 1-1000 characters.",
            ));
        }
        if step.instruction.is_empty() {
            return Err(AgentExecutionError::invalid_request(
                "section step instruction is required.",
            ));
        }
    }

    if request.sect1_meta_steps.len() > 100 {
        return Err(AgentExecutionError::invalid_request(
            "sect1MetaSteps may contain at most 100 entries.",
        ));
    }
    for meta in &request.sect1_meta_steps {
        check_id(&meta.id, "sect1MetaStep id")?;
        if meta.type_name.is_empty() || char_len(&meta.type_name) > 1000 {
            return Err(AgentExecutionError::invalid_request(
                "sect1MetaStep typeName must be 1-1000 characters.",
            ));
        }
        if meta.instruction.is_empty() {
            return Err(AgentExecutionError::invalid_request(
                "sect1MetaStep instruction is required.",
            ));
        }
        if meta.keywords.len() > 100 {
            return Err(AgentExecutionError::invalid_request(
                "sect1MetaStep keywords may contain at most 100 entries.",
            ));
        }
    }

    if request.sources.len() > 1000 {
        return Err(AgentExecutionError::invalid_request(
            "sources may contain at most 1000 entries.",
        ));
    }
    for source in &request.sources {
        check_id(source_id(source), "sourceId")?;
        if let ExecutionSource::Upload { sha256, .. } = source {
            if !is_valid_digest(sha256) {
                return Err(AgentExecutionError::invalid_request(
                    "source sha256 must be 64 lowercase hex characters.",
                ));
            }
        }
    }

    if request.skills.len() > 100 {
        return Err(AgentExecutionError::invalid_request(
            "skills may contain at most 100 entries.",
        ));
    }
    for skill in &request.skills {
        check_id(&skill.id, "skill id")?;
        if skill.text.is_empty() {
            return Err(AgentExecutionError::invalid_request("skill text is required."));
        }
    }

    if request.model.is_empty() || char_len(&request.model) > 512 {
        return Err(AgentExecutionError::invalid_request("model must be 1-512 characters."));
    }

    check_optional_non_empty(request.corpus_id.as_deref(), "corpusId")?;
    check_optional_non_empty(request.meta_corpus_id.as_deref(), "metaCorpusId")?;
    check_optional_non_empty(request.project_id.as_deref(), "projectId")?;

    // Inline `templates` are validated here (→ INVALID_REQUEST), matching
    // compileSchema validating them at parse time. The YAML branch validates the
    // same record later but maps failures to INVALID_TEMPLATES.
    if let Some(inline) = &request.templates {
        validate_templates_record(inline).map_err(|reason| {
            AgentExecutionError::invalid_request(format!("Invalid templates: {reason}."))
        })?;
    }

    Ok(())
}

/// Read the `sourceId` out of either [`ExecutionSource`] variant.
fn source_id(source: &ExecutionSource) -> &str {
    match source {
        ExecutionSource::Upload { source_id, .. } => source_id,
        ExecutionSource::Text { source_id, .. } => source_id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentnodes::error::{codes, stage};
    use axum::http::StatusCode;
    use serde_json::json;

    // ── KeywordsInput transform ─────────────────────────────────────────────

    #[test]
    fn keywords_string_passes_through_and_array_joins() {
        assert_eq!(KeywordsInput::Text("a, b".into()).into_joined(), "a, b");
        assert_eq!(
            KeywordsInput::List(vec!["a".into(), "b".into(), "c".into()]).into_joined(),
            "a, b, c"
        );
        assert_eq!(KeywordsInput::default().into_joined(), "");
    }

    #[test]
    fn keywords_deserializes_from_string_or_array() {
        #[derive(Deserialize)]
        struct Wrap {
            #[serde(default)]
            keywords: KeywordsInput,
        }
        let from_string: Wrap = serde_json::from_value(json!({ "keywords": "x, y" })).unwrap();
        assert_eq!(from_string.keywords.into_joined(), "x, y");
        let from_array: Wrap = serde_json::from_value(json!({ "keywords": ["x", "y"] })).unwrap();
        assert_eq!(from_array.keywords.into_joined(), "x, y");
        let absent: Wrap = serde_json::from_value(json!({})).unwrap();
        assert_eq!(absent.keywords.into_joined(), "");
    }

    // ── validate_templates_record ───────────────────────────────────────────

    fn template(id: &str, instruction: &str) -> Value {
        json!({ "id": id, "user_instruction": instruction })
    }

    #[test]
    fn valid_templates_record_passes_and_keeps_passthrough() {
        let mut map = Map::new();
        map.insert(
            "clinical".into(),
            json!({ "id": "tmpl-1", "user_instruction": "Write it.", "extra": 7 }),
        );
        assert!(validate_templates_record(&map).is_ok());
    }

    #[test]
    fn templates_record_rejects_missing_id_and_blank_instruction() {
        let mut missing_id = Map::new();
        missing_id.insert("k".into(), json!({ "user_instruction": "hi" }));
        assert!(validate_templates_record(&missing_id).is_err());

        let mut blank_instruction = Map::new();
        blank_instruction.insert("k".into(), template("tmpl-1", "   "));
        assert!(validate_templates_record(&blank_instruction).is_err());

        let mut non_object = Map::new();
        non_object.insert("k".into(), json!("not an object"));
        assert!(validate_templates_record(&non_object).is_err());
    }

    // ── parse_yaml_templates ────────────────────────────────────────────────

    #[test]
    fn parses_valid_yaml_templates() {
        let yaml = "templates:\n  clinical:\n    id: tmpl-1\n    user_instruction: Write section.\n";
        let templates = parse_yaml_templates(yaml).expect("valid yaml");
        assert_eq!(templates["clinical"]["id"], "tmpl-1");
    }

    #[test]
    fn yaml_without_templates_key_is_invalid_templates() {
        let error = parse_yaml_templates("other: 1\n").expect_err("missing templates key");
        assert_eq!(error.code, codes::INVALID_TEMPLATES);
        assert_eq!(error.http_status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error.stage, stage::VALIDATION);
    }

    #[test]
    fn yaml_with_invalid_template_is_invalid_templates() {
        // `user_instruction` is blank after trimming.
        let yaml = "templates:\n  clinical:\n    id: tmpl-1\n    user_instruction: '   '\n";
        let error = parse_yaml_templates(yaml).expect_err("blank instruction");
        assert_eq!(error.code, codes::INVALID_TEMPLATES);
    }

    #[test]
    fn malformed_yaml_is_invalid_templates() {
        // Unterminated flow mapping — a hard YAML syntax error.
        let error = parse_yaml_templates("templates: {a: 1\n").expect_err("bad yaml");
        assert_eq!(error.code, codes::INVALID_TEMPLATES);
    }

    // ── collect_template_ids ────────────────────────────────────────────────

    #[test]
    fn collects_template_ids_from_values() {
        let mut map = Map::new();
        map.insert("a".into(), template("tmpl-1", "x"));
        map.insert("b".into(), template("tmpl-2", "y"));
        let mut ids = collect_template_ids(&map);
        ids.sort();
        assert_eq!(ids, vec!["tmpl-1".to_string(), "tmpl-2".to_string()]);
    }

    // ── build_bindings ──────────────────────────────────────────────────────

    fn study(id: &str, template_id: &str, source_ids: &[&str]) -> CompileStudy {
        CompileStudy {
            id: id.into(),
            file_name: "f.pdf".into(),
            doc_title: "Title".into(),
            summary: String::new(),
            keywords: KeywordsInput::default(),
            study_type: String::new(),
            template_id: template_id.into(),
            selected: true,
            protocol_number: None,
            user_input: None,
            source_ids: source_ids.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn meta_file(id: &str, meta_step_id: Option<&str>, source_ids: &[&str]) -> CompileMetaFile {
        CompileMetaFile {
            id: id.into(),
            name: "bio.pdf".into(),
            meta_step_id: meta_step_id.map(str::to_string),
            user_input: None,
            source_ids: source_ids.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn set<'a>(values: &[&'a str]) -> HashSet<&'a str> {
        values.iter().copied().collect()
    }

    #[test]
    fn binds_file_backed_study_and_numbers_layers() {
        let studies = vec![study("s1", "tmpl-1", &["src-1"]), study("s2", "tmpl-1", &["src-2"])];
        let refs: Vec<&CompileStudy> = studies.iter().collect();
        let sources = set(&["src-1", "src-2"]);
        let templates = set(&["tmpl-1"]);
        let bindings = build_bindings(&refs, &[], &sources, None, None, &templates, &HashSet::new())
            .expect("binds");
        assert_eq!(bindings.get("layer-1"), Some(&vec!["src-1".to_string()]));
        assert_eq!(bindings.get("layer-2"), Some(&vec!["src-2".to_string()]));
        // Insertion order: layer-1 then layer-2.
        let keys: Vec<&String> = bindings.keys().collect();
        assert_eq!(keys, vec!["layer-1", "layer-2"]);
    }

    #[test]
    fn corpus_bound_study_produces_no_binding_entry() {
        let studies = vec![study("s1", "tmpl-1", &[])];
        let refs: Vec<&CompileStudy> = studies.iter().collect();
        let templates = set(&["tmpl-1"]);
        let bindings =
            build_bindings(&refs, &[], &HashSet::new(), Some("corpus-1"), None, &templates, &HashSet::new())
                .expect("corpus mode binds nothing");
        assert!(bindings.is_empty());
    }

    #[test]
    fn ambiguous_source_mode_when_corpus_and_files_both_present() {
        let studies = vec![study("s1", "tmpl-1", &["src-1"])];
        let refs: Vec<&CompileStudy> = studies.iter().collect();
        let error = build_bindings(
            &refs,
            &[],
            &set(&["src-1"]),
            Some("corpus-1"),
            None,
            &set(&["tmpl-1"]),
            &HashSet::new(),
        )
        .expect_err("ambiguous");
        assert_eq!(error.code, codes::AMBIGUOUS_SOURCE_MODE);
    }

    #[test]
    fn missing_source_when_neither_corpus_nor_files() {
        let studies = vec![study("s1", "tmpl-1", &[])];
        let refs: Vec<&CompileStudy> = studies.iter().collect();
        let error =
            build_bindings(&refs, &[], &HashSet::new(), None, None, &set(&["tmpl-1"]), &HashSet::new())
                .expect_err("missing source");
        assert_eq!(error.code, codes::MISSING_SOURCE);
    }

    #[test]
    fn invalid_source_binding_on_duplicate_or_unknown_source() {
        let dup = vec![study("s1", "tmpl-1", &["src-1", "src-1"])];
        let dup_refs: Vec<&CompileStudy> = dup.iter().collect();
        let error =
            build_bindings(&dup_refs, &[], &set(&["src-1"]), None, None, &set(&["tmpl-1"]), &HashSet::new())
                .expect_err("duplicate source");
        assert_eq!(error.code, codes::INVALID_SOURCE_BINDING);

        let unknown = vec![study("s1", "tmpl-1", &["ghost"])];
        let unknown_refs: Vec<&CompileStudy> = unknown.iter().collect();
        let error = build_bindings(
            &unknown_refs,
            &[],
            &set(&["src-1"]),
            None,
            None,
            &set(&["tmpl-1"]),
            &HashSet::new(),
        )
        .expect_err("unknown source");
        assert_eq!(error.code, codes::INVALID_SOURCE_BINDING);
    }

    #[test]
    fn template_not_found_for_unknown_study_template() {
        let studies = vec![study("s1", "ghost-template", &["src-1"])];
        let refs: Vec<&CompileStudy> = studies.iter().collect();
        let error =
            build_bindings(&refs, &[], &set(&["src-1"]), None, None, &set(&["tmpl-1"]), &HashSet::new())
                .expect_err("template not found");
        assert_eq!(error.code, codes::TEMPLATE_NOT_FOUND);
    }

    #[test]
    fn meta_file_binds_and_validates_meta_step_id() {
        let files = vec![meta_file("m1", Some("meta-1"), &["src-1"])];
        let bindings = build_bindings(
            &[],
            &files,
            &set(&["src-1"]),
            None,
            None,
            &HashSet::new(),
            &set(&["meta-1"]),
        )
        .expect("meta binds");
        assert_eq!(bindings.get("meta-layer-1"), Some(&vec!["src-1".to_string()]));

        let bad = vec![meta_file("m1", Some("ghost"), &["src-1"])];
        let error = build_bindings(
            &[],
            &bad,
            &set(&["src-1"]),
            None,
            None,
            &HashSet::new(),
            &set(&["meta-1"]),
        )
        .expect_err("meta step not found");
        assert_eq!(error.code, codes::TEMPLATE_NOT_FOUND);
    }

    // ── source_id ───────────────────────────────────────────────────────────

    #[test]
    fn source_id_reads_both_variants() {
        let text = ExecutionSource::Text {
            source_id: "t1".into(),
            name: "n".into(),
            text: "body".into(),
        };
        assert_eq!(source_id(&text), "t1");
        let upload = ExecutionSource::Upload {
            source_id: "u1".into(),
            name: "n".into(),
            mime_type: "text/plain".into(),
            sha256: "a".repeat(64),
        };
        assert_eq!(source_id(&upload), "u1");
    }
}
