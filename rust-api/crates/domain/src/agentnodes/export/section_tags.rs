//! Synthetic section-tag migration for the canvas-272 export subtree.
//!
//! Ported from `frontend_v3/app/canvas-272/lib/migrateSectionTags.ts` under
//! **equivalent-behavior** parity. This is a pure module: given a slice of
//! [`ExecutionLayer`]s it retro-fits a `tag` onto every layer that lives under a
//! "Section …" header, but only when the agent carries no explicit tags at all.
//! Downstream, those tags let the export grouper keep a section and its steps
//! together.
//!
//! ## Shared helpers
//!
//! The reference imports `extractActiveSortedLayers` and `isSectionHeaderName`
//! from `canvas-272/lib/sections.ts`. The Rust home of that module is the sibling
//! [`crate::agentnodes::export::diagram`] unit, which re-implements both as public
//! functions. This module reuses them directly (mirroring the TS import) so the
//! load-bearing `^section\b` header test and the active/sorted filter stay a
//! single source of truth across the export subtree — no drift on the parity trap
//! the port plan flags.
//!
//! ## Parity notes (load-bearing)
//!
//! * Header detection is the verbatim `^section\b` (case-insensitive) test from
//!   [`is_section_header_name`]. `[SECTION n]` names and bare `Section n` tags
//!   therefore stay **flat** (the `[` prefix fails `^section`, so they are never
//!   promoted to headers). Getting this wrong triggers the "1-step-section
//!   heading-drop" trap called out in the port plan's Parity requirements.
//! * `hasAnyTag` short-circuits: if any *active/sorted* layer already carries a
//!   non-blank `tag`, the input is returned untouched (no synthetic tags).
//! * The synthetic tag is `__sec-{headerId}`, applied to the header and every
//!   following non-header layer until the next header. Layers before the first
//!   header stay untagged.

use std::collections::HashMap;

use crate::agentnodes::dto::ExecutionLayer;
use crate::agentnodes::export::diagram::{extract_active_sorted_layers, is_section_header_name};

/// Retro-fit synthetic section tags onto untagged layers.
///
/// Mirrors `migrateSectionNamesToTags`:
/// 1. If any active/sorted layer already has a non-blank `tag`, return the input
///    unchanged (the agent is already tagged; nothing to migrate).
/// 2. Otherwise walk the active/sorted layers: each `Section …` header opens a new
///    synthetic tag `__sec-{headerId}`; that header and every following non-header
///    layer (until the next header) are recorded under that tag. Layers appearing
///    before the first header stay untagged.
/// 3. If no layer received a tag, return the input unchanged.
/// 4. Otherwise return clones of the original layers (in original order) with the
///    synthetic `tag` applied to each recorded id.
pub fn migrate_section_names_to_tags(layers: &[ExecutionLayer]) -> Vec<ExecutionLayer> {
    let sorted = extract_active_sorted_layers(layers);

    let has_any_tag = sorted.iter().any(|layer| {
        layer
            .tag
            .as_deref()
            .is_some_and(|tag| !tag.trim().is_empty())
    });
    if has_any_tag {
        return layers.to_vec();
    }

    let mut current_synthetic_tag: Option<String> = None;
    let mut tag_by_layer_id: HashMap<String, String> = HashMap::new();

    for layer in &sorted {
        if is_section_header_name(&layer.name) {
            let tag = format!("__sec-{}", layer.id);
            current_synthetic_tag = Some(tag.clone());
            tag_by_layer_id.insert(layer.id.clone(), tag);
        } else if let Some(tag) = &current_synthetic_tag {
            tag_by_layer_id.insert(layer.id.clone(), tag.clone());
        }
    }

    if tag_by_layer_id.is_empty() {
        return layers.to_vec();
    }

    layers
        .iter()
        .map(|layer| match tag_by_layer_id.get(&layer.id) {
            Some(syn_tag) => {
                let mut cloned = layer.clone();
                cloned.tag = Some(syn_tag.clone());
                cloned
            }
            None => layer.clone(),
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

    fn tag_of<'a>(layers: &'a [ExecutionLayer], id: &str) -> Option<&'a str> {
        layers
            .iter()
            .find(|l| l.id == id)
            .and_then(|l| l.tag.as_deref())
    }

    #[test]
    fn returns_unchanged_when_any_tag_already_present() {
        let layers = vec![
            layer_from(json!({ "id": "h1", "name": "Section 1", "order": 0 })),
            layer_from(json!({ "id": "s1", "name": "Step", "order": 1, "tag": "manual" })),
        ];
        let out = migrate_section_names_to_tags(&layers);
        assert_eq!(out, layers);
        // Header did NOT receive a synthetic tag.
        assert_eq!(tag_of(&out, "h1"), None);
    }

    #[test]
    fn blank_existing_tag_does_not_count_as_tagged() {
        // A whitespace-only tag is not a real tag -> migration still runs.
        let layers = vec![
            layer_from(json!({ "id": "h1", "name": "Section 1", "order": 0, "tag": "   " })),
            layer_from(json!({ "id": "s1", "name": "Step", "order": 1 })),
        ];
        let out = migrate_section_names_to_tags(&layers);
        assert_eq!(tag_of(&out, "h1"), Some("__sec-h1"));
        assert_eq!(tag_of(&out, "s1"), Some("__sec-h1"));
    }

    #[test]
    fn assigns_synthetic_tag_to_header_and_following_children() {
        let layers = vec![
            layer_from(json!({ "id": "pre", "name": "Preamble", "order": 0 })),
            layer_from(json!({ "id": "h1", "name": "Section 1", "order": 1 })),
            layer_from(json!({ "id": "c1", "name": "Step A", "order": 2 })),
            layer_from(json!({ "id": "c2", "name": "Step B", "order": 3 })),
            layer_from(json!({ "id": "h2", "name": "Section 2", "order": 4 })),
            layer_from(json!({ "id": "c3", "name": "Step C", "order": 5 })),
        ];
        let out = migrate_section_names_to_tags(&layers);
        // Layer before the first header stays untagged.
        assert_eq!(tag_of(&out, "pre"), None);
        // First section groups its header + children.
        assert_eq!(tag_of(&out, "h1"), Some("__sec-h1"));
        assert_eq!(tag_of(&out, "c1"), Some("__sec-h1"));
        assert_eq!(tag_of(&out, "c2"), Some("__sec-h1"));
        // Second header opens a new tag.
        assert_eq!(tag_of(&out, "h2"), Some("__sec-h2"));
        assert_eq!(tag_of(&out, "c3"), Some("__sec-h2"));
        // Original order preserved.
        let ids: Vec<&str> = out.iter().map(|l| l.id.as_str()).collect();
        assert_eq!(ids, vec!["pre", "h1", "c1", "c2", "h2", "c3"]);
    }

    #[test]
    fn no_headers_returns_input_unchanged() {
        let layers = vec![
            layer_from(json!({ "id": "s1", "name": "Intro", "order": 0 })),
            layer_from(json!({ "id": "s2", "name": "Body", "order": 1 })),
        ];
        let out = migrate_section_names_to_tags(&layers);
        assert_eq!(out, layers);
        assert!(out.iter().all(|l| l.tag.is_none()));
    }

    #[test]
    fn grouping_follows_sorted_order_not_input_order() {
        // Input order is scrambled; `order` drives the header/child grouping.
        let layers = vec![
            layer_from(json!({ "id": "c1", "name": "Step A", "order": 2 })),
            layer_from(json!({ "id": "h1", "name": "Section 1", "order": 1 })),
            layer_from(json!({ "id": "c2", "name": "Step B", "order": 3 })),
        ];
        let out = migrate_section_names_to_tags(&layers);
        assert_eq!(tag_of(&out, "h1"), Some("__sec-h1"));
        assert_eq!(tag_of(&out, "c1"), Some("__sec-h1"));
        assert_eq!(tag_of(&out, "c2"), Some("__sec-h1"));
        // Returned in original (input) order.
        let ids: Vec<&str> = out.iter().map(|l| l.id.as_str()).collect();
        assert_eq!(ids, vec!["c1", "h1", "c2"]);
    }

    #[test]
    fn inactive_layers_are_skipped_and_stay_untagged() {
        // Inactive child is excluded from the sorted walk -> never recorded.
        let layers = vec![
            layer_from(json!({ "id": "h1", "name": "Section 1", "order": 0 })),
            layer_from(json!({ "id": "gone", "name": "Step", "order": 1, "isActive": false })),
            layer_from(json!({ "id": "c1", "name": "Step", "order": 2 })),
        ];
        let out = migrate_section_names_to_tags(&layers);
        assert_eq!(tag_of(&out, "h1"), Some("__sec-h1"));
        assert_eq!(tag_of(&out, "gone"), None);
        assert_eq!(tag_of(&out, "c1"), Some("__sec-h1"));
    }

    #[test]
    fn section_prefixed_name_stays_flat_as_child() {
        // "[SECTION 1]" is not a header, so under a real header it becomes a child.
        let layers = vec![
            layer_from(json!({ "id": "h1", "name": "Section One", "order": 0 })),
            layer_from(json!({ "id": "flat", "name": "[SECTION 1]", "order": 1 })),
        ];
        let out = migrate_section_names_to_tags(&layers);
        assert_eq!(tag_of(&out, "h1"), Some("__sec-h1"));
        assert_eq!(tag_of(&out, "flat"), Some("__sec-h1"));
    }
}
