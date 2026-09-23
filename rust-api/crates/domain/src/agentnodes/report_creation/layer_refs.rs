//! Referenced-step resolution for the 272 report-creation compiler.
//!
//! Ported 1:1 (equivalent-behavior parity) from
//! `frontend_v3/app/lib/reportCreationLayerRefs.ts`. This module decides, for a
//! given generated 272 layer, *which* prior layers it should reference — the
//! `referencedStepIds` that later feed [`super::super::step_prompt`]'s
//! `build_referenced_steps_context`. Two kinds of layer are wired here:
//!
//! * **Section 3** layers ([`build_sec3_referenced_steps`]) reference every study
//!   summary, every meta-analysis, and every *earlier* Section 3 layer.
//! * **Section 1** layers ([`build_sec1_referenced_steps`]) are routed by the
//!   *normalized* step name into one of a handful of buckets (HB table, clinical
//!   studies table, key findings, overviews, or the default study+sec3 set).
//!
//! The routing hinges on [`normalize_sec1_step_name`], the exact analogue of the
//! reference's `normalizeSec1StepName` (`trim → toLowerCase → strip a leading
//! `[section 1]` tag → collapse whitespace to `_` → drop everything outside
//! `[a-z0-9_]`). It is reimplemented with plain ASCII predicates rather than the
//! `regex` crate, matching how `validation.rs` ports its identifier/digest regexes
//! (the domain crate deliberately carries no `regex` dependency).
//!
//! This unit is pure and depends on no DTOs — the reference file likewise imports
//! nothing; its only input shape is the local `Sec1StepNameInput`.

use serde::{Deserialize, Serialize};

/// Section-3 layer id for the (1-based) position `i` — `sec3-layer-{i}`.
///
/// Mirrors the template literal used across the report-creation compiler.
#[inline]
fn sec3_layer_id(one_based: usize) -> String {
    format!("sec3-layer-{one_based}")
}

/// The ids of every Section 3 layer strictly *before* zero-based index `idx`.
///
/// Mirrors `priorSec3LayerIds(idx) = Array.from({length: idx}, (_, i) =>
/// `sec3-layer-${i + 1}`)`: `idx == 0` yields an empty vec.
pub fn prior_sec3_layer_ids(idx: usize) -> Vec<String> {
    (0..idx).map(|i| sec3_layer_id(i + 1)).collect()
}

/// Referenced steps for the Section 3 layer at zero-based `sec3_index_zero_based`.
///
/// Mirrors `buildSec3ReferencedSteps`: all study ids, then all meta ids, then the
/// prior Section 3 layer ids — in that exact order.
pub fn build_sec3_referenced_steps(
    study_ids: &[String],
    meta_ids: &[String],
    sec3_index_zero_based: usize,
) -> Vec<String> {
    let mut refs =
        Vec::with_capacity(study_ids.len() + meta_ids.len() + sec3_index_zero_based);
    refs.extend_from_slice(study_ids);
    refs.extend_from_slice(meta_ids);
    refs.extend(prior_sec3_layer_ids(sec3_index_zero_based));
    refs
}

/// `\s*`-equivalent: whether `c` is stripped as leading/collapsed whitespace.
///
/// Uses Unicode `char::is_whitespace` — under equivalent-behavior parity this
/// stands in for JS regex `\s` (the two differ only on exotic code points like
/// `﻿`, which the reference's own `.trim()` step already normalizes away).
#[inline]
fn is_ws(c: char) -> bool {
    c.is_whitespace()
}

/// Strip a leading `[section 1]` tag — the `/^\[section\s*1\]\s*/i` replacement.
///
/// Operates on the already-lowercased string, so the case-insensitive flag is a
/// no-op. Any component that fails to match leaves the input untouched, exactly
/// like a non-matching `String.replace`.
fn strip_section1_prefix(s: &str) -> &str {
    let after_bracket = match s.strip_prefix('[') {
        Some(rest) => rest,
        None => return s,
    };
    let after_section = match after_bracket.strip_prefix("section") {
        Some(rest) => rest,
        None => return s,
    };
    // `\s*` between "section" and "1".
    let after_inner_ws = after_section.trim_start_matches(is_ws);
    let after_one = match after_inner_ws.strip_prefix('1') {
        Some(rest) => rest,
        None => return s,
    };
    let after_close = match after_one.strip_prefix(']') {
        Some(rest) => rest,
        None => return s,
    };
    // Trailing `\s*` after the closing bracket.
    after_close.trim_start_matches(is_ws)
}

/// Normalize a Section 1 step name into its routing key.
///
/// Mirrors `normalizeSec1StepName`: `trim → toLowerCase → strip a leading
/// `[section 1]` tag → replace each whitespace run with a single `_` → drop every
/// character outside `[a-z0-9_]`.
pub fn normalize_sec1_step_name(name: &str) -> String {
    // trim + toLowerCase.
    let lowered = name.trim().to_lowercase();
    // strip a leading `[section 1]` tag (operates on the lowercased text).
    let stripped = strip_section1_prefix(&lowered);

    // `\s+` -> `_`: collapse each run of whitespace to a single underscore.
    let mut collapsed = String::with_capacity(stripped.len());
    let mut prev_ws = false;
    for c in stripped.chars() {
        if is_ws(c) {
            if !prev_ws {
                collapsed.push('_');
                prev_ws = true;
            }
        } else {
            collapsed.push(c);
            prev_ws = false;
        }
    }

    // `[^a-z0-9_]` -> "": drop anything outside the allowed set (already lowercased).
    collapsed
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '_')
        .collect()
}

/// Whether the normalized name denotes a homogeneous-biomaterial (HB) table.
///
/// Mirrors the private `isHbTable`: exact `hb_table`, any `*_hb_table` suffix, or
/// any name containing both `hb` and `table`.
fn is_hb_table(n: &str) -> bool {
    n == "hb_table" || n.ends_with("_hb_table") || (n.contains("hb") && n.contains("table"))
}

/// Whether `step_name` (raw, un-normalized) is a Section 1 HB-table step.
///
/// Mirrors `isSec1HbTableStep`.
pub fn is_sec1_hb_table_step(step_name: &str) -> bool {
    is_hb_table(&normalize_sec1_step_name(step_name))
}

/// Whether the normalized name denotes a clinical-studies table.
///
/// Mirrors the private `isClinStudiesTable`. The final exact check is redundant
/// with the `clin_studies` substring test but is ported verbatim.
fn is_clin_studies_table(n: &str) -> bool {
    n.contains("clinstudies") || n.contains("clin_studies") || n == "clin_studies_table"
}

/// Whether the normalized name denotes a Section 1 *overviews* step.
///
/// Mirrors the private `isSec1Overviews` **exactly**: the literal `sec1_overviews`,
/// or any name containing the plural `overviews` and **not** containing `key`.
/// Note the plural: a bare `overview` matches only via the `sec1_overviews` literal.
fn is_sec1_overviews(n: &str) -> bool {
    n == "sec1_overviews" || (n.contains("overviews") && !n.contains("key"))
}

/// Whether the normalized name denotes a Section 1 key-findings step.
///
/// Mirrors the private `isSec1KeyFindings`.
fn is_sec1_key_findings(n: &str) -> bool {
    n.contains("key_findings") || n.contains("keyfindings")
}

/// A Section 1 step identified only by its (raw) name — the reference's
/// `Sec1StepNameInput` interface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sec1StepNameInput {
    pub name: String,
}

/// A Section 1 step with an optional selection flag — the `{ name, selected? }`
/// shape consumed by [`sec1_selection_requires_biomaterial_corpus`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sec1StepSelection {
    pub name: String,
    /// `selected?: boolean`. Absent (`None`) is treated as selected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected: Option<bool>,
}

/// Whether any *selected* Section 1 step is an HB-table step, so the compile needs
/// the biomaterial corpus bound.
///
/// Mirrors `sec1SelectionRequiresBiomaterialCorpus`: a step counts when
/// `selected !== false` (so `undefined`/absent counts) **and** it is an HB-table
/// step.
pub fn sec1_selection_requires_biomaterial_corpus(sec1_steps: &[Sec1StepSelection]) -> bool {
    sec1_steps
        .iter()
        .any(|s| s.selected != Some(false) && is_sec1_hb_table_step(&s.name))
}

/// Referenced steps for a Section 1 layer, routed by its normalized name.
///
/// Mirrors `buildSec1ReferencedSteps`, preserving branch order:
/// 1. HB table → the meta ids;
/// 2. clinical-studies table → the study ids;
/// 3. key findings → the single overviews layer id (`sec1-layer-{n}`), or empty if
///    no overviews step precedes it;
/// 4. overviews → the study ids followed by the Section 3 ids;
/// 5. default → the study ids followed by the Section 3 ids.
pub fn build_sec1_referenced_steps(
    step_name: &str,
    sec1_steps_in_order: &[Sec1StepNameInput],
    study_ids: &[String],
    meta_ids: &[String],
    sec3_ids: &[String],
) -> Vec<String> {
    let n = normalize_sec1_step_name(step_name);

    if is_hb_table(&n) {
        return meta_ids.to_vec();
    }

    if is_clin_studies_table(&n) {
        return study_ids.to_vec();
    }

    if is_sec1_key_findings(&n) {
        let overviews_idx = sec1_steps_in_order
            .iter()
            .position(|s| is_sec1_overviews(&normalize_sec1_step_name(&s.name)));
        return match overviews_idx {
            Some(idx) => vec![format!("sec1-layer-{}", idx + 1)],
            None => Vec::new(),
        };
    }

    if is_sec1_overviews(&n) {
        return study_ids.iter().chain(sec3_ids).cloned().collect();
    }

    study_ids.iter().chain(sec3_ids).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| s.to_string()).collect()
    }

    fn name_input(name: &str) -> Sec1StepNameInput {
        Sec1StepNameInput { name: name.to_string() }
    }

    #[test]
    fn prior_sec3_layer_ids_are_one_based_and_empty_at_zero() {
        assert!(prior_sec3_layer_ids(0).is_empty());
        assert_eq!(
            prior_sec3_layer_ids(3),
            ids(&["sec3-layer-1", "sec3-layer-2", "sec3-layer-3"])
        );
    }

    #[test]
    fn build_sec3_preserves_study_meta_prior_order() {
        let refs = build_sec3_referenced_steps(
            &ids(&["study-1", "study-2"]),
            &ids(&["meta-1"]),
            2,
        );
        assert_eq!(
            refs,
            ids(&["study-1", "study-2", "meta-1", "sec3-layer-1", "sec3-layer-2"])
        );
    }

    #[test]
    fn build_sec3_at_index_zero_has_no_prior_sec3() {
        let refs = build_sec3_referenced_steps(&ids(&["study-1"]), &ids(&["meta-1"]), 0);
        assert_eq!(refs, ids(&["study-1", "meta-1"]));
    }

    #[test]
    fn normalize_strips_section1_tag_and_collapses_whitespace() {
        assert_eq!(normalize_sec1_step_name("[Section 1] Overviews"), "overviews");
        assert_eq!(normalize_sec1_step_name("  [section1]   Key Findings  "), "key_findings");
        // No tag: whitespace collapses to underscores, case folded.
        assert_eq!(normalize_sec1_step_name("Clinical  Studies Table"), "clinical_studies_table");
    }

    #[test]
    fn normalize_drops_disallowed_characters() {
        assert_eq!(normalize_sec1_step_name("HB-Table (v2)!"), "hbtable_v2");
        // A leading tag that does not fully match is left in place, then sanitized.
        assert_eq!(normalize_sec1_step_name("[section 2] foo"), "section_2_foo");
    }

    #[test]
    fn hb_table_matches_exact_suffix_and_both_tokens() {
        assert!(is_sec1_hb_table_step("HB Table"));
        assert!(is_sec1_hb_table_step("Biomaterial HB Table")); // *_hb_table suffix
        assert!(is_sec1_hb_table_step("hb summary table")); // contains hb + table
        assert!(!is_sec1_hb_table_step("Clinical Overviews"));
    }

    #[test]
    fn overviews_matcher_is_exact() {
        assert!(is_sec1_overviews("sec1_overviews"));
        assert!(is_sec1_overviews("overviews"));
        assert!(is_sec1_overviews("clinical_overviews"));
        // Plural required: bare singular does not match unless it is the literal.
        assert!(!is_sec1_overviews("overview"));
        // `key` anywhere excludes it (key-findings takes precedence).
        assert!(!is_sec1_overviews("key_overviews"));
    }

    #[test]
    fn clin_studies_and_key_findings_matchers() {
        assert!(is_clin_studies_table("clinstudies_table"));
        assert!(is_clin_studies_table("clin_studies"));
        assert!(is_clin_studies_table("clin_studies_table"));
        assert!(!is_clin_studies_table("clinical_studies_table")); // no `clin_studies` substring

        assert!(is_sec1_key_findings("key_findings"));
        assert!(is_sec1_key_findings("keyfindings"));
        assert!(!is_sec1_key_findings("findings"));
    }

    #[test]
    fn sec1_hb_table_branch_returns_meta_ids() {
        let refs = build_sec1_referenced_steps(
            "HB Table",
            &[],
            &ids(&["study-1"]),
            &ids(&["meta-1", "meta-2"]),
            &ids(&["sec3-layer-1"]),
        );
        assert_eq!(refs, ids(&["meta-1", "meta-2"]));
    }

    #[test]
    fn sec1_clin_studies_branch_returns_study_ids() {
        let refs = build_sec1_referenced_steps(
            "ClinStudies Table",
            &[],
            &ids(&["study-1", "study-2"]),
            &ids(&["meta-1"]),
            &ids(&["sec3-layer-1"]),
        );
        assert_eq!(refs, ids(&["study-1", "study-2"]));
    }

    #[test]
    fn sec1_key_findings_points_at_the_overviews_layer() {
        let steps = vec![name_input("[Section 1] Intro"), name_input("Overviews")];
        let refs = build_sec1_referenced_steps(
            "Key Findings",
            &steps,
            &ids(&["study-1"]),
            &ids(&["meta-1"]),
            &ids(&["sec3-layer-1"]),
        );
        // Overviews is the 2nd step (index 1) -> sec1-layer-2.
        assert_eq!(refs, ids(&["sec1-layer-2"]));
    }

    #[test]
    fn sec1_key_findings_without_overviews_returns_empty() {
        let steps = vec![name_input("Intro"), name_input("Clinical Studies")];
        let refs = build_sec1_referenced_steps(
            "Key Findings",
            &steps,
            &ids(&["study-1"]),
            &ids(&["meta-1"]),
            &ids(&["sec3-layer-1"]),
        );
        assert!(refs.is_empty());
    }

    #[test]
    fn sec1_overviews_and_default_return_studies_then_sec3() {
        let expected = ids(&["study-1", "sec3-layer-1", "sec3-layer-2"]);
        let overviews = build_sec1_referenced_steps(
            "Overviews",
            &[],
            &ids(&["study-1"]),
            &ids(&["meta-1"]),
            &ids(&["sec3-layer-1", "sec3-layer-2"]),
        );
        assert_eq!(overviews, expected);

        let default = build_sec1_referenced_steps(
            "Some Other Step",
            &[],
            &ids(&["study-1"]),
            &ids(&["meta-1"]),
            &ids(&["sec3-layer-1", "sec3-layer-2"]),
        );
        assert_eq!(default, expected);
    }

    #[test]
    fn biomaterial_corpus_required_only_for_selected_hb_steps() {
        let selected_hb = vec![Sec1StepSelection {
            name: "HB Table".to_string(),
            selected: Some(true),
        }];
        assert!(sec1_selection_requires_biomaterial_corpus(&selected_hb));

        // `selected` absent counts as selected (`selected !== false`).
        let absent_hb =
            vec![Sec1StepSelection { name: "HB Table".to_string(), selected: None }];
        assert!(sec1_selection_requires_biomaterial_corpus(&absent_hb));

        // Explicitly deselected HB step does not require the corpus.
        let deselected_hb = vec![Sec1StepSelection {
            name: "HB Table".to_string(),
            selected: Some(false),
        }];
        assert!(!sec1_selection_requires_biomaterial_corpus(&deselected_hb));

        // A selected non-HB step does not require it either.
        let non_hb = vec![Sec1StepSelection {
            name: "Overviews".to_string(),
            selected: Some(true),
        }];
        assert!(!sec1_selection_requires_biomaterial_corpus(&non_hb));
    }
}
