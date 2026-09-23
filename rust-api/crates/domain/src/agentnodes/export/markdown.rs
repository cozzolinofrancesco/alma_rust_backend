//! Final markdown assembly for the canvas-272 export subtree.
//!
//! Ported from `frontend_v3/app/canvas-272/lib/exportFormatter.ts`
//! (`structuredDocToMarkdown`) under **equivalent-behavior** parity, not
//! byte-parity. This is a pure module with no I/O: it turns a fully-built
//! [`StructuredDoc`] into the single markdown string used by **both** the
//! document preview and every export format (json / markdown / — later — docx),
//! and it is shared by 272 **and** IB.
//!
//! ## What this function does (and, deliberately, does not)
//!
//! The reference comment on `structuredDocToMarkdown` is load-bearing, so it is
//! reproduced here: *"Emit the document as the step outputs only — no injected
//! section headings and no step-name leaders. Bodies keep their own (natural)
//! heading levels. Empty / placeholder-only steps are dropped so nothing
//! orphaned is left behind."*
//!
//! Concretely the emitted markdown is **only** each `step.output.trim()`, in
//! order, separated by a blank line, then run through
//! [`sanitize_markdown_for_document_preview`]. No headings, step numbers, step
//! names, or section labels are ever written. This is the highest-risk parity
//! area in the export subtree:
//!
//! * All ordering, section grouping, name sanitization, technical-placeholder
//!   filtering, and consecutive-same-name merging happen **upstream** in
//!   [`prepare_structured_doc_for_export`] (the `structured_doc` unit) — which
//!   this function calls first. It must **not** be duplicated here.
//! * The section-flatness invariant (`isSectionHeaderName = /^section\b/i`,
//!   export order = stable sort by `layer.order`) lives in the `sections` /
//!   `structured_doc` units. Re-grouping or re-sorting here would resurrect the
//!   "1-step-section heading-drop → empty report" trap the port plan calls out.
//!
//! ## Per-step drop rule (parity-exact)
//!
//! After preparation, a step is skipped when **either**:
//! 1. its `output.trim()` is empty, **or**
//! 2. [`is_known_empty_llm_placeholder_only_body`] (the `sanitize` unit) reports
//!    the *raw* (untrimmed) output is placeholder-only — e.g. a body that is
//!    nothing but `no source text identified`.
//!
//! Note the asymmetry mirrored from the reference: the emptiness test uses the
//! **trimmed** output, while the placeholder-only test is passed the **raw**
//! `step.output`. Emitted bodies are the **trimmed** output.

use crate::agentnodes::export::sanitize::{
    is_known_empty_llm_placeholder_only_body, sanitize_markdown_for_document_preview,
};
use crate::agentnodes::export::sanitize::prepare_structured_doc_for_export;
use crate::agentnodes::export::structured_doc::StructuredDoc;

/// Render a [`StructuredDoc`] to the canonical export markdown string.
///
/// Mirrors `structuredDocToMarkdown(doc)`:
/// 1. Run the doc through [`prepare_structured_doc_for_export`] (sanitize names,
///    drop technical placeholders, merge consecutive same-name steps, apply the
///    section heading-drop).
/// 2. Walk every prepared section's steps in order; for each step whose
///    (trimmed) output is non-empty and not a known placeholder-only body, push
///    the trimmed output followed by a blank-line separator.
/// 3. Join the collected lines with `"\n"` and hand the result to
///    [`sanitize_markdown_for_document_preview`] (which trims, strips known noise
///    lines fence-aware, and collapses runs of 3+ newlines to `\n\n`).
///
/// The final `sanitize` call is what turns the per-step trailing blank lines
/// into single blank-line separators and drops the trailing blank, so the join
/// step intentionally over-emits a blank after every kept step — exactly as the
/// reference does.
pub fn structured_doc_to_markdown(doc: &StructuredDoc) -> String {
    let prepared = prepare_structured_doc_for_export(doc);

    let mut lines: Vec<String> = Vec::new();
    for section in &prepared.sections {
        for step in &section.steps {
            let trimmed_out = step.output.trim();
            // Skip empty (trimmed) or placeholder-only (raw) bodies so nothing
            // orphaned is emitted. Matches `!trimmedOut || isKnownEmptyLlm…`.
            if trimmed_out.is_empty() || is_known_empty_llm_placeholder_only_body(&step.output) {
                continue;
            }
            lines.push(trimmed_out.to_string());
            lines.push(String::new());
        }
    }

    sanitize_markdown_for_document_preview(&lines.join("\n"), None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Build a [`StructuredDoc`] from JSON. Relies on the `structured_doc` unit
    /// deriving `Deserialize` with `#[serde(rename_all = "camelCase")]` (the
    /// export DTOs round-trip through JSON in the assemble/export handlers), the
    /// same construction style `section_tags` uses for `ExecutionLayer`.
    fn doc_from(value: serde_json::Value) -> StructuredDoc {
        serde_json::from_value(value).expect("structured doc deserializes")
    }

    #[test]
    fn emits_only_trimmed_outputs_joined_by_blank_lines() {
        // Distinct, non-technical, non-empty names so the upstream preparer does
        // no dropping/merging/renaming — this isolates markdown's own behaviour.
        let doc = doc_from(json!({
            "title": "Doc",
            "agentName": "My Agent",
            "exportedAt": "2020-01-01T00:00:00.000Z",
            "sections": [{
                "heading": null,
                "tag": null,
                "steps": [
                    { "number": "1", "name": "Intro", "output": "  Hello world  " },
                    { "number": "2", "name": "Body",  "output": "Second block" },
                ],
            }],
        }));

        // Each kept output is trimmed; separated by exactly one blank line; no
        // heading / name / number leaks into the output.
        assert_eq!(structured_doc_to_markdown(&doc), "Hello world\n\nSecond block");
    }

    #[test]
    fn drops_empty_and_placeholder_only_steps() {
        let doc = doc_from(json!({
            "title": "Doc",
            "agentName": "My Agent",
            "exportedAt": "2020-01-01T00:00:00.000Z",
            "sections": [{
                "heading": null,
                "tag": null,
                "steps": [
                    { "number": "1", "name": "Intro",       "output": "Kept one" },
                    // Whitespace-only body -> trimmed empty -> skipped.
                    { "number": "2", "name": "Whitespace",  "output": "   \n  " },
                    // Placeholder-only body -> is_known_empty_llm_placeholder_only_body -> skipped.
                    { "number": "3", "name": "Placeholder", "output": "No source text identified." },
                    { "number": "4", "name": "Outro",       "output": "Kept two" },
                ],
            }],
        }));

        // Only the two real bodies survive, separated by one blank line.
        assert_eq!(structured_doc_to_markdown(&doc), "Kept one\n\nKept two");
    }

    #[test]
    fn collapses_excess_blank_lines_within_a_body() {
        let doc = doc_from(json!({
            "title": "Doc",
            "agentName": "My Agent",
            "exportedAt": "2020-01-01T00:00:00.000Z",
            "sections": [{
                "heading": null,
                "tag": null,
                "steps": [
                    { "number": "1", "name": "Body", "output": "Line one\n\n\n\nLine two" },
                ],
            }],
        }));

        // sanitize collapses runs of 3+ newlines down to a single blank line.
        assert_eq!(structured_doc_to_markdown(&doc), "Line one\n\nLine two");
    }

    #[test]
    fn empty_doc_yields_empty_string() {
        let doc = doc_from(json!({
            "title": "Doc",
            "agentName": "My Agent",
            "exportedAt": "2020-01-01T00:00:00.000Z",
            "sections": [],
        }));

        assert_eq!(structured_doc_to_markdown(&doc), "");
    }
}
