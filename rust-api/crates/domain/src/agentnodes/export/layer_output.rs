//! Per-layer output-field probing for the canvas-272 export subtree.
//!
//! Ported from `frontend_v3/app/canvas-272/lib/layerOutput.ts` under
//! **equivalent-behavior** parity. This is a pure module: given an
//! [`ExecutionLayer`], it resolves the layer's textual output by probing a fixed
//! ordered list of candidate keys, and it renders any generated images as
//! markdown appended to that text.
//!
//! ## Candidate-key order (load-bearing)
//!
//! The reference probes keys in exactly this order, returning the first that
//! holds a non-blank string:
//!
//! ```text
//! result, output, assistantResponse, response, text, completion, answer
//! ```
//!
//! In the Rust DTO ([`ExecutionLayer`]) the first three are **typed fields**
//! (`result` / `output` / `assistant_response`); serde extracts them out of the
//! JSON, so they never appear in the `passthrough` bag. The remaining four
//! (`response` / `text` / `completion` / `answer`) are **not** typed, so they land
//! in [`ExecutionLayer::passthrough`]. Probing the three typed fields first and
//! the four passthrough keys second reproduces the reference order exactly.
//!
//! ## Assemble-time interaction (parity trap)
//!
//! `assemblePortableDocument` blanks `output` / `assistantResponse` / `response` /
//! `text` / `completion` / `answer` to `''` and sets `result`, so in the export
//! path `result` normally wins here. The blank-and-set contract in the assemble
//! unit must be preserved or this probe reads a stale field (see the port plan's
//! "Parity requirements").

use serde_json::Value;

use crate::agentnodes::dto::ExecutionLayer;

/// Candidate output keys that live only in the layer's `passthrough` bag, in
/// probe order. The earlier keys (`result` / `output` / `assistantResponse`) are
/// typed fields on [`ExecutionLayer`] and are probed before these.
const PASSTHROUGH_CANDIDATE_KEYS: [&str; 4] = ["response", "text", "completion", "answer"];

/// Resolve a layer's textual output by the canvas-272 candidate-key probe.
///
/// Mirrors `getLayerOutputText`: walk the candidate keys in order
/// (`result`, `output`, `assistantResponse`, then `response`, `text`,
/// `completion`, `answer`) and return the first value that is a string whose
/// trimmed length is greater than zero. The **untrimmed** original string is
/// returned. If no candidate qualifies, returns an empty string.
pub fn get_layer_output_text(layer: &ExecutionLayer) -> String {
    // Typed candidate fields, in reference order: result, output, assistantResponse.
    for candidate in [
        layer.result.as_deref(),
        layer.output.as_deref(),
        layer.assistant_response.as_deref(),
    ] {
        if let Some(val) = candidate {
            if !val.trim().is_empty() {
                return val.to_string();
            }
        }
    }

    // Remaining candidates live only in the passthrough bag, in reference order:
    // response, text, completion, answer.
    for key in PASSTHROUGH_CANDIDATE_KEYS {
        if let Some(val) = layer.passthrough.get(key).and_then(Value::as_str) {
            if !val.trim().is_empty() {
                return val.to_string();
            }
        }
    }

    String::new()
}

/// Data URLs of images generated on a step.
///
/// Mirrors `getLayerImageUrls`. Images are stored on `imageUrls` (not `result`)
/// so they never leak into downstream prompts. In the DTO this is the typed
/// [`ExecutionLayer::image_urls`] field (already `Vec<String>` after deserialize,
/// so the reference's `Array.isArray` + string filter is satisfied structurally);
/// an absent field yields an empty list.
pub fn get_layer_image_urls(layer: &ExecutionLayer) -> Vec<String> {
    layer.image_urls.clone().unwrap_or_default()
}

/// Append a layer's generated images to its text output as markdown image syntax.
///
/// Mirrors `appendLayerImagesMarkdown`. When the layer has no images the text is
/// returned unchanged. Otherwise the trimmed text (dropped when empty, matching
/// the reference `.filter(Boolean)`) and one `![generated image](<url>)` line per
/// image are joined by blank lines.
pub fn append_layer_images_markdown(text: &str, layer: &ExecutionLayer) -> String {
    let images = get_layer_image_urls(layer);
    if images.is_empty() {
        return text.to_string();
    }

    let mut parts: Vec<String> = Vec::with_capacity(images.len() + 1);
    let trimmed = text.trim();
    if !trimmed.is_empty() {
        parts.push(trimmed.to_string());
    }
    for url in images {
        parts.push(format!("![generated image]({url})"));
    }
    parts.join("\n\n")
}

/// Diagnostic: report the length of every candidate output field that holds a
/// string on this layer.
///
/// Mirrors `describeLayerOutputFields`. Keyed by the reference candidate-key
/// names (`result` / `output` / `assistantResponse` / `response` / `text` /
/// `completion` / `answer`); a field is reported only when it is present as a
/// string. Lengths are Unicode scalar counts (`char` count), which is adequate
/// under equivalent-behavior parity (exact UTF-16-unit counting is not pursued).
pub fn describe_layer_output_fields(layer: &ExecutionLayer) -> Vec<(&'static str, usize)> {
    let mut report: Vec<(&'static str, usize)> = Vec::new();

    // Typed candidate fields, in reference order.
    let typed: [(&'static str, Option<&str>); 3] = [
        ("result", layer.result.as_deref()),
        ("output", layer.output.as_deref()),
        ("assistantResponse", layer.assistant_response.as_deref()),
    ];
    for (key, val) in typed {
        if let Some(val) = val {
            report.push((key, val.chars().count()));
        }
    }

    // Passthrough candidate keys, in reference order.
    for key in PASSTHROUGH_CANDIDATE_KEYS {
        if let Some(val) = layer.passthrough.get(key).and_then(Value::as_str) {
            report.push((key, val.chars().count()));
        }
    }

    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn layer_from(value: serde_json::Value) -> ExecutionLayer {
        serde_json::from_value(value).expect("layer deserializes")
    }

    #[test]
    fn output_text_prefers_result_over_later_candidates() {
        let layer = layer_from(json!({
            "id": "l1",
            "name": "Step",
            "result": "from result",
            "output": "from output",
            "response": "from response",
        }));
        assert_eq!(get_layer_output_text(&layer), "from result");
    }

    #[test]
    fn output_text_skips_blank_and_falls_through_to_passthrough() {
        // result / output / assistantResponse all blank -> falls through to the
        // passthrough keys in order (response before text).
        let layer = layer_from(json!({
            "id": "l1",
            "name": "Step",
            "result": "   ",
            "output": "",
            "assistantResponse": "\n\t ",
            "response": "  ",
            "text": "from text",
            "completion": "from completion",
        }));
        assert_eq!(get_layer_output_text(&layer), "from text");
    }

    #[test]
    fn output_text_returns_untrimmed_original() {
        let layer = layer_from(json!({
            "id": "l1",
            "name": "Step",
            "output": "  padded value  ",
        }));
        assert_eq!(get_layer_output_text(&layer), "  padded value  ");
    }

    #[test]
    fn output_text_empty_when_no_candidate_qualifies() {
        let layer = layer_from(json!({
            "id": "l1",
            "name": "Step",
            "answer": "   ",
        }));
        assert_eq!(get_layer_output_text(&layer), "");
    }

    #[test]
    fn image_urls_absent_is_empty() {
        let layer = layer_from(json!({ "id": "l1", "name": "Step" }));
        assert!(get_layer_image_urls(&layer).is_empty());
    }

    #[test]
    fn image_urls_returned_in_order() {
        let layer = layer_from(json!({
            "id": "l1",
            "name": "Step",
            "imageUrls": ["data:image/png;base64,AAA", "data:image/png;base64,BBB"],
        }));
        assert_eq!(
            get_layer_image_urls(&layer),
            vec![
                "data:image/png;base64,AAA".to_string(),
                "data:image/png;base64,BBB".to_string(),
            ]
        );
    }

    #[test]
    fn append_images_returns_text_unchanged_without_images() {
        let layer = layer_from(json!({ "id": "l1", "name": "Step" }));
        assert_eq!(append_layer_images_markdown("hello", &layer), "hello");
    }

    #[test]
    fn append_images_joins_trimmed_text_and_markdown() {
        let layer = layer_from(json!({
            "id": "l1",
            "name": "Step",
            "imageUrls": ["u1", "u2"],
        }));
        assert_eq!(
            append_layer_images_markdown("  caption  ", &layer),
            "caption\n\n![generated image](u1)\n\n![generated image](u2)"
        );
    }

    #[test]
    fn append_images_drops_blank_text() {
        let layer = layer_from(json!({
            "id": "l1",
            "name": "Step",
            "imageUrls": ["u1"],
        }));
        assert_eq!(
            append_layer_images_markdown("   ", &layer),
            "![generated image](u1)"
        );
    }

    #[test]
    fn describe_reports_string_candidate_lengths_in_order() {
        let layer = layer_from(json!({
            "id": "l1",
            "name": "Step",
            "result": "abc",
            "text": "de",
        }));
        assert_eq!(
            describe_layer_output_fields(&layer),
            vec![("result", 3), ("text", 2)]
        );
    }
}
