//! Source-summary prompt + parser for the 272 `prepare-source` step.
//!
//! Ported 1:1 (equivalent-behavior parity) from
//! `frontend_v3/app/lib/reportCreation/sourceSummary.ts`. This unit powers the
//! `272/prepare-source` operation: [`build_source_summary_prompt`] produces the
//! `userInstruction` fed to a text model, and [`parse_source_summary`] validates
//! the model's reply into a [`SourceSummary`] (the analogue of the reference's
//! `summarySchema`). Downstream, the `272/compile` / prepare handler marshals the
//! parsed fields into the source metadata (`protocolNumber` / `docTitle` /
//! `summary` / `keywords`).
//!
//! The reference imports only `AgentExecutionError`; likewise this module depends
//! on no DTOs — its inputs are a plain name + [`SourceSummaryMode`], and its
//! output is the local [`SourceSummary`].
//!
//! **Regex without the `regex` crate.** The parser's fenced-code-block matcher
//! (`/^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i`) is reimplemented with plain
//! `str` scanning — matching how `validation.rs` and `layer_refs.rs` port their
//! regexes (the domain crate deliberately carries no `regex` dependency). JS `\s`
//! is approximated by [`char::is_whitespace`] (Unicode White_Space); the two
//! differ only on exotic code points and are equivalent under the parity bar.
//!
//! **Length bounds** use `chars().count()` (Unicode scalar values) rather than
//! JS UTF-16 code-unit `.length`: the port plan's parity bar explicitly does not
//! require UTF-16-unit counting, so ordinary character length stands in.

use serde::{Deserialize, Serialize};

use crate::agentnodes::error::AgentExecutionError;

/// Which surface the source document is being summarized from.
///
/// Mirrors the reference's `'attached' | 'corpus'` union: `attached` = a single
/// attached source document, `corpus` = a single PDF from a File Search store.
/// Only the prompt's first line differs between the two.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceSummaryMode {
    /// Summarizing a single attached source document.
    Attached,
    /// Summarizing a single PDF from a File Search store.
    Corpus,
}

/// The validated source summary — the Rust analogue of `summarySchema`'s output.
///
/// Field names are the schema's snake_case JSON keys verbatim (no serde rename),
/// so this both deserializes the model's JSON reply and re-serializes to the same
/// shape. Mirrors:
/// ```text
/// z.object({
///   protocol_number: z.string().max(1000),
///   title:           z.string().max(5000),
///   summary:         z.string().trim().min(1).max(100_000),
///   keywords:        z.array(z.string().trim().min(1).max(512)).min(1).max(30),
/// })
/// ```
/// Per zod: `summary` and every `keyword` are trimmed in the output; unknown keys
/// (e.g. the prompt's requested `pdf_name`) are stripped — serde ignores unknown
/// fields by default, matching zod's strip mode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceSummary {
    /// Extracted protocol number, or `""` when absent. `max(1000)`, no trim/min.
    pub protocol_number: String,
    /// Extracted document title, or `""` when absent. `max(5000)`, no trim/min.
    pub title: String,
    /// ~100-word summary. Trimmed; length in `1..=100_000`.
    pub summary: String,
    /// 5-8 keywords (schema allows `1..=30`). Each trimmed; length in `1..=512`.
    pub keywords: Vec<String>,
}

/// Build the `prepare-source` user instruction for `name` under `mode`.
///
/// Ports `buildSourceSummaryPrompt` byte-for-byte: the same seven lines joined by
/// `'\n'`, where only the first line varies by mode and the final line embeds the
/// JSON-encoded (`JSON.stringify`-equivalent, quoted + escaped) file name.
pub fn build_source_summary_prompt(name: &str, mode: SourceSummaryMode) -> String {
    let first = match mode {
        SourceSummaryMode::Corpus => "You are summarizing a single PDF from a File Search store.",
        SourceSummaryMode::Attached => "You are summarizing a single attached source document.",
    };
    // `JSON.stringify(name)` — a JSON string literal (quotes + escaping).
    // Serializing a `&str` to JSON is infallible.
    let name_json =
        serde_json::to_string(name).expect("serializing a &str to a JSON string never fails");
    let name_line = format!("PDF name: {name_json}");
    let lines: [&str; 7] = [
        first,
        "Use only content from the PDF named below.",
        "Return JSON only with keys: pdf_name, protocol_number, title, summary, keywords.",
        "protocol_number and title must be extracted from the PDF content if present; otherwise use empty string.",
        "summary must be ~100 words. keywords must be 5-8 items.",
        "",
        name_line.as_str(),
    ];
    lines.join("\n")
}

/// Parse a model reply into a validated [`SourceSummary`].
///
/// Ports `parseSourceSummary`: strip an optional ```` ```json ```` fence, JSON-parse
/// the inner (or raw) text, and validate against the schema. Any failure — no
/// JSON, wrong shape, or a violated bound — collapses to a single
/// `INVALID_SOURCE_SUMMARY` error (422, stage `source_preparation`), exactly as
/// the reference's `try/catch` does.
pub fn parse_source_summary(text: &str) -> Result<SourceSummary, AgentExecutionError> {
    parse_source_summary_inner(text).ok_or_else(|| {
        AgentExecutionError::invalid_source_summary(
            "Source preparation did not return a complete, valid JSON summary. No successful source record was created.",
        )
    })
}

/// The fallible core of [`parse_source_summary`]: `None` on any failure.
fn parse_source_summary_inner(text: &str) -> Option<SourceSummary> {
    // `fenced?.[1] ?? text` — the captured fence body, else the raw text.
    let json_str = extract_fenced_json(text).unwrap_or(text);
    // `JSON.parse(...)` — serde_json rejects trailing content, like JSON.parse.
    let raw: SourceSummary = serde_json::from_str(json_str).ok()?;
    // `summarySchema.parse(...)` — the refinements serde cannot express.
    validate_summary(raw)
}

/// Apply the `summarySchema` refinements (trim + length bounds), returning the
/// normalized summary or `None` if any bound is violated.
fn validate_summary(raw: SourceSummary) -> Option<SourceSummary> {
    // protocol_number / title: max only, no trim, no min (empty is allowed).
    if char_len(&raw.protocol_number) > 1000 {
        return None;
    }
    if char_len(&raw.title) > 5000 {
        return None;
    }

    // summary: trim().min(1).max(100_000) — the output value is trimmed.
    let summary = raw.summary.trim().to_string();
    let summary_len = char_len(&summary);
    if summary_len == 0 || summary_len > 100_000 {
        return None;
    }

    // keywords: array min(1).max(30); each element trim().min(1).max(512).
    if raw.keywords.is_empty() || raw.keywords.len() > 30 {
        return None;
    }
    let mut keywords = Vec::with_capacity(raw.keywords.len());
    for keyword in &raw.keywords {
        let trimmed = keyword.trim();
        let len = char_len(trimmed);
        if len == 0 || len > 512 {
            return None;
        }
        keywords.push(trimmed.to_string());
    }

    Some(SourceSummary {
        protocol_number: raw.protocol_number,
        title: raw.title,
        summary,
        keywords,
    })
}

/// Character count (Unicode scalar values) — the equivalent-behavior stand-in for
/// JS UTF-16 `.length` used by the schema's `.max()`/`.min()` bounds.
#[inline]
fn char_len(s: &str) -> usize {
    s.chars().count()
}

/// `\s`-equivalent: Unicode White_Space (matches `layer_refs.rs`'s `is_ws`).
#[inline]
fn is_ws(c: char) -> bool {
    c.is_whitespace()
}

/// ASCII-case-insensitive `strip_prefix`. `prefix` must be ASCII (here: `"json"`).
///
/// Returns the remainder after `prefix`, or `None` if `s` does not start with it
/// (case-insensitively) — the `(?:json)?` optional-group check.
fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let len = prefix.len();
    if s.len() >= len && s.is_char_boundary(len) && s[..len].eq_ignore_ascii_case(prefix) {
        Some(&s[len..])
    } else {
        None
    }
}

/// Extract the body of a leading fenced code block, or `None` when the text is not
/// a single fully-fenced block.
///
/// Reimplements `/^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i` (anchored both ends):
/// * `^\s*` — leading whitespace is skipped.
/// * ```` ``` ```` then an optional case-insensitive `json`.
/// * `\s*\n` — the greedy match makes the body begin right after the **last**
///   newline in the whitespace run that follows the opening fence.
/// * `([\s\S]*?)\n```\s*$` — the lazy body ends at the **first** `\n```` that is
///   followed by only whitespace through the end of the input.
///
/// On no match, the caller falls back to parsing the raw text.
fn extract_fenced_json(text: &str) -> Option<&str> {
    // ^\s*
    let after_lead = text.trim_start_matches(is_ws);
    // ```
    let after_open = after_lead.strip_prefix("```")?;
    // (?:json)? — case-insensitive, optional.
    let after_lang = strip_prefix_ci(after_open, "json").unwrap_or(after_open);

    // \s*\n : the body starts just past the last '\n' in the leading ws run.
    let ws_run_end = after_lang
        .find(|c: char| !is_ws(c))
        .unwrap_or(after_lang.len());
    let ws_run = &after_lang[..ws_run_end];
    let last_newline = ws_run.rfind('\n')?;
    let body = &after_lang[last_newline + 1..];

    // ([\s\S]*?)\n```\s*$ : first "\n```" with only whitespace after it to EOF.
    let mut from = 0usize;
    loop {
        let rel = body[from..].find("\n```")?;
        let newline_idx = from + rel;
        // "\n```" is 4 ASCII bytes; the index after it is a char boundary.
        let after_close = &body[newline_idx + 4..];
        if after_close.chars().all(is_ws) {
            return Some(&body[..newline_idx]);
        }
        // This closing fence had trailing non-whitespace; keep scanning (the lazy
        // body must expand past it to a later "\n```").
        from = newline_idx + 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentnodes::error::{codes, stage};
    use axum::http::StatusCode;

    fn kw(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| s.to_string()).collect()
    }

    // ── build_source_summary_prompt ─────────────────────────────────────────

    #[test]
    fn attached_prompt_matches_reference_line_for_line() {
        let expected = concat!(
            "You are summarizing a single attached source document.\n",
            "Use only content from the PDF named below.\n",
            "Return JSON only with keys: pdf_name, protocol_number, title, summary, keywords.\n",
            "protocol_number and title must be extracted from the PDF content if present; otherwise use empty string.\n",
            "summary must be ~100 words. keywords must be 5-8 items.\n",
            "\n",
            "PDF name: \"study.pdf\"",
        );
        assert_eq!(
            build_source_summary_prompt("study.pdf", SourceSummaryMode::Attached),
            expected
        );
    }

    #[test]
    fn corpus_prompt_only_differs_on_the_first_line() {
        let attached = build_source_summary_prompt("x.pdf", SourceSummaryMode::Attached);
        let corpus = build_source_summary_prompt("x.pdf", SourceSummaryMode::Corpus);
        assert!(corpus.starts_with("You are summarizing a single PDF from a File Search store.\n"));
        assert!(attached.starts_with("You are summarizing a single attached source document.\n"));
        // Everything after the first newline is identical.
        assert_eq!(
            attached.split_once('\n').unwrap().1,
            corpus.split_once('\n').unwrap().1
        );
    }

    #[test]
    fn prompt_json_encodes_the_name_like_json_stringify() {
        // Embedded quotes are escaped, matching JSON.stringify.
        let prompt = build_source_summary_prompt("a\"b.pdf", SourceSummaryMode::Corpus);
        assert!(prompt.ends_with("PDF name: \"a\\\"b.pdf\""));
    }

    // ── parse_source_summary (happy paths) ──────────────────────────────────

    #[test]
    fn parses_plain_json_without_a_fence() {
        let text = r#"{"protocol_number":"P-1","title":"T","summary":"A short summary.","keywords":["a","b","c","d","e"]}"#;
        let parsed = parse_source_summary(text).expect("valid summary");
        assert_eq!(parsed.protocol_number, "P-1");
        assert_eq!(parsed.title, "T");
        assert_eq!(parsed.summary, "A short summary.");
        assert_eq!(parsed.keywords, kw(&["a", "b", "c", "d", "e"]));
    }

    #[test]
    fn parses_json_inside_a_json_fence() {
        let text = "```json\n{\"protocol_number\":\"\",\"title\":\"\",\"summary\":\"s\",\"keywords\":[\"k\"]}\n```";
        let parsed = parse_source_summary(text).expect("valid fenced summary");
        assert_eq!(parsed.summary, "s");
        assert_eq!(parsed.keywords, kw(&["k"]));
    }

    #[test]
    fn parses_json_inside_a_bare_fence_with_surrounding_whitespace() {
        // Leading/trailing whitespace + an uppercase JSON tag + trailing newline.
        let text = "\n  ```JSON\n{\"protocol_number\":\"\",\"title\":\"\",\"summary\":\"s\",\"keywords\":[\"k\"]}\n```  \n";
        let parsed = parse_source_summary(text).expect("valid fenced summary");
        assert_eq!(parsed.summary, "s");
    }

    #[test]
    fn strips_unknown_keys_such_as_pdf_name() {
        let text = r#"{"pdf_name":"x.pdf","protocol_number":"P","title":"T","summary":"s","keywords":["k"]}"#;
        let parsed = parse_source_summary(text).expect("valid summary with extra key");
        assert_eq!(parsed.protocol_number, "P");
        assert_eq!(parsed.summary, "s");
    }

    #[test]
    fn trims_summary_and_each_keyword() {
        let text = r#"{"protocol_number":"P","title":"T","summary":"   trimmed me   ","keywords":["  a ","b"]}"#;
        let parsed = parse_source_summary(text).expect("valid summary");
        assert_eq!(parsed.summary, "trimmed me");
        assert_eq!(parsed.keywords, kw(&["a", "b"]));
    }

    // ── parse_source_summary (failure paths → INVALID_SOURCE_SUMMARY) ────────

    fn assert_invalid(text: &str) {
        let err = parse_source_summary(text).expect_err("should be invalid");
        assert_eq!(err.code, codes::INVALID_SOURCE_SUMMARY);
        assert_eq!(err.http_status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(err.stage, stage::SOURCE_PREPARATION);
        assert_eq!(
            err.message,
            "Source preparation did not return a complete, valid JSON summary. No successful source record was created."
        );
    }

    #[test]
    fn rejects_non_json_text() {
        assert_invalid("this is not json at all");
    }

    #[test]
    fn rejects_missing_required_field() {
        // No `keywords`.
        assert_invalid(r#"{"protocol_number":"P","title":"T","summary":"s"}"#);
    }

    #[test]
    fn rejects_wrong_typed_field() {
        // `keywords` is not an array of strings.
        assert_invalid(r#"{"protocol_number":"P","title":"T","summary":"s","keywords":[1,2]}"#);
    }

    #[test]
    fn rejects_empty_summary_after_trim() {
        assert_invalid(r#"{"protocol_number":"P","title":"T","summary":"   ","keywords":["k"]}"#);
    }

    #[test]
    fn rejects_empty_keyword_after_trim() {
        assert_invalid(r#"{"protocol_number":"P","title":"T","summary":"s","keywords":["  "]}"#);
    }

    #[test]
    fn rejects_empty_keywords_array() {
        assert_invalid(r#"{"protocol_number":"P","title":"T","summary":"s","keywords":[]}"#);
    }

    #[test]
    fn rejects_too_many_keywords() {
        let many: Vec<String> = (0..31).map(|i| format!("\"k{i}\"")).collect();
        let text = format!(
            r#"{{"protocol_number":"P","title":"T","summary":"s","keywords":[{}]}}"#,
            many.join(",")
        );
        assert_invalid(&text);
    }

    #[test]
    fn rejects_protocol_number_over_the_bound() {
        let long = "x".repeat(1001);
        let text = format!(
            r#"{{"protocol_number":"{long}","title":"T","summary":"s","keywords":["k"]}}"#
        );
        assert_invalid(&text);
    }

    #[test]
    fn accepts_protocol_number_at_the_bound() {
        let at = "x".repeat(1000);
        let text = format!(
            r#"{{"protocol_number":"{at}","title":"T","summary":"s","keywords":["k"]}}"#
        );
        let parsed = parse_source_summary(&text).expect("1000 chars is within bound");
        assert_eq!(char_len(&parsed.protocol_number), 1000);
    }

    // ── extract_fenced_json (the regex port) ────────────────────────────────

    #[test]
    fn fence_extraction_returns_none_without_a_fence() {
        assert_eq!(extract_fenced_json("{\"a\":1}"), None);
    }

    #[test]
    fn fence_extraction_requires_a_newline_before_the_closing_ticks() {
        // No "\n```" before EOF -> no match -> None (falls back to raw).
        assert_eq!(extract_fenced_json("```json\n{\"a\":1}```"), None);
    }

    #[test]
    fn fence_extraction_captures_the_inner_body() {
        assert_eq!(
            extract_fenced_json("```json\n{\"a\":1}\n```"),
            Some("{\"a\":1}")
        );
        assert_eq!(extract_fenced_json("```\nbody\n```"), Some("body"));
    }
}
