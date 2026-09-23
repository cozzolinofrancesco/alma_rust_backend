//! Shared step prompt-assembly for the portable agent-execution engine.
//!
//! Ported 1:1 (equivalent-behavior parity) from `frontend_v3/app/lib/stepPrompt.ts`,
//! the single source of truth for user-message framing, the code-output directive,
//! permanent-skill composition, and referenced-step context formatting. Both editor
//! views in the reference (the linear "Agent Steps" form and the "Agent Nodes" graph
//! runner) route through these functions so a step produces the same request wherever
//! it runs.
//!
//! Scope of this unit (port plan, Phase 2 "step_prompt.rs"): the pure builders
//! [`build_step_messages_payload`] and [`build_referenced_steps_context`], plus the
//! [`combine_skills_with_system_instruction`] helper and the two constants they need.
//! It has no I/O and depends only on the S1 DTOs in [`super::dto`].
//!
//! The *per-layer prompt mutations* (`<attached_documents>` / `<corpus_evidence>` /
//! `addAgentInputEvidence`) live in `agentInputs*.server.ts` and are a **separate**
//! unit — this module only produces the base payload they later mutate.
//!
//! Parity-critical details preserved from the reference:
//! * exact framing strings and their `\n` layout, and the final `trimEnd` on the user
//!   message;
//! * `referenceNames = {id: name}` — the referenced-step header is `=== {name} (Step
//!   {id}) ===`, falling back to `Step {id}` only when the name is missing *or empty*;
//! * the JS-falsy skip rule (`if (!result)`) — a referenced step whose result is
//!   `None` **or the empty string** is skipped;
//! * the 200k referenced-steps cap. Under equivalent-behavior parity this is measured
//!   with an *ordinary* length (Unicode scalar count), not JS UTF-16 code units —
//!   byte-parity is explicitly not pursued (see the plan's "Parity requirements").

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

use super::dto::{ExecutionLayer, OutputType, OutputVersion};

/// System pre-prompt prepended whenever a step carries permanent skills.
///
/// Mirrors the exported `PERMANENT_SKILLS_SYSTEM_PREPROMPT` in `stepPrompt.ts`,
/// built by joining the same six directive lines with `'\n'`.
pub static PERMANENT_SKILLS_SYSTEM_PREPROMPT: LazyLock<String> = LazyLock::new(|| {
    [
        "Permanent skills are additive system-level requirements: combine them with the agent task using logical AND, not XOR.",
        "Complete the current User Instruction using the supplied User Input and relevant Context; never replace, omit, or rewrite that task or input with a skill.",
        "Apply all compatible permanent skills and step instructions together. A skill may require additional output or constrain the task's tone, format, or length; it is not an alternative to performing the task.",
        "Length limits apply to the complete response, including any required prefix or additional output, unless the skill explicitly limits only a particular section. Keep the response within those limits while still fulfilling the task.",
        "Conditional examples, not additional requirements: if a skill says \"print francesco\" and the task asks for a summary, print \"francesco\" and provide the summary below it. If a skill says \"maximum 50 characters\", produce a summary within 50 characters, not an unrelated response.",
        "If requirements are genuinely incompatible, respect the applicable instruction priority and briefly identify the conflict or ask for clarification; do not silently discard the agent task or a skill.",
    ]
    .join("\n")
});

/// Upper bound (in ordinary characters) on the assembled referenced-steps context.
///
/// Mirrors `REFERENCED_STEPS_CONTEXT_CHAR_CAP` in `stepPrompt.ts`.
pub const REFERENCED_STEPS_CONTEXT_CHAR_CAP: usize = 200_000;

/// Role of a chat message (`'user' | 'system'` in the reference payload).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    User,
    System,
}

/// A single chat message (`{ role, text }`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepMessage {
    pub role: MessageRole,
    pub text: String,
}

/// The base request payload for a step (`StepMessagePayload` in `stepPrompt.ts`).
///
/// `system_instruction` is `None` exactly when the combined system text is empty,
/// matching the reference's `combinedSystem ? {...} : undefined`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepMessagePayload {
    pub messages: Vec<StepMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_instruction: Option<StepMessage>,
}

/// Assembled referenced-steps context plus its accounting (`ReferencedStepsContext`).
///
/// `bytes` keeps the reference field name; under equivalent-behavior parity it is the
/// ordinary character length of `text` (Unicode scalar count), not a UTF-16 unit or
/// UTF-8 byte count.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferencedStepsContext {
    pub text: String,
    pub bytes: usize,
    pub truncated: bool,
    pub steps_included: usize,
    pub steps_skipped_no_result: usize,
}

/// Resolves a referenced step's display name and prior result by id.
///
/// Mirrors the `ReferencedStepsLookup` interface (`getName` / `getResult`). Both
/// return the raw value — the empty-string / missing-name fallbacks are applied by
/// [`build_referenced_steps_context`], exactly as in the reference.
pub trait ReferencedStepsLookup {
    /// The step's display name, or `None` if unknown (`referenceNames[id]`).
    fn get_name(&self, ref_id: &str) -> Option<String>;
    /// The step's prior result text, or `None` if it has no recorded output
    /// (`previousOutputs[id]?.result`).
    fn get_result(&self, ref_id: &str) -> Option<String>;
}

/// The lookup used on the execute path: `referenceNames` (`{id: name}`) plus the
/// `previousOutputs` (`{id: OutputVersion}`) map, borrowed without copying.
pub struct MapReferencedStepsLookup<'a> {
    /// `referenceNames = {layerId: layer.name}` for all layers.
    pub reference_names: &'a HashMap<String, String>,
    /// `previousOutputs = {layerId: latest OutputVersion}`.
    pub previous_outputs: &'a HashMap<String, OutputVersion>,
}

impl ReferencedStepsLookup for MapReferencedStepsLookup<'_> {
    fn get_name(&self, ref_id: &str) -> Option<String> {
        self.reference_names.get(ref_id).cloned()
    }

    fn get_result(&self, ref_id: &str) -> Option<String> {
        self.previous_outputs.get(ref_id).map(|output| output.result.clone())
    }
}

/// Ordinary character length (Unicode scalar count) — the parity-approved length
/// measure for the 200k cap (not JS UTF-16 code units).
#[inline]
fn char_len(text: &str) -> usize {
    text.chars().count()
}

/// Combine agent-level skill texts (applied to every step) with this step's own
/// system instruction. Skills add requirements without replacing the task.
///
/// Mirrors `combineSkillsWithSystemInstruction`: callers pass already-resolved skill
/// texts; this stays pure and never fetches. Empty/whitespace-only skills are dropped
/// (`.filter(Boolean)`), and an empty step system instruction is dropped from the
/// final join.
pub fn combine_skills_with_system_instruction(
    system_instruction: Option<&str>,
    agent_skills: &[String],
) -> String {
    let skills_block = agent_skills
        .iter()
        .map(|skill| skill.trim())
        .filter(|skill| !skill.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let step_sys = system_instruction.map(str::trim).unwrap_or("");
    if skills_block.is_empty() {
        return step_sys.to_string();
    }
    let skills_line = format!("Permanent Skills:\n{skills_block}");
    let parts: [&str; 3] = [
        PERMANENT_SKILLS_SYSTEM_PREPROMPT.as_str(),
        skills_line.as_str(),
        step_sys,
    ];
    parts
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Build the base message payload for a step (`buildStepMessagesPayload`).
///
/// The user message is framed as `User Instruction: … / User Input: … / Context: …`
/// with the exact `\n` layout of the reference, the `Provide code only.` directive
/// appended for `outputType === 'code'`, and a trailing `trimEnd`. The system
/// instruction is the skills-combined text, or `None` when that is empty.
pub fn build_step_messages_payload(
    layer: &ExecutionLayer,
    context_text: &str,
    agent_skills: &[String],
) -> StepMessagePayload {
    // `layer.userInstruction ?? ''` — the DTO already defaults this to "".
    let mut user_message_text = format!("User Instruction:\n{}\n-----\n\n", layer.user_instruction);

    if let Some(user_input) = layer.user_input.as_deref() {
        let trimmed = user_input.trim();
        if !trimmed.is_empty() {
            user_message_text.push_str(&format!("User Input:\n{trimmed}\n\n"));
        }
    }
    if !context_text.is_empty() {
        user_message_text.push_str(&format!("Context:\n{context_text}\n"));
    }
    if layer.output_type == Some(OutputType::Code) {
        user_message_text.push_str("Provide code only.\n");
    }

    let combined_system =
        combine_skills_with_system_instruction(layer.system_instruction.as_deref(), agent_skills);
    let system_instruction = if combined_system.is_empty() {
        None
    } else {
        Some(StepMessage { role: MessageRole::System, text: combined_system })
    };

    StepMessagePayload {
        messages: vec![StepMessage {
            role: MessageRole::User,
            text: user_message_text.trim_end().to_string(),
        }],
        system_instruction,
    }
}

/// Assemble the `Referenced Steps Results:` context block (`buildReferencedStepsContext`).
///
/// For each id in order: skip when the result is missing *or empty* (JS-falsy),
/// otherwise emit `=== {name} (Step {id}) ===\n{result}\n\n` where `name` falls back
/// to `Step {id}` when missing or empty. Emission stops once the running length would
/// exceed [`REFERENCED_STEPS_CONTEXT_CHAR_CAP`], appending a truncation marker. When
/// nothing is included and nothing was truncated, an empty context is returned (but
/// the skipped-count is preserved), matching the reference's guards exactly.
pub fn build_referenced_steps_context(
    referenced_step_ids: &[String],
    lookup: &impl ReferencedStepsLookup,
) -> ReferencedStepsContext {
    if referenced_step_ids.is_empty() {
        return ReferencedStepsContext {
            text: String::new(),
            bytes: 0,
            truncated: false,
            steps_included: 0,
            steps_skipped_no_result: 0,
        };
    }

    let header = "Referenced Steps Results:\n";
    let mut parts: Vec<String> = vec![header.to_string()];
    let mut running_len = char_len(header);
    let mut steps_included: usize = 0;
    let mut steps_skipped_no_result: usize = 0;
    let mut truncated = false;

    for ref_id in referenced_step_ids {
        // `if (!result)` — treat both a missing result and the empty string as "no result".
        let result = match lookup.get_result(ref_id) {
            Some(result) if !result.is_empty() => result,
            _ => {
                steps_skipped_no_result += 1;
                continue;
            }
        };
        // `lookup.getName(refId) || \`Step ${refId}\`` — empty name also falls back.
        let name = lookup
            .get_name(ref_id)
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| format!("Step {ref_id}"));

        let block = format!("=== {name} (Step {ref_id}) ===\n{result}\n\n");
        if running_len + char_len(&block) > REFERENCED_STEPS_CONTEXT_CHAR_CAP {
            parts.push(format!(
                "[… remaining referenced steps truncated to stay within {REFERENCED_STEPS_CONTEXT_CHAR_CAP} chars …]\n"
            ));
            truncated = true;
            break;
        }
        running_len += char_len(&block);
        parts.push(block);
        steps_included += 1;
    }

    if steps_included == 0 && !truncated {
        return ReferencedStepsContext {
            text: String::new(),
            bytes: 0,
            truncated: false,
            steps_included: 0,
            steps_skipped_no_result,
        };
    }

    let text = parts.concat();
    let bytes = char_len(&text);
    ReferencedStepsContext { text, bytes, truncated, steps_included, steps_skipped_no_result }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn layer_from(value: serde_json::Value) -> ExecutionLayer {
        serde_json::from_value(value).expect("layer deserializes")
    }

    fn output(result: &str) -> OutputVersion {
        OutputVersion {
            version: 1,
            timestamp: "2026-01-01T00:00:00Z".to_string(),
            result: result.to_string(),
            image_urls: Vec::new(),
        }
    }

    #[test]
    fn instruction_only_message_is_trimmed() {
        let layer = layer_from(json!({
            "id": "l1",
            "name": "Step",
            "userInstruction": "Do the thing",
        }));
        let payload = build_step_messages_payload(&layer, "", &[]);
        assert_eq!(payload.messages.len(), 1);
        assert_eq!(payload.messages[0].role, MessageRole::User);
        // Trailing "\n\n" from the framing is removed by trimEnd.
        assert_eq!(payload.messages[0].text, "User Instruction:\nDo the thing\n-----");
        assert!(payload.system_instruction.is_none());
    }

    #[test]
    fn full_user_message_framing_with_input_context_and_code() {
        let layer = layer_from(json!({
            "id": "l1",
            "name": "S",
            "userInstruction": "Instr",
            "userInput": "  the input  ",
            "outputType": "code",
        }));
        let payload = build_step_messages_payload(&layer, "ctx text", &[]);
        assert_eq!(
            payload.messages[0].text,
            "User Instruction:\nInstr\n-----\n\nUser Input:\nthe input\n\nContext:\nctx text\nProvide code only."
        );
    }

    #[test]
    fn blank_user_input_is_omitted() {
        let layer = layer_from(json!({
            "id": "l1",
            "name": "S",
            "userInstruction": "Instr",
            "userInput": "   ",
        }));
        let payload = build_step_messages_payload(&layer, "", &[]);
        assert_eq!(payload.messages[0].text, "User Instruction:\nInstr\n-----");
    }

    #[test]
    fn basic_output_type_does_not_append_code_directive() {
        let layer = layer_from(json!({
            "id": "l1",
            "name": "S",
            "userInstruction": "Instr",
            "outputType": "basic",
        }));
        let payload = build_step_messages_payload(&layer, "", &[]);
        assert!(!payload.messages[0].text.contains("Provide code only."));
    }

    #[test]
    fn system_instruction_with_skills_prepends_preprompt() {
        let layer = layer_from(json!({
            "id": "l1",
            "name": "S",
            "userInstruction": "Do",
            "systemInstruction": "Be terse.",
        }));
        let skills =
            vec!["  skill A  ".to_string(), String::new(), "skill B".to_string()];
        let payload = build_step_messages_payload(&layer, "", &skills);
        let sys = payload.system_instruction.expect("system instruction present");
        assert_eq!(sys.role, MessageRole::System);
        assert!(sys.text.starts_with(PERMANENT_SKILLS_SYSTEM_PREPROMPT.as_str()));
        // Empty skill dropped; remaining joined with "\n\n".
        assert!(sys.text.contains("Permanent Skills:\nskill A\n\nskill B"));
        assert!(sys.text.ends_with("Be terse."));
    }

    #[test]
    fn combine_without_skills_returns_trimmed_step_system() {
        assert_eq!(combine_skills_with_system_instruction(Some("  sys  "), &[]), "sys");
        assert_eq!(combine_skills_with_system_instruction(None, &[]), "");
    }

    #[test]
    fn combine_with_skills_drops_empty_step_system() {
        let combined =
            combine_skills_with_system_instruction(None, &["only skill".to_string()]);
        let expected = format!(
            "{}\n\nPermanent Skills:\nonly skill",
            PERMANENT_SKILLS_SYSTEM_PREPROMPT.as_str()
        );
        assert_eq!(combined, expected);
    }

    #[test]
    fn referenced_context_empty_ids_returns_zeroed() {
        let names = HashMap::new();
        let outputs = HashMap::new();
        let lookup = MapReferencedStepsLookup { reference_names: &names, previous_outputs: &outputs };
        let ctx = build_referenced_steps_context(&[], &lookup);
        assert_eq!(ctx.text, "");
        assert_eq!(ctx.bytes, 0);
        assert!(!ctx.truncated);
        assert_eq!(ctx.steps_included, 0);
        assert_eq!(ctx.steps_skipped_no_result, 0);
    }

    #[test]
    fn referenced_context_skips_empty_and_missing_results() {
        let names: HashMap<String, String> =
            [("a".to_string(), "Alpha".to_string())].into_iter().collect();
        let outputs: HashMap<String, OutputVersion> = [
            ("a".to_string(), output("resA")),
            ("b".to_string(), output("")), // empty result -> falsy -> skipped
        ]
        .into_iter()
        .collect();
        let lookup = MapReferencedStepsLookup { reference_names: &names, previous_outputs: &outputs };

        let ids = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let ctx = build_referenced_steps_context(&ids, &lookup);
        assert_eq!(ctx.text, "Referenced Steps Results:\n=== Alpha (Step a) ===\nresA\n\n");
        assert_eq!(ctx.steps_included, 1);
        assert_eq!(ctx.steps_skipped_no_result, 2);
        assert!(!ctx.truncated);
        assert_eq!(ctx.bytes, ctx.text.chars().count());
    }

    #[test]
    fn referenced_context_name_falls_back_to_step_id() {
        let names = HashMap::new(); // no name for "z"
        let outputs: HashMap<String, OutputVersion> =
            [("z".to_string(), output("rz"))].into_iter().collect();
        let lookup = MapReferencedStepsLookup { reference_names: &names, previous_outputs: &outputs };
        let ctx = build_referenced_steps_context(&["z".to_string()], &lookup);
        assert_eq!(ctx.text, "Referenced Steps Results:\n=== Step z (Step z) ===\nrz\n\n");
        assert_eq!(ctx.steps_included, 1);
    }

    #[test]
    fn referenced_context_all_skipped_returns_empty_but_keeps_skip_count() {
        let names = HashMap::new();
        let outputs = HashMap::new();
        let lookup = MapReferencedStepsLookup { reference_names: &names, previous_outputs: &outputs };
        let ids = vec!["missing1".to_string(), "missing2".to_string()];
        let ctx = build_referenced_steps_context(&ids, &lookup);
        assert_eq!(ctx.text, "");
        assert_eq!(ctx.bytes, 0);
        assert!(!ctx.truncated);
        assert_eq!(ctx.steps_included, 0);
        assert_eq!(ctx.steps_skipped_no_result, 2);
    }

    #[test]
    fn referenced_context_truncates_when_over_cap() {
        let names: HashMap<String, String> =
            [("big".to_string(), "Name".to_string())].into_iter().collect();
        let huge = "x".repeat(REFERENCED_STEPS_CONTEXT_CHAR_CAP);
        let outputs: HashMap<String, OutputVersion> =
            [("big".to_string(), output(&huge))].into_iter().collect();
        let lookup = MapReferencedStepsLookup { reference_names: &names, previous_outputs: &outputs };

        let ctx = build_referenced_steps_context(&["big".to_string()], &lookup);
        assert!(ctx.truncated);
        assert_eq!(ctx.steps_included, 0);
        assert!(ctx.text.starts_with("Referenced Steps Results:\n"));
        assert!(ctx.text.contains(
            "[… remaining referenced steps truncated to stay within 200000 chars …]"
        ));
    }

    #[test]
    fn referenced_context_includes_earlier_steps_before_truncating() {
        let names: HashMap<String, String> = [
            ("a".to_string(), "Alpha".to_string()),
            ("b".to_string(), "Beta".to_string()),
        ]
        .into_iter()
        .collect();
        let huge = "y".repeat(REFERENCED_STEPS_CONTEXT_CHAR_CAP);
        let outputs: HashMap<String, OutputVersion> = [
            ("a".to_string(), output("small")),
            ("b".to_string(), output(&huge)),
        ]
        .into_iter()
        .collect();
        let lookup = MapReferencedStepsLookup { reference_names: &names, previous_outputs: &outputs };

        let ids = vec!["a".to_string(), "b".to_string()];
        let ctx = build_referenced_steps_context(&ids, &lookup);
        assert_eq!(ctx.steps_included, 1);
        assert!(ctx.truncated);
        assert!(ctx.text.contains("=== Alpha (Step a) ===\nsmall\n\n"));
        assert!(!ctx.text.contains(&huge));
    }
}
