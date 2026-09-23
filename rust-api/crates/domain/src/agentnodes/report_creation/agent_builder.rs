//! The 272 report-creation agent builder.
//!
//! Ported (equivalent-behavior parity) from
//! `frontend_v3/app/lib/reportCreation/compiler.ts`. Given a
//! [`ReportCreationInput`] (studies + optional Section 3 / Section 1 steps +
//! biomaterial "meta" files) and a template map, [`build_report_creation_agent`]
//! emits a portable agent object whose `layers` are the ordered DAG the executor
//! later plans and advances. Layer order is **study → meta → sec3 → sec1**, and
//! each layer's `order` field is its global 0-based index in that concatenation.
//!
//! # Why layers are `serde_json::Value`
//!
//! The 272 builder writes many `Canvas272Layer` fields that the strict
//! `ExecutionLayer` schema does not type (`type`, `pod`, `bibliography`,
//! `urlContent`, `keepMaster`, `documentSelections`, …). Per the port plan the
//! builder therefore emits each layer as a free-form JSON object (the
//! `.passthrough()` bag) rather than a typed struct; the produced agent is later
//! run through the `validation` pass and wrapped as the opaque `agent` field of
//! an [`crate::agentnodes::dto::ExecutionBundle`]. The whole return value is a
//! [`serde_json::Value`] for the same reason.
//!
//! # Sibling-module contract (this unit imports, does not recreate)
//!
//! This file mirrors `compiler.ts`'s imports onto sibling modules of
//! `agentnodes::report_creation` (plus the shared error contract):
//!
//! * [`super::layer_refs`] (already ported) — `build_sec1_referenced_steps`,
//!   `build_sec3_referenced_steps`, `sec1_selection_requires_biomaterial_corpus`,
//!   and the `Sec1StepNameInput` / `Sec1StepSelection` name-only shapes.
//! * [`super::meta_steps`] (`sect1MetaSteps.ts`) — expected to expose
//!   `format_meta_instruction(instruction: &str, file_name: &str, type_name: &str)
//!   -> String`, `match_meta_file_to_step(file_name: &str, steps:
//!   &[Sect1MetaStepRow]) -> Option<&Sect1MetaStepRow>`, and the
//!   `Sect1MetaStepRow { id, type_name, instruction, keywords, user_input }`
//!   struct.
//! * [`super::sanitize`] (`synthesisCorpus.ts`) —
//!   `sanitize_report_creation_layers(layers: &[ExecutionLayer]) ->
//!   Vec<ExecutionLayer>` (strips the clinical-corpus binding off Section 1 /
//!   Section 3 layers; a no-op for the Section 2 / meta layers this builder binds
//!   a corpus onto, and for the binding-free Section 1 / 3 layers it emits). Since
//!   it is typed, the `Value` layers built here are round-tripped through
//!   [`ExecutionLayer`] (its `passthrough` bag absorbing the untyped 272 fields)
//!   for the sanitize call.
//! * [`crate::agentnodes::error::AgentExecutionError`] — the portable error
//!   contract; the three validation failures raised here (`INVALID_REPORT`,
//!   `INVALID_BIOMATERIAL_SELECTION`, `BIOMATERIAL_REQUIRED`) all map to HTTP 400.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

use super::super::dto::ExecutionLayer;
use super::super::error::AgentExecutionError;
use super::layer_refs::{
    build_sec1_referenced_steps, build_sec3_referenced_steps,
    sec1_selection_requires_biomaterial_corpus, Sec1StepNameInput, Sec1StepSelection,
};
use super::meta_steps::{format_meta_instruction, match_meta_file_to_step, Sect1MetaStepRow};
use super::sanitize::sanitize_report_creation_layers;

/// Default text-generation model id. Mirrors `DEFAULT_MODEL` in
/// `frontend_v3/app/lib/modelConfig.ts` (kept local because the pure domain crate
/// does not depend on the bootstrap runtime configuration).
pub const DEFAULT_MODEL: &str = "gemini-3.6-flash";

/// Fallback biomaterial instruction when no template/shared instruction resolves.
///
/// Mirrors `META_SECTION_PROMPT_FALLBACK` in `compiler.ts` verbatim; `{pdf_name}`
/// is substituted by [`format_meta_instruction`].
pub const META_SECTION_PROMPT_FALLBACK: &str =
    "Summarize and extract all key information from the document: {pdf_name}.";

/// The system instruction attached to every Section 2 (per-study) layer.
///
/// Ported **verbatim** from `STUDY_SYSTEM_INSTRUCTION` in `compiler.ts`. The
/// four-space-indented lines and the blank line before `IMPORTANT OUTPUT RULE`
/// are load-bearing and reproduced exactly (raw string, no code indentation).
pub const STUDY_SYSTEM_INSTRUCTION: &str = r#"Each output must check all:
[ ] A Bias Check section naming the main biases you controlled for.
    Bias: agreement bias, confirmation bias, pattern-matching shortcuts.
    Resist sycophancy: never treat user claims as true just because they said them.
    Logic: leaps, narrative-filling, missing alternatives.
[ ] Harvard-style references.
[ ] An explicit answer to: "Did I understand the task?"

IMPORTANT OUTPUT RULE (override):
- You MUST perform the Bias Check + Task Understanding check, but do NOT print/return those sections verbatim in the user-visible output.
- DO include Harvard-style references in the user-visible output when applicable."#;

/// A single clinical study fed into the report builder (`ReportStudy`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportStudy {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub file_name: String,
    #[serde(default)]
    pub doc_title: String,
    #[serde(default)]
    pub summary: String,
    /// A single string (comma/newline separated), matching the reference shape.
    #[serde(default)]
    pub keywords: String,
    #[serde(default)]
    pub study_type: String,
    #[serde(default)]
    pub template_id: String,
    #[serde(default)]
    pub selected: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol_number: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_input: Option<String>,
}

/// A Section 3 / Section 1 synthesis step (`ReportSectionStep`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportSectionStep {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub instruction: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_input: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected: Option<bool>,
}

/// A biomaterial "meta" source document (`ReportMetaFile`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportMetaFile {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta_step_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_input: Option<String>,
}

/// The complete report-creation request (`ReportCreationInput`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportCreationInput {
    #[serde(default)]
    pub agent_name: String,
    #[serde(default)]
    pub studies: Vec<ReportStudy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sec3_steps: Option<Vec<ReportSectionStep>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sec1_steps: Option<Vec<ReportSectionStep>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta_files: Option<Vec<ReportMetaFile>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta_corpus_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta_corpus_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub corpus_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub corpus_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared_meta_instruction: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report_creation_display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub biomaterial_skipped: Option<bool>,
}

/// A resolved template entry (`Record<string, { id?, user_instruction?,
/// user_input? }>` value). Field names stay snake_case to match the YAML/wire
/// shape the reference reads (no camelCase rename).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ReportTemplate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_instruction: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_input: Option<String>,
}

/// Optional build knobs (`{ localMetaSources?, timestamp? }`).
///
/// `timestamp` is the request-scoped clock the caller pins so `created` /
/// `modified` stay consistent; when `None`, the builder falls back to the current
/// UTC instant (the `new Date().toISOString()` default in the reference).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BuildOptions {
    pub local_meta_sources: bool,
    pub timestamp: Option<String>,
}

/// `Some(s)` iff `value` is a present, non-empty string — the JS truthiness gate
/// applied to `corpusId` / `corpusName` / `metaCorpusId` / … in the reference.
fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|s| !s.is_empty())
}

/// Build a JSON string array from owned `String`s.
fn string_array(items: Vec<String>) -> Value {
    Value::Array(items.into_iter().map(Value::String).collect())
}

/// The deduplicated study types in first-occurrence order (`[...new Set(...)]`).
fn unique_in_order<'a>(items: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for item in items {
        if seen.insert(item.to_string()) {
            out.push(item.to_string());
        }
    }
    out
}

/// A base 272 layer with every default field, then `fields` spread on top.
///
/// Ported from the private `blankLayer` in `compiler.ts`. The three
/// `undefined`-valued keys there (`collection`, `selectedPersona`,
/// `selectedPersonaIcon`) are omitted entirely, exactly as `JSON.stringify` drops
/// them; `image` stays an explicit `null`. Any field the caller sets — including
/// an omitted `corpusId` — overrides the default via the final spread.
fn blank_layer(model: &str, fields: Map<String, Value>) -> Value {
    let mut layer = Map::new();
    layer.insert("type".into(), json!("user"));
    layer.insert("isActive".into(), json!(true));
    layer.insert("pod".into(), json!(""));
    layer.insert("systemInstruction".into(), json!(""));
    layer.insert("userInstruction".into(), json!(""));
    layer.insert("assistantResponse".into(), json!(""));
    layer.insert("functionCall".into(), json!(""));
    layer.insert("toolCall".into(), json!(""));
    layer.insert("selectedModel".into(), json!(model));
    layer.insert("referencedSteps".into(), json!([]));
    // collection: undefined -> omitted
    layer.insert("ragKnowledge".into(), json!([]));
    layer.insert("userInput".into(), json!(""));
    layer.insert("result".into(), json!(""));
    layer.insert("imageUrls".into(), json!([]));
    layer.insert("urlContent".into(), json!([]));
    layer.insert("condition".into(), json!(""));
    layer.insert("isFrozen".into(), json!(false));
    layer.insert("keepMaster".into(), json!(false));
    layer.insert("outputType".into(), json!("basic"));
    layer.insert("image".into(), Value::Null);
    layer.insert("inputUrl".into(), json!(""));
    layer.insert("inputUrlType".into(), json!(""));
    // selectedPersona / selectedPersonaIcon: undefined -> omitted
    layer.insert("bibliography".into(), json!([]));
    layer.insert("documentSelections".into(), json!([]));

    for (key, value) in fields {
        layer.insert(key, value);
    }
    Value::Object(layer)
}

/// Whether `c` is a JS regex `\w` character (`[A-Za-z0-9_]`, ASCII only).
fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Whether `c` is a member of the `[A-Za-z0-9-]` study-id token class.
fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-'
}

/// Keyword-anchored study-id scan — the `\bKEYWORD\s+((?=[A-Za-z0-9-]*\d)
/// [A-Za-z0-9-]{2,})\b` patterns (case-insensitive keyword). Returns the leftmost
/// token that follows a word-boundaried, whitespace-separated `keyword`, is at
/// least two `[A-Za-z0-9-]` chars after trailing hyphens are trimmed (the `\b`
/// requirement), and contains at least one digit (the lookahead).
fn find_keyword_token(chars: &[char], keyword: &[char]) -> Option<String> {
    let n = chars.len();
    let klen = keyword.len();
    if klen == 0 || n < klen {
        return None;
    }
    let mut i = 0;
    while i + klen <= n {
        let keyword_matches =
            (0..klen).all(|k| chars[i + k].eq_ignore_ascii_case(&keyword[k]));
        let boundary_before = i == 0 || !is_word(chars[i - 1]);
        if keyword_matches && boundary_before {
            // \s+
            let mut j = i + klen;
            let ws_start = j;
            while j < n && chars[j].is_whitespace() {
                j += 1;
            }
            if j > ws_start {
                // maximal [A-Za-z0-9-] run
                let tok_start = j;
                let mut k = j;
                while k < n && is_token_char(chars[k]) {
                    k += 1;
                }
                // trailing hyphens can't sit before the final \b; trim them
                let mut tok_end = k;
                while tok_end > tok_start && chars[tok_end - 1] == '-' {
                    tok_end -= 1;
                }
                if tok_end - tok_start >= 2
                    && chars[tok_start..tok_end].iter().any(char::is_ascii_digit)
                {
                    return Some(chars[tok_start..tok_end].iter().collect());
                }
            }
        }
        i += 1;
    }
    None
}

/// Uppercase-code study-id scan — the `\b([A-Z]{2,}-?\d+[A-Z]?)\b` pattern
/// (case-sensitive). Returns the leftmost `2+` uppercase letters, an optional
/// single hyphen, `1+` digits, and an optional single trailing uppercase letter,
/// bounded by word boundaries.
fn find_upper_code(chars: &[char]) -> Option<String> {
    let n = chars.len();
    let mut i = 0;
    while i < n {
        let boundary_before = i == 0 || !is_word(chars[i - 1]);
        if boundary_before && chars[i].is_ascii_uppercase() {
            let start = i;
            let mut p = i;
            while p < n && chars[p].is_ascii_uppercase() {
                p += 1;
            }
            if p - start >= 2 {
                // -?
                let mut q = p;
                if q < n && chars[q] == '-' {
                    q += 1;
                }
                // \d+
                let digit_start = q;
                while q < n && chars[q].is_ascii_digit() {
                    q += 1;
                }
                if q > digit_start {
                    // [A-Z]? then \b — try the greedy (with trailing letter) first
                    if q < n && chars[q].is_ascii_uppercase() {
                        let end = q + 1;
                        if end == n || !is_word(chars[end]) {
                            return Some(chars[start..end].iter().collect());
                        }
                    }
                    if q == n || !is_word(chars[q]) {
                        return Some(chars[start..q].iter().collect());
                    }
                }
            }
        }
        i += 1;
    }
    None
}

/// Long-number study-id scan — the `\b(\d{6,})\b` pattern. Returns the leftmost
/// maximal run of `6+` digits sitting between word boundaries.
fn find_long_number(chars: &[char]) -> Option<String> {
    let n = chars.len();
    let mut i = 0;
    while i < n {
        if chars[i].is_ascii_digit() {
            let boundary_before = i == 0 || !is_word(chars[i - 1]);
            let start = i;
            let mut j = i;
            while j < n && chars[j].is_ascii_digit() {
                j += 1;
            }
            if boundary_before && j - start >= 6 && (j == n || !is_word(chars[j])) {
                return Some(chars[start..j].iter().collect());
            }
            i = j;
        } else {
            i += 1;
        }
    }
    None
}

/// Best-effort study id from a filename + title (`extractStudyId`).
///
/// Tries, in order: `Protocol <id>`, `Study <id>`, an uppercase code
/// (`AB-123X`), then a long numeric id — returning the first pattern that matches
/// anywhere in `"{file_name} {title}"`, else `""`. The four regexes are
/// hand-rolled because the domain crate carries no `regex` dependency.
fn extract_study_id(file_name: &str, title: &str) -> String {
    let hay: Vec<char> = format!("{file_name} {title}").chars().collect();
    const PROTOCOL: &[char] = &['P', 'r', 'o', 't', 'o', 'c', 'o', 'l'];
    const STUDY: &[char] = &['S', 't', 'u', 'd', 'y'];
    find_keyword_token(&hay, PROTOCOL)
        .or_else(|| find_keyword_token(&hay, STUDY))
        .or_else(|| find_upper_code(&hay))
        .or_else(|| find_long_number(&hay))
        .unwrap_or_default()
}

/// Strip a single trailing `.pdf` / `.doc` / `.docx` / `.txt` extension
/// (case-insensitive) — the `/\.(pdf|docx?|txt)$/i` replacement.
fn strip_doc_extension(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    for ext in ["pdf", "docx", "doc", "txt"] {
        let dotted = format!(".{ext}");
        if lower.ends_with(&dotted) {
            let cut = name.len() - dotted.len();
            return name[..cut].to_string();
        }
    }
    name.to_string()
}

/// Current UTC instant as `YYYY-MM-DDTHH:MM:SS.mmmZ`.
///
/// Mirrors the established `SystemTime` + integer date-math timestamp pattern used
/// elsewhere in the domain crate (no `chrono` dependency). Only reached when the
/// caller does not pin `options.timestamp`; timestamps are explicitly *not* a
/// byte-parity target (live clocks).
fn fallback_iso8601_timestamp() -> String {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let seconds_since_epoch = elapsed.as_secs();
    let milliseconds = elapsed.subsec_millis();

    let seconds_of_day = seconds_since_epoch % 86_400;
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;

    let is_leap = |year: u64| -> bool { (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 };
    let mut remaining_days = seconds_since_epoch / 86_400;
    let mut year: u64 = 1970;
    loop {
        let days_in_year = if is_leap(year) { 366 } else { 365 };
        if remaining_days >= days_in_year {
            remaining_days -= days_in_year;
            year += 1;
        } else {
            break;
        }
    }
    let february = if is_leap(year) { 29 } else { 28 };
    let month_lengths = [31, february, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 0usize;
    while month < 12 && remaining_days >= month_lengths[month] {
        remaining_days -= month_lengths[month];
        month += 1;
    }
    let day = remaining_days + 1;
    let month_number = month + 1;
    format!(
        "{year:04}-{month_number:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milliseconds:03}Z"
    )
}

/// Build the portable 272 report-creation agent (`buildReportCreationAgent`).
///
/// Returns the agent object `{ version, name, layers, metadata }` as a
/// [`serde_json::Value`] — layers ordered study → meta → sec3 → sec1, each a
/// free-form passthrough object — or an [`AgentExecutionError`] for the four
/// early-return validation failures the reference throws.
#[allow(clippy::too_many_lines)]
pub fn build_report_creation_agent(
    input: &ReportCreationInput,
    templates: &HashMap<String, ReportTemplate>,
    meta_step_rows: &[Sect1MetaStepRow],
    options: &BuildOptions,
) -> Result<Value, AgentExecutionError> {
    let biomaterial_skipped = input.biomaterial_skipped.unwrap_or(false);
    // Local `metaFiles` / `metaCorpusId` collapse to empty when biomaterial is skipped.
    let meta_files: &[ReportMetaFile] = if biomaterial_skipped {
        &[]
    } else {
        input.meta_files.as_deref().unwrap_or(&[])
    };
    let meta_corpus_id: Option<&str> = if biomaterial_skipped {
        None
    } else {
        non_empty(input.meta_corpus_id.as_deref())
    };
    let sec1_steps: &[ReportSectionStep] = input.sec1_steps.as_deref().unwrap_or(&[]);
    let sec3_steps: &[ReportSectionStep] = input.sec3_steps.as_deref().unwrap_or(&[]);

    // ── Validation (equivalent to the four reference throws) ──
    if input.agent_name.is_empty() || input.studies.is_empty() {
        return Err(AgentExecutionError::invalid_report(
            "Agent name and at least one study are required",
        ));
    }
    if biomaterial_skipped && input.meta_files.as_ref().is_some_and(|m| !m.is_empty()) {
        return Err(AgentExecutionError::invalid_biomaterial_selection(
            "biomaterialSkipped cannot be used with biomaterial PDFs. Remove meta files or clear the skip.",
        ));
    }
    let sec1_selections: Vec<Sec1StepSelection> = sec1_steps
        .iter()
        .map(|step| Sec1StepSelection {
            name: step.name.clone(),
            selected: step.selected,
        })
        .collect();
    if !biomaterial_skipped
        && meta_files.is_empty()
        && sec1_selection_requires_biomaterial_corpus(&sec1_selections)
    {
        return Err(AgentExecutionError::biomaterial_required(
            "HB_Table requires biomaterial sources or an explicit biomaterialSkipped selection.",
        ));
    }
    if !meta_files.is_empty() && meta_corpus_id.is_none() && !options.local_meta_sources {
        return Err(AgentExecutionError::biomaterial_required(
            "metaCorpusId is required when biomaterial (meta) PDFs are included.",
        ));
    }

    let timestamp = options
        .timestamp
        .clone()
        .unwrap_or_else(fallback_iso8601_timestamp);
    let model = non_empty(input.model.as_deref())
        .unwrap_or(DEFAULT_MODEL)
        .to_string();

    let corpus_id = non_empty(input.corpus_id.as_deref());
    let rag_knowledge = if let Some(cid) = corpus_id {
        json!([{
            "id": cid,
            "filename": non_empty(input.corpus_name.as_deref()).unwrap_or(cid),
            "theme": "Report Creation Corpus",
            "description": format!(
                "Corpus created for report generation containing {} clinical studies",
                input.studies.len()
            ),
            "createdAt": timestamp.clone(),
        }])
    } else {
        json!([])
    };
    let meta_rag_knowledge = match meta_corpus_id {
        Some(mcid) if !meta_files.is_empty() => json!([{
            "id": mcid,
            "filename": non_empty(input.meta_corpus_name.as_deref()).unwrap_or(mcid),
            "theme": "Meta Section Corpus",
            "description": format!(
                "Corpus created for meta-section containing {} documents",
                meta_files.len()
            ),
            "createdAt": timestamp.clone(),
        }]),
        _ => json!([]),
    };

    // ── Study layers (Section 2) ──
    let mut study_layers: Vec<Value> = Vec::with_capacity(input.studies.len());
    let mut study_ids: Vec<String> = Vec::with_capacity(input.studies.len());
    for (index, study) in input.studies.iter().enumerate() {
        let template = templates
            .values()
            .find(|candidate| candidate.id.as_deref() == Some(study.template_id.as_str()));
        let trimmed_protocol = study
            .protocol_number
            .as_deref()
            .map(str::trim)
            .unwrap_or("");
        let study_id = if trimmed_protocol.is_empty() {
            extract_study_id(&study.file_name, &study.doc_title)
        } else {
            trimmed_protocol.to_string()
        };
        let label = if !study_id.is_empty() {
            study_id.clone()
        } else {
            let truncated: String = strip_doc_extension(&study.file_name).chars().take(30).collect();
            if truncated.is_empty() {
                format!("Study {}", index + 1)
            } else {
                truncated
            }
        };
        let study_id_replacement = if study_id.is_empty() {
            "[extract from source document]"
        } else {
            study_id.as_str()
        };
        let instruction = template
            .and_then(|t| t.user_instruction.as_deref())
            .unwrap_or("")
            .replace("[INSERT STUDY ID]", study_id_replacement)
            .replace("[Drug Name]", "[Drug Name from source]");
        let study_number_line = if study_id.is_empty() {
            "- Study Number/ID: (not provided \u{2014} extract from the source document per the prompt above)".to_string()
        } else {
            format!("- Study Number/ID: {study_id}")
        };
        let study_info = format!(
            "Study Info:\n{study_number_line}\n- Study Title: {}\n- Filename: {}",
            study.doc_title, study.file_name
        );
        let title_truncated: String = study.doc_title.chars().take(40).collect();
        let title_ellipsis = if study.doc_title.chars().count() > 40 {
            "..."
        } else {
            ""
        };

        let id = format!("layer-{}", index + 1);
        let mut fields = Map::new();
        fields.insert("id".into(), Value::String(id.clone()));
        fields.insert(
            "name".into(),
            Value::String(format!("[SECTION 2] {label} - {title_truncated}{title_ellipsis}")),
        );
        fields.insert("tag".into(), Value::String("Section 2".into()));
        fields.insert("order".into(), json!(index));
        fields.insert(
            "systemInstruction".into(),
            Value::String(STUDY_SYSTEM_INSTRUCTION.to_string()),
        );
        fields.insert(
            "userInstruction".into(),
            Value::String(format!("{}\n\n{}", instruction.trim(), study_info)),
        );
        fields.insert(
            "userInput".into(),
            Value::String(study.user_input.as_deref().unwrap_or("").trim().to_string()),
        );
        fields.insert("ragKnowledge".into(), rag_knowledge.clone());
        fields.insert(
            "bibliography".into(),
            json!([{
                "name": study.file_name.clone(),
                "path": study.file_name.clone(),
                "type": "file",
                "description": format!("Source document for {}", study.doc_title),
            }]),
        );
        if let Some(cid) = corpus_id {
            fields.insert("corpusId".into(), Value::String(cid.to_string()));
        }
        let doc_selections = if corpus_id.is_some() && !study.file_name.is_empty() {
            string_array(vec![study.file_name.clone()])
        } else {
            json!([])
        };
        fields.insert("documentSelections".into(), doc_selections);

        study_layers.push(blank_layer(&model, fields));
        study_ids.push(id);
    }

    // ── Meta layers (biomaterial) ──
    let shared_trimmed = input
        .shared_meta_instruction
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let mut meta_layers: Vec<Value> = Vec::with_capacity(meta_files.len());
    let mut meta_ids: Vec<String> = Vec::with_capacity(meta_files.len());
    for (index, file) in meta_files.iter().enumerate() {
        let trimmed_meta_step_id = file
            .meta_step_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let picked = trimmed_meta_step_id
            .and_then(|id| meta_step_rows.iter().find(|row| row.id.as_str() == id));

        let mut user_input = file.user_input.as_deref().map(str::trim).unwrap_or("").to_string();
        let (instruction, display_type) = if let Some(p) = picked {
            let instruction = format_meta_instruction(&p.instruction, &file.name, &p.type_name);
            let display_type = {
                let trimmed = p.type_name.trim();
                if trimmed.is_empty() {
                    "Biomaterial".to_string()
                } else {
                    trimmed.to_string()
                }
            };
            (instruction, display_type)
        } else if let Some(shared) = shared_trimmed {
            (
                format_meta_instruction(shared, &file.name, "Biomaterial"),
                "Biomaterial".to_string(),
            )
        } else {
            // `matched` is consumed exactly once so this compiles whether the
            // `meta_steps` sibling returns a borrowed (`Option<&Sect1MetaStepRow>`,
            // the natural port) or an owned `Option<Sect1MetaStepRow>`.
            let matched = match_meta_file_to_step(&file.name, meta_step_rows);
            let (instruction, display_type, matched_user_input) = match matched {
                Some(m) => (
                    format_meta_instruction(&m.instruction, &file.name, &m.type_name),
                    {
                        let trimmed = m.type_name.trim();
                        if trimmed.is_empty() {
                            "Biomaterial".to_string()
                        } else {
                            trimmed.to_string()
                        }
                    },
                    m.user_input
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string),
                ),
                None => (
                    format_meta_instruction(META_SECTION_PROMPT_FALLBACK, &file.name, "Default"),
                    "Biomaterial".to_string(),
                    None,
                ),
            };
            if user_input.is_empty() {
                user_input = matched_user_input.unwrap_or_default();
            }
            (instruction, display_type)
        };

        let id = format!("meta-layer-{}", index + 1);
        let order = study_layers.len() + index;
        let mut fields = Map::new();
        fields.insert("id".into(), Value::String(id.clone()));
        fields.insert(
            "name".into(),
            Value::String(format!("[META] {display_type} \u{00b7} {}", file.name)),
        );
        fields.insert("tag".into(), Value::String("meta-section".into()));
        fields.insert("order".into(), json!(order));
        fields.insert("userInstruction".into(), Value::String(instruction));
        fields.insert("userInput".into(), Value::String(user_input));
        fields.insert("ragKnowledge".into(), meta_rag_knowledge.clone());
        fields.insert(
            "bibliography".into(),
            json!([{
                "name": file.name.clone(),
                "path": file.name.clone(),
                "type": "file",
                "description": format!("Source document for {}", file.name),
            }]),
        );
        if let Some(mcid) = meta_corpus_id {
            fields.insert("corpusId".into(), Value::String(mcid.to_string()));
        }
        let doc_selections = if meta_corpus_id.is_some() && !file.name.is_empty() {
            string_array(vec![file.name.clone()])
        } else {
            json!([])
        };
        fields.insert("documentSelections".into(), doc_selections);

        meta_layers.push(blank_layer(&model, fields));
        meta_ids.push(id);
    }

    // ── Section 3 layers ──
    let mut sec3_layers: Vec<Value> = Vec::with_capacity(sec3_steps.len());
    let mut sec3_ids: Vec<String> = Vec::with_capacity(sec3_steps.len());
    for (index, step) in sec3_steps.iter().enumerate() {
        let id = format!("sec3-layer-{}", index + 1);
        let order = study_layers.len() + meta_layers.len() + index;
        let refs = build_sec3_referenced_steps(&study_ids, &meta_ids, index);
        let mut fields = Map::new();
        fields.insert("id".into(), Value::String(id.clone()));
        fields.insert(
            "name".into(),
            Value::String(format!("[SECTION 3] {}", step.name)),
        );
        fields.insert("tag".into(), Value::String("Section 3".into()));
        fields.insert("order".into(), json!(order));
        fields.insert("userInstruction".into(), Value::String(step.instruction.clone()));
        fields.insert(
            "userInput".into(),
            Value::String(step.user_input.as_deref().unwrap_or("").trim().to_string()),
        );
        fields.insert("referencedSteps".into(), string_array(refs));

        sec3_layers.push(blank_layer(&model, fields));
        sec3_ids.push(id);
    }

    // ── Section 1 layers ──
    let sec1_name_inputs: Vec<Sec1StepNameInput> = sec1_steps
        .iter()
        .map(|step| Sec1StepNameInput {
            name: step.name.clone(),
        })
        .collect();
    let mut sec1_layers: Vec<Value> = Vec::with_capacity(sec1_steps.len());
    for (index, step) in sec1_steps.iter().enumerate() {
        let id = format!("sec1-layer-{}", index + 1);
        let order = study_layers.len() + meta_layers.len() + sec3_layers.len() + index;
        let refs =
            build_sec1_referenced_steps(&step.name, &sec1_name_inputs, &study_ids, &meta_ids, &sec3_ids);
        let mut fields = Map::new();
        fields.insert("id".into(), Value::String(id));
        fields.insert(
            "name".into(),
            Value::String(format!("[SECTION 1] {}", step.name)),
        );
        fields.insert("tag".into(), Value::String("Section 1".into()));
        fields.insert("order".into(), json!(order));
        fields.insert("userInstruction".into(), Value::String(step.instruction.clone()));
        fields.insert(
            "userInput".into(),
            Value::String(step.user_input.as_deref().unwrap_or("").trim().to_string()),
        );
        fields.insert("referencedSteps".into(), string_array(refs));

        sec1_layers.push(blank_layer(&model, fields));
    }

    // ── Assemble: study -> meta -> sec3 -> sec1, then sanitize ──
    let mut all_layers: Vec<Value> = Vec::with_capacity(
        study_layers.len() + meta_layers.len() + sec3_layers.len() + sec1_layers.len(),
    );
    all_layers.extend(study_layers);
    all_layers.extend(meta_layers);
    all_layers.extend(sec3_layers);
    all_layers.extend(sec1_layers);

    // `sanitize_report_creation_layers` operates on the typed [`ExecutionLayer`]
    // (its `#[serde(flatten)] passthrough` bag absorbs the untyped 272 fields
    // this builder writes), so round-trip the Value layers through it. It is a
    // no-op for every layer emitted here — Section 2 / meta are not synthesis
    // layers, and the Section 1 / 3 layers carry no clinical-corpus binding to
    // strip — matching the reference's identity return. `order` re-serializes as
    // the DTO's canonical `f64`; equivalent-behavior parity does not require the
    // integer form.
    let typed_layers: Vec<ExecutionLayer> = all_layers
        .into_iter()
        .map(serde_json::from_value::<ExecutionLayer>)
        .collect::<Result<_, _>>()
        .map_err(|error| {
            AgentExecutionError::invalid_report(format!(
                "failed to normalize generated report layers: {error}"
            ))
        })?;
    let sanitized_layers: Vec<Value> = sanitize_report_creation_layers(&typed_layers)
        .into_iter()
        .map(|layer| {
            serde_json::to_value(layer).map_err(|error| {
                AgentExecutionError::invalid_report(format!(
                    "failed to serialize sanitized report layer: {error}"
                ))
            })
        })
        .collect::<Result<_, _>>()?;

    let unique_types = unique_in_order(input.studies.iter().map(|study| study.study_type.as_str()));
    let display_title = input
        .report_creation_display_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let mut metadata = Map::new();
    metadata.insert("created".into(), Value::String(timestamp.clone()));
    metadata.insert("modified".into(), Value::String(timestamp));
    metadata.insert(
        "description".into(),
        Value::String(format!(
            "Report agent generated from {} clinical studies. Types: {}",
            input.studies.len(),
            unique_types.join(", ")
        )),
    );
    metadata.insert("notes".into(), json!([]));
    metadata.insert("generatedBy".into(), Value::String("Report Creation Tool".into()));
    metadata.insert("studyTypes".into(), string_array(unique_types));
    if let Some(display_title) = display_title {
        metadata.insert("displayTitle".into(), Value::String(display_title.to_string()));
    }
    if biomaterial_skipped {
        metadata.insert("biomaterialSkipped".into(), Value::Bool(true));
    }

    let mut agent = Map::new();
    agent.insert("version".into(), Value::String("1.0.0".into()));
    agent.insert("name".into(), Value::String(input.agent_name.clone()));
    agent.insert("layers".into(), Value::Array(sanitized_layers));
    agent.insert("metadata".into(), Value::Object(metadata));
    Ok(Value::Object(agent))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn study(file_name: &str, doc_title: &str, study_type: &str, template_id: &str) -> ReportStudy {
        ReportStudy {
            file_name: file_name.to_string(),
            doc_title: doc_title.to_string(),
            study_type: study_type.to_string(),
            template_id: template_id.to_string(),
            ..ReportStudy::default()
        }
    }

    fn options() -> BuildOptions {
        BuildOptions {
            local_meta_sources: false,
            timestamp: Some("2026-01-01T00:00:00.000Z".to_string()),
        }
    }

    fn layers_of(agent: &Value) -> &Vec<Value> {
        agent["layers"].as_array().expect("layers is an array")
    }

    #[test]
    fn extract_study_id_prefers_protocol_then_study_then_code_then_number() {
        assert_eq!(extract_study_id("Protocol AB-12 results.pdf", ""), "AB-12");
        assert_eq!(extract_study_id("Study X9 summary", ""), "X9");
        // No keyword -> uppercase code.
        assert_eq!(extract_study_id("report ABC-123X final", ""), "ABC-123X");
        // No code -> long number.
        assert_eq!(extract_study_id("scan 1234567 v2", ""), "1234567");
        // Nothing matches.
        assert_eq!(extract_study_id("summary notes", "final draft"), "");
    }

    #[test]
    fn extract_study_id_keyword_token_requires_a_digit_and_trims_hyphens() {
        // "Protocol alpha" has no digit in the token -> skip; later code matches.
        assert_eq!(extract_study_id("Protocol alpha AB12 done", ""), "AB12");
        // Trailing hyphen is excluded by the \b boundary.
        assert_eq!(extract_study_id("Study 9a- rest", ""), "9a");
        // A 5-digit run does not satisfy \d{6,}; a keyword/code path is required.
        assert_eq!(extract_study_id("value 12345 only", ""), "");
    }

    #[test]
    fn strip_doc_extension_handles_docx_before_doc_case_insensitively() {
        assert_eq!(strip_doc_extension("report.DOCX"), "report");
        assert_eq!(strip_doc_extension("report.doc"), "report");
        assert_eq!(strip_doc_extension("scan.PDF"), "scan");
        assert_eq!(strip_doc_extension("notes.txt"), "notes");
        assert_eq!(strip_doc_extension("archive.tar.gz"), "archive.tar.gz");
    }

    #[test]
    fn blank_layer_omits_undefined_keys_and_keeps_null_image() {
        let layer = blank_layer("gemini-x", Map::new());
        let obj = layer.as_object().unwrap();
        assert_eq!(obj["type"], json!("user"));
        assert_eq!(obj["selectedModel"], json!("gemini-x"));
        assert_eq!(obj["image"], Value::Null);
        assert!(obj.contains_key("image"));
        // undefined-valued keys are dropped entirely.
        assert!(!obj.contains_key("collection"));
        assert!(!obj.contains_key("selectedPersona"));
        assert!(!obj.contains_key("selectedPersonaIcon"));
        // corpusId only appears when a field supplies it.
        assert!(!obj.contains_key("corpusId"));
    }

    #[test]
    fn requires_agent_name_and_at_least_one_study() {
        let empty_name = ReportCreationInput {
            agent_name: String::new(),
            studies: vec![study("a.pdf", "Title", "tox", "t1")],
            ..ReportCreationInput::default()
        };
        assert_eq!(
            build_report_creation_agent(&empty_name, &HashMap::new(), &[], &options())
                .unwrap_err()
                .code,
            "INVALID_REPORT"
        );

        let no_studies = ReportCreationInput {
            agent_name: "Agent".to_string(),
            ..ReportCreationInput::default()
        };
        assert_eq!(
            build_report_creation_agent(&no_studies, &HashMap::new(), &[], &options())
                .unwrap_err()
                .code,
            "INVALID_REPORT"
        );
    }

    #[test]
    fn biomaterial_skip_conflicts_with_supplied_meta_files() {
        let input = ReportCreationInput {
            agent_name: "Agent".to_string(),
            studies: vec![study("a.pdf", "Title", "tox", "t1")],
            biomaterial_skipped: Some(true),
            meta_files: Some(vec![ReportMetaFile {
                name: "bm.pdf".to_string(),
                ..ReportMetaFile::default()
            }]),
            ..ReportCreationInput::default()
        };
        assert_eq!(
            build_report_creation_agent(&input, &HashMap::new(), &[], &options())
                .unwrap_err()
                .code,
            "INVALID_BIOMATERIAL_SELECTION"
        );
    }

    #[test]
    fn selected_hb_table_without_biomaterial_is_rejected() {
        let input = ReportCreationInput {
            agent_name: "Agent".to_string(),
            studies: vec![study("a.pdf", "Title", "tox", "t1")],
            sec1_steps: Some(vec![ReportSectionStep {
                name: "HB Table".to_string(),
                instruction: "make the table".to_string(),
                ..ReportSectionStep::default()
            }]),
            ..ReportCreationInput::default()
        };
        assert_eq!(
            build_report_creation_agent(&input, &HashMap::new(), &[], &options())
                .unwrap_err()
                .code,
            "BIOMATERIAL_REQUIRED"
        );
    }

    #[test]
    fn meta_files_require_a_corpus_unless_local_sources() {
        let base = ReportCreationInput {
            agent_name: "Agent".to_string(),
            studies: vec![study("a.pdf", "Title", "tox", "t1")],
            meta_files: Some(vec![ReportMetaFile {
                name: "bm.pdf".to_string(),
                ..ReportMetaFile::default()
            }]),
            shared_meta_instruction: Some("Summarize {pdf_name}".to_string()),
            ..ReportCreationInput::default()
        };
        // No corpus id, no local sources -> rejected.
        assert_eq!(
            build_report_creation_agent(&base, &HashMap::new(), &[], &options())
                .unwrap_err()
                .code,
            "BIOMATERIAL_REQUIRED"
        );
        // local_meta_sources lets it through.
        let opts = BuildOptions {
            local_meta_sources: true,
            timestamp: Some("2026-01-01T00:00:00.000Z".to_string()),
        };
        assert!(build_report_creation_agent(&base, &HashMap::new(), &[], &opts).is_ok());
    }

    #[test]
    fn builds_study_layers_with_expected_shape_and_corpus_binding() {
        let mut templates = HashMap::new();
        templates.insert(
            "toxicology".to_string(),
            ReportTemplate {
                id: Some("t1".to_string()),
                user_instruction: Some(
                    "Report on [INSERT STUDY ID] for [Drug Name].".to_string(),
                ),
                user_input: None,
            },
        );
        let input = ReportCreationInput {
            agent_name: "My 272".to_string(),
            studies: vec![ReportStudy {
                file_name: "study.pdf".to_string(),
                doc_title: "Chronic Tox".to_string(),
                study_type: "tox".to_string(),
                template_id: "t1".to_string(),
                protocol_number: Some("PRT-9".to_string()),
                ..ReportStudy::default()
            }],
            corpus_id: Some("filesearch-abc".to_string()),
            corpus_name: Some("Corpus".to_string()),
            report_creation_display_name: Some("  Displayed  ".to_string()),
            ..ReportCreationInput::default()
        };

        let agent = build_report_creation_agent(&input, &templates, &[], &options()).unwrap();
        assert_eq!(agent["version"], json!("1.0.0"));
        assert_eq!(agent["name"], json!("My 272"));
        assert_eq!(agent["metadata"]["displayTitle"], json!("Displayed"));
        assert_eq!(agent["metadata"]["generatedBy"], json!("Report Creation Tool"));
        assert_eq!(agent["metadata"]["studyTypes"], json!(["tox"]));
        assert!(agent["metadata"].get("biomaterialSkipped").is_none());

        let layers = layers_of(&agent);
        assert_eq!(layers.len(), 1);
        let layer = &layers[0];
        assert_eq!(layer["id"], json!("layer-1"));
        assert_eq!(layer["tag"], json!("Section 2"));
        // `order` re-serializes as the DTO's canonical f64 after the sanitize round-trip.
        assert_eq!(layer["order"].as_f64(), Some(0.0));
        assert_eq!(layer["name"], json!("[SECTION 2] PRT-9 - Chronic Tox"));
        assert_eq!(layer["systemInstruction"], json!(STUDY_SYSTEM_INSTRUCTION));
        // Template placeholders substituted with the protocol-derived study id.
        assert!(layer["userInstruction"]
            .as_str()
            .unwrap()
            .starts_with("Report on PRT-9 for [Drug Name from source]."));
        assert_eq!(layer["corpusId"], json!("filesearch-abc"));
        assert_eq!(layer["documentSelections"], json!(["study.pdf"]));
        assert_eq!(layer["ragKnowledge"][0]["id"], json!("filesearch-abc"));
        assert_eq!(layer["ragKnowledge"][0]["theme"], json!("Report Creation Corpus"));
    }

    #[test]
    fn orders_layers_study_then_meta_then_sec3_then_sec1_and_wires_refs() {
        let input = ReportCreationInput {
            agent_name: "Agent".to_string(),
            studies: vec![
                study("s1.pdf", "Study One", "tox", "t1"),
                study("s2.pdf", "Study Two", "pk", "t1"),
            ],
            meta_files: Some(vec![ReportMetaFile {
                name: "bm.pdf".to_string(),
                ..ReportMetaFile::default()
            }]),
            meta_corpus_id: Some("filesearch-meta".to_string()),
            shared_meta_instruction: Some("Summarize the biomaterial.".to_string()),
            sec3_steps: Some(vec![ReportSectionStep {
                name: "Cross-study synthesis".to_string(),
                instruction: "Synthesize".to_string(),
                ..ReportSectionStep::default()
            }]),
            sec1_steps: Some(vec![ReportSectionStep {
                name: "Overviews".to_string(),
                instruction: "Overview".to_string(),
                ..ReportSectionStep::default()
            }]),
            ..ReportCreationInput::default()
        };

        let agent = build_report_creation_agent(&input, &HashMap::new(), &[], &options()).unwrap();
        let layers = layers_of(&agent);
        let ids: Vec<&str> = layers.iter().map(|l| l["id"].as_str().unwrap()).collect();
        assert_eq!(
            ids,
            vec!["layer-1", "layer-2", "meta-layer-1", "sec3-layer-1", "sec1-layer-1"]
        );
        // Global order indices are the concatenation positions (canonical f64).
        let orders: Vec<f64> = layers.iter().map(|l| l["order"].as_f64().unwrap()).collect();
        assert_eq!(orders, vec![0.0, 1.0, 2.0, 3.0, 4.0]);

        // Section 3 references every study then every meta layer.
        assert_eq!(
            layers[3]["referencedSteps"],
            json!(["layer-1", "layer-2", "meta-layer-1"])
        );
        // The "Overviews" Section 1 layer references studies then Section 3.
        assert_eq!(
            layers[4]["referencedSteps"],
            json!(["layer-1", "layer-2", "sec3-layer-1"])
        );

        // Meta layer shape: shared instruction, meta-section tag, corpus binding.
        assert_eq!(layers[2]["tag"], json!("meta-section"));
        assert_eq!(layers[2]["name"], json!("[META] Biomaterial \u{00b7} bm.pdf"));
        assert_eq!(layers[2]["userInstruction"], json!("Summarize the biomaterial."));
        assert_eq!(layers[2]["corpusId"], json!("filesearch-meta"));
        assert_eq!(layers[2]["documentSelections"], json!(["bm.pdf"]));
    }

    #[test]
    fn label_falls_back_to_filename_then_placeholder() {
        // No protocol/id extractable -> label is the extension-stripped filename.
        let input = ReportCreationInput {
            agent_name: "Agent".to_string(),
            studies: vec![study("overview-notes.pdf", "Overview Notes", "tox", "t1")],
            ..ReportCreationInput::default()
        };
        let agent = build_report_creation_agent(&input, &HashMap::new(), &[], &options()).unwrap();
        assert_eq!(
            layers_of(&agent)[0]["name"],
            json!("[SECTION 2] overview-notes - Overview Notes")
        );
        // Study info notes the missing id and no corpus binding is emitted.
        let user_instruction = layers_of(&agent)[0]["userInstruction"].as_str().unwrap();
        assert!(user_instruction.contains("(not provided \u{2014} extract from the source document"));
        assert!(layers_of(&agent)[0].get("corpusId").is_none());
        assert_eq!(layers_of(&agent)[0]["documentSelections"], json!([]));
    }

    #[test]
    fn dedupes_study_types_in_first_occurrence_order() {
        let input = ReportCreationInput {
            agent_name: "Agent".to_string(),
            studies: vec![
                study("a.pdf", "A", "tox", "t1"),
                study("b.pdf", "B", "pk", "t1"),
                study("c.pdf", "C", "tox", "t1"),
            ],
            biomaterial_skipped: Some(true),
            ..ReportCreationInput::default()
        };
        let agent = build_report_creation_agent(&input, &HashMap::new(), &[], &options()).unwrap();
        assert_eq!(agent["metadata"]["studyTypes"], json!(["tox", "pk"]));
        assert_eq!(
            agent["metadata"]["description"],
            json!("Report agent generated from 3 clinical studies. Types: tox, pk")
        );
        // biomaterialSkipped surfaces in metadata when set.
        assert_eq!(agent["metadata"]["biomaterialSkipped"], json!(true));
    }
}
