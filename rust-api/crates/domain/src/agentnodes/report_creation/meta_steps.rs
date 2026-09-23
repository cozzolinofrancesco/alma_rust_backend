//! Section 1 *meta-step* templates for the 272 report-creation compiler.
//!
//! Ported (equivalent-behavior parity) from
//! `frontend_v3/app/lib/sect1MetaSteps.ts`. A "meta step" is a Section 1
//! instruction template — a `{ typeName, instruction, keywords }` row that the
//! compiler routes an uploaded biomaterial PDF into so the generated layer gets
//! the right per-document instruction.
//!
//! Only the **pure** helpers are ported here; the Google Sheets fetch functions
//! (`fetchSect1MetaStepsFromSheet`, `fetchInstructionsTabFromSheet`,
//! `resolveSharedBiomaterialInstruction`, and the `normalizeSheetId` /
//! `mergeSharedBiomaterialInstruction` plumbing) are **cut** in v1 — the Sheets
//! path needs an OAuth Bearer token (see the port plan's "v1 explicit cuts").
//! The rows those functions would have returned arrive instead through the
//! seeded template asset and are fed to [`parse_sect1_meta_rows`] directly.
//!
//! The four ported units:
//! * [`parse_sect1_meta_rows`] — `A2:C` sheet rows → validated [`Sect1MetaStepRow`]s.
//! * [`file_name_to_keyword_tokens`] — a PDF file name → its lowercase token set.
//! * [`match_meta_file_to_step`] — pick the best-matching template for a file.
//! * [`format_meta_instruction`] — expand `{pdf_name}` / `{type}` placeholders.
//!
//! Following the `report_creation` sibling [`super::layer_refs`], the reference's
//! regexes are reimplemented with plain ASCII predicates (the domain crate
//! carries no `regex` dependency) and its local `Sect1MetaStepRow` interface is
//! declared here rather than pulled from `dto` (it is a file-local shape in the
//! reference, not part of the portable agent-execution schema).

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

/// A Section 1 meta-step template row — the reference's `Sect1MetaStepRow`.
///
/// `id` is synthesized as `meta-template-{n}` (1-based) by
/// [`parse_sect1_meta_rows`]. `user_input` (`userInput?`) is declared for shape
/// parity with the reference interface; none of the ported pure helpers populate
/// it, so it is always `None` when produced here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sect1MetaStepRow {
    pub id: String,
    pub type_name: String,
    pub instruction: String,
    pub keywords: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_input: Option<String>,
}

/// Parse the `keywords` cell into a list of trimmed, non-empty tokens.
///
/// Mirrors the private `parseKeywords`: trim the raw cell; an empty cell yields
/// no keywords; a cell containing a newline splits on `\n`, otherwise on `,`;
/// every token is trimmed and empties are dropped (`.filter(Boolean)`).
///
/// The newline test uses the *pre-trim* semantics of the reference faithfully:
/// `t` is already trimmed, so a value is only split by newline when a newline
/// survives between tokens (a leading/trailing newline is trimmed away first).
fn parse_keywords(raw: &str) -> Vec<String> {
    let t = raw.trim();
    if t.is_empty() {
        return Vec::new();
    }

    let separator = if t.contains('\n') { '\n' } else { ',' };
    t.split(separator)
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

/// Read cell `col` of `row` as a trimmed `&str`, treating a missing cell as `""`.
///
/// Mirrors `(row[col] || '').trim()`: an absent column (short row) or an empty
/// cell both collapse to the empty string.
#[inline]
fn cell(row: &[String], col: usize) -> &str {
    row.get(col).map(String::as_str).unwrap_or("").trim()
}

/// Parse raw `sect1MetaSteps!A2:C` sheet rows into validated meta-step templates.
///
/// Mirrors `parseSect1MetaRows`: for each row, column A is `typeName`, B is
/// `instruction`, C is the raw keywords cell. A row missing either `typeName`
/// **or** `instruction` (after trimming) is dropped; surviving rows get the
/// synthetic id `meta-template-{idx + 1}` where `idx` is the **original**
/// zero-based row position (so dropped rows still consume an index — the id
/// numbering follows the input rows, not the surviving ones), exactly as the
/// reference's `.map(...).filter(...)` does.
pub fn parse_sect1_meta_rows(rows: &[Vec<String>]) -> Vec<Sect1MetaStepRow> {
    rows.iter()
        .enumerate()
        .filter_map(|(idx, row)| {
            let type_name = cell(row, 0);
            let instruction = cell(row, 1);
            let keywords_raw = cell(row, 2);
            if type_name.is_empty() || instruction.is_empty() {
                return None;
            }
            Some(Sect1MetaStepRow {
                id: format!("meta-template-{}", idx + 1),
                type_name: type_name.to_string(),
                instruction: instruction.to_string(),
                keywords: parse_keywords(keywords_raw),
                user_input: None,
            })
        })
        .collect()
}

/// Strip a single trailing file extension — the `/\.[^.]+$/i` replacement.
///
/// The regex matches a dot followed by one-or-more non-dot characters anchored
/// at end-of-string, so the dot it removes is necessarily the **last** dot in
/// the name and there must be at least one character after it. Returns
/// everything before that dot; a name with no dot, or one whose only dot is the
/// final character (`"foo."`), is returned unchanged. A dotfile like
/// `".gitignore"` therefore reduces to `""`, matching the reference.
fn strip_last_extension(file_name: &str) -> &str {
    match file_name.rfind('.') {
        // A dot with at least one following character removes that extension.
        Some(dot) if dot + 1 < file_name.len() => &file_name[..dot],
        _ => file_name,
    }
}

/// Whether `c` is a token separator for the file-name split — `[\s_\-/]`.
#[inline]
fn is_token_separator(c: char) -> bool {
    c.is_whitespace() || c == '_' || c == '-' || c == '/'
}

/// Derive the lowercase keyword tokens for a PDF file name.
///
/// Mirrors `fileNameToKeywordTokens`: strip the extension to get `base`, split
/// `base` on runs of `[\s_\-/]` into `parts`, then insert `fileName`, `base`,
/// and each part — each lowercased and trimmed, empties skipped — into an
/// insertion-ordered, de-duplicated set. The returned vector preserves JS `Set`
/// semantics: first-seen order, no duplicates.
pub fn file_name_to_keyword_tokens(file_name: &str) -> Vec<String> {
    let base = strip_last_extension(file_name);
    let parts = base
        .split(is_token_separator)
        .filter(|s| !s.is_empty());

    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    // Iteration order matches `[fileName, base, ...parts]`.
    let candidates = [file_name, base].into_iter().chain(parts);
    for candidate in candidates {
        let token = candidate.to_lowercase();
        let token = token.trim();
        if token.is_empty() {
            continue;
        }
        if seen.insert(token.to_string()) {
            out.push(token.to_string());
        }
    }
    out
}

/// Slugify a `typeName` for the file-name containment bonus — `[^a-z0-9]+ -> ""`
/// over the lowercased string.
///
/// Lowercases, then keeps only ASCII `[a-z0-9]`, dropping everything else (spaces,
/// punctuation, and any non-ASCII letters, which `toLowerCase` cannot fold into
/// `[a-z]`).
fn type_slug(type_name: &str) -> String {
    type_name
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .collect()
}

/// Pick the meta-step template that best matches an uploaded file name.
///
/// Mirrors `matchMetaFileToStep`. Scoring per step:
/// * `+1` for every file-name keyword token that has a **substring overlap**
///   (either direction) with some non-empty lowercased template keyword — at
///   most one point per file-name token (inner loop `break`s on first hit);
/// * `+5` if the step's [`type_slug`] is non-empty and appears as a substring of
///   the lowercased file name.
///
/// The best step is the first one reaching the strict maximum score (`matchCount
/// > best.score` keeps the earliest on ties). Returns `None` when `steps` is
/// empty or no step scores above zero. The result borrows from `steps`; callers
/// clone if they need ownership.
pub fn match_meta_file_to_step<'a>(
    file_name: &str,
    steps: &'a [Sect1MetaStepRow],
) -> Option<&'a Sect1MetaStepRow> {
    if steps.is_empty() {
        return None;
    }

    let normalized_keywords = file_name_to_keyword_tokens(file_name);
    let lower_file_name = file_name.to_lowercase();
    let mut best: Option<(&'a Sect1MetaStepRow, i64)> = None;

    for step in steps {
        let template_keywords: Vec<String> =
            step.keywords.iter().map(|k| k.to_lowercase().trim().to_string()).collect();

        let mut match_count: i64 = 0;
        for summary_kw in &normalized_keywords {
            for template_kw in &template_keywords {
                if !template_kw.is_empty()
                    && (summary_kw.contains(template_kw.as_str())
                        || template_kw.contains(summary_kw.as_str()))
                {
                    match_count += 1;
                    break;
                }
            }
        }

        let slug = type_slug(&step.type_name);
        if !slug.is_empty() && lower_file_name.contains(&slug) {
            match_count += 5;
        }

        if match_count > 0 && best.map_or(true, |(_, score)| match_count > score) {
            best = Some((step, match_count));
        }
    }

    best.map(|(step, _)| step)
}

/// Expand the `{pdf_name}` and `{type}` placeholders in a meta instruction.
///
/// Mirrors `formatMetaInstruction`: a global replace of the literal `{pdf_name}`
/// with `file_name`, then of `{type}` with `type_name`. The two replacements are
/// sequential, so — as in the reference — a `{type}` occurring inside the
/// injected `file_name` is itself substituted by the second pass.
pub fn format_meta_instruction(instruction: &str, file_name: &str, type_name: &str) -> String {
    instruction
        .replace("{pdf_name}", file_name)
        .replace("{type}", type_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(cells: &[&str]) -> Vec<String> {
        cells.iter().map(|s| s.to_string()).collect()
    }

    fn step(type_name: &str, keywords: &[&str]) -> Sect1MetaStepRow {
        Sect1MetaStepRow {
            id: "x".to_string(),
            type_name: type_name.to_string(),
            instruction: "i".to_string(),
            keywords: keywords.iter().map(|s| s.to_string()).collect(),
            user_input: None,
        }
    }

    #[test]
    fn parse_keywords_empty_comma_and_newline_modes() {
        assert!(parse_keywords("   ").is_empty());
        assert_eq!(
            parse_keywords("a, b ,c"),
            vec!["a".to_string(), "b".to_string(), "c".to_string()]
        );
        // Newline present -> split on newline, not comma.
        assert_eq!(
            parse_keywords("a, b\n c, d"),
            vec!["a, b".to_string(), "c, d".to_string()]
        );
        // Empties dropped after trim.
        assert_eq!(parse_keywords("a,,b, ,c"), vec!["a".to_string(), "b".to_string(), "c".to_string()]);
    }

    #[test]
    fn parse_rows_synthesizes_ids_from_original_index_and_drops_incomplete() {
        let rows = vec![
            row(&["Type A", "Do A {pdf_name}", "alpha, beta"]),
            row(&["", "missing type"]),          // dropped (no typeName)
            row(&["Type C", "", "gamma"]),       // dropped (no instruction)
            row(&["Type D", "Do D"]),            // no keywords cell -> []
        ];
        let parsed = parse_sect1_meta_rows(&rows);
        assert_eq!(parsed.len(), 2);

        assert_eq!(parsed[0].id, "meta-template-1");
        assert_eq!(parsed[0].type_name, "Type A");
        assert_eq!(parsed[0].instruction, "Do A {pdf_name}");
        assert_eq!(parsed[0].keywords, vec!["alpha".to_string(), "beta".to_string()]);
        assert_eq!(parsed[0].user_input, None);

        // Index reflects the ORIGINAL 4th row (idx 3) -> meta-template-4.
        assert_eq!(parsed[1].id, "meta-template-4");
        assert_eq!(parsed[1].type_name, "Type D");
        assert!(parsed[1].keywords.is_empty());
    }

    #[test]
    fn strip_last_extension_matches_regex_semantics() {
        assert_eq!(strip_last_extension("study.pdf"), "study");
        assert_eq!(strip_last_extension("foo.bar.txt"), "foo.bar");
        assert_eq!(strip_last_extension("noext"), "noext");
        assert_eq!(strip_last_extension("foo."), "foo."); // trailing dot, nothing after
        assert_eq!(strip_last_extension(".gitignore"), ""); // dotfile reduces to empty
    }

    #[test]
    fn keyword_tokens_preserve_first_seen_order_and_dedup() {
        // base = "Clin_Study-01", parts = [clin, study, 01].
        let tokens = file_name_to_keyword_tokens("Clin_Study-01.PDF");
        assert_eq!(
            tokens,
            vec![
                "clin_study-01.pdf".to_string(), // fileName lowercased
                "clin_study-01".to_string(),     // base lowercased
                "clin".to_string(),
                "study".to_string(),
                "01".to_string(),
            ]
        );
    }

    #[test]
    fn keyword_tokens_dedup_when_filename_equals_base() {
        // No extension -> fileName == base, so the base entry is de-duplicated.
        let tokens = file_name_to_keyword_tokens("summary");
        assert_eq!(tokens, vec!["summary".to_string()]);
    }

    #[test]
    fn match_returns_none_for_empty_steps() {
        assert!(match_meta_file_to_step("anything.pdf", &[]).is_none());
    }

    #[test]
    fn match_scores_keyword_overlap() {
        let steps = vec![step("Overview", &["study", "clinical"]), step("Other", &["unrelated"])];
        // "clin_study.pdf" tokens include "study" (exact) and "clin"/"study" parts.
        let matched = match_meta_file_to_step("clin_study.pdf", &steps).unwrap();
        assert_eq!(matched.type_name, "Overview");
    }

    #[test]
    fn match_type_slug_bonus_dominates() {
        // Step B's slug "biomaterialhbtable" is contained in the file name -> +5,
        // outweighing step A's single keyword overlap.
        let steps = vec![
            step("Overview", &["study"]),
            step("Biomaterial HB Table", &["irrelevant"]),
        ];
        let matched =
            match_meta_file_to_step("report_biomaterialhbtable_study.pdf", &steps).unwrap();
        assert_eq!(matched.type_name, "Biomaterial HB Table");
    }

    #[test]
    fn match_is_stable_on_ties() {
        // Both steps score exactly 1 on "study"; the strict `>` keeps the first.
        let steps = vec![step("First", &["study"]), step("Second", &["study"])];
        let matched = match_meta_file_to_step("study.pdf", &steps).unwrap();
        assert_eq!(matched.type_name, "First");
    }

    #[test]
    fn match_returns_none_when_nothing_scores() {
        let steps = vec![step("Overview", &["nonoverlapping"])];
        assert!(match_meta_file_to_step("zzz.pdf", &steps).is_none());
    }

    #[test]
    fn format_expands_placeholders_sequentially() {
        assert_eq!(
            format_meta_instruction("Summarize {pdf_name} as {type}.", "study.pdf", "Overview"),
            "Summarize study.pdf as Overview."
        );
        // A {type} injected via the file name is expanded by the second pass.
        assert_eq!(
            format_meta_instruction("File: {pdf_name}", "a{type}b", "T"),
            "File: aTb"
        );
        // No placeholders -> unchanged.
        assert_eq!(format_meta_instruction("plain", "f.pdf", "T"), "plain");
    }
}
