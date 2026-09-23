//! `.docx` (OOXML) rendering for the canvas-272 export subtree.
//!
//! Finishes the deferred "Phase 6" docx export path. Given a fully-built
//! [`StructuredDoc`], [`structured_doc_to_docx`] produces a Word `.docx` byte
//! buffer **without any external binary** (no pandoc). It mirrors
//! `frontend_v3/app/canvas-272/lib/simpleDocxExport.ts` — the pure-JS fallback
//! the reference uses when the `pandoc` binary is absent — **not** the pandoc
//! primary, so LaTeX / OMML math and rich markdown formatting are intentionally
//! out of scope for v1: step bodies are emitted as plain text paragraphs.
//!
//! Content selection reuses the shared preparation + drop rules so the docx and
//! markdown exports stay consistent: the doc is run through
//! [`prepare_structured_doc_for_export`], and a step is skipped when its trimmed
//! output is empty or the raw output is a known placeholder-only body — exactly
//! the rule in [`super::markdown::structured_doc_to_markdown`]. Unlike the
//! markdown export (which is content-only), the docx keeps light structure: the
//! document title as a top heading and each non-empty section heading as a
//! sub-heading.

use docx_rs::{BreakType, Docx, Paragraph, Run};
use std::io::Cursor;

use crate::agentnodes::export::sanitize::{
    is_known_empty_llm_placeholder_only_body, prepare_structured_doc_for_export,
};
use crate::agentnodes::export::structured_doc::StructuredDoc;

/// Error rendering a [`StructuredDoc`] to a `.docx` buffer.
#[derive(Debug, thiserror::Error)]
pub enum DocxRenderError {
    /// The `docx-rs` writer failed to serialize/pack the OOXML zip.
    #[error("failed to pack the docx document: {0}")]
    Pack(String),
}

/// Render a [`StructuredDoc`] to a `.docx` (OOXML) byte buffer.
///
/// Structure: an optional title heading, then, per prepared section, an optional
/// section heading followed by one paragraph per kept step output (blank-line
/// separated blocks become separate paragraphs; single newlines become soft
/// line breaks). Empty and placeholder-only steps are dropped.
pub fn structured_doc_to_docx(doc: &StructuredDoc) -> Result<Vec<u8>, DocxRenderError> {
    let prepared = prepare_structured_doc_for_export(doc);

    let mut docx = Docx::new();

    let trimmed_title = doc.title.trim();
    if !trimmed_title.is_empty() {
        docx = docx.add_paragraph(heading_paragraph(trimmed_title, "Heading1"));
    }

    for section in &prepared.sections {
        if let Some(heading) = &section.heading {
            let trimmed_heading = heading.trim();
            if !trimmed_heading.is_empty() {
                docx = docx.add_paragraph(heading_paragraph(trimmed_heading, "Heading2"));
            }
        }

        for step in &section.steps {
            let trimmed_output = step.output.trim();
            // Mirror the markdown drop rule: skip empty (trimmed) or
            // placeholder-only (raw) bodies so nothing orphaned is emitted.
            if trimmed_output.is_empty() || is_known_empty_llm_placeholder_only_body(&step.output) {
                continue;
            }
            // A blank line separates paragraphs; single newlines are soft breaks.
            for block in trimmed_output.split("\n\n") {
                let block = block.trim_matches('\n');
                if block.is_empty() {
                    continue;
                }
                docx = docx.add_paragraph(body_paragraph(block));
            }
        }
    }

    let mut cursor = Cursor::new(Vec::<u8>::new());
    docx.build()
        .pack(&mut cursor)
        .map_err(|error| DocxRenderError::Pack(error.to_string()))?;
    Ok(cursor.into_inner())
}

/// A single styled heading paragraph.
fn heading_paragraph(text: &str, style_id: &str) -> Paragraph {
    Paragraph::new()
        .style(style_id)
        .add_run(Run::new().add_text(text))
}

/// A body paragraph where single newlines become soft (in-paragraph) breaks.
fn body_paragraph(block: &str) -> Paragraph {
    let mut paragraph = Paragraph::new();
    for (line_index, line) in block.split('\n').enumerate() {
        let mut run = Run::new();
        if line_index > 0 {
            run = run.add_break(BreakType::TextWrapping);
        }
        run = run.add_text(line);
        paragraph = paragraph.add_run(run);
    }
    paragraph
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc_from(value: serde_json::Value) -> StructuredDoc {
        serde_json::from_value(value).expect("structured doc deserializes")
    }

    /// A `.docx` is a ZIP archive; its first bytes are the local-file-header
    /// signature `PK\x03\x04`. A non-empty buffer with that signature is a
    /// sufficient smoke test that the writer produced a real package.
    #[test]
    fn renders_a_nonempty_docx_zip() {
        let doc = doc_from(json!({
            "title": "My Report",
            "agentName": "My Agent",
            "exportedAt": "2020-01-01T00:00:00.000Z",
            "sections": [{
                "heading": "Introduction",
                "tag": null,
                "steps": [
                    { "number": "1", "name": "Intro", "output": "Hello world\n\nSecond block" },
                ],
            }],
        }));

        let bytes = structured_doc_to_docx(&doc).expect("renders");
        assert!(bytes.len() > 4, "docx buffer must be non-empty");
        assert_eq!(&bytes[0..4], b"PK\x03\x04", "docx must be a ZIP package");
    }

    #[test]
    fn empty_doc_still_renders_a_valid_package() {
        let doc = doc_from(json!({
            "title": "",
            "agentName": "A",
            "exportedAt": "2020-01-01T00:00:00.000Z",
            "sections": [],
        }));

        let bytes = structured_doc_to_docx(&doc).expect("renders");
        assert_eq!(&bytes[0..4], b"PK\x03\x04");
    }
}
