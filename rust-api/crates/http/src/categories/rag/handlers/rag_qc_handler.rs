//! `POST /api/rag/qc` — QC-simple: per-source data-point extraction over a
//! corpus plus optional comparison against a generated draft.
//!
//! Port of `frontend_v3/app/api/rag/qc/route.ts`. The reference:
//!  1. resolves the corpus, filters to `status === "indexed"` files, and derives
//!     the deduplicated set of base document names (`getBasePdfNames`);
//!  2. for each base name, runs a grounded Gemini extraction over the File Search
//!     store (`queryFileSearchStore`) and parses the JSON data points
//!     (`parseDataPointsFromResponse`);
//!  3. computes cross-document parameter disagreements (`findParameterDiffs`);
//!  4. when a `generatedText` draft is supplied, extracts its data points with a
//!     dedicated single-part helper (`extractFromGeneratedText`) and builds a
//!     corpus-vs-generated comparison table (`buildComparisonTable`).
//!
//! Parity notes (equivalent-behavior bar — see the plan's "Parity requirements";
//! byte-parity and ICU/CLDR pinning are explicitly NOT pursued):
//!  - `parseDataPointsFromResponse` mirrors the regex JSON slice + line-parse
//!    fallback and the JS `String(x)` scalar stringification (`5.0` -> `"5"`).
//!  - `findParameterDiffs` does not sort; `buildComparisonTable` sorts by the
//!    original-cased parameter via a Unicode-aware `localeCompare`-equivalent
//!    (implemented with std, since `icu_collator` is not wired into this crate;
//!    a plain byte / `BTreeMap` sort would order uppercase before lowercase and
//!    read wrong).
//!  - Insertion-order first-writer-wins semantics (the reference `Map`s) are
//!    reproduced with small `Vec`-backed ordered maps, since `indexmap` is not a
//!    dependency of this crate. The returned `pdfs` arrays carry the
//!    order-authoritative sequence; `valuesByPdf` object key order is not
//!    behaviour-visible.
//!  - `extractFromGeneratedText` keeps its own lighter generation config
//!    (`temperature 0.1 / topP 0.95 / topK 20` only — no candidateCount /
//!    penalties), distinct from the per-source extraction which sends the full
//!    reference sampling config.

use crate::categories::rag::collections::RAG_CORPORA_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::ports::ai::{ArtificialIntelligencePort, GenerationRequest};
use alma_application::ports::document_collection::StoredDocument;
use alma_application::ports::retrieval::{RetrievalPort, RetrievalQueryMessage, RetrievedEvidence};
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::cmp::Ordering;
use std::sync::Arc;

/// Flash-tier model used for both QC extraction surfaces. Mirrors the reference
/// `GEMINI_MODELS.flash` (`frontend_v3/app/lib/modelConfig.ts`).
const QC_EXTRACTION_MODEL: &str = "gemini-3.6-flash";

/// The em-dash placeholder the reference uses for absent comparison values
/// (`'—'`, U+2014).
const EM_DASH: &str = "\u{2014}";

/// Verbatim `EXTRACTION_SYSTEM` system instruction from the reference route.
const EXTRACTION_SYSTEM: &str = "You are a precise scientific data extractor. Your task is to extract ALL key data points, numeric values, and measurable parameters from the specified document.
Rules:
- Extract variable/parameter names and their values exactly as printed.
- Preserve units, decimal precision, scientific notation, and inequalities (<, ≤, >, ≥).
- Include sample sizes (n), p-values, confidence intervals, means, SDs, etc.
- Output valid JSON only, no markdown or extra text.";

/// A single extracted data point. Mirrors the reference `DataPoint` shape as
/// produced by `parseDataPointsFromResponse` (`unit`/`source` omitted when
/// absent, matching `JSON.stringify` dropping `undefined`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataPoint {
    pub parameter: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// The extraction outcome for one source document. Mirrors `ExtractionResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractionResult {
    pub pdf_name: String,
    pub data_points: Vec<DataPoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
}

/// A cross-document disagreement on a parameter's value. Mirrors `ParameterDiff`.
/// (`values_by_pdf` is a `serde_json::Value`, so no `Eq`.)
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParameterDiff {
    pub parameter: String,
    /// `{ pdfName: value }` object. Key order is not behaviour-visible; `pdfs`
    /// carries the order-authoritative sequence.
    pub values_by_pdf: Value,
    pub pdfs: Vec<String>,
}

/// One row of the corpus-vs-generated comparison table. Mirrors `ComparisonRow`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonRow {
    pub parameter: String,
    pub corpus_value: String,
    pub corpus_source_pdf: String,
    pub generated_value: String,
    #[serde(rename = "match")]
    pub matches: bool,
}

#[route(method = "POST", path = "/api/rag/qc")]
pub async fn rag_qc_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let corpus_identifier = extract_required_corpus_identifier(&submitted_body)?;
    let generated_text = extract_optional_generated_text(&submitted_body);

    let corpus_document = application_state
        .document_collection
        .fetch_document(RAG_CORPORA_COLLECTION_NAME, &corpus_identifier)
        .await?
        .ok_or_else(|| HttpError::RequestedResourceWasNotFound {
            explanation: format!("no corpus was found for identifier '{corpus_identifier}'"),
        })?;

    let file_search_store_name = resolve_file_search_store_name(&corpus_document, &corpus_identifier);
    let corpus_files = read_corpus_files(&corpus_document);
    let base_document_names = base_pdf_names(&corpus_files);

    if base_document_names.is_empty() {
        return Ok(Json(json!({
            "extractions": [],
            "diffs": [],
            "comparisonTable": [],
            "message": "No indexed files in corpus",
        })));
    }

    // Per-source grounded extraction (retrieval + Gemini), in base-name order.
    let mut extractions: Vec<ExtractionResult> = Vec::new();
    for base_document_name in &base_document_names {
        let extraction = extract_data_points_for_source(
            &application_state.retrieval_adapter,
            &application_state.artificial_intelligence_adapter,
            &file_search_store_name,
            base_document_name,
        )
        .await?;
        extractions.push(extraction);
    }

    let diffs = find_parameter_diffs(&extractions);

    let comparison_table = match &generated_text {
        Some(generated_text) => {
            let generated_data_points = extract_data_points_from_generated_text(
                &application_state.artificial_intelligence_adapter,
                generated_text,
            )
            .await?;
            build_comparison_table(&extractions, &generated_data_points)
        }
        None => Vec::new(),
    };

    Ok(Json(assemble_qc_response(
        &extractions,
        &diffs,
        &comparison_table,
    )?))
}

/// Read the required `corpusId` from the body. Mirrors the reference `if
/// (!corpusId)` guard: a missing, non-string, or empty-string value is a 400;
/// the value is used verbatim (no trimming) as the lookup key.
fn extract_required_corpus_identifier(submitted_body: &Value) -> Result<String, HttpError> {
    match submitted_body.get("corpusId").and_then(Value::as_str) {
        Some(corpus_identifier) if !corpus_identifier.is_empty() => {
            Ok(corpus_identifier.to_string())
        }
        _ => Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from("Missing corpusId"),
        }),
    }
}

/// Read the optional `generatedText`. Mirrors the reference `generatedText &&
/// typeof generatedText === 'string'` truthiness gate: an empty string is
/// treated as absent, a whitespace-only string is retained (the downstream
/// helper then short-circuits it to no data points).
fn extract_optional_generated_text(submitted_body: &Value) -> Option<String> {
    submitted_body
        .get("generatedText")
        .and_then(Value::as_str)
        .filter(|generated_text| !generated_text.is_empty())
        .map(str::to_string)
}

/// Resolve the File Search store resource name to query against. Mirrors the
/// reference passing `corpus.corpusId` to `queryFileSearchStore`; falls back to
/// the corpus document identifier when the store name is absent.
fn resolve_file_search_store_name(
    corpus_document: &StoredDocument,
    corpus_identifier: &str,
) -> String {
    corpus_document
        .document_body
        .get("corpusId")
        .and_then(Value::as_str)
        .filter(|store_name| !store_name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| corpus_identifier.to_string())
}

/// Read the corpus `files` array (each entry a `{ name, status, ... }` object).
fn read_corpus_files(corpus_document: &StoredDocument) -> Vec<Value> {
    corpus_document
        .document_body
        .get("files")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// Port of `getBasePdfNames`: the deduplicated (first-seen order) set of base
/// document names among `status === "indexed"` files, stripping any trailing
/// `_pages_<n>-<m>` chunk suffix.
fn base_pdf_names(files: &[Value]) -> Vec<String> {
    let mut base_names: Vec<String> = Vec::new();
    for file in files {
        let status = file
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if status != "indexed" {
            continue;
        }
        let name = file.get("name").and_then(Value::as_str).unwrap_or_default();
        let base = strip_pages_suffix(name);
        if !base_names.contains(&base) {
            base_names.push(base);
        }
    }
    base_names
}

/// Strip a trailing `_pages_<digits>-<digits>` suffix (port of the
/// `/_pages_\d+-\d+$/` replacement, without the `regex` crate).
fn strip_pages_suffix(name: &str) -> String {
    const MARKER: &str = "_pages_";
    if let Some(marker_position) = name.rfind(MARKER) {
        let tail = &name[marker_position + MARKER.len()..];
        if is_pages_range(tail) {
            return name[..marker_position].to_string();
        }
    }
    name.to_string()
}

/// Whether `tail` matches `^\d+-\d+$` (ASCII digits, a single hyphen).
fn is_pages_range(tail: &str) -> bool {
    let mut parts = tail.split('-');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(first), Some(second), None) => {
            !first.is_empty()
                && !second.is_empty()
                && first.bytes().all(|byte| byte.is_ascii_digit())
                && second.bytes().all(|byte| byte.is_ascii_digit())
        }
        _ => false,
    }
}

/// Per-source grounded extraction: retrieve evidence for the extraction prompt
/// over the File Search store, then run the extraction generation and parse the
/// data points. Equivalent to the reference `queryFileSearchStore` grounded
/// call followed by `parseDataPointsFromResponse`.
async fn extract_data_points_for_source(
    retrieval_adapter: &Arc<dyn RetrievalPort>,
    artificial_intelligence_adapter: &Arc<dyn ArtificialIntelligencePort>,
    file_search_store_name: &str,
    pdf_name: &str,
) -> Result<ExtractionResult, HttpError> {
    let extraction_prompt = build_extraction_prompt(pdf_name);

    let store_names = vec![file_search_store_name.to_string()];
    let query_messages = vec![RetrievalQueryMessage {
        role: String::from("user"),
        text: extraction_prompt.clone(),
    }];
    let retrieval_result = retrieval_adapter
        .retrieve(&store_names, &query_messages, None, None)
        .await?;

    let grounded_prompt =
        assemble_extraction_prompt_with_evidence(&extraction_prompt, &retrieval_result.passages);

    let mut generation_request =
        GenerationRequest::with_reference_sampling_defaults(
            QC_EXTRACTION_MODEL.to_string(),
            grounded_prompt,
        );
    generation_request.system = Some(EXTRACTION_SYSTEM.to_string());

    let generation_outcome = artificial_intelligence_adapter
        .generate(&generation_request)
        .await?;

    let data_points = parse_data_points_from_response(&generation_outcome.text);

    Ok(ExtractionResult {
        pdf_name: pdf_name.to_string(),
        data_points,
        raw: Some(generation_outcome.text),
    })
}

/// Append retrieved evidence to the extraction prompt so the model has the
/// source content to extract from (the split-seam equivalent of File Search
/// grounding). Provider order is preserved verbatim.
fn assemble_extraction_prompt_with_evidence(
    extraction_prompt: &str,
    passages: &[RetrievedEvidence],
) -> String {
    if passages.is_empty() {
        return extraction_prompt.to_string();
    }

    let mut prompt = String::from(extraction_prompt);
    prompt.push_str("\n\n### Retrieved source excerpts\n");
    for passage in passages {
        let source_label = passage
            .title
            .clone()
            .or_else(|| passage.file_name.clone())
            .or_else(|| passage.uri.clone())
            .unwrap_or_else(|| format!("source-{}", passage.index));
        let passage_text = passage.text.clone().unwrap_or_default();
        prompt.push_str(&format!(
            "[{}] (source: {}) {}\n",
            passage.index, source_label, passage_text
        ));
    }
    prompt
}

/// Port of `extractFromGeneratedText`. Its own single-part helper: a lighter
/// generation config (temperature / topP / topK only) distinct from the shared
/// per-source path. Under the equivalent-behaviour bar it routes through the
/// same AI port; the outcome text (joined non-thought parts) equals `parts[0]`
/// for the single-part responses this prompt elicits.
async fn extract_data_points_from_generated_text(
    artificial_intelligence_adapter: &Arc<dyn ArtificialIntelligencePort>,
    generated_text: &str,
) -> Result<Vec<DataPoint>, HttpError> {
    if generated_text.trim().is_empty() {
        return Ok(Vec::new());
    }

    // Reference: `text.slice(0, 50000)`.
    let truncated_text: String = generated_text.chars().take(50_000).collect();
    let prompt = build_generated_text_extraction_prompt(&truncated_text);

    let generation_request = GenerationRequest {
        model: QC_EXTRACTION_MODEL.to_string(),
        system: None,
        prompt,
        response_json_schema: None,
        temperature: Some(0.1),
        top_p: Some(0.95),
        top_k: Some(20),
        candidate_count: None,
        presence_penalty: None,
        frequency_penalty: None,
        max_output_tokens: None,
        thinking: None,
        inputs: None,
    };

    let generation_outcome = artificial_intelligence_adapter
        .generate(&generation_request)
        .await?;

    Ok(parse_data_points_from_response(&generation_outcome.text))
}

/// Verbatim `buildExtractionPrompt(pdfName)`.
fn build_extraction_prompt(pdf_name: &str) -> String {
    format!(
        "Extract ALL data points and measurable parameters from the document/file named \"{pdf_name}\" (or any chunk of it, e.g. \"{pdf_name}_pages_1-300\").

Return a JSON object with this exact structure:
{{
  \"dataPoints\": [
    {{ \"parameter\": \"variable name\", \"value\": \"value exactly as printed\", \"unit\": \"unit if any\", \"source\": \"brief source/context\" }}
  ]
}}

Extract every numeric value, statistic, measurement, and parameter you find. Preserve precision."
    )
}

/// Verbatim `extractFromGeneratedText` prompt (with the text already truncated).
fn build_generated_text_extraction_prompt(text: &str) -> String {
    format!(
        "Extract ALL data points, numeric values, and measurable parameters from the following generated text.

Return a JSON object with this exact structure:
{{
  \"dataPoints\": [
    {{ \"parameter\": \"variable name\", \"value\": \"value exactly as printed\", \"unit\": \"unit if any\" }}
  ]
}}

Text:
{text}

Output valid JSON only."
    )
}

/// Port of `parseDataPointsFromResponse`: attempt to parse the JSON object
/// carrying `dataPoints`, falling back to `key: value` line parsing on error.
fn parse_data_points_from_response(text: &str) -> Vec<DataPoint> {
    let json_candidate = data_points_json_candidate(text);

    match serde_json::from_str::<Value>(json_candidate) {
        Ok(parsed) => {
            let mut data_points = Vec::new();
            if let Some(points) = parsed.get("dataPoints").and_then(Value::as_array) {
                for point in points {
                    // JS `p?.parameter != null && p?.value != null`: both present
                    // and non-null (0, false, "" all pass).
                    let (Some(parameter), Some(value)) =
                        (non_null_field(point, "parameter"), non_null_field(point, "value"))
                    else {
                        continue;
                    };
                    data_points.push(DataPoint {
                        parameter: json_scalar_to_js_string(parameter).trim().to_string(),
                        value: json_scalar_to_js_string(value).trim().to_string(),
                        unit: non_null_field(point, "unit")
                            .map(|unit| json_scalar_to_js_string(unit).trim().to_string()),
                        source: non_null_field(point, "source")
                            .map(|source| json_scalar_to_js_string(source).trim().to_string()),
                    });
                }
            }
            data_points
        }
        Err(_) => parse_data_points_from_lines(text),
    }
}

/// Mirror `/\{[\s\S]*"dataPoints"[\s\S]*\}/`: the span from the first `{` to the
/// last `}` when it contains `"dataPoints"`, else the whole text.
fn data_points_json_candidate(text: &str) -> &str {
    if let (Some(start), Some(end)) = (text.find('{'), text.rfind('}')) {
        if start < end {
            let slice = &text[start..=end];
            if slice.contains("\"dataPoints\"") {
                return slice;
            }
        }
    }
    text
}

/// Line-parse fallback: `([^:]+):\s*(.+)` per line, skipping blank / `dataPoint`
/// keys. No `regex` crate — the first colon splits key from value.
fn parse_data_points_from_lines(text: &str) -> Vec<DataPoint> {
    let mut data_points = Vec::new();
    for line in text.split('\n') {
        let Some(colon_position) = line.find(':') else {
            continue;
        };
        let parameter = line[..colon_position].trim();
        let value = line[colon_position + 1..].trim();
        if !parameter.is_empty()
            && !value.is_empty()
            && !parameter.to_lowercase().contains("datapoint")
        {
            data_points.push(DataPoint {
                parameter: parameter.to_string(),
                value: value.to_string(),
                unit: None,
                source: None,
            });
        }
    }
    data_points
}

/// A field value present and non-null (JS `!= null`).
fn non_null_field<'value>(object: &'value Value, key: &str) -> Option<&'value Value> {
    match object.get(key) {
        Some(field_value) if !field_value.is_null() => Some(field_value),
        _ => None,
    }
}

/// Mirror JS `String(x)` for a JSON scalar. Numbers follow JS number-to-string
/// (`5.0` -> `"5"`, `5.5` -> `"5.5"`); Rust's shortest-round-trip float Display
/// matches for the common decimal cases.
fn json_scalar_to_js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => {
            if let Some(signed) = number.as_i64() {
                signed.to_string()
            } else if let Some(unsigned) = number.as_u64() {
                unsigned.to_string()
            } else if let Some(floating) = number.as_f64() {
                format!("{floating}")
            } else {
                number.to_string()
            }
        }
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Port of `findParameterDiffs`: parameters whose value disagrees across two or
/// more documents. Does not sort; preserves first-seen parameter order.
fn find_parameter_diffs(extractions: &[ExtractionResult]) -> Vec<ParameterDiff> {
    // Insertion-ordered `key -> [(pdfName, value)]`, reproducing the JS `Map` /
    // object semantics without `indexmap`.
    let mut by_param: Vec<(String, Vec<(String, String)>)> = Vec::new();

    for extraction in extractions {
        for data_point in &extraction.data_points {
            let key = normalize_parameter_key(&data_point.parameter);
            let value = combined_value(data_point);

            let index = match by_param.iter().position(|(existing_key, _)| *existing_key == key) {
                Some(index) => index,
                None => {
                    by_param.push((key, Vec::new()));
                    by_param.len() - 1
                }
            };
            let values_for_param = &mut by_param[index].1;

            // JS: `if (!(pdf in prev) || prev[pdf] !== val) prev[pdf] = val`
            // (last-writer-wins per pdf).
            match values_for_param
                .iter_mut()
                .find(|(pdf, _)| *pdf == extraction.pdf_name)
            {
                Some((_, existing_value)) => {
                    if *existing_value != value {
                        *existing_value = value;
                    }
                }
                None => values_for_param.push((extraction.pdf_name.clone(), value)),
            }
        }
    }

    let mut diffs = Vec::new();
    for (param_key, values_for_param) in &by_param {
        if values_for_param.len() < 2 {
            continue;
        }
        let distinct_values: std::collections::HashSet<&String> =
            values_for_param.iter().map(|(_, value)| value).collect();
        if distinct_values.len() <= 1 {
            continue;
        }

        let first_param = original_cased_parameter(extractions, &[], param_key);
        let mut values_object = Map::new();
        let mut pdfs = Vec::new();
        for (pdf, value) in values_for_param {
            values_object.insert(pdf.clone(), Value::String(value.clone()));
            pdfs.push(pdf.clone());
        }

        diffs.push(ParameterDiff {
            parameter: first_param,
            values_by_pdf: Value::Object(values_object),
            pdfs,
        });
    }
    diffs
}

/// Port of `buildComparisonTable`: corpus (first-writer-wins) vs generated
/// (last-writer-wins) values per parameter, sorted by the original-cased
/// parameter via a `localeCompare`-equivalent stable sort.
fn build_comparison_table(
    extractions: &[ExtractionResult],
    generated_data_points: &[DataPoint],
) -> Vec<ComparisonRow> {
    // corpusByParam: FIRST writer wins.
    let mut corpus_by_param: Vec<(String, (String, String))> = Vec::new();
    for extraction in extractions {
        for data_point in &extraction.data_points {
            let key = normalize_parameter_key(&data_point.parameter);
            let value = combined_value(data_point);
            if !corpus_by_param.iter().any(|(existing_key, _)| *existing_key == key) {
                corpus_by_param.push((key, (value, extraction.pdf_name.clone())));
            }
        }
    }

    // generatedByParam: last writer wins.
    let mut generated_by_param: Vec<(String, String)> = Vec::new();
    for data_point in generated_data_points {
        let key = normalize_parameter_key(&data_point.parameter);
        let value = combined_value(data_point);
        match generated_by_param
            .iter_mut()
            .find(|(existing_key, _)| *existing_key == key)
        {
            Some((_, existing_value)) => *existing_value = value,
            None => generated_by_param.push((key, value)),
        }
    }

    // allParams: union preserving first-seen order (corpus keys, then new
    // generated keys).
    let mut all_params: Vec<String> = Vec::new();
    for (key, _) in &corpus_by_param {
        if !all_params.contains(key) {
            all_params.push(key.clone());
        }
    }
    for (key, _) in &generated_by_param {
        if !all_params.contains(key) {
            all_params.push(key.clone());
        }
    }

    let mut rows: Vec<ComparisonRow> = Vec::new();
    for key in &all_params {
        let first_param = original_cased_parameter(extractions, generated_data_points, key);
        let corpus_entry = corpus_by_param
            .iter()
            .find(|(existing_key, _)| existing_key == key)
            .map(|(_, entry)| entry);
        let corpus_value = corpus_entry
            .map(|(value, _)| value.clone())
            .unwrap_or_else(|| EM_DASH.to_string());
        let corpus_source_pdf = corpus_entry
            .map(|(_, source_pdf)| source_pdf.clone())
            .unwrap_or_default();
        let generated_value = generated_by_param
            .iter()
            .find(|(existing_key, _)| existing_key == key)
            .map(|(_, value)| value.clone())
            .unwrap_or_else(|| EM_DASH.to_string());
        let matches = corpus_value == generated_value;

        rows.push(ComparisonRow {
            parameter: first_param,
            corpus_value,
            corpus_source_pdf,
            generated_value,
            matches,
        });
    }

    // Stable sort keeps insertion order on ties (JS `Array.prototype.sort` is
    // stable), matching `sort((a, b) => a.parameter.localeCompare(b.parameter))`.
    rows.sort_by(|left, right| locale_compare(&left.parameter, &right.parameter));
    rows
}

/// The combined display value for a data point: `"<value> <unit>"` trimmed when
/// a non-empty unit is present, else the bare value (JS `dp.unit ? … : dp.value`).
fn combined_value(data_point: &DataPoint) -> String {
    match &data_point.unit {
        Some(unit) if !unit.is_empty() => {
            format!("{} {}", data_point.value, unit).trim().to_string()
        }
        _ => data_point.value.clone(),
    }
}

/// Canonical parameter key: `toLowerCase().trim().replace(/\s+/g, ' ')`.
fn normalize_parameter_key(parameter: &str) -> String {
    parameter
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// The original-cased parameter for a normalized key — searching corpus data
/// points first, then generated — falling back to the key itself.
fn original_cased_parameter(
    extractions: &[ExtractionResult],
    generated_data_points: &[DataPoint],
    key: &str,
) -> String {
    for extraction in extractions {
        for data_point in &extraction.data_points {
            if normalize_parameter_key(&data_point.parameter) == key {
                return data_point.parameter.clone();
            }
        }
    }
    for data_point in generated_data_points {
        if normalize_parameter_key(&data_point.parameter) == key {
            return data_point.parameter.clone();
        }
    }
    key.to_string()
}

/// A `localeCompare`-equivalent ordering implemented with std (no `icu_collator`
/// in this crate). Case-insensitive primary ordering (so "apple" sorts before
/// "Banana", unlike a byte sort), with a deterministic case tiebreak. ICU/CLDR
/// pinning and Node golden vectors are explicitly out of scope under the
/// equivalent-behaviour bar.
fn locale_compare(left: &str, right: &str) -> Ordering {
    left.to_lowercase()
        .cmp(&right.to_lowercase())
        .then_with(|| left.cmp(right))
}

/// Serialize the success payload `{ extractions, diffs, comparisonTable }`.
fn assemble_qc_response(
    extractions: &[ExtractionResult],
    diffs: &[ParameterDiff],
    comparison_table: &[ComparisonRow],
) -> Result<Value, HttpError> {
    let extractions_json = serde_json::to_value(extractions).map_err(serialization_failure)?;
    let diffs_json = serde_json::to_value(diffs).map_err(serialization_failure)?;
    let comparison_table_json =
        serde_json::to_value(comparison_table).map_err(serialization_failure)?;

    Ok(json!({
        "extractions": extractions_json,
        "diffs": diffs_json,
        "comparisonTable": comparison_table_json,
    }))
}

fn serialization_failure(error: serde_json::Error) -> HttpError {
    HttpError::UpstreamApplicationFailure {
        explanation: format!("failed to serialize the QC response: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data_point(parameter: &str, value: &str, unit: Option<&str>) -> DataPoint {
        DataPoint {
            parameter: parameter.to_string(),
            value: value.to_string(),
            unit: unit.map(str::to_string),
            source: None,
        }
    }

    fn extraction(pdf_name: &str, data_points: Vec<DataPoint>) -> ExtractionResult {
        ExtractionResult {
            pdf_name: pdf_name.to_string(),
            data_points,
            raw: None,
        }
    }

    // --- request parsing -------------------------------------------------

    #[test]
    fn corpus_identifier_required_and_verbatim() {
        assert_eq!(
            extract_required_corpus_identifier(&json!({ "corpusId": "abc" })).unwrap(),
            "abc"
        );
        // Not trimmed (matches the reference `if (!corpusId)` truthiness gate).
        assert_eq!(
            extract_required_corpus_identifier(&json!({ "corpusId": "  x " })).unwrap(),
            "  x "
        );
        assert!(extract_required_corpus_identifier(&json!({ "corpusId": "" })).is_err());
        assert!(extract_required_corpus_identifier(&json!({})).is_err());
    }

    #[test]
    fn generated_text_empty_is_absent_whitespace_retained() {
        assert_eq!(
            extract_optional_generated_text(&json!({ "generatedText": "draft" })),
            Some("draft".to_string())
        );
        assert_eq!(extract_optional_generated_text(&json!({ "generatedText": "" })), None);
        assert_eq!(
            extract_optional_generated_text(&json!({ "generatedText": "  " })),
            Some("  ".to_string())
        );
        assert_eq!(extract_optional_generated_text(&json!({})), None);
    }

    // --- corpus reading --------------------------------------------------

    #[test]
    fn resolve_store_name_prefers_corpus_id_field() {
        let document = StoredDocument {
            document_identifier: "corpus-1".to_string(),
            owning_account: None,
            document_body: json!({ "corpusId": "fileSearchStores/folder-x" }),
        };
        assert_eq!(
            resolve_file_search_store_name(&document, "corpus-1"),
            "fileSearchStores/folder-x"
        );
    }

    #[test]
    fn resolve_store_name_falls_back_to_identifier() {
        let document = StoredDocument {
            document_identifier: "corpus-1".to_string(),
            owning_account: None,
            document_body: json!({}),
        };
        assert_eq!(resolve_file_search_store_name(&document, "corpus-1"), "corpus-1");
    }

    #[test]
    fn base_pdf_names_strips_chunk_suffix_dedupes_and_skips_unindexed() {
        let files = vec![
            json!({ "name": "studyA_pages_1-300", "status": "indexed" }),
            json!({ "name": "studyA_pages_301-600", "status": "indexed" }),
            json!({ "name": "studyB", "status": "indexed" }),
            json!({ "name": "studyC", "status": "pending" }),
        ];
        assert_eq!(
            base_pdf_names(&files),
            vec!["studyA".to_string(), "studyB".to_string()]
        );
    }

    #[test]
    fn strip_pages_suffix_only_at_end_and_valid_range() {
        assert_eq!(strip_pages_suffix("doc_pages_1-300"), "doc");
        assert_eq!(strip_pages_suffix("doc_pages_12-3"), "doc");
        // Not a valid \d+-\d+ tail -> unchanged.
        assert_eq!(strip_pages_suffix("doc_pages_1-2-3"), "doc_pages_1-2-3");
        assert_eq!(strip_pages_suffix("doc_pages_abc"), "doc_pages_abc");
        assert_eq!(strip_pages_suffix("plain_name"), "plain_name");
        // Marker present but tail empty -> unchanged.
        assert_eq!(strip_pages_suffix("doc_pages_"), "doc_pages_");
    }

    #[test]
    fn is_pages_range_matches_digit_hyphen_digit() {
        assert!(is_pages_range("1-300"));
        assert!(is_pages_range("0-0"));
        assert!(!is_pages_range("1-"));
        assert!(!is_pages_range("-3"));
        assert!(!is_pages_range("1-2-3"));
        assert!(!is_pages_range("a-b"));
        assert!(!is_pages_range(""));
    }

    // --- parse_data_points_from_response --------------------------------

    #[test]
    fn parse_data_points_from_clean_json() {
        let text = r#"{ "dataPoints": [
            { "parameter": "Cmax", "value": "12.5", "unit": "ng/mL", "source": "Table 1" },
            { "parameter": "Tmax", "value": "2" }
        ] }"#;
        let points = parse_data_points_from_response(text);
        assert_eq!(points.len(), 2);
        assert_eq!(points[0].parameter, "Cmax");
        assert_eq!(points[0].value, "12.5");
        assert_eq!(points[0].unit.as_deref(), Some("ng/mL"));
        assert_eq!(points[0].source.as_deref(), Some("Table 1"));
        assert_eq!(points[1].parameter, "Tmax");
        assert_eq!(points[1].unit, None);
    }

    #[test]
    fn parse_data_points_from_markdown_wrapped_json() {
        let text = "Here you go:\n```json\n{ \"dataPoints\": [ { \"parameter\": \"n\", \"value\": \"42\" } ] }\n```\nDone.";
        let points = parse_data_points_from_response(text);
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].parameter, "n");
        assert_eq!(points[0].value, "42");
    }

    #[test]
    fn parse_data_points_stringifies_numbers_like_js() {
        // 5.0 -> "5", 5.5 -> "5.5" (JS String(number)); trims strings.
        let text = r#"{ "dataPoints": [
            { "parameter": "dose", "value": 5.0, "unit": "mg" },
            { "parameter": "ratio", "value": 5.5 },
            { "parameter": "  weight ", "value": "  70 " }
        ] }"#;
        let points = parse_data_points_from_response(text);
        assert_eq!(points[0].value, "5");
        assert_eq!(points[1].value, "5.5");
        assert_eq!(points[2].parameter, "weight");
        assert_eq!(points[2].value, "70");
    }

    #[test]
    fn parse_data_points_skips_null_parameter_or_value() {
        let text = r#"{ "dataPoints": [
            { "parameter": null, "value": "1" },
            { "value": "2" },
            { "parameter": "ok", "value": "3" }
        ] }"#;
        let points = parse_data_points_from_response(text);
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].parameter, "ok");
    }

    #[test]
    fn parse_data_points_empty_when_parsed_without_data_points() {
        // Valid JSON, no dataPoints -> [] (no line-parse fallback).
        let points = parse_data_points_from_response(r#"{ "other": 1 }"#);
        assert!(points.is_empty());
    }

    #[test]
    fn parse_data_points_line_fallback_on_invalid_json() {
        let text = "Cmax: 12.5 ng/mL\nTmax: 2 h\ndataPoint: ignored\n: novalue\nnokey\n";
        let points = parse_data_points_from_response(text);
        assert_eq!(points.len(), 2);
        assert_eq!(points[0].parameter, "Cmax");
        assert_eq!(points[0].value, "12.5 ng/mL");
        assert_eq!(points[1].parameter, "Tmax");
        assert_eq!(points[1].value, "2 h");
    }

    #[test]
    fn data_points_json_candidate_extracts_span() {
        assert_eq!(
            data_points_json_candidate("noise {\"dataPoints\":[]} trailing"),
            "{\"dataPoints\":[]}"
        );
        // No dataPoints marker -> whole text.
        assert_eq!(data_points_json_candidate("{\"x\":1}"), "{\"x\":1}");
        assert_eq!(data_points_json_candidate("no braces here"), "no braces here");
    }

    #[test]
    fn json_scalar_stringification() {
        assert_eq!(json_scalar_to_js_string(&json!("text")), "text");
        assert_eq!(json_scalar_to_js_string(&json!(42)), "42");
        assert_eq!(json_scalar_to_js_string(&json!(5.0)), "5");
        assert_eq!(json_scalar_to_js_string(&json!(5.5)), "5.5");
        assert_eq!(json_scalar_to_js_string(&json!(true)), "true");
    }

    // --- normalization / combined value ---------------------------------

    #[test]
    fn normalize_key_lowercases_trims_collapses_whitespace() {
        assert_eq!(normalize_parameter_key("  Blood   Pressure "), "blood pressure");
        assert_eq!(normalize_parameter_key("HALF-life"), "half-life");
    }

    #[test]
    fn combined_value_appends_unit_when_present() {
        assert_eq!(combined_value(&data_point("p", "5", Some("mg"))), "5 mg");
        assert_eq!(combined_value(&data_point("p", "5", Some(""))), "5");
        assert_eq!(combined_value(&data_point("p", "5", None)), "5");
    }

    // --- find_parameter_diffs -------------------------------------------

    #[test]
    fn find_diffs_reports_disagreements_only() {
        let extractions = vec![
            extraction(
                "A.pdf",
                vec![data_point("Dose", "5", Some("mg")), data_point("pH", "7", None)],
            ),
            extraction(
                "B.pdf",
                vec![data_point("dose", "10", Some("mg")), data_point("pH", "7", None)],
            ),
        ];
        let diffs = find_parameter_diffs(&extractions);
        assert_eq!(diffs.len(), 1);
        // Original-cased first-seen parameter.
        assert_eq!(diffs[0].parameter, "Dose");
        assert_eq!(diffs[0].pdfs, vec!["A.pdf".to_string(), "B.pdf".to_string()]);
        assert_eq!(diffs[0].values_by_pdf.get("A.pdf").unwrap(), "5 mg");
        assert_eq!(diffs[0].values_by_pdf.get("B.pdf").unwrap(), "10 mg");
    }

    #[test]
    fn find_diffs_skips_single_document_parameters() {
        let extractions = vec![extraction(
            "A.pdf",
            vec![data_point("Only", "1", None), data_point("Only", "2", None)],
        )];
        // Same pdf -> last-writer-wins -> one pdf -> no diff.
        assert!(find_parameter_diffs(&extractions).is_empty());
    }

    #[test]
    fn find_diffs_empty_when_values_agree() {
        let extractions = vec![
            extraction("A.pdf", vec![data_point("x", "1", None)]),
            extraction("B.pdf", vec![data_point("x", "1", None)]),
        ];
        assert!(find_parameter_diffs(&extractions).is_empty());
    }

    // --- build_comparison_table -----------------------------------------

    #[test]
    fn comparison_table_matches_and_mismatches() {
        let extractions = vec![extraction(
            "A.pdf",
            vec![data_point("Cmax", "12.5", Some("ng/mL")), data_point("Tmax", "2", None)],
        )];
        let generated = vec![
            data_point("cmax", "12.5", Some("ng/mL")),
            data_point("AUC", "100", None),
        ];
        let table = build_comparison_table(&extractions, &generated);
        // Sorted by parameter (localeCompare-equivalent): AUC, Cmax, Tmax.
        assert_eq!(table.len(), 3);
        assert_eq!(table[0].parameter, "AUC");
        assert_eq!(table[0].corpus_value, EM_DASH);
        assert_eq!(table[0].generated_value, "100");
        assert!(!table[0].matches);

        assert_eq!(table[1].parameter, "Cmax");
        assert_eq!(table[1].corpus_value, "12.5 ng/mL");
        assert_eq!(table[1].corpus_source_pdf, "A.pdf");
        assert_eq!(table[1].generated_value, "12.5 ng/mL");
        assert!(table[1].matches);

        assert_eq!(table[2].parameter, "Tmax");
        assert_eq!(table[2].generated_value, EM_DASH);
        assert!(!table[2].matches);
    }

    #[test]
    fn comparison_table_first_writer_wins_for_corpus() {
        let extractions = vec![
            extraction("A.pdf", vec![data_point("x", "first", None)]),
            extraction("B.pdf", vec![data_point("x", "second", None)]),
        ];
        let table = build_comparison_table(&extractions, &[]);
        assert_eq!(table.len(), 1);
        assert_eq!(table[0].corpus_value, "first");
        assert_eq!(table[0].corpus_source_pdf, "A.pdf");
    }

    #[test]
    fn comparison_table_sort_is_case_insensitive() {
        let extractions = vec![extraction(
            "A.pdf",
            vec![
                data_point("banana", "1", None),
                data_point("Apple", "2", None),
            ],
        )];
        let table = build_comparison_table(&extractions, &[]);
        // Case-insensitive: Apple before banana (a byte sort would invert this).
        assert_eq!(table[0].parameter, "Apple");
        assert_eq!(table[1].parameter, "banana");
    }

    #[test]
    fn locale_compare_orders_case_insensitively() {
        assert_eq!(locale_compare("apple", "Banana"), Ordering::Less);
        assert_eq!(locale_compare("Zebra", "apple"), Ordering::Greater);
        assert_eq!(locale_compare("same", "same"), Ordering::Equal);
    }

    // --- prompts ---------------------------------------------------------

    #[test]
    fn extraction_prompt_names_the_document() {
        let prompt = build_extraction_prompt("studyA");
        assert!(prompt.contains("named \"studyA\""));
        assert!(prompt.contains("\"studyA_pages_1-300\""));
        assert!(prompt.contains("\"dataPoints\""));
    }

    #[test]
    fn generated_text_prompt_embeds_text() {
        let prompt = build_generated_text_extraction_prompt("some draft");
        assert!(prompt.contains("some draft"));
        assert!(prompt.contains("Output valid JSON only."));
    }

    // --- evidence assembly ----------------------------------------------

    #[test]
    fn evidence_assembly_preserves_order_and_labels() {
        let passages = vec![
            RetrievedEvidence {
                index: 1,
                title: Some("Doc A".to_string()),
                file_name: None,
                uri: None,
                page: None,
                text: Some("alpha".to_string()),
            },
            RetrievedEvidence {
                index: 2,
                title: None,
                file_name: Some("b.pdf".to_string()),
                uri: None,
                page: None,
                text: Some("beta".to_string()),
            },
        ];
        let prompt = assemble_extraction_prompt_with_evidence("BASE", &passages);
        let doc_a = prompt.find("Doc A").unwrap();
        let doc_b = prompt.find("b.pdf").unwrap();
        assert!(doc_a < doc_b);
        assert!(prompt.contains("[1] (source: Doc A) alpha"));
        assert!(prompt.contains("[2] (source: b.pdf) beta"));
    }

    #[test]
    fn evidence_assembly_returns_prompt_unchanged_without_passages() {
        assert_eq!(assemble_extraction_prompt_with_evidence("BASE", &[]), "BASE");
    }

    // --- response assembly ----------------------------------------------

    #[test]
    fn qc_response_shape() {
        let extractions = vec![extraction("A.pdf", vec![data_point("x", "1", None)])];
        let response = assemble_qc_response(&extractions, &[], &[]).unwrap();
        assert!(response.get("extractions").unwrap().is_array());
        assert!(response.get("diffs").unwrap().is_array());
        assert!(response.get("comparisonTable").unwrap().is_array());
        let first = &response.get("extractions").unwrap()[0];
        assert_eq!(first.get("pdfName").unwrap(), "A.pdf");
        assert_eq!(first.get("dataPoints").unwrap()[0].get("parameter").unwrap(), "x");
    }

    #[test]
    fn comparison_row_serializes_match_key() {
        let row = ComparisonRow {
            parameter: "p".to_string(),
            corpus_value: "1".to_string(),
            corpus_source_pdf: "A.pdf".to_string(),
            generated_value: "1".to_string(),
            matches: true,
        };
        let value = serde_json::to_value(&row).unwrap();
        assert_eq!(value.get("match").unwrap(), &json!(true));
        assert_eq!(value.get("corpusSourcePdf").unwrap(), "A.pdf");
        assert!(value.get("matches").is_none());
    }
}
