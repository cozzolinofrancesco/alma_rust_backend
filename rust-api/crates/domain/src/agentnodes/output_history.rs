//! Per-layer output-history version bumping for the agent-execution engine.
//!
//! Ported from `frontend_v3/app/lib/agentOutputHistory.ts` (`recordAgentOutput`)
//! under **equivalent-behavior** parity.
//!
//! Why this is parity-critical (see the port plan's "Engine (loud failures)" and
//! `runs/advance` notes): `record_agent_output` is invoked identically by
//! `executePortableStep`, `verifyCheckpoint`, and `materializeAgent`. All three
//! must derive the **same** `outputHistory` (and therefore the same version
//! numbers) for a given layer + output + timestamp. If the version bump drifts
//! between those call sites, the checkpoint's `planHash`/state no longer verifies
//! and **every `runs/advance` returns `CHECKPOINT_CONFLICT` (409)**.
//!
//! Determinism requirement: this function is **pure**. The reference defaults
//! `timestamp` to `new Date().toISOString()`, but a fresh clock would make
//! `execute` and `verify` disagree. The domain crate takes no I/O, so the caller
//! supplies the (already-persisted) `timestamp` — this is exactly what makes the
//! three call sites reproduce identical history.
//!
//! Nullish vs. falsy semantics are reproduced exactly:
//! * `layer.result ?? layer.output ?? ''` is **nullish coalescing** — an existing
//!   empty string `""` is preserved (it does not fall through to `output`).
//! * `layer.modified || layer.created || timestamp` is **logical OR** — an empty
//!   string is falsy and falls through to the next candidate.

use serde_json::Value;

use crate::agentnodes::dto::{ExecutionLayer, OutputVersion};

/// The new output being recorded onto a layer.
///
/// Mirrors the reference's `{ result: string; imageUrls?: string[] }` argument.
/// `image_urls == None` is equivalent to the reference's `imageUrls ?? []`
/// (an absent array becomes empty).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RecordedOutput {
    /// The step's textual result (`output.result`).
    pub result: String,
    /// Generated image URLs, if any (`output.imageUrls`).
    pub image_urls: Option<Vec<String>>,
}

impl RecordedOutput {
    /// Convenience constructor for a text-only output (no images).
    pub fn text(result: impl Into<String>) -> Self {
        Self {
            result: result.into(),
            image_urls: None,
        }
    }
}

/// Append `output` to `layer`'s output history, bumping the version to
/// `max(existing versions, 0) + 1`, and return the updated layer.
///
/// Mirrors `recordAgentOutput` in `agentOutputHistory.ts`. The returned layer is
/// a fresh value (the reference performs an immutable update); the input `layer`
/// is left untouched. `result`, `image_urls`, and `output_history` are always set
/// on the result (`Some(_)`), matching the reference's non-optional return shape.
///
/// If the layer carries a prior result/images but no `outputHistory` yet, an
/// implicit `version: 1` entry is back-filled first (so the newly recorded output
/// becomes `version: 2`), matching the reference. The back-filled entry's
/// timestamp is `modified || created || timestamp` read from the layer's
/// passthrough bag (`ExecutionLayer` does not type `modified`/`created`; they
/// live in `.passthrough`), with empty strings treated as absent.
pub fn record_agent_output(
    layer: &ExecutionLayer,
    output: RecordedOutput,
    timestamp: &str,
) -> ExecutionLayer {
    // `(layer.outputHistory ?? []).map(v => ({ ...v, imageUrls: [...v.imageUrls] }))`
    // — cloning the Vec deep-copies each version's `image_urls` too.
    let mut history: Vec<OutputVersion> = layer.output_history.clone().unwrap_or_default();

    // `layer.result ?? layer.output ?? ''` — nullish, so an existing "" is kept.
    let previous_result: String = layer
        .result
        .clone()
        .or_else(|| layer.output.clone())
        .unwrap_or_default();

    // `layer.imageUrls?.length` — truthy only for a present, non-empty array.
    let has_prior_images = layer
        .image_urls
        .as_ref()
        .is_some_and(|urls| !urls.is_empty());

    if history.is_empty() && (!previous_result.is_empty() || has_prior_images) {
        history.push(OutputVersion {
            version: 1,
            // `layer.modified || layer.created || timestamp` — logical OR: empty
            // strings are falsy and fall through to the next candidate.
            timestamp: nonempty_passthrough_str(layer, "modified")
                .or_else(|| nonempty_passthrough_str(layer, "created"))
                .unwrap_or_else(|| timestamp.to_string()),
            result: previous_result,
            image_urls: layer.image_urls.clone().unwrap_or_default(),
        });
    }

    // `history.reduce((h, v) => Math.max(h, v.version), 0) + 1`, evaluated AFTER
    // the back-fill push (so a back-filled v1 yields a next version of 2). This is
    // max-of-versions + 1, NOT the history length.
    let next_version = history.iter().map(|version| version.version).max().unwrap_or(0) + 1;

    // `[...(output.imageUrls ?? [])]`.
    let image_urls: Vec<String> = output.image_urls.unwrap_or_default();
    let result = output.result;

    history.push(OutputVersion {
        version: next_version,
        timestamp: timestamp.to_string(),
        result: result.clone(),
        image_urls: image_urls.clone(),
    });

    // `{ ...layer, result, imageUrls, outputHistory }` — every other field
    // (including `output`) is carried over unchanged.
    let mut updated = layer.clone();
    updated.result = Some(result);
    updated.image_urls = Some(image_urls);
    updated.output_history = Some(history);
    updated
}

/// Read a passthrough string field, treating absent/non-string/empty as `None`.
///
/// Reproduces JavaScript's falsy-string behaviour for the `modified`/`created`
/// candidates: `undefined` and `""` are both falsy, so both yield `None`.
fn nonempty_passthrough_str(layer: &ExecutionLayer, key: &str) -> Option<String> {
    layer
        .passthrough
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TS: &str = "2026-09-22T12:00:00Z";

    fn layer(value: serde_json::Value) -> ExecutionLayer {
        serde_json::from_value(value).expect("layer deserializes")
    }

    fn base(extra: serde_json::Value) -> ExecutionLayer {
        // Start from a minimal valid layer, merging in the test-specific keys.
        let mut obj = json!({ "id": "layer-1", "name": "Step 1" });
        if let (Some(dst), Some(src)) = (obj.as_object_mut(), extra.as_object()) {
            for (key, val) in src {
                dst.insert(key.clone(), val.clone());
            }
        }
        layer(obj)
    }

    #[test]
    fn records_first_output_as_version_one() {
        let recorded = record_agent_output(&base(json!({})), RecordedOutput::text("hello"), TS);

        assert_eq!(recorded.result.as_deref(), Some("hello"));
        assert_eq!(recorded.image_urls, Some(vec![]));
        let history = recorded.output_history.expect("history is set");
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].version, 1);
        assert_eq!(history[0].result, "hello");
        assert_eq!(history[0].timestamp, TS);
    }

    #[test]
    fn backfills_prior_result_then_appends() {
        // Prior `result` but no `outputHistory` → back-fill v1, new output is v2.
        let recorded = record_agent_output(
            &base(json!({ "result": "old" })),
            RecordedOutput::text("new"),
            TS,
        );

        let history = recorded.output_history.expect("history is set");
        assert_eq!(history.len(), 2);
        assert_eq!((history[0].version, history[0].result.as_str()), (1, "old"));
        assert_eq!((history[1].version, history[1].result.as_str()), (2, "new"));
        // No modified/created → back-fill uses the supplied timestamp.
        assert_eq!(history[0].timestamp, TS);
        assert_eq!(recorded.result.as_deref(), Some("new"));
    }

    #[test]
    fn backfill_falls_back_to_output_field_when_result_absent() {
        // `layer.result ?? layer.output` → legacy `output` seeds the v1 back-fill.
        let recorded = record_agent_output(
            &base(json!({ "output": "legacy" })),
            RecordedOutput::text("fresh"),
            TS,
        );

        let history = recorded.output_history.expect("history is set");
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].result, "legacy");
        assert_eq!(history[1].result, "fresh");
    }

    #[test]
    fn backfill_timestamp_prefers_modified_then_created_then_param() {
        // modified present → used.
        let with_modified = record_agent_output(
            &base(json!({ "result": "x", "modified": "2020-01-01T00:00:00Z", "created": "2019-01-01T00:00:00Z" })),
            RecordedOutput::text("y"),
            TS,
        );
        assert_eq!(
            with_modified.output_history.unwrap()[0].timestamp,
            "2020-01-01T00:00:00Z",
        );

        // modified is empty (falsy) → falls through to created.
        let empty_modified = record_agent_output(
            &base(json!({ "result": "x", "modified": "", "created": "2021-05-05T00:00:00Z" })),
            RecordedOutput::text("y"),
            TS,
        );
        assert_eq!(
            empty_modified.output_history.unwrap()[0].timestamp,
            "2021-05-05T00:00:00Z",
        );

        // neither present → falls through to the supplied timestamp.
        let neither = record_agent_output(
            &base(json!({ "result": "x" })),
            RecordedOutput::text("y"),
            TS,
        );
        assert_eq!(neither.output_history.unwrap()[0].timestamp, TS);
    }

    #[test]
    fn empty_prior_result_with_images_still_backfills() {
        // previousResult == "" but prior imageUrls non-empty → back-fill fires.
        let recorded = record_agent_output(
            &base(json!({ "result": "", "imageUrls": ["u1"] })),
            RecordedOutput::text("next"),
            TS,
        );

        let history = recorded.output_history.expect("history is set");
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].version, 1);
        assert_eq!(history[0].result, "");
        assert_eq!(history[0].image_urls, vec!["u1".to_string()]);
        assert_eq!(history[1].version, 2);
    }

    #[test]
    fn empty_prior_result_no_images_no_history_skips_backfill() {
        // previousResult == "", no images, no history → NO back-fill; new is v1.
        let recorded = record_agent_output(
            &base(json!({ "result": "" })),
            RecordedOutput::text("first"),
            TS,
        );

        let history = recorded.output_history.expect("history is set");
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].version, 1);
        assert_eq!(history[0].result, "first");
    }

    #[test]
    fn next_version_is_max_plus_one_not_count() {
        // Existing history whose max version (5) exceeds its length → next is 6.
        let recorded = record_agent_output(
            &base(json!({
                "result": "prev",
                "outputHistory": [
                    { "version": 5, "timestamp": TS, "result": "prev", "imageUrls": [] }
                ],
            })),
            RecordedOutput::text("y"),
            TS,
        );

        let history = recorded.output_history.expect("history is set");
        // No back-fill (history already non-empty); append at max+1 = 6.
        assert_eq!(history.len(), 2);
        assert_eq!(history[1].version, 6);
    }

    #[test]
    fn output_image_urls_are_recorded_and_default_to_empty() {
        let with_images = record_agent_output(
            &base(json!({})),
            RecordedOutput { result: "r".into(), image_urls: Some(vec!["a".into(), "b".into()]) },
            TS,
        );
        assert_eq!(with_images.image_urls, Some(vec!["a".to_string(), "b".to_string()]));
        assert_eq!(
            with_images.output_history.unwrap()[0].image_urls,
            vec!["a".to_string(), "b".to_string()],
        );

        // None output images → empty vec (mirrors `imageUrls ?? []`).
        let no_images = record_agent_output(&base(json!({})), RecordedOutput::text("r"), TS);
        assert_eq!(no_images.image_urls, Some(vec![]));
    }

    #[test]
    fn input_layer_is_not_mutated() {
        let original = base(json!({ "result": "old" }));
        let _ = record_agent_output(&original, RecordedOutput::text("new"), TS);
        // The source layer is untouched: still the old result, still no history.
        assert_eq!(original.result.as_deref(), Some("old"));
        assert!(original.output_history.is_none());
    }
}
