//! End-to-end tests for the canvas-272 markdown export path.
//!
//! Where the sibling units' inline `#[cfg(test)]` modules pin one function each
//! ([`build_structured_doc`], [`structured_doc_to_markdown`], the diagram /
//! layer-output / sanitize helpers), this file drives the **whole export subtree
//! at once**: a small [`PortableAgent`] → [`build_structured_doc`] →
//! [`structured_doc_to_markdown`] → an *exact* expected markdown string. It is the
//! parity harness for the highest-risk export behaviours called out in the port
//! plan's "Export / markdown (272 + IB)" section, mirrored from
//! `frontend_v3/app/canvas-272/lib/exportFormatter.ts`
//! (`buildStructuredDoc` + `structuredDocToMarkdown`) and its own
//! `__tests__/exportFormatter.export.test.ts`.
//!
//! Three invariants are exercised:
//!
//! 1. **Only step outputs ship.** The emitted markdown is exactly each kept
//!    `step.output.trim()`, in `order`, joined by a single blank line — never a
//!    section heading, step name, or step number.
//! 2. **Section-flatness.** `[SECTION n]`-style names are **not** `/^section\b/i`
//!    headers, so they stay flat and their output survives; a genuine `Section n`
//!    header, by contrast, is grouped and its lone output is dropped/merged by the
//!    one-step-section heading rule. Locking both sides guards the "1-step-section
//!    heading-drop → empty report" trap.
//! 3. **Sanitizer strips.** `sanitizeMarkdownForDocumentPreview` removes known
//!    placeholder noise lines (`no source text identified`, `(no output)`,
//!    `Input text Test`) fence-aware, drops placeholder-only bodies whole, and
//!    collapses runs of 3+ newlines — all under equivalent-behavior parity.
//!
//! The whole file is gated on `#![cfg(test)]` so it compiles only under `cargo
//! test`, regardless of whether the integrator declares it with or without a
//! `#[cfg(test)]` attribute in the `export` module.
#![cfg(test)]

use std::collections::HashMap;

use serde_json::json;

use crate::agentnodes::dto::PortableAgent;
use crate::agentnodes::export::markdown::structured_doc_to_markdown;
use crate::agentnodes::export::structured_doc::build_structured_doc;

/// Deserialize a small agent from JSON and render it straight to export markdown.
///
/// This is the "small agent → expected markdown" composition under test: it wires
/// [`build_structured_doc`] into [`structured_doc_to_markdown`] with no sidecar
/// output edits, exactly as the assemble/export handlers do.
fn markdown_for(agent_json: serde_json::Value) -> String {
    let agent: PortableAgent =
        serde_json::from_value(agent_json).expect("agent fixture deserializes");
    structured_doc_to_markdown(&build_structured_doc(&agent, &HashMap::new()))
}

// --- 1. Only step outputs ship ----------------------------------------------

#[test]
fn small_agent_emits_only_trimmed_bodies_joined_by_blank_lines() {
    // Distinct, non-technical, non-header names with real bodies: nothing should
    // be renamed, merged, grouped, or dropped, so this isolates the core
    // "bodies only, blank-line separated" contract.
    let md = markdown_for(json!({
        "name": "My Agent",
        "layers": [
            { "id": "a", "name": "Introduction", "order": 0, "result": "  First body.  " },
            { "id": "b", "name": "Findings",     "order": 1, "result": "Second body." },
        ],
    }));

    // Each output is trimmed; separated by exactly one blank line.
    assert_eq!(md, "First body.\n\nSecond body.");

    // No injected structure leaks: no names, numbers, or agent title.
    assert!(!md.contains("Introduction"));
    assert!(!md.contains("Findings"));
    assert!(!md.contains("My Agent"));
    assert!(!md.contains('1'));
    assert!(!md.contains('2'));
}

#[test]
fn step_bodies_keep_their_own_heading_levels_verbatim() {
    // Bodies keep their natural markdown; the exporter never injects or demotes
    // headings. Mirrors the reference "keeps only bodies" / "natural levels" tests.
    let md = markdown_for(json!({
        "name": "Doc",
        "layers": [
            { "id": "a", "name": "Body", "order": 0,
              "result": "# One hash\n\n## Two hash\n\n### Three hash" },
        ],
    }));

    assert_eq!(md, "# One hash\n\n## Two hash\n\n### Three hash");
}

// --- 2. Section-flatness -----------------------------------------------------

#[test]
fn genuine_section_header_body_merges_into_first_child_and_no_label_leaks() {
    // A `/^section\b/i` header groups the following layer as a child. The
    // one-step-section heading rule drops the header step (its display name equals
    // the section heading) and prepends its output to the first child. The section
    // *label* itself never appears in the markdown — only bodies do.
    let md = markdown_for(json!({
        "name": "My Agent",
        "layers": [
            { "id": "p",  "name": "Preamble",    "order": 0, "result": "Intro body" },
            { "id": "s",  "name": "Section One",  "order": 1, "result": "Header body" },
            { "id": "c1", "name": "Child A",      "order": 2, "result": "Child body" },
        ],
    }));

    // Preamble, then header-body merged ahead of the child body — bodies only.
    assert_eq!(md, "Intro body\n\nHeader body\n\nChild body");
    // The grouping label must not surface in the exported document.
    assert!(!md.contains("Section One"));
}

#[test]
fn bracket_section_names_stay_flat_and_their_output_survives() {
    // `[SECTION 1]` does not start with the word "section", so it is NOT a header:
    // it stays a flat step and its output is emitted like any other. If it were
    // wrongly grouped as a lone-header section, the heading-drop would delete
    // "Bracket body" (the trap this parity test guards).
    let md = markdown_for(json!({
        "name": "Report",
        "layers": [
            { "id": "a", "name": "[SECTION 1]", "order": 0, "result": "Bracket body" },
            { "id": "b", "name": "Body",        "order": 1, "result": "Real body" },
        ],
    }));

    assert_eq!(md, "Bracket body\n\nReal body");
}

#[test]
fn genuine_one_step_section_keeps_its_lone_output() {
    // INTENTIONAL DIVERGENCE FROM frontend_v3 (deliberate bugfix, approved).
    // The reference `prepareStructuredDocForExport` drops a real `Section n`
    // header with NO children and, with no following step to absorb it, discards
    // its output -> an empty document (silent content loss). In agent-execution
    // every layer produces real content, so this trap erases whole sections of a
    // 272/IB report. We keep the lone header step instead, so its body survives.
    // Bracket `[SECTION n]` names still stay flat for the same reason (see prior
    // test); this only changes the genuine-`Section n`-with-no-children case.
    let md = markdown_for(json!({
        "name": "Report",
        "layers": [
            { "id": "s", "name": "Section One", "order": 0, "result": "Only body" },
        ],
    }));

    assert_eq!(md, "Only body");
}

#[test]
fn export_order_follows_layer_order_not_input_order() {
    // Export order is a stable sort by `layer.order` ascending (NOT topo / input
    // order). Layers supplied out of order must emit sorted.
    let md = markdown_for(json!({
        "name": "Report",
        "layers": [
            { "id": "g", "name": "Gamma", "order": 2, "result": "third" },
            { "id": "a", "name": "Alpha", "order": 0, "result": "first" },
            { "id": "b", "name": "Beta",  "order": 1, "result": "second" },
        ],
    }));

    assert_eq!(md, "first\n\nsecond\n\nthird");
}

// --- 3. Sanitizer strips -----------------------------------------------------

#[test]
fn sanitizer_strips_placeholder_noise_lines_within_a_body() {
    // Noise lines interleaved with real prose are removed line-by-line; the real
    // lines stay adjacent (they were consecutive, minus the stripped lines).
    let md = markdown_for(json!({
        "name": "Report",
        "layers": [
            { "id": "a", "name": "Mixed", "order": 0, "result":
                "Real intro line.\nNo Source Text Identified.\n(no output)\nInput text Test\nReal closing line." },
        ],
    }));

    assert_eq!(md, "Real intro line.\nReal closing line.");
    assert!(!md.to_lowercase().contains("no source text identified"));
    assert!(!md.to_lowercase().contains("(no output)"));
    assert!(!md.contains("Input text Test"));
}

#[test]
fn sanitizer_drops_placeholder_only_step_but_keeps_real_neighbours() {
    // A step whose body is *only* placeholder text is dropped whole; its real
    // neighbours survive, separated by one blank line.
    let md = markdown_for(json!({
        "name": "Report",
        "layers": [
            { "id": "a", "name": "Intro", "order": 0, "result": "Kept intro." },
            // Placeholder-only body -> whole step dropped, no orphaned line.
            { "id": "b", "name": "Synth", "order": 1, "result": "**No source text identified.**" },
            { "id": "c", "name": "Outro", "order": 2, "result": "Kept outro." },
        ],
    }));

    assert_eq!(md, "Kept intro.\n\nKept outro.");
}

#[test]
fn sanitizer_preserves_placeholder_lines_inside_fenced_code() {
    // Fence-aware: noise-looking lines inside a ``` fence are code, not noise, and
    // must be preserved verbatim (both the fence body and the surrounding prose).
    let md = markdown_for(json!({
        "name": "Report",
        "layers": [
            { "id": "a", "name": "Body", "order": 0, "result":
                "Before.\n\n```md\nNo source text identified.\n(no output)\n```\n\nAfter." },
        ],
    }));

    assert_eq!(
        md,
        "Before.\n\n```md\nNo source text identified.\n(no output)\n```\n\nAfter."
    );
}

#[test]
fn excess_blank_lines_collapse_to_a_single_blank_line() {
    // Runs of 3+ newlines within a body collapse to exactly one blank line.
    let md = markdown_for(json!({
        "name": "Report",
        "layers": [
            { "id": "a", "name": "Body", "order": 0, "result": "Line one\n\n\n\nLine two" },
        ],
    }));

    assert_eq!(md, "Line one\n\nLine two");
}

#[test]
fn all_placeholder_agent_yields_empty_document() {
    // Every step is empty or placeholder-only -> the exported document is "".
    let md = markdown_for(json!({
        "name": "Report",
        "layers": [
            { "id": "a", "name": "Blank",  "order": 0, "result": "   \n  " },
            { "id": "b", "name": "Synth",  "order": 1, "result": "No source text identified." },
        ],
    }));

    assert_eq!(md, "");
}
