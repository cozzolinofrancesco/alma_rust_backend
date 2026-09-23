//! Agent display-name formatters for the `canvas-272` export subtree.
//!
//! Ported verbatim (equivalent-behavior parity, not byte-parity) from
//! `frontend_v3/app/canvas-272/lib/agentDisplayName.ts`
//! (`formatAgentDisplayName` / `formatAgentToolbarTitle` /
//! `formatAgentSidebarLabel` + the private `firstVisualToken` helper and the
//! `REPORT_AGENT_ISO_SUFFIX` regex).
//!
//! These are pure string transforms used by the export/markdown assembly and the
//! SPA toolbar/sidebar. No I/O.
//!
//! ## Regex-free by design
//!
//! The `domain` crate deliberately carries no `regex` dependency — the sibling
//! `agentnodes::validation` module hand-rolls every zod/JS regex with byte
//! scanning, and this module follows the same convention. The two patterns the
//! reference relies on are reproduced structurally:
//! - `REPORT_AGENT_ISO_SUFFIX` = `/-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}$/` — a
//!   fixed-length (17 ASCII char) trailing timestamp — see
//!   [`strip_report_agent_iso_suffix`].
//! - the sidebar year cut `/\s+\d{4}\b/` — see [`find_year_boundary_index`].
//!
//! ## Whitespace / word-char parity note
//!
//! JS `\s` and Rust [`char::is_whitespace`] agree on the code points that matter
//! here (space, tab, newlines, NBSP, the Unicode space run); they differ only on
//! U+FEFF (BOM), which JS `\s` matches and the Unicode `White_Space` property
//! does not — irrelevant to agent names and acceptable under equivalent-behavior
//! parity. JS `\d` / `\w` are ASCII by default, mirrored here with
//! [`char::is_ascii_digit`] and [`is_ascii_word_char`].

use serde_json::Value;

use crate::agentnodes::dto::AgentMetadata;

/// The `_clinical_Report-agent-` marker embedded in clinical report agent names.
const CLINICAL_MARKER: &str = "_clinical_Report-agent-";

/// The `Report-agent-` prefix on generated report agents.
const REPORT_AGENT_PREFIX: &str = "Report-agent-";

/// Length in bytes/chars of `-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}` (all ASCII):
/// `- dddd - dd - dd T dd - dd` = 1+4+1+2+1+2+1+2+1+2 = 17.
const ISO_SUFFIX_LEN: usize = 17;

/// Strip a known file-type suffix and surrounding whitespace from a raw agent
/// name. Mirrors `formatAgentDisplayName`.
///
/// The suffixes (`.json`, `.canvas272`, `.canvas`, `.agentnodes-graph`) are
/// removed case-insensitively and applied in the reference's order, each as an
/// end-anchored strip. Only the initial `trim()` runs; no re-trim between strips.
pub fn format_agent_display_name(raw_name: &str) -> String {
    let mut s: &str = raw_name.trim();
    for suffix in [".json", ".canvas272", ".canvas", ".agentnodes-graph"] {
        if let Some(stripped) = strip_suffix_ci(s, suffix) {
            s = stripped;
        }
    }
    s.to_string()
}

/// Compute a compact toolbar title for an agent. Mirrors
/// `formatAgentToolbarTitle(rawName, metadata)`.
///
/// `display_title` carries the optional `metadata.displayTitle` value (the only
/// metadata field the reference reads). When present and non-blank it wins
/// outright. Otherwise a clinical session slug, then a `Report-agent-` derived
/// token, then the plain display name are tried in order.
pub fn format_agent_toolbar_title(raw_name: &str, display_title: Option<&str>) -> String {
    // metadata?.displayTitle?.trim() — a non-empty trimmed title short-circuits.
    if let Some(title) = display_title {
        let trimmed = title.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    let s = format_agent_display_name(raw_name);

    // `_clinical_Report-agent-` marker → the session slug that precedes it.
    if let Some(idx) = s.find(CLINICAL_MARKER) {
        if idx > 0 {
            let session_slug = s[..idx].replace('-', " ");
            let session_slug = session_slug.trim();
            if !session_slug.is_empty() {
                return session_slug.to_string();
            }
        }
    }

    // `Report-agent-<name>-<iso>` → the first visual token of `<name>`.
    if let Some(rest) = s.strip_prefix(REPORT_AGENT_PREFIX) {
        let without_suffix = strip_report_agent_iso_suffix(rest);
        let spaced = without_suffix.replace('-', " ");
        let spaced = spaced.trim();
        if !spaced.is_empty() {
            return first_visual_token(spaced);
        }
    }

    format_agent_display_name(raw_name)
}

/// Convenience over [`format_agent_toolbar_title`] that pulls `displayTitle`
/// straight from an [`AgentMetadata`] passthrough bag (S1 dto).
///
/// `displayTitle` is not a typed field — it lives in the `.passthrough()`
/// overflow map — so it is read there and coerced to a string when present.
pub fn format_agent_toolbar_title_from_metadata(
    raw_name: &str,
    metadata: Option<&AgentMetadata>,
) -> String {
    let display_title = metadata
        .and_then(|m| m.passthrough.get("displayTitle"))
        .and_then(Value::as_str);
    format_agent_toolbar_title(raw_name, display_title)
}

/// Compute a sidebar label for an agent. Mirrors `formatAgentSidebarLabel`.
///
/// Normalises path separators and takes the final path segment, delegates
/// report/clinical names to the toolbar formatter, then collapses `_`/`-` and
/// whitespace runs to single spaces and trims a trailing ` <year>` tail.
pub fn format_agent_sidebar_label(raw_name: &str) -> String {
    // Backslashes → forward slashes, then keep the last path segment.
    let mut s = format_agent_display_name(raw_name).replace('\\', "/");
    if s.contains('/') {
        // `split('/').pop()` — the substring after the final '/', trimmed.
        s = s.rsplit('/').next().unwrap_or("").trim().to_string();
    }

    // Report/clinical agents reuse the toolbar derivation (metadata-less).
    if s.starts_with(REPORT_AGENT_PREFIX) || s.contains(CLINICAL_MARKER) {
        return format_agent_toolbar_title(&s, None);
    }

    // `[_-]+ → ' '`, then `\s+ → ' '`, then trim.
    let s = replace_underscore_dash_runs_with_space(&s);
    let s = collapse_whitespace_runs(&s);
    let mut s = s.trim().to_string();

    // `/\s+\d{4}\b/` — drop a trailing ` <4-digit year>` and everything after.
    if let Some(idx) = find_year_boundary_index(&s) {
        if idx > 0 {
            s = s[..idx].trim().to_string();
        }
    }

    if s.is_empty() {
        format_agent_display_name(raw_name)
    } else {
        s
    }
}

// ---------------------------------------------------------------------------
// Private helpers (regex-free ports)
// ---------------------------------------------------------------------------

/// Case-insensitive end-anchored suffix strip (`/<suffix>$/i` → `''`).
///
/// Returns the head slice when `s` ends with `suffix` ignoring ASCII case, else
/// `None`. Guards the split point against landing mid-multibyte-char (the
/// suffixes are ASCII, so a non-boundary split can never be a match).
fn strip_suffix_ci<'a>(s: &'a str, suffix: &str) -> Option<&'a str> {
    let start = s.len().checked_sub(suffix.len())?;
    if !s.is_char_boundary(start) {
        return None;
    }
    let (head, tail) = s.split_at(start);
    if tail.eq_ignore_ascii_case(suffix) {
        Some(head)
    } else {
        None
    }
}

/// First whitespace-delimited token of a trimmed string. Mirrors
/// `firstVisualToken`: trim, then take everything before the first whitespace
/// char (trimmed again — a no-op for the leading side, kept for fidelity).
fn first_visual_token(s: &str) -> String {
    let t = s.trim();
    match t.find(char::is_whitespace) {
        Some(i) => t[..i].trim().to_string(),
        None => t.to_string(),
    }
}

/// Strip a trailing `-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}` timestamp. Mirrors
/// `.replace(REPORT_AGENT_ISO_SUFFIX, '')`.
///
/// The pattern is fixed-length (17 ASCII chars) and end-anchored, so at most the
/// final 17 bytes can match. Reads raw bytes (no `str` slicing of the tail) so a
/// multibyte char sitting in that window simply fails the ASCII checks rather
/// than panicking; when it matches, all 17 bytes are ASCII and the head cut lands
/// on the already-verified char boundary.
fn strip_report_agent_iso_suffix(s: &str) -> &str {
    let Some(start) = s.len().checked_sub(ISO_SUFFIX_LEN) else {
        return s;
    };
    if !s.is_char_boundary(start) {
        return s;
    }
    let tail = &s.as_bytes()[start..];
    // Layout: 0:'-' 1..5:dddd 5:'-' 6..8:dd 8:'-' 9..11:dd 11:'T' 12..14:dd 14:'-' 15..17:dd
    let matches = tail[0] == b'-'
        && tail[1..5].iter().all(u8::is_ascii_digit)
        && tail[5] == b'-'
        && tail[6..8].iter().all(u8::is_ascii_digit)
        && tail[8] == b'-'
        && tail[9..11].iter().all(u8::is_ascii_digit)
        && tail[11] == b'T'
        && tail[12..14].iter().all(u8::is_ascii_digit)
        && tail[14] == b'-'
        && tail[15..17].iter().all(u8::is_ascii_digit);
    if matches {
        &s[..start]
    } else {
        s
    }
}

/// True for JS default `\w` characters (`[A-Za-z0-9_]`), for `\b` boundary tests.
fn is_ascii_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Byte index of the start of the whitespace run that matches `/\s+\d{4}\b/`.
///
/// Mirrors `s.search(/\s+\d{4}\b/)`: scan left-to-right for a whitespace run
/// immediately followed by exactly four ASCII digits terminated by a word
/// boundary (next char is a non-word char, or end of string). Returns the byte
/// index of the run's first whitespace char — every position within a run yields
/// the same following text, so the run start is the leftmost match. `None` when
/// no such run exists.
fn find_year_boundary_index(s: &str) -> Option<usize> {
    let chars: Vec<(usize, char)> = s.char_indices().collect();
    let len = chars.len();
    let mut idx = 0;
    while idx < len {
        if !chars[idx].1.is_whitespace() {
            idx += 1;
            continue;
        }
        let run_start_byte = chars[idx].0;
        // Consume the whole whitespace run (greedy `\s+`).
        let mut j = idx;
        while j < len && chars[j].1.is_whitespace() {
            j += 1;
        }
        // Need exactly 4 ASCII digits, then a `\b` (non-word char or end).
        if j + 4 <= len && chars[j..j + 4].iter().all(|(_, c)| c.is_ascii_digit()) {
            let at_boundary = match chars.get(j + 4) {
                Some((_, c)) => !is_ascii_word_char(*c),
                None => true,
            };
            if at_boundary {
                return Some(run_start_byte);
            }
        }
        // Whole run failed; resume scanning after it.
        idx = j;
    }
    None
}

/// Replace each maximal run of `_`/`-` with a single space. Mirrors
/// `.replace(/[_-]+/g, ' ')`.
fn replace_underscore_dash_runs_with_space(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_run = false;
    for c in s.chars() {
        if c == '_' || c == '-' {
            if !in_run {
                out.push(' ');
                in_run = true;
            }
        } else {
            in_run = false;
            out.push(c);
        }
    }
    out
}

/// Collapse each maximal whitespace run to a single space. Mirrors
/// `.replace(/\s+/g, ' ')`.
fn collapse_whitespace_runs(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_ws = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !in_ws {
                out.push(' ');
                in_ws = true;
            }
        } else {
            in_ws = false;
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ---- format_agent_display_name ----

    #[test]
    fn display_name_trims_and_strips_suffixes_case_insensitively() {
        assert_eq!(format_agent_display_name("  My Agent.JSON  "), "My Agent");
        assert_eq!(format_agent_display_name("flow.canvas272"), "flow");
        assert_eq!(format_agent_display_name("flow.CANVAS"), "flow");
        assert_eq!(format_agent_display_name("graph.agentnodes-graph"), "graph");
        assert_eq!(format_agent_display_name("plain name"), "plain name");
    }

    #[test]
    fn display_name_strips_suffixes_sequentially() {
        // `.canvas272.json` → strip `.json` then `.canvas272`.
        assert_eq!(format_agent_display_name("board.canvas272.json"), "board");
    }

    #[test]
    fn display_name_leaves_dot_json_in_the_middle() {
        assert_eq!(format_agent_display_name("a.json.thing"), "a.json.thing");
    }

    // ---- format_agent_toolbar_title ----

    #[test]
    fn toolbar_prefers_non_blank_display_title() {
        assert_eq!(
            format_agent_toolbar_title("Report-agent-Foo-2026-09-22T14-30", Some("  Nice Title ")),
            "Nice Title",
        );
    }

    #[test]
    fn toolbar_ignores_blank_display_title() {
        assert_eq!(
            format_agent_toolbar_title("Report-agent-Foo-2026-09-22T14-30", Some("   ")),
            "Foo",
        );
    }

    #[test]
    fn toolbar_uses_clinical_session_slug() {
        assert_eq!(
            format_agent_toolbar_title("my-session_clinical_Report-agent-2026-09-22T14-30", None),
            "my session",
        );
    }

    #[test]
    fn toolbar_derives_first_token_from_report_prefix() {
        // ISO suffix stripped, dashes spaced, first visual token kept.
        assert_eq!(
            format_agent_toolbar_title("Report-agent-tox-study-2026-09-22T14-30", None),
            "tox",
        );
        assert_eq!(
            format_agent_toolbar_title("Report-agent-Foo-2026-09-22T14-30", None),
            "Foo",
        );
    }

    #[test]
    fn toolbar_falls_back_to_display_name() {
        assert_eq!(
            format_agent_toolbar_title("Just An Agent.json", None),
            "Just An Agent",
        );
    }

    #[test]
    fn toolbar_from_metadata_reads_passthrough_display_title() {
        let mut meta = AgentMetadata::default();
        meta.passthrough
            .insert("displayTitle".to_string(), json!("From Meta"));
        assert_eq!(
            format_agent_toolbar_title_from_metadata("Report-agent-Foo-2026-09-22T14-30", Some(&meta)),
            "From Meta",
        );
        // No metadata / no key → same as the raw formatter.
        assert_eq!(
            format_agent_toolbar_title_from_metadata("Report-agent-Foo-2026-09-22T14-30", None),
            "Foo",
        );
        assert_eq!(
            format_agent_toolbar_title_from_metadata(
                "Report-agent-Foo-2026-09-22T14-30",
                Some(&AgentMetadata::default()),
            ),
            "Foo",
        );
    }

    // ---- format_agent_sidebar_label ----

    #[test]
    fn sidebar_takes_last_path_segment_and_strips_year_tail() {
        assert_eq!(
            format_agent_sidebar_label("folder\\sub\\my_agent-2026-v2.json"),
            "my agent",
        );
    }

    #[test]
    fn sidebar_delegates_report_and_clinical_names_to_toolbar() {
        assert_eq!(
            format_agent_sidebar_label("Report-agent-Foo-2026-09-22T14-30"),
            "Foo",
        );
        assert_eq!(
            format_agent_sidebar_label("sess-x_clinical_Report-agent-abc"),
            "sess x",
        );
    }

    #[test]
    fn sidebar_collapses_separators_and_whitespace() {
        assert_eq!(format_agent_sidebar_label("my__weird--name"), "my weird name");
    }

    #[test]
    fn sidebar_does_not_strip_five_digit_run() {
        // `\d{4}\b` requires a boundary after exactly four digits; 12345 has none.
        assert_eq!(format_agent_sidebar_label("agent 12345"), "agent 12345");
    }

    #[test]
    fn sidebar_does_not_strip_leading_year() {
        // No whitespace precedes the digits, so `\s+\d{4}\b` cannot match.
        assert_eq!(format_agent_sidebar_label("2026 agent"), "2026 agent");
    }

    #[test]
    fn sidebar_falls_back_when_result_is_empty() {
        // "___" collapses to a single space → trims to "" → fall back to display name.
        assert_eq!(format_agent_sidebar_label("___"), "___");
    }

    #[test]
    fn sidebar_handles_multibyte_before_year() {
        // Ensures byte-index slicing of the year cut lands on a char boundary.
        assert_eq!(format_agent_sidebar_label("café report 2026"), "café report");
    }

    // ---- helper-level checks ----

    #[test]
    fn iso_suffix_strip_only_matches_exact_shape() {
        assert_eq!(strip_report_agent_iso_suffix("Foo-2026-09-22T14-30"), "Foo");
        // Wrong shape (missing 'T') → unchanged.
        assert_eq!(
            strip_report_agent_iso_suffix("Foo-2026-09-22-14-30"),
            "Foo-2026-09-22-14-30",
        );
        // Too short → unchanged.
        assert_eq!(strip_report_agent_iso_suffix("short"), "short");
    }

    #[test]
    fn first_visual_token_stops_at_first_whitespace() {
        assert_eq!(first_visual_token("  tox study report "), "tox");
        assert_eq!(first_visual_token("single"), "single");
    }
}
