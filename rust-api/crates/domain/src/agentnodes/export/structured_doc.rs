//! Structured-document assembly for the canvas-272 export subtree.
//!
//! Ports `buildStructuredDoc` (and the `StructuredDoc` shape it produces) from
//! `frontend_v3/app/canvas-272/lib/exportFormatter.ts` under
//! **equivalent-behavior** parity. This module is pure: it turns a
//! [`PortableAgent`] (the Rust equivalent of the reference `Canvas272Agent`) plus
//! a map of sidecar output edits into the ordered [`StructuredDoc`] consumed by
//! the export sanitizers and the markdown renderer.
//!
//! ## What this unit owns
//!
//! Only [`build_structured_doc`] and the [`StructuredDoc`] / [`StructuredDocSection`]
//! / [`StructuredDocStep`] DTOs. The sanitizers (`prepareStructuredDocForExport`,
//! `sanitizeMarkdownForDocumentPreview`, …) and the markdown renderer
//! (`structuredDocToMarkdown`) live in the sibling `sanitize` / `markdown` units,
//! which import the DTOs defined here.
//!
//! ## Numbering (parity-critical)
//!
//! A single running counter drives the visible step numbers. Standalone
//! (non-section) steps and section header layers get flat numbers (`"1"`, `"2"`,
//! …); a section header's children are numbered `"{header}.{i+1}"` (`"2.1"`,
//! `"2.2"`, …) — the child prefix is the header's own number, not the raw
//! counter. Section grouping comes entirely from [`build_diagram_model`], so the
//! verbatim `/^section\b/i` header rule (and the "`[SECTION n]` stays flat" trap)
//! is already enforced upstream in `diagram`.
//!
//! ## `exportedAt`
//!
//! The reference stamps `new Date().toISOString()`. This value is **live** and is
//! explicitly *not* hashed, so byte-for-byte reproduction is impossible even
//! reference-vs-reference (see the port plan, "Cannot be identical"). The domain
//! crate has no `chrono` dependency, so — mirroring the established codebase
//! pattern (`community/store_prompt_comment_handler.rs`) — the current UTC instant
//! is formatted from [`std::time::SystemTime`] with plain integer date math,
//! yielding a `YYYY-MM-DDTHH:MM:SS.mmmZ` string that matches the JS
//! `toISOString()` shape.
//!
//! ## Section tags
//!
//! `migrateSectionNamesToTags` (`migrateSectionTags.ts`) is not part of this
//! unit's declared dependency set, so a faithful private copy lives here
//! ([`migrate_section_names_to_tags`]). It relies only on the public `diagram`
//! helpers. Tags feed [`StructuredDocSection::tag`] but never affect markdown
//! output (order + inclusion + sanitize are the only things that ship there), so
//! this metadata is carried, not rendered.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::agentnodes::dto::{ExecutionLayer, PortableAgent};
use crate::agentnodes::export::diagram::{
    MainLaneItem, build_diagram_model, extract_active_sorted_layers, is_section_header_name,
};
use crate::agentnodes::export::display_name::format_agent_display_name;
use crate::agentnodes::export::layer_output::{append_layer_images_markdown, get_layer_output_text};

/// One numbered step of a [`StructuredDocSection`].
///
/// Mirrors the reference `StructuredDocStep` interface.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredDocStep {
    /// Visible step number: flat (`"1"`) for standalone steps and section
    /// headers, dotted (`"2.1"`) for a section header's children.
    pub number: String,
    /// The step's display name (the raw layer name; sanitization happens later in
    /// the `sanitize` unit).
    pub name: String,
    /// The resolved output text (sidecar edit if present and non-blank, otherwise
    /// the layer's probed output), with any generated images appended as markdown.
    pub output: String,
}

/// A section of the structured document: either the anonymous prelude (steps that
/// precede the first section header, `heading == None`) or a detected section.
///
/// Mirrors the reference `StructuredDocSection` interface.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredDocSection {
    /// The section label, or `None` for the anonymous prelude. Always serialized
    /// (emits `null` for the prelude) to match the reference wire shape.
    #[serde(default)]
    pub heading: Option<String>,
    /// The ordered steps in this section.
    pub steps: Vec<StructuredDocStep>,
    /// The section's tag (real or synthetic `__sec-{id}`), keyed off the header
    /// layer. Absent for the prelude and for headers with no tag.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
}

/// The assembled structured document. Mirrors the reference `StructuredDoc`
/// interface.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredDoc {
    /// The document title (the agent's display name).
    pub title: String,
    /// The agent's display name (identical to `title` here, kept as a distinct
    /// field so downstream sanitizers can compare step names against it).
    pub agent_name: String,
    /// Live export timestamp, `YYYY-MM-DDTHH:MM:SS.mmmZ` (never hashed).
    pub exported_at: String,
    /// The ordered sections (prelude first when present, then detected sections).
    pub sections: Vec<StructuredDocSection>,
}

/// Assemble a [`StructuredDoc`] from an agent and its sidecar output edits.
///
/// Ports `buildStructuredDoc`. Steps are walked in diagram (`mainLane`) order:
/// standalone steps accumulate into a prelude (flushed as a `heading: None`
/// section on the first section header, and once more at the end); each section
/// header opens a section whose header step is numbered flatly and whose children
/// are numbered `"{header}.{i+1}"`. Per-step output is resolved via the sidecar
/// map first (non-blank edit wins), then the layer's probed output
/// ([`get_layer_output_text`]), with generated images appended
/// ([`append_layer_images_markdown`]). Section tags come from
/// [`migrate_section_names_to_tags`] and are attached by header id.
pub fn build_structured_doc(
    agent: &PortableAgent,
    sidecar_outputs: &HashMap<String, String>,
) -> StructuredDoc {
    let model = build_diagram_model(&agent.layers);
    let migrated_layers = migrate_section_names_to_tags(&agent.layers);

    // Map layer id -> trimmed tag (real or synthetic), matching the reference's
    // `tagByLayerId` built from the active, sorted, migrated layers.
    let mut tag_by_layer_id: HashMap<String, String> = HashMap::new();
    for layer in extract_active_sorted_layers(&migrated_layers) {
        let trimmed = layer.tag.as_deref().map(str::trim).unwrap_or("");
        if !trimmed.is_empty() {
            tag_by_layer_id.insert(layer.id.clone(), trimmed.to_string());
        }
    }

    // Resolve a step's output: a non-blank sidecar edit wins, else the non-blank
    // fallback, else the empty string (mirrors the reference `resolveOutput`).
    let resolve_output = |layer_id: &str, fallback: String| -> String {
        if let Some(edited) = sidecar_outputs.get(layer_id) {
            if !edited.trim().is_empty() {
                return edited.clone();
            }
        }
        if !fallback.trim().is_empty() {
            fallback
        } else {
            String::new()
        }
    };

    let mut sections: Vec<StructuredDocSection> = Vec::new();
    let mut prelude: Vec<StructuredDocStep> = Vec::new();
    let mut step_number: u64 = 1;

    for item in &model.main_lane {
        match item {
            MainLaneItem::Step { layer, .. } => {
                let output = append_layer_images_markdown(
                    &resolve_output(layer.id.as_str(), get_layer_output_text(layer)),
                    layer,
                );
                prelude.push(StructuredDocStep {
                    number: step_number.to_string(),
                    name: layer.name.clone(),
                    output,
                });
                step_number += 1;
            }
            MainLaneItem::Section { section, .. } => {
                // Flush any accumulated prelude before opening the section.
                if !prelude.is_empty() {
                    sections.push(StructuredDocSection {
                        heading: None,
                        steps: std::mem::take(&mut prelude),
                        tag: None,
                    });
                }

                let header = &section.header_layer;
                let header_number = step_number.to_string();
                let header_output = append_layer_images_markdown(
                    &resolve_output(header.id.as_str(), get_layer_output_text(header)),
                    header,
                );
                let mut steps: Vec<StructuredDocStep> = vec![StructuredDocStep {
                    number: header_number.clone(),
                    name: header.name.clone(),
                    output: header_output,
                }];
                step_number += 1;

                for (i, child) in section.children.iter().enumerate() {
                    let child_output = append_layer_images_markdown(
                        &resolve_output(child.id.as_str(), get_layer_output_text(child)),
                        child,
                    );
                    steps.push(StructuredDocStep {
                        number: format!("{}.{}", header_number, i + 1),
                        name: child.name.clone(),
                        output: child_output,
                    });
                    step_number += 1;
                }

                let section_tag = tag_by_layer_id.get(&header.id).cloned();
                sections.push(StructuredDocSection {
                    heading: Some(section.label.clone()),
                    steps,
                    tag: section_tag,
                });
            }
        }
    }

    // Flush a trailing prelude (steps after the last section, or an all-flat doc).
    if !prelude.is_empty() {
        sections.push(StructuredDocSection {
            heading: None,
            steps: prelude,
            tag: None,
        });
    }

    let display_name = format_agent_display_name(&agent.name);
    StructuredDoc {
        title: display_name.clone(),
        agent_name: display_name,
        exported_at: current_utc_iso8601_timestamp(),
        sections,
    }
}

/// Private port of `migrateSectionTags.ts::migrateSectionNamesToTags`.
///
/// Not part of this unit's declared dependency set (the `section_tags` module is
/// built separately), so a faithful copy lives here to keep `structured_doc`
/// self-contained. It uses only the public `diagram` helpers
/// ([`extract_active_sorted_layers`], [`is_section_header_name`]).
///
/// If any active layer already carries a non-blank tag the input is returned
/// unchanged; otherwise a synthetic `__sec-{id}` tag is minted per section header
/// and propagated to that header and its following non-header layers.
fn migrate_section_names_to_tags(layers: &[ExecutionLayer]) -> Vec<ExecutionLayer> {
    let sorted = extract_active_sorted_layers(layers);
    let has_any_tag = sorted
        .iter()
        .any(|layer| layer.tag.as_deref().map(|t| !t.trim().is_empty()).unwrap_or(false));
    if has_any_tag {
        return layers.to_vec();
    }

    let mut current_synthetic_tag: Option<String> = None;
    let mut tag_by_layer_id: HashMap<String, String> = HashMap::new();
    for layer in &sorted {
        if is_section_header_name(&layer.name) {
            let synthetic = format!("__sec-{}", layer.id);
            tag_by_layer_id.insert(layer.id.clone(), synthetic.clone());
            current_synthetic_tag = Some(synthetic);
        } else if let Some(synthetic) = &current_synthetic_tag {
            tag_by_layer_id.insert(layer.id.clone(), synthetic.clone());
        }
    }

    if tag_by_layer_id.is_empty() {
        return layers.to_vec();
    }

    layers
        .iter()
        .map(|layer| match tag_by_layer_id.get(&layer.id) {
            Some(synthetic) => {
                let mut cloned = layer.clone();
                cloned.tag = Some(synthetic.clone());
                cloned
            }
            None => layer.clone(),
        })
        .collect()
}

/// Current UTC instant as an ISO-8601 string (`YYYY-MM-DDTHH:MM:SS.mmmZ`).
///
/// Formatted from [`std::time::SystemTime`] because the domain crate has no
/// date/time crate; mirrors the established `SystemTime` timestamp pattern used
/// across the http crate, extended with millisecond precision to match the JS
/// `new Date().toISOString()` shape the reference emits.
fn current_utc_iso8601_timestamp() -> String {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format_unix_millis_as_iso8601(elapsed.as_secs(), elapsed.subsec_millis())
}

/// Convert seconds + milliseconds since the Unix epoch into an ISO-8601 UTC
/// string of the form `YYYY-MM-DDTHH:MM:SS.mmmZ`, using plain integer arithmetic
/// over the proleptic Gregorian calendar (no date/time crate required).
fn format_unix_millis_as_iso8601(seconds_since_epoch: u64, milliseconds: u32) -> String {
    let seconds_of_day = seconds_since_epoch % 86_400;
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;

    let mut remaining_days = seconds_since_epoch / 86_400;
    let mut year: u64 = 1970;
    loop {
        let days_in_year = if is_leap_year(year) { 366 } else { 365 };
        if remaining_days >= days_in_year {
            remaining_days -= days_in_year;
            year += 1;
        } else {
            break;
        }
    }

    let month_lengths = month_lengths_for_year(year);
    let mut month: usize = 0;
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

/// Whether the given proleptic Gregorian year is a leap year.
fn is_leap_year(year: u64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// Day counts per month for the given year (index 0 == January).
fn month_lengths_for_year(year: u64) -> [u64; 12] {
    let february = if is_leap_year(year) { 29 } else { 28 };
    [31, february, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn agent_from(value: serde_json::Value) -> PortableAgent {
        serde_json::from_value(value).expect("agent deserializes")
    }

    fn no_sidecar() -> HashMap<String, String> {
        HashMap::new()
    }

    #[test]
    fn flat_prelude_numbers_sequentially_in_one_headingless_section() {
        let agent = agent_from(json!({
            "name": "Plain agent",
            "layers": [
                { "id": "a", "name": "Intro", "order": 0, "result": "AA" },
                { "id": "b", "name": "Body", "order": 1, "result": "BB" },
            ],
        }));
        let doc = build_structured_doc(&agent, &no_sidecar());

        assert_eq!(doc.title, "Plain agent");
        assert_eq!(doc.agent_name, "Plain agent");
        assert_eq!(doc.sections.len(), 1);

        let section = &doc.sections[0];
        assert_eq!(section.heading, None);
        assert_eq!(section.tag, None);
        let numbered: Vec<(&str, &str, &str)> = section
            .steps
            .iter()
            .map(|s| (s.number.as_str(), s.name.as_str(), s.output.as_str()))
            .collect();
        assert_eq!(
            numbered,
            vec![("1", "Intro", "AA"), ("2", "Body", "BB")]
        );
    }

    #[test]
    fn section_children_use_dotted_numbers_and_synthetic_tag() {
        let agent = agent_from(json!({
            "name": "Report",
            "layers": [
                { "id": "p", "name": "Preamble", "order": 0, "result": "P" },
                { "id": "s", "name": "Section One", "order": 1, "result": "S" },
                { "id": "c1", "name": "Child A", "order": 2, "result": "C1" },
                { "id": "c2", "name": "Child B", "order": 3, "result": "C2" },
            ],
        }));
        let doc = build_structured_doc(&agent, &no_sidecar());

        // Prelude flushed as a heading-less section, then the detected section.
        assert_eq!(doc.sections.len(), 2);

        let prelude = &doc.sections[0];
        assert_eq!(prelude.heading, None);
        assert_eq!(prelude.tag, None);
        assert_eq!(prelude.steps.len(), 1);
        assert_eq!(prelude.steps[0].number, "1");
        assert_eq!(prelude.steps[0].name, "Preamble");

        let section = &doc.sections[1];
        assert_eq!(section.heading.as_deref(), Some("Section One"));
        // No real tags anywhere -> synthetic tag keyed off the header id.
        assert_eq!(section.tag.as_deref(), Some("__sec-s"));

        let numbered: Vec<(&str, &str)> = section
            .steps
            .iter()
            .map(|s| (s.number.as_str(), s.name.as_str()))
            .collect();
        assert_eq!(
            numbered,
            vec![
                ("2", "Section One"),
                ("2.1", "Child A"),
                ("2.2", "Child B"),
            ]
        );
    }

    #[test]
    fn sidecar_edit_overrides_when_non_blank_else_falls_back() {
        let agent = agent_from(json!({
            "name": "Report",
            "layers": [
                { "id": "a", "name": "Intro", "order": 0, "result": "original" },
                { "id": "b", "name": "Body", "order": 1, "result": "keep-me" },
            ],
        }));
        let mut sidecar = HashMap::new();
        sidecar.insert("a".to_string(), "edited".to_string());
        // Blank sidecar edit for 'b' must be ignored -> falls back to layer output.
        sidecar.insert("b".to_string(), "   ".to_string());

        let doc = build_structured_doc(&agent, &sidecar);
        let steps = &doc.sections[0].steps;
        assert_eq!(steps[0].output, "edited");
        assert_eq!(steps[1].output, "keep-me");
    }

    #[test]
    fn preexisting_real_tag_is_used_and_not_overwritten() {
        let agent = agent_from(json!({
            "name": "Report",
            "layers": [
                { "id": "s", "name": "Section One", "order": 0, "tag": "REAL", "result": "S" },
                { "id": "c", "name": "Child", "order": 1, "result": "C" },
            ],
        }));
        let doc = build_structured_doc(&agent, &no_sidecar());
        // hasAnyTag == true -> no synthetic tags; the header's own tag is used.
        assert_eq!(doc.sections.len(), 1);
        assert_eq!(doc.sections[0].tag.as_deref(), Some("REAL"));
    }

    #[test]
    fn images_are_appended_to_resolved_output() {
        let agent = agent_from(json!({
            "name": "Report",
            "layers": [
                { "id": "a", "name": "Figure", "order": 0, "result": "caption", "imageUrls": ["u1"] },
            ],
        }));
        let doc = build_structured_doc(&agent, &no_sidecar());
        assert_eq!(
            doc.sections[0].steps[0].output,
            "caption\n\n![generated image](u1)"
        );
    }

    #[test]
    fn bracket_tagged_names_stay_flat_and_are_not_dropped() {
        // `[SECTION 1]` is not a `/^section\b/i` header, so it stays a plain step.
        let agent = agent_from(json!({
            "name": "Report",
            "layers": [
                { "id": "a", "name": "[SECTION 1]", "order": 0, "result": "A" },
                { "id": "b", "name": "Body", "order": 1, "result": "B" },
            ],
        }));
        let doc = build_structured_doc(&agent, &no_sidecar());
        assert_eq!(doc.sections.len(), 1);
        assert_eq!(doc.sections[0].heading, None);
        assert_eq!(doc.sections[0].steps.len(), 2);
        assert_eq!(doc.sections[0].steps[0].number, "1");
        assert_eq!(doc.sections[0].steps[1].number, "2");
    }

    #[test]
    fn exported_at_has_iso8601_utc_shape() {
        let agent = agent_from(json!({
            "name": "Report",
            "layers": [{ "id": "a", "name": "Intro", "order": 0, "result": "A" }],
        }));
        let doc = build_structured_doc(&agent, &no_sidecar());
        let ts = &doc.exported_at;
        assert!(ts.ends_with('Z'), "timestamp should end with Z: {ts}");
        assert!(ts.contains('T'), "timestamp should contain T: {ts}");
        assert!(ts.contains('.'), "timestamp should carry milliseconds: {ts}");
        // YYYY-MM-DDTHH:MM:SS.mmmZ == 24 characters.
        assert_eq!(ts.len(), 24, "unexpected timestamp length: {ts}");
    }

    #[test]
    fn iso8601_formatting_is_correct_for_known_epoch() {
        // 2021-01-01T00:00:00.000Z == 1_609_459_200 seconds since the epoch.
        assert_eq!(
            format_unix_millis_as_iso8601(1_609_459_200, 0),
            "2021-01-01T00:00:00.000Z"
        );
        // A leap-year date with sub-second precision.
        assert_eq!(
            format_unix_millis_as_iso8601(1_582_934_400 + 7, 42),
            "2020-02-29T00:00:07.042Z"
        );
    }
}
