//! Export sanitizers for the canvas-272 export subtree.
//!
//! Ports the sanitization half of
//! `frontend_v3/app/canvas-272/lib/exportFormatter.ts` under
//! **equivalent-behavior** parity (not byte-parity — see the port plan, "Parity
//! requirements"). This unit owns everything that *cleans* a document on its way
//! to markdown; the assembly (`buildStructuredDoc`) lives in the sibling
//! `structured_doc` unit and the final render (`structuredDocToMarkdown`) in
//! `markdown`.
//!
//! ## What this unit owns
//!
//! Two layers of sanitization, exactly as the reference splits them:
//!
//! 1. **Structural** — [`prepare_structured_doc_for_export`] (ports
//!    `prepareStructuredDocForExport`) plus the display-name normalizers it calls
//!    ([`normalize_export_display_title`], [`strip_section_marker_from_export_label`]).
//!    It drops technical/empty placeholder steps, applies the section
//!    heading-drop (folding a header step whose display name equals the section
//!    heading into the next step), normalizes step names, and merges consecutive
//!    steps that share a display name.
//! 2. **Line-level markdown** — [`sanitize_markdown_for_document_preview`] (ports
//!    `sanitizeMarkdownForDocumentPreview`) and its predicates
//!    ([`is_known_empty_llm_placeholder_line`], [`is_known_no_output_placeholder_line`],
//!    [`is_known_empty_llm_placeholder_only_body`]). It is **fence-aware** (lines
//!    inside ` ``` `/`~~~` fences are never stripped), removes known LLM-noise
//!    lines (`no source text identified` / `(no output)` variants /
//!    `Input text Test.`), and collapses runs of 3+ newlines to a single blank
//!    line.
//!
//! ## Regex-free by design (parity-critical)
//!
//! The `domain` crate deliberately carries no `regex` dependency — the sibling
//! `agentnodes::validation` and `agentnodes::export::display_name` modules
//! hand-roll every zod/JS regex with byte/char scanning, and this module follows
//! the same convention. The task calls these "byte-faithful regexes": each
//! reference pattern is reproduced structurally by the private [`Scanner`] below,
//! preserving the exact character classes, quantifier bounds, case-insensitivity,
//! and anchoring of the JS source. Every port comment cites the original pattern.
//!
//! JS `\s` and Rust [`char::is_whitespace`] agree on every code point that matters
//! here; they differ only on U+FEFF (BOM), which is irrelevant to export text and
//! acceptable under equivalent-behavior parity (same note as `display_name`).
//! JS `\d` is ASCII by default, mirrored with [`char::is_ascii_digit`]. JS string
//! `.length` (UTF-16 units) is replaced by ordinary char counts — the port plan
//! explicitly drops UTF-16-unit counting as a non-goal under equivalent behavior.

use crate::agentnodes::export::display_name::{format_agent_display_name, format_agent_toolbar_title};
use crate::agentnodes::export::structured_doc::{
    StructuredDoc, StructuredDocSection, StructuredDocStep,
};

// ---------------------------------------------------------------------------
// Structural sanitization (prepareStructuredDocForExport)
// ---------------------------------------------------------------------------

/// Strip a leading `[SECTION n]` marker and any leading numeric-id prefixes from
/// an export label. Mirrors `stripSectionMarkerFromExportLabel`.
///
/// Steps (all on the trimmed raw string, `original`):
/// 1. Remove one leading `^\[\s*SECTION\s*\d+\s*\]\s*` (case-insensitive).
/// 2. Repeatedly remove a leading `^\d{5,}\s*[-–—―]\s*` while one matches
///    (`-` hyphen-minus, `–` en dash, `—` em dash, `―`
///    horizontal bar).
/// 3. Trim, and fall back to `original` if the result is now empty (`s || original`).
pub fn strip_section_marker_from_export_label(raw: &str) -> String {
    let original = raw.trim().to_string();
    if original.is_empty() {
        // Mirrors `if (!s) return s;` — returns the (empty) trimmed string.
        return original;
    }

    let mut s = original.clone();

    // s = s.replace(/^\[\s*SECTION\s*\d+\s*\]\s*/i, '') — a single anchored strip.
    {
        let chars: Vec<char> = s.chars().collect();
        if let Some(consumed) = match_leading_section_bracket(&chars) {
            s = chars[consumed..].iter().collect();
        }
    }

    // while (leadingId.test(s)) { s = s.replace(leadingId, '') } — repeat until no
    // leading numeric-id prefix remains.
    loop {
        let chars: Vec<char> = s.chars().collect();
        match match_leading_numeric_id(&chars) {
            Some(consumed) => s = chars[consumed..].iter().collect(),
            None => break,
        }
    }

    let s = s.trim();
    if s.is_empty() {
        original
    } else {
        s.to_string()
    }
}

/// Normalize a raw label to its export display title. Mirrors
/// `normalizeExportDisplayTitle` (a thin alias over `sanitizeExportStepName`).
pub fn normalize_export_display_title(raw: &str, doc: &StructuredDoc) -> String {
    sanitize_export_step_name(raw, doc)
}

/// Mirrors the private `sanitizeExportStepName`: strip section markers, shorten a
/// technical layer name, then collapse a name that equals the agent name (raw or
/// display form) down to the agent toolbar title.
fn sanitize_export_step_name(raw: &str, doc: &StructuredDoc) -> String {
    let s = strip_section_marker_from_export_label(raw);
    let s = shorten_technical_layer_name(&s);
    let an = doc.agent_name.trim();
    if !an.is_empty() {
        let display = format_agent_display_name(an);
        if s == an || s == display {
            return format_agent_toolbar_title(an, None);
        }
    }
    s
}

/// Mirrors the private `shortenTechnicalLayerName`: replace long machine-generated
/// report/clinical agent names with their compact toolbar title.
fn shorten_technical_layer_name(name: &str) -> String {
    let t = name.trim();
    if t.is_empty() {
        return t.to_string();
    }
    // t.includes('_clinical_Report-agent-') || /^Report-agent-/i.test(t)
    if t.contains("_clinical_Report-agent-") || starts_with_ci(t, "Report-agent-") {
        return format_agent_toolbar_title(t, None);
    }
    let hyphens = t.chars().filter(|&c| c == '-').count();
    let underscores = t.chars().filter(|&c| c == '_').count();
    // t.length > 64 && hyphens >= 6 && underscores >= 2 && !t.includes(' ')
    if t.chars().count() > 64 && hyphens >= 6 && underscores >= 2 && !t.contains(' ') {
        return format_agent_toolbar_title(t, None);
    }
    t.to_string()
}

/// Mirrors the private `isTechnicalEmptyPlaceholderStep`: a step whose output is
/// blank and whose name is a machine-generated report/clinical name (or equals
/// the agent name) is a droppable placeholder.
fn is_technical_empty_placeholder_step(name: &str, output: &str, doc: &StructuredDoc) -> bool {
    if !output.trim().is_empty() {
        return false;
    }
    let s = name.trim();
    if s.is_empty() {
        return false;
    }
    if s.contains("_clinical_Report-agent-") {
        return true;
    }
    if starts_with_ci(s, "Report-agent-") {
        return true;
    }
    let an = doc.agent_name.trim();
    if !an.is_empty() {
        let display = format_agent_display_name(an);
        if s == an || s == display {
            return true;
        }
    }
    if s.chars().count() > 64 {
        let hyphens = s.chars().filter(|&c| c == '-').count();
        let underscores = s.chars().filter(|&c| c == '_').count();
        if hyphens >= 6 && underscores >= 2 && !s.contains(' ') {
            return true;
        }
    }
    false
}

/// Mirrors the private `mergeConsecutiveStepsWithSameDisplayName`: fold each run
/// of adjacent steps sharing a (already-normalized) display name into one step,
/// concatenating their trimmed outputs with a blank line.
///
/// The surviving step keeps the first step's `number` and `name`; only `output`
/// is rewritten. Blank outputs are dropped from the join (`a ? (b ? a\n\nb : a) : b`).
fn merge_consecutive_steps_with_same_display_name(
    steps: Vec<StructuredDocStep>,
) -> Vec<StructuredDocStep> {
    let mut out: Vec<StructuredDocStep> = Vec::new();
    for st in steps {
        // Compute the "same display name as the previous step" decision under an
        // immutable borrow, then re-borrow mutably — avoids the guard-plus-`_`
        // double-borrow of `out` that `match out.last_mut()` would trip over.
        let same_as_prev = out.last().map(|prev| prev.name == st.name).unwrap_or(false);
        if same_as_prev {
            let prev = out
                .last_mut()
                .expect("out is non-empty when same_as_prev is true");
            let a = prev.output.trim().to_string();
            let b = st.output.trim().to_string();
            prev.output = if !a.is_empty() {
                if !b.is_empty() {
                    format!("{a}\n\n{b}")
                } else {
                    a
                }
            } else {
                b
            };
        } else {
            out.push(st);
        }
    }
    out
}

/// Prepare a structured document for export. Mirrors `prepareStructuredDocForExport`.
///
/// Per section, in order:
/// 1. Sanitize the heading (`null`/empty heading stays absent).
/// 2. Drop technical empty-placeholder steps.
/// 3. Section heading-drop: if the (sanitized) display name of the first
///    surviving step equals the sanitized heading, drop that header step and
///    fold its trimmed output into the next step.
/// 4. Normalize every step's name.
/// 5. Merge consecutive steps sharing a display name.
///
/// All other document fields (title, agent name, timestamp) pass through
/// unchanged (`{...doc, sections}`).
pub fn prepare_structured_doc_for_export(doc: &StructuredDoc) -> StructuredDoc {
    let sections: Vec<StructuredDocSection> = doc
        .sections
        .iter()
        .map(|section| {
            // section.heading ? normalizeExportDisplayTitle(...) : null — the JS
            // truthiness check treats an empty-string heading as falsy → None.
            let heading_sanitized: Option<String> = match &section.heading {
                Some(h) if !h.is_empty() => Some(normalize_export_display_title(h, doc)),
                _ => None,
            };

            let mut steps: Vec<StructuredDocStep> = section.steps.clone();
            // steps.filter(st => !isTechnicalEmptyPlaceholderStep(...))
            steps.retain(|st| !is_technical_empty_placeholder_step(&st.name, &st.output, doc));

            // if (headingSanitized && steps.length > 0) — a truthy (non-empty)
            // sanitized heading gates the heading-drop.
            let heading_str = heading_sanitized.as_deref().filter(|h| !h.is_empty());
            if let Some(heading_str) = heading_str {
                if !steps.is_empty() {
                    let first_display = normalize_export_display_title(&steps[0].name, doc);
                    // Only drop the redundant header step when there is a FOLLOWING
                    // step to fold its output into. If the header step is the
                    // section's only step, keep it: `structured_doc_to_markdown`
                    // emits step outputs only (never headings), so dropping it here
                    // would silently erase the section's entire content from the
                    // markdown export — the "1-step-section heading-drop -> empty
                    // report" trap that a `/^section\b/i`-named layer triggers.
                    // (Keeping it causes no duplicate heading, since headings are
                    // never rendered.)
                    if first_display == heading_str && steps.len() > 1 {
                        let dropped_out = steps[0].output.trim().to_string();
                        steps.remove(0);
                        if !dropped_out.is_empty() {
                            let next_out = steps[0].output.trim().to_string();
                            steps[0].output = if !next_out.is_empty() {
                                format!("{dropped_out}\n\n{next_out}")
                            } else {
                                dropped_out
                            };
                        }
                    }
                }
            }

            // steps.map(st => ({...st, name: normalizeExportDisplayTitle(...)}))
            for st in steps.iter_mut() {
                st.name = normalize_export_display_title(&st.name, doc);
            }

            let steps = merge_consecutive_steps_with_same_display_name(steps);

            StructuredDocSection {
                heading: heading_sanitized,
                steps,
                tag: section.tag.clone(),
            }
        })
        .collect();

    StructuredDoc {
        sections,
        ..doc.clone()
    }
}

// ---------------------------------------------------------------------------
// Line-level markdown sanitization (sanitizeMarkdownForDocumentPreview)
// ---------------------------------------------------------------------------

/// Options for [`sanitize_markdown_for_document_preview`]. Mirrors the reference
/// `SanitizeMarkdownForDocumentPreviewOptions`.
#[derive(Debug, Clone, Copy, Default)]
pub struct SanitizeMarkdownForDocumentPreviewOptions {
    /// When set, a canonical `_(no output)_` underscore-emphasis line is *kept*
    /// rather than stripped (mirrors `preserveCanonicalNoOutputEmphasisLines`).
    pub preserve_canonical_no_output_emphasis_lines: bool,
}

/// Whether a line is the known "no source text identified" LLM placeholder.
/// Mirrors `isKnownEmptyLlmPlaceholderLine` /
/// `KNOWN_EMPTY_LLM_PLACEHOLDER_LINE_RE`:
/// `^\*{0,2}\s*no\s+source\s+text\s+identified\.?!*\s*\*{0,2}$` (case-insensitive,
/// on the trimmed line).
pub fn is_known_empty_llm_placeholder_line(line: &str) -> bool {
    let chars: Vec<char> = line.trim().chars().collect();
    let mut sc = Scanner::new(&chars);
    sc.eat_char_bounded('*', 2); // \*{0,2}
    sc.eat_ws_star(); // \s*
    if !sc.eat_literal_ci("no") {
        return false;
    }
    if !sc.eat_ws_plus() {
        return false;
    }
    if !sc.eat_literal_ci("source") {
        return false;
    }
    if !sc.eat_ws_plus() {
        return false;
    }
    if !sc.eat_literal_ci("text") {
        return false;
    }
    if !sc.eat_ws_plus() {
        return false;
    }
    if !sc.eat_literal_ci("identified") {
        return false;
    }
    sc.eat_char_bounded('.', 1); // \.?
    sc.eat_char_greedy('!'); // !*
    sc.eat_ws_star(); // \s*
    sc.eat_char_bounded('*', 2); // \*{0,2}
    sc.at_end() // $
}

/// Whether a line is a known "(no output)" placeholder (plain, underscore- or
/// asterisk-emphasized). Mirrors `isKnownNoOutputPlaceholderLine`.
pub fn is_known_no_output_placeholder_line(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() {
        return false;
    }
    matches_no_output_plain(t) || matches_no_output_underscore(t) || matches_no_output_asterisk(t)
}

/// Whether a whole (possibly multi-line) body is nothing but known empty-LLM
/// placeholder lines. Mirrors `isKnownEmptyLlmPlaceholderOnlyBody`: trim, split on
/// `\r?\n`, trim + drop blank lines, and require at least one line with every
/// line matching [`is_known_empty_llm_placeholder_line`].
pub fn is_known_empty_llm_placeholder_only_body(output: &str) -> bool {
    let lines: Vec<String> = output
        .trim()
        // split(/\r?\n/) then map(trim): splitting on '\n' and trimming each piece
        // drops any trailing '\r' identically (CR is whitespace).
        .split('\n')
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    if lines.is_empty() {
        return false;
    }
    lines.iter().all(|l| is_known_empty_llm_placeholder_line(l))
}

/// Sanitize a markdown string for the document preview / export. Mirrors
/// `sanitizeMarkdownForDocumentPreview`.
///
/// 1. Trim; empty → `""`.
/// 2. Walk lines (split on `\r?\n`), tracking fenced code blocks (a line whose
///    trimmed-start begins with ` ``` ` or `~~~` toggles the fence and is always
///    kept). Lines inside a fence are kept verbatim; outside a fence, known-noise
///    lines ([`is_preview_noise_line_to_strip`]) are dropped.
/// 3. Join with `\n`, trim, then collapse every run of 3+ newlines to `\n\n`.
pub fn sanitize_markdown_for_document_preview(
    markdown: &str,
    opts: Option<&SanitizeMarkdownForDocumentPreviewOptions>,
) -> String {
    let trimmed = markdown.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    // Normalize CRLF -> LF so `split('\n')` faithfully replicates `split(/\r?\n/)`
    // (a lone CR is left inside its line, exactly as the JS regex would).
    let normalized = trimmed.replace("\r\n", "\n");

    let mut in_fence = false;
    let mut out_lines: Vec<&str> = Vec::new();
    for line in normalized.split('\n') {
        let trimmed_start = line.trim_start();
        // /^(```|~~~)/.test(trimmedStart)
        if trimmed_start.starts_with("```") || trimmed_start.starts_with("~~~") {
            in_fence = !in_fence;
            out_lines.push(line);
            continue;
        }
        if in_fence {
            out_lines.push(line);
            continue;
        }
        if is_preview_noise_line_to_strip(line, opts) {
            continue;
        }
        out_lines.push(line);
    }

    let joined = out_lines.join("\n");
    let result = joined.trim();
    collapse_three_or_more_newlines(result)
}

/// Mirrors the private `isPreviewNoiseLineToStrip`: strip empty-LLM placeholder
/// lines and `(no output)` variants and `Input text Test.` lines — but keep a
/// canonical `_(no output)_` line when the option requests it.
fn is_preview_noise_line_to_strip(
    line: &str,
    opts: Option<&SanitizeMarkdownForDocumentPreviewOptions>,
) -> bool {
    let t = line.trim();
    if is_known_empty_llm_placeholder_line(t) {
        return true;
    }
    if opts
        .map(|o| o.preserve_canonical_no_output_emphasis_lines)
        .unwrap_or(false)
        && matches_no_output_underscore(t)
    {
        return false;
    }
    if is_known_no_output_placeholder_line(t) {
        return true;
    }
    if is_input_text_test_line(t) {
        return true;
    }
    false
}

/// `/^\(\s*no\s+output\s*\)$/i` on the trimmed line.
fn matches_no_output_plain(t: &str) -> bool {
    let chars: Vec<char> = t.chars().collect();
    let mut sc = Scanner::new(&chars);
    if !sc.eat_char('(') {
        return false;
    }
    if !eat_no_output_core(&mut sc) {
        return false;
    }
    if !sc.eat_char(')') {
        return false;
    }
    sc.at_end()
}

/// `/^_\s*\(\s*no\s+output\s*\)\s*_\s*$/i` on the trimmed line.
fn matches_no_output_underscore(t: &str) -> bool {
    let chars: Vec<char> = t.chars().collect();
    let mut sc = Scanner::new(&chars);
    if !sc.eat_char('_') {
        return false;
    }
    sc.eat_ws_star();
    if !sc.eat_char('(') {
        return false;
    }
    if !eat_no_output_core(&mut sc) {
        return false;
    }
    if !sc.eat_char(')') {
        return false;
    }
    sc.eat_ws_star();
    if !sc.eat_char('_') {
        return false;
    }
    sc.eat_ws_star();
    sc.at_end()
}

/// `/^\*\s*\(\s*no\s+output\s*\)\s*\*$/i` on the trimmed line (no trailing `\s*`).
fn matches_no_output_asterisk(t: &str) -> bool {
    let chars: Vec<char> = t.chars().collect();
    let mut sc = Scanner::new(&chars);
    if !sc.eat_char('*') {
        return false;
    }
    sc.eat_ws_star();
    if !sc.eat_char('(') {
        return false;
    }
    if !eat_no_output_core(&mut sc) {
        return false;
    }
    if !sc.eat_char(')') {
        return false;
    }
    sc.eat_ws_star();
    if !sc.eat_char('*') {
        return false;
    }
    sc.at_end()
}

/// The shared `\s*no\s+output\s*` core (between the opening `(` and closing `)`).
fn eat_no_output_core(sc: &mut Scanner) -> bool {
    sc.eat_ws_star();
    if !sc.eat_literal_ci("no") {
        return false;
    }
    if !sc.eat_ws_plus() {
        return false;
    }
    if !sc.eat_literal_ci("output") {
        return false;
    }
    sc.eat_ws_star();
    true
}

/// `/^Input text Test\.?$/i` on the trimmed line.
fn is_input_text_test_line(t: &str) -> bool {
    let chars: Vec<char> = t.chars().collect();
    let mut sc = Scanner::new(&chars);
    if !sc.eat_literal_ci("Input text Test") {
        return false;
    }
    sc.eat_char_bounded('.', 1);
    sc.at_end()
}

/// Collapse every run of 3+ `\n` to `\n\n`. Mirrors `.replace(/\n{3,}/g, '\n\n')`.
///
/// Runs of 1 or 2 newlines pass through unchanged; a run of `n` newlines emits
/// `min(n, 2)` newlines, which is exactly the regex behavior for `n >= 1`.
fn collapse_three_or_more_newlines(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut run = 0usize;
    for c in s.chars() {
        if c == '\n' {
            run += 1;
        } else {
            if run > 0 {
                for _ in 0..run.min(2) {
                    out.push('\n');
                }
                run = 0;
            }
            out.push(c);
        }
    }
    for _ in 0..run.min(2) {
        out.push('\n');
    }
    out
}

// ---------------------------------------------------------------------------
// Leading-prefix matchers (used by strip_section_marker_from_export_label)
// ---------------------------------------------------------------------------

/// Match `^\[\s*SECTION\s*\d+\s*\]\s*` (case-insensitive). Returns the number of
/// leading chars consumed, or `None` if the prefix does not match.
fn match_leading_section_bracket(chars: &[char]) -> Option<usize> {
    let mut sc = Scanner::new(chars);
    if !sc.eat_char('[') {
        return None;
    }
    sc.eat_ws_star();
    if !sc.eat_literal_ci("SECTION") {
        return None;
    }
    sc.eat_ws_star();
    if sc.eat_digits() == 0 {
        return None;
    }
    sc.eat_ws_star();
    if !sc.eat_char(']') {
        return None;
    }
    sc.eat_ws_star();
    Some(sc.pos)
}

/// Match `^\d{5,}\s*[-–—―]\s*`. Returns the number of leading
/// chars consumed, or `None` if the prefix does not match.
fn match_leading_numeric_id(chars: &[char]) -> Option<usize> {
    const DASHES: [char; 4] = ['\u{002D}', '\u{2013}', '\u{2014}', '\u{2015}'];
    let mut sc = Scanner::new(chars);
    if sc.eat_digits() < 5 {
        return None;
    }
    sc.eat_ws_star();
    if !sc.eat_one_of(&DASHES) {
        return None;
    }
    sc.eat_ws_star();
    Some(sc.pos)
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/// Case-insensitive `starts_with` (ASCII-fold). Mirrors `/^<prefix>/i` /
/// `String.startsWith` used with fixed ASCII prefixes.
fn starts_with_ci(s: &str, prefix: &str) -> bool {
    let mut it = s.chars();
    for pc in prefix.chars() {
        match it.next() {
            Some(sc) if sc.eq_ignore_ascii_case(&pc) => continue,
            _ => return false,
        }
    }
    true
}

/// A cursor over a char slice used to hand-roll the anchored JS regexes above
/// without pulling a `regex` dependency into the `domain` crate (see the module
/// doc). Each method consumes one regex token from the current position.
struct Scanner<'a> {
    chars: &'a [char],
    pos: usize,
}

impl<'a> Scanner<'a> {
    fn new(chars: &'a [char]) -> Self {
        Self { chars, pos: 0 }
    }

    /// `$` — true when the cursor has consumed the whole slice.
    fn at_end(&self) -> bool {
        self.pos >= self.chars.len()
    }

    /// `\s*` — consume zero or more whitespace chars.
    fn eat_ws_star(&mut self) {
        while matches!(self.chars.get(self.pos), Some(c) if c.is_whitespace()) {
            self.pos += 1;
        }
    }

    /// `\s+` — consume one or more whitespace chars; `false` if none present.
    fn eat_ws_plus(&mut self) -> bool {
        let start = self.pos;
        self.eat_ws_star();
        self.pos > start
    }

    /// Match a fixed ASCII literal case-insensitively, advancing on success.
    fn eat_literal_ci(&mut self, lit: &str) -> bool {
        let start = self.pos;
        for lc in lit.chars() {
            match self.chars.get(self.pos) {
                Some(c) if c.eq_ignore_ascii_case(&lc) => self.pos += 1,
                _ => {
                    self.pos = start;
                    return false;
                }
            }
        }
        true
    }

    /// Match a single literal char, advancing on success.
    fn eat_char(&mut self, expected: char) -> bool {
        if matches!(self.chars.get(self.pos), Some(&c) if c == expected) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    /// `X{0,max}` of a single char — consume up to `max` occurrences.
    fn eat_char_bounded(&mut self, expected: char, max: usize) {
        let mut n = 0;
        while n < max && matches!(self.chars.get(self.pos), Some(&c) if c == expected) {
            self.pos += 1;
            n += 1;
        }
    }

    /// `X*` of a single char — consume every consecutive occurrence.
    fn eat_char_greedy(&mut self, expected: char) {
        while matches!(self.chars.get(self.pos), Some(&c) if c == expected) {
            self.pos += 1;
        }
    }

    /// `\d*` (returning the count) — consume every consecutive ASCII digit.
    fn eat_digits(&mut self) -> usize {
        let start = self.pos;
        while matches!(self.chars.get(self.pos), Some(c) if c.is_ascii_digit()) {
            self.pos += 1;
        }
        self.pos - start
    }

    /// A single char from a set (`[...]`), advancing on success.
    fn eat_one_of(&mut self, options: &[char]) -> bool {
        if let Some(&c) = self.chars.get(self.pos) {
            if options.contains(&c) {
                self.pos += 1;
                return true;
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc_from(value: serde_json::Value) -> StructuredDoc {
        serde_json::from_value(value).expect("structured doc deserializes")
    }

    // ---- is_known_empty_llm_placeholder_line ----

    #[test]
    fn empty_llm_placeholder_matches_expected_shapes() {
        assert!(is_known_empty_llm_placeholder_line("no source text identified"));
        assert!(is_known_empty_llm_placeholder_line("No source text identified."));
        assert!(is_known_empty_llm_placeholder_line("**No source text identified.**"));
        assert!(is_known_empty_llm_placeholder_line("No source text identified!!!"));
        assert!(is_known_empty_llm_placeholder_line("  no   source   text   identified  "));
        assert!(is_known_empty_llm_placeholder_line("* no source text identified *"));
    }

    #[test]
    fn empty_llm_placeholder_rejects_non_matches() {
        assert!(!is_known_empty_llm_placeholder_line("no source text found"));
        assert!(!is_known_empty_llm_placeholder_line("no source text identified extra"));
        // Three asterisks exceed \*{0,2}.
        assert!(!is_known_empty_llm_placeholder_line("***no source text identified***"));
        assert!(!is_known_empty_llm_placeholder_line("source text identified"));
        assert!(!is_known_empty_llm_placeholder_line(""));
    }

    // ---- is_known_no_output_placeholder_line ----

    #[test]
    fn no_output_placeholder_matches_all_three_forms() {
        assert!(is_known_no_output_placeholder_line("(no output)"));
        assert!(is_known_no_output_placeholder_line("( no  output )"));
        assert!(is_known_no_output_placeholder_line("_(no output)_"));
        assert!(is_known_no_output_placeholder_line("_ ( no output ) _"));
        assert!(is_known_no_output_placeholder_line("*(no output)*"));
        // Surrounding whitespace is trimmed before matching, so this still matches.
        assert!(is_known_no_output_placeholder_line("  *(no output)*  "));
    }

    #[test]
    fn no_output_placeholder_rejects_non_matches() {
        assert!(!is_known_no_output_placeholder_line("(output)"));
        assert!(!is_known_no_output_placeholder_line("no output"));
        assert!(!is_known_no_output_placeholder_line("(no output) trailing"));
        // The function trims the line first (mirroring the reference JS), so
        // surrounding whitespace does NOT defeat a match — a genuine non-match
        // needs trailing non-whitespace content. (Trailing space alone is trimmed
        // away, and "*(no output)*" then matches the asterisk form; see the
        // positive assertion in no_output_placeholder_matches_all_three_forms.)
        assert!(!is_known_no_output_placeholder_line("*(no output)* x"));
        assert!(!is_known_no_output_placeholder_line(""));
    }

    // ---- is_known_empty_llm_placeholder_only_body ----

    #[test]
    fn placeholder_only_body_detects_all_placeholder_lines() {
        assert!(is_known_empty_llm_placeholder_only_body(
            "no source text identified\n\n**No source text identified.**"
        ));
        // A single blank body is not "placeholder-only" (zero non-blank lines).
        assert!(!is_known_empty_llm_placeholder_only_body("   \n  \n"));
        // Any real content makes it not placeholder-only.
        assert!(!is_known_empty_llm_placeholder_only_body(
            "no source text identified\nReal content"
        ));
    }

    // ---- sanitize_markdown_for_document_preview ----

    #[test]
    fn sanitize_strips_noise_lines_outside_fences() {
        let md = "Real one\nno source text identified\n(no output)\nInput text Test.\nReal two";
        assert_eq!(
            sanitize_markdown_for_document_preview(md, None),
            "Real one\nReal two"
        );
    }

    #[test]
    fn sanitize_is_fence_aware() {
        // The noise line inside the fence must survive; the one outside is stripped.
        let md = "Real\n\n```\nno source text identified\n```\n\nno source text identified";
        assert_eq!(
            sanitize_markdown_for_document_preview(md, None),
            "Real\n\n```\nno source text identified\n```"
        );
    }

    #[test]
    fn sanitize_collapses_three_or_more_newlines() {
        assert_eq!(
            sanitize_markdown_for_document_preview("A\n\n\n\nB", None),
            "A\n\nB"
        );
        // A run of exactly two is preserved.
        assert_eq!(
            sanitize_markdown_for_document_preview("A\n\nB", None),
            "A\n\nB"
        );
    }

    #[test]
    fn sanitize_empty_input_yields_empty() {
        assert_eq!(sanitize_markdown_for_document_preview("   \n  ", None), "");
    }

    #[test]
    fn sanitize_preserve_option_keeps_underscore_no_output() {
        let opts = SanitizeMarkdownForDocumentPreviewOptions {
            preserve_canonical_no_output_emphasis_lines: true,
        };
        // Underscore form kept; plain and asterisk forms still stripped.
        let md = "_(no output)_\n(no output)\n*(no output)*";
        assert_eq!(
            sanitize_markdown_for_document_preview(md, Some(&opts)),
            "_(no output)_"
        );
        // Without the option, all three are stripped -> empty.
        assert_eq!(sanitize_markdown_for_document_preview(md, None), "");
    }

    #[test]
    fn sanitize_normalizes_crlf() {
        assert_eq!(
            sanitize_markdown_for_document_preview("A\r\n\r\n\r\n\r\nB", None),
            "A\n\nB"
        );
    }

    // ---- strip_section_marker_from_export_label ----

    #[test]
    fn strips_leading_section_bracket() {
        assert_eq!(
            strip_section_marker_from_export_label("[SECTION 1] Introduction"),
            "Introduction"
        );
        assert_eq!(
            strip_section_marker_from_export_label("[ section  12 ]   Title"),
            "Title"
        );
    }

    #[test]
    fn strips_leading_numeric_ids_repeatedly() {
        assert_eq!(
            strip_section_marker_from_export_label("123456 - Real Name"),
            "Real Name"
        );
        // Em dash, no spaces, chained ids.
        assert_eq!(
            strip_section_marker_from_export_label("12345\u{2014}67890-Name"),
            "Name"
        );
        // Fewer than 5 digits is not a numeric-id prefix.
        assert_eq!(
            strip_section_marker_from_export_label("1234 - Keep"),
            "1234 - Keep"
        );
    }

    #[test]
    fn falls_back_to_original_when_result_empties() {
        assert_eq!(
            strip_section_marker_from_export_label("[SECTION 1]"),
            "[SECTION 1]"
        );
        assert_eq!(strip_section_marker_from_export_label("   "), "");
    }

    // ---- prepare_structured_doc_for_export ----

    #[test]
    fn prepare_drops_technical_empty_placeholder_steps() {
        let doc = doc_from(json!({
            "title": "Doc",
            "agentName": "My Agent",
            "exportedAt": "2020-01-01T00:00:00.000Z",
            "sections": [{
                "heading": null,
                "tag": null,
                "steps": [
                    { "number": "1", "name": "Real", "output": "Kept" },
                    // Blank output + machine name -> dropped.
                    { "number": "2", "name": "Report-agent-Foo-2026-09-22T14-30", "output": "  " },
                ],
            }],
        }));
        let prepared = prepare_structured_doc_for_export(&doc);
        assert_eq!(prepared.sections[0].steps.len(), 1);
        assert_eq!(prepared.sections[0].steps[0].name, "Real");
        assert_eq!(prepared.sections[0].steps[0].output, "Kept");
    }

    #[test]
    fn prepare_merges_consecutive_same_name_steps() {
        let doc = doc_from(json!({
            "title": "Doc",
            "agentName": "My Agent",
            "exportedAt": "2020-01-01T00:00:00.000Z",
            "sections": [{
                "heading": null,
                "tag": null,
                "steps": [
                    { "number": "1", "name": "Body", "output": "First" },
                    { "number": "2", "name": "Body", "output": "Second" },
                    { "number": "3", "name": "Other", "output": "Alone" },
                ],
            }],
        }));
        let prepared = prepare_structured_doc_for_export(&doc);
        let steps = &prepared.sections[0].steps;
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].name, "Body");
        assert_eq!(steps[0].output, "First\n\nSecond");
        assert_eq!(steps[1].name, "Other");
        assert_eq!(steps[1].output, "Alone");
    }

    #[test]
    fn prepare_applies_heading_drop_and_folds_output_into_next() {
        let doc = doc_from(json!({
            "title": "Doc",
            "agentName": "My Agent",
            "exportedAt": "2020-01-01T00:00:00.000Z",
            "sections": [{
                "heading": "Overview",
                "tag": null,
                "steps": [
                    // First step's display name equals the heading -> dropped, its
                    // output folded into the next step.
                    { "number": "1", "name": "Overview", "output": "Header body" },
                    { "number": "2", "name": "Details", "output": "Detail body" },
                ],
            }],
        }));
        let prepared = prepare_structured_doc_for_export(&doc);
        let section = &prepared.sections[0];
        assert_eq!(section.heading.as_deref(), Some("Overview"));
        assert_eq!(section.steps.len(), 1);
        assert_eq!(section.steps[0].name, "Details");
        assert_eq!(section.steps[0].output, "Header body\n\nDetail body");
    }

    #[test]
    fn prepare_keeps_lone_header_step_instead_of_emptying_the_section() {
        // Regression: a section whose ONLY step's display name equals the heading
        // (e.g. a `/^section\b/i`-named layer with no following step) must NOT be
        // emptied — its output is the section's entire content. Previously the
        // heading-drop removed the step and discarded its output, so the markdown
        // export silently lost the whole section.
        let doc = doc_from(json!({
            "title": "Doc",
            "agentName": "My Agent",
            "exportedAt": "2020-01-01T00:00:00.000Z",
            "sections": [{
                "heading": "Section 5",
                "tag": null,
                "steps": [
                    { "number": "1", "name": "Section 5", "output": "Critical safety content" },
                ],
            }],
        }));
        let prepared = prepare_structured_doc_for_export(&doc);
        let section = &prepared.sections[0];
        assert_eq!(section.steps.len(), 1);
        assert_eq!(section.steps[0].output, "Critical safety content");
        // And it actually reaches the markdown export.
        assert_eq!(
            crate::agentnodes::export::markdown::structured_doc_to_markdown(&doc),
            "Critical safety content"
        );
    }

    #[test]
    fn prepare_empty_string_heading_becomes_none() {
        let doc = doc_from(json!({
            "title": "Doc",
            "agentName": "My Agent",
            "exportedAt": "2020-01-01T00:00:00.000Z",
            "sections": [{
                "heading": "",
                "tag": null,
                "steps": [
                    { "number": "1", "name": "A", "output": "x" },
                    { "number": "2", "name": "A", "output": "y" },
                ],
            }],
        }));
        let prepared = prepare_structured_doc_for_export(&doc);
        // Empty heading is falsy -> None; no heading-drop, but merge still runs.
        assert_eq!(prepared.sections[0].heading, None);
        assert_eq!(prepared.sections[0].steps.len(), 1);
        assert_eq!(prepared.sections[0].steps[0].output, "x\n\ny");
    }
}
