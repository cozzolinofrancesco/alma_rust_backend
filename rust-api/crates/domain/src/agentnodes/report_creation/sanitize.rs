//! Synthesis-layer corpus sanitization for the 272 report-creation compiler.
//!
//! Ported 1:1 (equivalent-behavior parity) from
//! `frontend_v3/app/lib/reportCreation/synthesisCorpus.ts`. A CTD 2.7.2 report
//! interleaves *study* layers (which are grounded on a clinical corpus) with
//! *synthesis* layers — Section 1 (Summary of Biopharmaceutic Studies …) and
//! Section 3 (Comparison and Analyses …) — which must **not** be corpus-bound:
//! they synthesize the already-generated study/meta outputs, so any clinical
//! corpus binding left on them would let raw source documents leak back into the
//! synthesis prompt. This module detects synthesis layers and strips that binding.
//!
//! ## What this unit exports
//!
//! * Section detectors — [`is_section1_report_layer`], [`is_section3_report_layer`],
//!   [`is_synthesis_report_layer`] — each matching by **tag**, then **name**
//!   prefix, then **id** pattern (in that short-circuit order).
//! * [`strip_synthesis_clinical_corpus_binding`] — the per-layer mutation that
//!   removes `corpusId`, prunes clinical entries from `ragKnowledge`, and clears
//!   `documentSelections` when appropriate, reporting whether anything changed.
//! * [`strip_section3_clinical_corpus_binding`] — the reference's back-compat alias
//!   for the function above.
//! * [`sanitize_report_creation_layers`] — the batch pass the compiler runs over
//!   the assembled layer list.
//! * The public tag constants [`SECTION_1_LAYER_TAG`] / [`SECTION_3_LAYER_TAG`].
//!
//! ## Layer shape
//!
//! The reference operates on `Canvas272Layer` via a `Record<string, unknown>`
//! cast. The Rust engine's analogue is [`ExecutionLayer`] (S1 `dto`), where the
//! keys this module reads — `tag`, `name`, `id`, `corpusId`, `documentSelections`
//! — are **typed fields** and `ragKnowledge` is kept opaque as a
//! [`serde_json::Value`]. Because serde routes any matching key to its named field
//! (never the passthrough bag), reading the typed fields is exactly equivalent to
//! the reference's dynamic property access.
//!
//! ## Parity notes (load-bearing)
//!
//! * The reference's five regexes are reimplemented with plain ASCII predicates,
//!   matching how the sibling [`super::layer_refs`] ports its regexes (the domain
//!   crate carries no `regex` dependency):
//!   * `/^sec1-layer-\d+$/` / `/^sec3-layer-\d+$/` — a fixed prefix followed by one
//!     or more ASCII digits, anchored at both ends ([`is_sec_layer_id`]).
//!   * `/^\[SECTION 1\]/i` / `/^\[SECTION 3\]/i` — a case-insensitive **prefix**
//!     match (no end anchor) on the trimmed name ([`name_has_section_prefix`]).
//!   * `/^(filesearch-|fileSearchStores\/)/` — a corpus-id prefix test
//!     ([`is_corpus_id`]).
//! * The `tag` comparison is exact and **un-trimmed** (`tag === 'Section 1'`),
//!   whereas `name` and `id` are `.trim()`-ed before matching — reproduced here.
//! * `readRagKnowledge` keeps JS `typeof x === 'object' && x !== null` semantics,
//!   which include arrays and exclude `null`/scalars — mirrored by
//!   [`is_rag_object`] accepting `Value::Object`/`Value::Array` only. Reading a
//!   missing/array `id` yields `""`, exactly like `x?.id` in JS.
//! * The single-entry special case (one surviving rag entry with a non-empty
//!   string id is always dropped) and the `needsDocClear` gate (only clear
//!   `documentSelections` when a corpus id was stripped or the rag list changed)
//!   are ported verbatim.

use serde_json::Value;

use crate::agentnodes::dto::ExecutionLayer;

/// The canonical tag marking a Section 1 synthesis layer.
pub const SECTION_1_LAYER_TAG: &str = "Section 1";
/// The canonical tag marking a Section 3 synthesis layer.
pub const SECTION_3_LAYER_TAG: &str = "Section 3";

/// The `id` prefix of a Section 1 synthesis layer (`sec1-layer-{n}`).
const SECTION_1_LAYER_ID_PREFIX: &str = "sec1-layer-";
/// The `id` prefix of a Section 3 synthesis layer (`sec3-layer-{n}`).
const SECTION_3_LAYER_ID_PREFIX: &str = "sec3-layer-";

/// The lowercased `name` prefix of a Section 1 layer (`/^\[SECTION 1\]/i`).
const SECTION_1_NAME_PREFIX_LOWER: &str = "[section 1]";
/// The lowercased `name` prefix of a Section 3 layer (`/^\[SECTION 3\]/i`).
const SECTION_3_NAME_PREFIX_LOWER: &str = "[section 3]";

/// Whether a rag-knowledge id denotes a File Search corpus binding.
///
/// Mirrors `CORPUS_ID_PATTERN = /^(filesearch-|fileSearchStores\/)/`.
#[inline]
fn is_corpus_id(id: &str) -> bool {
    id.starts_with("filesearch-") || id.starts_with("fileSearchStores/")
}

/// Whether `id` matches `^{prefix}\d+$` — the prefix then one-or-more ASCII digits.
///
/// Reproduces `/^sec1-layer-\d+$/` and `/^sec3-layer-\d+$/` (JS `\d` is ASCII
/// `[0-9]` here — no `u` flag). An empty digit run fails, matching `\d+`.
fn is_sec_layer_id(id: &str, prefix: &str) -> bool {
    match id.strip_prefix(prefix) {
        Some(rest) => !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()),
        None => false,
    }
}

/// Whether the (already-trimmed) `name` starts with `[SECTION n]`, case-insensitive.
///
/// Reproduces the `/^\[SECTION 1\]/i` / `/^\[SECTION 3\]/i` **prefix** tests. The
/// expected prefix is pure ASCII, so lowercasing the name and comparing is exact
/// (ASCII lowercasing is 1:1; a name whose leading bytes are non-ASCII can never
/// match the ASCII prefix regardless).
fn name_has_section_prefix(name: &str, prefix_lower: &str) -> bool {
    name.to_lowercase().starts_with(prefix_lower)
}

/// Whether a `ragKnowledge` element counts under JS `typeof x === 'object' && x !== null`.
///
/// That predicate keeps objects **and** arrays and drops `null`/strings/numbers/
/// booleans — reproduced exactly.
#[inline]
fn is_rag_object(value: &Value) -> bool {
    matches!(value, Value::Object(_) | Value::Array(_))
}

/// The string `id` of a rag-knowledge entry, or `""`.
///
/// Mirrors `typeof e?.id === 'string' ? e.id : ''`: a missing key, a non-string
/// value, or an array element all read as `""`.
#[inline]
fn rag_entry_id(entry: &Value) -> &str {
    entry.get("id").and_then(Value::as_str).unwrap_or("")
}

/// The object/array entries of `layer.ragKnowledge`, in order.
///
/// Mirrors `readRagKnowledge`: a non-array `ragKnowledge` yields an empty list;
/// otherwise every element passing [`is_rag_object`] is retained.
fn read_rag_objects(layer: &ExecutionLayer) -> Vec<&Value> {
    match &layer.rag_knowledge {
        Some(Value::Array(entries)) => entries.iter().filter(|e| is_rag_object(e)).collect(),
        _ => Vec::new(),
    }
}

/// `readStr(layer, 'corpusId')` — the explicit corpus id, or `""` when absent.
#[inline]
fn read_corpus_id(layer: &ExecutionLayer) -> &str {
    layer.corpus_id.as_deref().unwrap_or("")
}

/// Whether `layer` is a Section 1 synthesis layer.
///
/// Mirrors `isSection1ReportLayer`: matches on an exact (un-trimmed) `tag`, then a
/// case-insensitive `[SECTION 1]` name prefix (on the trimmed name), then a
/// `sec1-layer-{n}` id (on the trimmed id) — short-circuiting in that order.
pub fn is_section1_report_layer(layer: &ExecutionLayer) -> bool {
    if layer.tag.as_deref() == Some(SECTION_1_LAYER_TAG) {
        return true;
    }
    let name = layer.name.trim();
    if !name.is_empty() && name_has_section_prefix(name, SECTION_1_NAME_PREFIX_LOWER) {
        return true;
    }
    let id = layer.id.trim();
    if !id.is_empty() && is_sec_layer_id(id, SECTION_1_LAYER_ID_PREFIX) {
        return true;
    }
    false
}

/// Whether `layer` is a Section 3 synthesis layer.
///
/// Mirrors `isSection3ReportLayer` — the Section 1 logic with the Section 3 tag,
/// name prefix, and id pattern.
pub fn is_section3_report_layer(layer: &ExecutionLayer) -> bool {
    if layer.tag.as_deref() == Some(SECTION_3_LAYER_TAG) {
        return true;
    }
    let name = layer.name.trim();
    if !name.is_empty() && name_has_section_prefix(name, SECTION_3_NAME_PREFIX_LOWER) {
        return true;
    }
    let id = layer.id.trim();
    if !id.is_empty() && is_sec_layer_id(id, SECTION_3_LAYER_ID_PREFIX) {
        return true;
    }
    false
}

/// Whether `layer` is any synthesis (Section 1 or Section 3) layer.
///
/// Mirrors `isSynthesisReportLayer`.
pub fn is_synthesis_report_layer(layer: &ExecutionLayer) -> bool {
    is_section1_report_layer(layer) || is_section3_report_layer(layer)
}

/// Strip the clinical corpus binding from a synthesis layer.
///
/// Mirrors `stripSynthesisClinicalCorpusBinding`. Returns the (possibly rewritten)
/// layer paired with a `changed` flag; when `changed` is `false` the returned
/// layer is an untouched clone of the input.
///
/// For a synthesis layer it:
/// 1. prunes `ragKnowledge` of entries whose id is a corpus id
///    ([`is_corpus_id`]) or equals the layer's explicit `corpusId`;
/// 2. as a special case, drops the sole surviving entry when the layer had exactly
///    one rag entry and it carries a non-empty string id;
/// 3. deletes `corpusId` when one was present;
/// 4. clears `documentSelections` to `[]` when it held any non-empty entry **and**
///    either the corpus id was stripped or the rag list changed.
///
/// A non-synthesis layer is returned unchanged. When none of the above conditions
/// fire, the layer is likewise returned unchanged (`changed == false`).
pub fn strip_synthesis_clinical_corpus_binding(layer: &ExecutionLayer) -> (ExecutionLayer, bool) {
    if !is_synthesis_report_layer(layer) {
        return (layer.clone(), false);
    }

    let explicit_corpus_id = read_corpus_id(layer);
    let rag = read_rag_objects(layer);

    // Drop corpus-bound entries: filesearch ids, and the explicit corpusId.
    let mut filtered: Vec<&Value> = rag
        .iter()
        .copied()
        .filter(|entry| {
            let id = rag_entry_id(entry);
            if id.is_empty() {
                return true;
            }
            if is_corpus_id(id) {
                return false;
            }
            if !explicit_corpus_id.is_empty() && id == explicit_corpus_id {
                return false;
            }
            true
        })
        .collect();

    // Special case: a single surviving rag entry with a real id is always dropped.
    if rag.len() == 1 && filtered.len() == 1 {
        let only_id = rag_entry_id(rag[0]);
        if !only_id.is_empty() {
            filtered = Vec::new();
        }
    }

    let rag_knowledge_same_length = filtered.len() == rag.len();
    let rag_knowledge_same_ids = rag_knowledge_same_length
        && filtered
            .iter()
            .enumerate()
            .all(|(i, entry)| rag_entry_id(entry) == rag_entry_id(rag[i]));
    let needs_rag_update = !rag_knowledge_same_ids;

    // `documentSelections`: count only the non-empty string entries (JS filter).
    let doc_arr_len = layer
        .document_selections
        .as_ref()
        .map(|docs| docs.iter().filter(|d| !d.is_empty()).count())
        .unwrap_or(0);

    let needs_corpus_id_strip = !explicit_corpus_id.is_empty();
    let needs_doc_clear = doc_arr_len > 0 && (needs_corpus_id_strip || needs_rag_update);

    if !needs_corpus_id_strip && !needs_rag_update && !needs_doc_clear {
        return (layer.clone(), false);
    }

    let mut next = layer.clone();
    if needs_corpus_id_strip {
        next.corpus_id = None;
    }
    if needs_rag_update {
        next.rag_knowledge = Some(Value::Array(filtered.into_iter().cloned().collect()));
    }
    if needs_doc_clear {
        next.document_selections = Some(Vec::new());
    }

    (next, true)
}

/// Back-compat alias for [`strip_synthesis_clinical_corpus_binding`].
///
/// Mirrors the reference's `export const stripSection3ClinicalCorpusBinding =
/// stripSynthesisClinicalCorpusBinding;` — Section 3 was the original scope before
/// the sanitizer was generalized to all synthesis (Section 1 + 3) layers.
#[inline]
pub fn strip_section3_clinical_corpus_binding(layer: &ExecutionLayer) -> (ExecutionLayer, bool) {
    strip_synthesis_clinical_corpus_binding(layer)
}

/// Sanitize every layer in a report-creation bundle.
///
/// Mirrors `sanitizeReportCreationLayers`: each layer is run through
/// [`strip_synthesis_clinical_corpus_binding`]; the rewritten layer is kept when it
/// changed, otherwise the original layer is preserved (matching `changed ? layer :
/// l`). Order and length are preserved.
pub fn sanitize_report_creation_layers(layers: &[ExecutionLayer]) -> Vec<ExecutionLayer> {
    layers
        .iter()
        .map(|layer| {
            let (next, changed) = strip_synthesis_clinical_corpus_binding(layer);
            if changed {
                next
            } else {
                layer.clone()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn layer_from(value: serde_json::Value) -> ExecutionLayer {
        serde_json::from_value(value).expect("layer deserializes")
    }

    // ---- section detectors -------------------------------------------------

    #[test]
    fn section1_matches_by_tag_name_and_id() {
        // Tag path (id/name chosen so they do not also match).
        assert!(is_section1_report_layer(&layer_from(
            json!({ "id": "misc-1", "name": "plain", "tag": SECTION_1_LAYER_TAG })
        )));
        // Name-prefix path (case-insensitive), no tag, non-matching id.
        assert!(is_section1_report_layer(&layer_from(
            json!({ "id": "misc-1", "name": "[section 1] Overviews" })
        )));
        assert!(is_section1_report_layer(&layer_from(
            json!({ "id": "misc-1", "name": "  [SECTION 1] Overviews" })
        )));
        // Id path, no tag, non-matching name.
        assert!(is_section1_report_layer(&layer_from(
            json!({ "id": "sec1-layer-2", "name": "plain" })
        )));
    }

    #[test]
    fn section3_matches_by_tag_name_and_id() {
        assert!(is_section3_report_layer(&layer_from(
            json!({ "id": "misc-1", "name": "plain", "tag": SECTION_3_LAYER_TAG })
        )));
        assert!(is_section3_report_layer(&layer_from(
            json!({ "id": "misc-1", "name": "[SECTION 3] PK" })
        )));
        assert!(is_section3_report_layer(&layer_from(
            json!({ "id": "sec3-layer-1", "name": "plain" })
        )));
    }

    #[test]
    fn section2_is_not_a_synthesis_layer() {
        let layer = layer_from(json!({
            "id": "layer-1",
            "name": "[SECTION 2] Study",
            "tag": "Section 2",
            "corpusId": "filesearch-x",
        }));
        assert!(!is_synthesis_report_layer(&layer));
        assert!(!is_section1_report_layer(&layer));
        assert!(!is_section3_report_layer(&layer));
    }

    #[test]
    fn tag_comparison_is_exact_and_untrimmed() {
        // A padded tag does not match the exact `=== 'Section 1'` comparison,
        // and the name/id here are non-matching, so this is not Section 1.
        let layer = layer_from(json!({ "id": "misc-1", "name": "plain", "tag": " Section 1 " }));
        assert!(!is_section1_report_layer(&layer));
    }

    #[test]
    fn id_pattern_requires_trailing_digits_and_full_match() {
        // Missing digits.
        assert!(!is_section1_report_layer(&layer_from(
            json!({ "id": "sec1-layer-", "name": "plain" })
        )));
        // Non-digit suffix.
        assert!(!is_section1_report_layer(&layer_from(
            json!({ "id": "sec1-layer-1a", "name": "plain" })
        )));
        // Trailing whitespace is trimmed away, so this still matches.
        assert!(is_section1_report_layer(&layer_from(
            json!({ "id": "  sec1-layer-10  ", "name": "plain" })
        )));
    }

    // ---- strip -------------------------------------------------------------

    #[test]
    fn strips_section1_corpus_fields() {
        let layer = layer_from(json!({
            "id": "sec1-layer-1",
            "name": "[SECTION 1] Key findings",
            "tag": SECTION_1_LAYER_TAG,
            "corpusId": "filesearch-clinical",
            "ragKnowledge": [{ "id": "filesearch-clinical", "filename": "C" }],
            "documentSelections": ["a.pdf"],
        }));
        let (next, changed) = strip_synthesis_clinical_corpus_binding(&layer);
        assert!(changed);
        assert_eq!(next.corpus_id, None);
        assert_eq!(next.rag_knowledge, Some(json!([])));
        assert_eq!(next.document_selections, Some(vec![]));
    }

    #[test]
    fn strip_removes_corpus_from_section3() {
        let layer = layer_from(json!({
            "id": "sec3-layer-1",
            "name": "[SECTION 3] Draft",
            "tag": SECTION_3_LAYER_TAG,
            "corpusId": "filesearch-abc123",
            "ragKnowledge": [{ "id": "filesearch-abc123", "filename": "Corpus A" }],
        }));
        let (next, changed) = strip_synthesis_clinical_corpus_binding(&layer);
        assert!(changed);
        assert_eq!(next.corpus_id, None);
        assert_eq!(next.rag_knowledge, Some(json!([])));
    }

    #[test]
    fn strip_is_noop_for_section2() {
        let layer = layer_from(json!({
            "id": "layer-1",
            "name": "Study",
            "tag": "Section 2",
            "corpusId": "filesearch-xyz",
            "ragKnowledge": [{ "id": "filesearch-xyz", "filename": "C" }],
        }));
        let (next, changed) = strip_synthesis_clinical_corpus_binding(&layer);
        assert!(!changed);
        assert_eq!(next, layer);
    }

    #[test]
    fn single_non_corpus_rag_entry_is_dropped() {
        // The id is neither a filesearch id nor the explicit corpusId, yet the
        // sole surviving entry is still cleared by the special case.
        let layer = layer_from(json!({
            "id": "sec3-layer-1",
            "name": "Draft",
            "tag": SECTION_3_LAYER_TAG,
            "ragKnowledge": [{ "id": "manual-note", "filename": "note" }],
        }));
        let (next, changed) = strip_synthesis_clinical_corpus_binding(&layer);
        assert!(changed);
        assert_eq!(next.rag_knowledge, Some(json!([])));
    }

    #[test]
    fn rag_entry_without_id_is_preserved_and_no_change() {
        // Entry has no string id -> kept; nothing else to strip -> unchanged.
        let layer = layer_from(json!({
            "id": "sec3-layer-1",
            "name": "Draft",
            "tag": SECTION_3_LAYER_TAG,
            "ragKnowledge": [{ "filename": "note" }, { "filename": "note2" }],
        }));
        let (next, changed) = strip_synthesis_clinical_corpus_binding(&layer);
        assert!(!changed);
        assert_eq!(next, layer);
    }

    #[test]
    fn strips_corpus_id_even_without_rag_or_docs() {
        let layer = layer_from(json!({
            "id": "sec1-layer-1",
            "name": "Overviews",
            "tag": SECTION_1_LAYER_TAG,
            "corpusId": "filesearch-clinical",
        }));
        let (next, changed) = strip_synthesis_clinical_corpus_binding(&layer);
        assert!(changed);
        assert_eq!(next.corpus_id, None);
    }

    #[test]
    fn doc_selections_cleared_only_when_binding_changed() {
        // A synthesis layer whose only content is a non-empty documentSelections
        // but with no corpusId and no rag change -> docs are NOT cleared.
        let layer = layer_from(json!({
            "id": "sec3-layer-1",
            "name": "Draft",
            "tag": SECTION_3_LAYER_TAG,
            "documentSelections": ["a.pdf"],
        }));
        let (next, changed) = strip_synthesis_clinical_corpus_binding(&layer);
        assert!(!changed);
        assert_eq!(next.document_selections, Some(vec!["a.pdf".to_string()]));
    }

    #[test]
    fn mixed_rag_prunes_only_corpus_entries() {
        let layer = layer_from(json!({
            "id": "sec3-layer-1",
            "name": "Draft",
            "tag": SECTION_3_LAYER_TAG,
            "ragKnowledge": [
                { "id": "filesearch-a", "filename": "A" },
                { "id": "keep-me", "filename": "B" },
                { "id": "fileSearchStores/xyz", "filename": "C" }
            ],
        }));
        let (next, changed) = strip_synthesis_clinical_corpus_binding(&layer);
        assert!(changed);
        assert_eq!(next.rag_knowledge, Some(json!([{ "id": "keep-me", "filename": "B" }])));
    }

    // ---- sanitize ----------------------------------------------------------

    #[test]
    fn sanitize_cleans_synthesis_but_keeps_section2() {
        let layers = vec![
            layer_from(json!({
                "id": "layer-1",
                "name": "layer-1",
                "tag": "Section 2",
                "corpusId": "filesearch-clinical",
                "ragKnowledge": [{ "id": "filesearch-clinical" }],
            })),
            layer_from(json!({
                "id": "sec3-layer-1",
                "name": "sec3-layer-1",
                "tag": "Section 3",
                "corpusId": "filesearch-clinical",
                "ragKnowledge": [{ "id": "filesearch-clinical" }],
            })),
            layer_from(json!({
                "id": "sec1-layer-1",
                "name": "sec1-layer-1",
                "tag": "Section 1",
                "corpusId": "filesearch-clinical",
                "ragKnowledge": [{ "id": "filesearch-clinical" }],
            })),
        ];

        let out = sanitize_report_creation_layers(&layers);
        // Section 2 keeps its binding.
        assert_eq!(out[0].corpus_id.as_deref(), Some("filesearch-clinical"));
        // Section 3 and Section 1 are stripped.
        assert_eq!(out[1].corpus_id, None);
        assert_eq!(out[2].corpus_id, None);
        // Length + order preserved.
        assert_eq!(out.len(), 3);
        let ids: Vec<&str> = out.iter().map(|l| l.id.as_str()).collect();
        assert_eq!(ids, vec!["layer-1", "sec3-layer-1", "sec1-layer-1"]);
    }

    #[test]
    fn section3_alias_matches_primary() {
        let layer = layer_from(json!({
            "id": "sec3-layer-1",
            "name": "Draft",
            "tag": SECTION_3_LAYER_TAG,
            "corpusId": "filesearch-abc",
        }));
        assert_eq!(
            strip_section3_clinical_corpus_binding(&layer),
            strip_synthesis_clinical_corpus_binding(&layer)
        );
    }
}
