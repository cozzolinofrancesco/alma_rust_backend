//! Section detection + diagram-model assembly for the canvas-272 export subtree.
//!
//! Ported from `frontend_v3/app/canvas-272/lib/sections.ts` under
//! **equivalent-behavior** parity. This module is pure: it turns a flat list of
//! agent layers ([`ExecutionLayer`], the Rust equivalent of the reference
//! `Canvas272Layer`) into the ordered `mainLane` / `sections` model consumed by
//! the markdown/structured-doc export path (`buildStructuredDoc`) and by
//! `migrateSectionTags`.
//!
//! ## Parity-critical behaviour (see the port plan, "Export / markdown")
//!
//! * [`is_section_header_name`] mirrors `isSectionHeaderName = /^section\b/i`
//!   **verbatim**. Only a `name` that *starts* (case-insensitively) with the word
//!   `section` — followed by a word boundary — is a section header. Consequences
//!   that must hold:
//!   - `[SECTION 1]`-style **names and tags are NOT headers** (they do not start
//!     with `section`), so they stay flat. Grouping them as sections would
//!     trigger the one-step-section heading-drop that silently deletes every
//!     output — the highest-risk export trap.
//!   - Section grouping keys off `layer.name` **only**; `layer.tag` is never
//!     consulted here.
//! * [`extract_active_sorted_layers`] filters out layers missing an `id`/`name`
//!   or explicitly `isActive: false`, then performs a **stable** sort by
//!   `order` ascending (missing/non-number `order` counts as `0`) — matching the
//!   reference's ES2019-stable `Array.prototype.sort`.

use std::cmp::Ordering;

use serde::{Deserialize, Serialize};

use crate::agentnodes::dto::ExecutionLayer;

/// One entry of [`DiagramModel::main_lane`].
///
/// Mirrors the TypeScript discriminated union
/// `{ kind: 'step'; layer; globalIndex } | { kind: 'section'; section; globalIndex }`.
/// Serialises internally-tagged on `kind` (`"step"` / `"section"`) to match the
/// wire shape of the reference `DiagramModel['mainLane']` element.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MainLaneItem {
    /// A standalone (non-section-header) step.
    Step {
        layer: ExecutionLayer,
        /// Position of the step within the flattened diagram (`globalIndex`).
        #[serde(rename = "globalIndex")]
        global_index: usize,
    },
    /// A section header together with its grouped child steps.
    Section {
        section: DiagramSection,
        /// Position of the section header within the flattened diagram
        /// (`globalIndex`); children occupy the following slots.
        #[serde(rename = "globalIndex")]
        global_index: usize,
    },
}

/// A section header layer plus the steps grouped beneath it.
///
/// Mirrors the reference `DiagramSection` interface.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramSection {
    /// `section-${layer.id}`.
    pub id: String,
    /// The trimmed header name (`layer.name.trim()`).
    pub label: String,
    /// Index of this section's entry within [`DiagramModel::main_lane`], captured
    /// before the entry is pushed (`mainLaneIndex`).
    pub main_lane_index: usize,
    /// The header layer itself.
    pub header_layer: ExecutionLayer,
    /// Steps that follow the header until the next section header (or the end).
    pub children: Vec<ExecutionLayer>,
}

/// The assembled diagram model: an ordered main lane plus the flat list of
/// detected sections. Mirrors the reference `DiagramModel` interface.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramModel {
    pub main_lane: Vec<MainLaneItem>,
    pub sections: Vec<DiagramSection>,
}

/// Whether `b` is a JavaScript (non-Unicode) regex word character (`[A-Za-z0-9_]`).
///
/// `/^section\b/i` carries no `u` flag, so `\b` uses ASCII word semantics.
#[inline]
fn is_ascii_word_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Returns whether `name` is a section-header name, mirroring
/// `isSectionHeaderName = /^section\b/i` applied to `name.trim()`.
///
/// The reference guards `if (!name) return false`; an empty (or blank) name is
/// shorter than `"section"` and therefore returns `false` here too. The trailing
/// `\b` requires the character after `section` to be a non-word char (or the end
/// of string), so `"Sections"`, `"sectional"`, `"section1"` and `"section_"` are
/// **not** headers, while `"Section 1"`, `"Section-2"`, `"SECTION"` and
/// `"section:"` are. Names such as `"[SECTION 1]"` start with `[`, so they never
/// match — keeping bracket-tagged steps flat.
pub fn is_section_header_name(name: &str) -> bool {
    let trimmed = name.trim();
    let bytes = trimmed.as_bytes();
    // Must begin with the 7 ASCII characters of "section" (case-insensitive).
    if bytes.len() < 7 || !bytes[..7].eq_ignore_ascii_case(b"section") {
        return false;
    }
    // `\b`: boundary iff the next character is a non-word char or the string ends.
    match bytes.get(7) {
        None => true,
        Some(&next) => !is_ascii_word_char(next),
    }
}

/// Effective sort key for a layer: its `order`, or `0` when absent — matching the
/// reference `typeof x.order === 'number' ? x.order : 0`.
#[inline]
fn layer_order(layer: &ExecutionLayer) -> f64 {
    layer.order.unwrap_or(0.0)
}

/// Filters to renderable, active layers and returns them **stably** sorted by
/// `order` ascending.
///
/// Ports `extractActiveSortedLayers`:
/// 1. drop layers with an empty `id` or `name` (`Boolean(layer?.id) && Boolean(layer?.name)`);
/// 2. drop layers explicitly marked `isActive: false` (absent / `true` are kept);
/// 3. stable-sort by `order` ascending, treating a missing `order` as `0`.
///
/// Rust's `slice::sort_by` is stable, matching the reference's ES2019-stable
/// `Array.prototype.sort`, so layers sharing an `order` keep their relative order.
pub fn extract_active_sorted_layers(layers: &[ExecutionLayer]) -> Vec<ExecutionLayer> {
    let mut selected: Vec<ExecutionLayer> = layers
        .iter()
        .filter(|layer| !layer.id.is_empty() && !layer.name.is_empty())
        .filter(|layer| layer.is_active != Some(false))
        .cloned()
        .collect();

    selected.sort_by(|a, b| {
        layer_order(a)
            .partial_cmp(&layer_order(b))
            .unwrap_or(Ordering::Equal)
    });

    selected
}

/// Builds the ordered diagram model from raw layers.
///
/// Ports `buildDiagramModel`: layers are first run through
/// [`extract_active_sorted_layers`], then scanned once. A section-header layer
/// (per [`is_section_header_name`]) opens a section that absorbs every following
/// non-header layer as a child until the next header (or the end); any other
/// layer becomes a standalone step. `globalIndex` advances by one per step and by
/// `1 + children.len()` per section, and each section records the
/// `mainLaneIndex` at which it was placed.
pub fn build_diagram_model(raw_layers: &[ExecutionLayer]) -> DiagramModel {
    let layers = extract_active_sorted_layers(raw_layers);
    let mut main_lane: Vec<MainLaneItem> = Vec::new();
    let mut sections: Vec<DiagramSection> = Vec::new();

    let mut global_index: usize = 0;
    let mut i = 0usize;
    while i < layers.len() {
        let layer = &layers[i];
        if is_section_header_name(&layer.name) {
            let mut children: Vec<ExecutionLayer> = Vec::new();
            let mut j = i + 1;
            while j < layers.len() && !is_section_header_name(&layers[j].name) {
                children.push(layers[j].clone());
                j += 1;
            }
            let section = DiagramSection {
                id: format!("section-{}", layer.id),
                label: layer.name.trim().to_string(),
                main_lane_index: main_lane.len(),
                header_layer: layer.clone(),
                children,
            };
            let children_len = section.children.len();
            sections.push(section.clone());
            main_lane.push(MainLaneItem::Section {
                section,
                global_index,
            });
            global_index += 1 + children_len;
            i = j;
        } else {
            main_lane.push(MainLaneItem::Step {
                layer: layer.clone(),
                global_index,
            });
            global_index += 1;
            i += 1;
        }
    }

    DiagramModel {
        main_lane,
        sections,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn layer(value: serde_json::Value) -> ExecutionLayer {
        serde_json::from_value(value).expect("layer deserializes")
    }

    // --- is_section_header_name (verbatim /^section\b/i parity) ---

    #[test]
    fn section_header_matches_word_then_boundary() {
        assert!(is_section_header_name("Section 1"));
        assert!(is_section_header_name("section 3"));
        assert!(is_section_header_name("SECTION 2"));
        assert!(is_section_header_name("section")); // end-of-string boundary
        assert!(is_section_header_name("Section-2")); // '-' is a boundary
        assert!(is_section_header_name("section:")); // ':' is a boundary
        assert!(is_section_header_name("  Section  ")); // trimmed first
    }

    #[test]
    fn non_section_names_are_not_headers() {
        assert!(!is_section_header_name(""));
        assert!(!is_section_header_name("Introduction"));
        assert!(!is_section_header_name("Sections")); // 's' after "section" -> word char, no boundary
        assert!(!is_section_header_name("sectional")); // 'a' -> word char
        assert!(!is_section_header_name("section1")); // '1' -> word char
        assert!(!is_section_header_name("section_")); // '_' -> word char
    }

    #[test]
    fn bracketed_section_tags_are_not_headers() {
        // Must stay flat: the `[SECTION n]` convention starts with '[', not "section".
        assert!(!is_section_header_name("[SECTION 1]"));
        assert!(!is_section_header_name("[Section 2]"));
    }

    // --- extract_active_sorted_layers ---

    #[test]
    fn filters_inactive_and_incomplete_layers() {
        let layers = vec![
            layer(json!({ "id": "a", "name": "A", "order": 1 })),
            layer(json!({ "id": "b", "name": "B", "order": 0, "isActive": false })),
            layer(json!({ "id": "c", "name": "C", "order": 2, "isActive": true })),
            // empty name -> dropped
            layer(json!({ "id": "d", "name": "", "order": -1 })),
        ];
        let out = extract_active_sorted_layers(&layers);
        let ids: Vec<&str> = out.iter().map(|l| l.id.as_str()).collect();
        // 'b' filtered (isActive false), 'd' filtered (empty name); sorted by order asc.
        assert_eq!(ids, ["a", "c"]);
    }

    #[test]
    fn sort_by_order_is_stable_and_defaults_missing_to_zero() {
        let layers = vec![
            layer(json!({ "id": "x", "name": "X", "order": 5 })),
            // no order -> treated as 0
            layer(json!({ "id": "y", "name": "Y" })),
            // equal order to keep-relative-order check
            layer(json!({ "id": "z1", "name": "Z1", "order": 2 })),
            layer(json!({ "id": "z2", "name": "Z2", "order": 2 })),
        ];
        let out = extract_active_sorted_layers(&layers);
        let ids: Vec<&str> = out.iter().map(|l| l.id.as_str()).collect();
        // y(0) < z1(2) == z2(2, stable after z1) < x(5)
        assert_eq!(ids, ["y", "z1", "z2", "x"]);
    }

    // --- build_diagram_model ---

    #[test]
    fn groups_children_under_section_headers() {
        let layers = vec![
            layer(json!({ "id": "p1", "name": "Prelude", "order": 0 })),
            layer(json!({ "id": "s1", "name": "Section One", "order": 1 })),
            layer(json!({ "id": "c1", "name": "Child A", "order": 2 })),
            layer(json!({ "id": "c2", "name": "Child B", "order": 3 })),
            layer(json!({ "id": "s2", "name": "Section Two", "order": 4 })),
            layer(json!({ "id": "c3", "name": "Child C", "order": 5 })),
        ];
        let model = build_diagram_model(&layers);

        assert_eq!(model.sections.len(), 2);
        assert_eq!(model.main_lane.len(), 3); // prelude step + 2 sections

        match &model.main_lane[0] {
            MainLaneItem::Step {
                layer,
                global_index,
            } => {
                assert_eq!(layer.id, "p1");
                assert_eq!(*global_index, 0);
            }
            other => panic!("expected step, got {other:?}"),
        }

        match &model.main_lane[1] {
            MainLaneItem::Section {
                section,
                global_index,
            } => {
                assert_eq!(section.id, "section-s1");
                assert_eq!(section.label, "Section One");
                assert_eq!(section.main_lane_index, 1);
                assert_eq!(section.header_layer.id, "s1");
                let child_ids: Vec<&str> =
                    section.children.iter().map(|c| c.id.as_str()).collect();
                assert_eq!(child_ids, ["c1", "c2"]);
                assert_eq!(*global_index, 1);
            }
            other => panic!("expected section, got {other:?}"),
        }

        match &model.main_lane[2] {
            MainLaneItem::Section {
                section,
                global_index,
            } => {
                assert_eq!(section.id, "section-s2");
                assert_eq!(section.main_lane_index, 2);
                let child_ids: Vec<&str> =
                    section.children.iter().map(|c| c.id.as_str()).collect();
                assert_eq!(child_ids, ["c3"]);
                // 1 (prelude) + 1 (section one header) + 2 (its children) = 4
                assert_eq!(*global_index, 4);
            }
            other => panic!("expected section, got {other:?}"),
        }
    }

    #[test]
    fn bracket_tagged_names_stay_flat_steps() {
        // `[SECTION 1]` must NOT open a section — it stays a plain step, so its
        // output is never dropped by the one-step-section heading rule.
        let layers = vec![
            layer(json!({ "id": "a", "name": "[SECTION 1]", "order": 0 })),
            layer(json!({ "id": "b", "name": "Body", "order": 1 })),
        ];
        let model = build_diagram_model(&layers);
        assert!(model.sections.is_empty());
        assert_eq!(model.main_lane.len(), 2);
        assert!(matches!(model.main_lane[0], MainLaneItem::Step { .. }));
        assert!(matches!(model.main_lane[1], MainLaneItem::Step { .. }));
    }

    #[test]
    fn all_standalone_steps_produce_no_sections() {
        let layers = vec![
            layer(json!({ "id": "a", "name": "One", "order": 0 })),
            layer(json!({ "id": "b", "name": "Two", "order": 1 })),
        ];
        let model = build_diagram_model(&layers);
        assert!(model.sections.is_empty());
        assert_eq!(model.main_lane.len(), 2);
        match &model.main_lane[1] {
            MainLaneItem::Step { global_index, .. } => assert_eq!(*global_index, 1),
            other => panic!("expected step, got {other:?}"),
        }
    }
}
