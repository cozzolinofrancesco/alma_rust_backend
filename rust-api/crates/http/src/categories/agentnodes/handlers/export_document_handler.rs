//! `POST /api/v1/agentnodes/exports/{format}` — export an assembled report document.
//!
//! Ports `exportPortableDocument` from
//! `frontend_v3/app/lib/agentExecution/documents.server.ts` under **equivalent-behavior**
//! parity. Given a validated `StructuredDoc` (as produced by the sibling
//! `documents/assemble` handler) plus a `{format}` path segment, it renders the document as
//! a downloadable file and returns it with the reference download headers
//! (`Content-Type` / `Content-Disposition` / `Content-Length` / `Cache-Control` /
//! `X-Content-Type-Options` / `X-Document-Renderer`).
//!
//! ## Supported formats (v1)
//!
//! `json` and `markdown` only. `markdown` is rendered by the shared canvas-272 exporter
//! [`structured_doc_to_markdown`] (the same renderer that backs 272 **and** IB); `json`
//! emits `JSON.stringify(doc, null, 2)`-equivalent 2-space pretty JSON of the validated
//! document. `docx` is **deferred to Phase 6** (`pandocDocx.ts` shells to the pandoc binary;
//! the `docx-rs` reimplementation lands later), so it — like any other unknown format —
//! resolves to `UNSUPPORTED_EXPORT` (HTTP 400).
//!
//! Pure logic lives in [`render_portable_export`]; the axum handler is a thin wrapper that
//! enforces the auth perimeter, reads the `{format}` path segment, and marshals the JSON body
//! into a binary download response.

use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::agentnodes::error::{AgentExecutionError, stage};
use alma_domain::agentnodes::export::markdown::structured_doc_to_markdown;
use alma_domain::agentnodes::export::structured_doc::StructuredDoc;
use alma_macros::route;
use axum::Json;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::response::Response;
use http::header::{
    CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE, X_CONTENT_TYPE_OPTIONS,
};
use http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use serde::Deserialize;
use serde_json::Value;

use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;

/// Maximum rendered export size, mirroring the reference `buffer.length > 32 * 1024 * 1024`
/// guard (`OUTPUT_TOO_LARGE`, HTTP 413).
const MAX_EXPORT_BYTES: usize = 32 * 1024 * 1024;

/// The `X-Document-Renderer` header name (lower-cased; `HeaderName` is case-insensitive).
/// Mirrors the reference response header of the same name.
const X_DOCUMENT_RENDERER: &str = "x-document-renderer";

/// `exportSchema` (`documents.server.ts`): `{ doc, fileName? }.strict()`.
///
/// `doc` is validated against `structuredDocSchema` by deserializing into the domain
/// [`StructuredDoc`] (its `camelCase` shape is exactly the reference wire shape produced by
/// `documents/assemble`). `deny_unknown_fields` enforces the top-level `.strict()`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExportDocumentRequest {
    doc: StructuredDoc,
    #[serde(default)]
    file_name: Option<String>,
}

/// A fully rendered export ready to be framed as an HTTP download.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RenderedExport {
    /// The download filename, e.g. `my_report.md`.
    filename: String,
    /// The `Content-Type` header value (with charset).
    content_type: &'static str,
    /// The `X-Document-Renderer` header value — the format that actually rendered the body.
    renderer: &'static str,
    /// The rendered file bytes.
    body: Vec<u8>,
}

/// `POST /api/v1/agentnodes/exports/{format}`.
///
/// Enforces the shared auth perimeter (the `HttpRequestInPipeline<RequestHasBeenAuthorized>`
/// extractor), reads the `{format}` path segment, and delegates to the pure
/// [`render_portable_export`]. The operation is pure (no I/O), so `State` is accepted only to
/// keep the handler shape uniform with the rest of the category and is otherwise unused.
#[route(method = "POST", path = "/api/v1/agentnodes/exports/:export_format")]
pub async fn export_document_handler<TransactionalUnitOfWork>(
    State(_application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Path(export_format): Path<String>,
    Json(submitted_body): Json<Value>,
) -> Result<Response, AgentExecutionError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let rendered = render_portable_export(submitted_body, &export_format)?;
    Ok(build_download_response(rendered))
}

/// Pure port of `exportPortableDocument(raw, format)` for the `json` / `markdown` formats.
///
/// Returns the [`RenderedExport`] on success, or the matching [`AgentExecutionError`]:
/// `UNSUPPORTED_EXPORT` (unknown / deferred format), `INVALID_INPUT` (malformed body / doc),
/// or `OUTPUT_TOO_LARGE` (rendered body exceeds 32MB).
fn render_portable_export(
    raw: Value,
    export_format: &str,
) -> Result<RenderedExport, AgentExecutionError> {
    // Content negotiation first, mirroring the reference `hasOwnProperty(formats, format)`
    // guard. `docx` is deferred (Phase 6) and falls through to UNSUPPORTED_EXPORT.
    let (content_type, extension, renderer): (&'static str, &'static str, &'static str) =
        match export_format {
            "json" => ("application/json; charset=utf-8", "json", "json"),
            "markdown" => ("text/markdown; charset=utf-8", "md", "markdown"),
            _ => {
                return Err(AgentExecutionError::unsupported_export(
                    "Supported exports are json and markdown.",
                ));
            }
        };

    // `exportSchema.parse(raw)` — strict `{ doc, fileName? }` with `doc: structuredDocSchema`.
    let request: ExportDocumentRequest = serde_json::from_value(raw)
        .map_err(|error| schema_error(format!("Invalid export request: {error}")))?;

    let filename = build_export_filename(&request, extension);

    let body: Vec<u8> = match export_format {
        "json" => serde_json::to_string_pretty(&request.doc)
            .map_err(|error| {
                AgentExecutionError::export_failed(format!("document serialization error: {error}"))
            })?
            .into_bytes(),
        // Only `json` / `markdown` reach here (the match above rejects the rest).
        _ => structured_doc_to_markdown(&request.doc).into_bytes(),
    };

    if body.len() > MAX_EXPORT_BYTES {
        return Err(AgentExecutionError::output_too_large(
            "The exported document exceeds 32MB.",
        ));
    }

    Ok(RenderedExport {
        filename,
        content_type,
        renderer,
        body,
    })
}

/// Compute the download filename, porting the reference expression:
/// `(fileName ?? doc.title ?? 'report')` → strip a trailing known export extension →
/// replace `[^a-zA-Z0-9_-]+` runs with `_` → take the first 180 chars → `|| 'report'` →
/// append `.{extension}`.
fn build_export_filename(request: &ExportDocumentRequest, extension: &str) -> String {
    // `??` is null-coalescing: an explicit (even empty) `fileName` wins over `doc.title`.
    let base = request
        .file_name
        .clone()
        .unwrap_or_else(|| request.doc.title.clone());
    let stripped = strip_known_export_extension(&base);
    let sanitized = sanitize_filename_stem(&stripped);
    let sliced: String = sanitized.chars().take(180).collect();
    let stem = if sliced.is_empty() {
        "report".to_string()
    } else {
        sliced
    };
    format!("{stem}.{extension}")
}

/// Strip a single trailing known export extension, mirroring the reference regex
/// `/\.(?:json|md|markdown|docx)$/i` (case-insensitive, anchored at end). At most one of the
/// candidate suffixes can match the very end of the string, so the order is irrelevant.
fn strip_known_export_extension(name: &str) -> String {
    let lowercased = name.to_ascii_lowercase();
    for candidate in [".markdown", ".json", ".docx", ".md"] {
        if lowercased.ends_with(candidate) {
            return name[..name.len() - candidate.len()].to_string();
        }
    }
    name.to_string()
}

/// Replace every maximal run of characters outside `[A-Za-z0-9_-]` with a single `_`,
/// mirroring the reference `replace(/[^a-zA-Z0-9_-]+/g, '_')` (ASCII-only character class).
fn sanitize_filename_stem(name: &str) -> String {
    let mut sanitized = String::with_capacity(name.len());
    let mut inside_disallowed_run = false;
    for character in name.chars() {
        if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
            sanitized.push(character);
            inside_disallowed_run = false;
        } else if !inside_disallowed_run {
            sanitized.push('_');
            inside_disallowed_run = true;
        }
    }
    sanitized
}

/// Frame a [`RenderedExport`] as an attachment download `Response`, mirroring the reference
/// header set. The custom `X-Document-Renderer` records the renderer that produced the body;
/// the plain-text DOCX warning header is not emitted because docx is deferred (Phase 6).
fn build_download_response(rendered: RenderedExport) -> Response {
    let mut response_headers = HeaderMap::new();
    response_headers.insert(CONTENT_TYPE, HeaderValue::from_static(rendered.content_type));
    response_headers.insert(
        CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"{}\"", rendered.filename))
            .unwrap_or_else(|_| HeaderValue::from_static("attachment; filename=\"report\"")),
    );
    response_headers.insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&rendered.body.len().to_string())
            .unwrap_or_else(|_| HeaderValue::from_static("0")),
    );
    response_headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response_headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    response_headers.insert(
        HeaderName::from_static(X_DOCUMENT_RENDERER),
        HeaderValue::from_static(rendered.renderer),
    );

    let mut response = Response::new(Body::from(rendered.body));
    *response.status_mut() = StatusCode::OK;
    *response.headers_mut() = response_headers;
    response
}

/// A zod `.parse` shape failure (malformed body / doc): `INVALID_INPUT`, HTTP 400,
/// `stage = "validation"`. Kept consistent with the sibling `assemble` handler.
fn schema_error(message: impl Into<String>) -> AgentExecutionError {
    AgentExecutionError::new(
        "INVALID_INPUT",
        message,
        StatusCode::BAD_REQUEST,
        stage::VALIDATION,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A minimal valid `{ doc, ... }` export body. The `doc` matches `structuredDocSchema`
    /// (the shape `documents/assemble` emits).
    fn export_body(title: &str, output: &str) -> Value {
        json!({
            "doc": {
                "title": title,
                "agentName": title,
                "exportedAt": "2026-01-01T00:00:00.000Z",
                "sections": [{
                    "heading": null,
                    "tag": null,
                    "steps": [{ "number": "1", "name": "Intro", "output": output }],
                }],
            }
        })
    }

    #[test]
    fn markdown_export_emits_only_trimmed_step_outputs() {
        let rendered =
            render_portable_export(export_body("My Report", "  Hello world  "), "markdown")
                .expect("renders markdown");
        assert_eq!(rendered.content_type, "text/markdown; charset=utf-8");
        assert_eq!(rendered.renderer, "markdown");
        assert_eq!(rendered.filename, "My_Report.md");
        assert_eq!(String::from_utf8(rendered.body).unwrap(), "Hello world");
    }

    #[test]
    fn json_export_is_two_space_pretty_and_round_trips() {
        let rendered = render_portable_export(export_body("Doc", "Body text"), "json")
            .expect("renders json");
        assert_eq!(rendered.content_type, "application/json; charset=utf-8");
        assert_eq!(rendered.renderer, "json");
        assert_eq!(rendered.filename, "Doc.json");

        let text = String::from_utf8(rendered.body).unwrap();
        // 2-space pretty printing (JSON.stringify(doc, null, 2) parity).
        assert!(text.contains("\n  \"title\": \"Doc\""), "pretty json: {text}");
        // The validated doc round-trips back into a StructuredDoc.
        let parsed: StructuredDoc = serde_json::from_str(&text).expect("round-trips");
        assert_eq!(parsed.title, "Doc");
        assert_eq!(parsed.sections[0].steps[0].output, "Body text");
    }

    #[test]
    fn unknown_format_is_rejected() {
        let error = render_portable_export(export_body("Doc", "x"), "pdf").unwrap_err();
        assert_eq!(error.code, "UNSUPPORTED_EXPORT");
        assert_eq!(error.http_status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn docx_is_deferred_and_reported_as_unsupported() {
        let error = render_portable_export(export_body("Doc", "x"), "docx").unwrap_err();
        assert_eq!(error.code, "UNSUPPORTED_EXPORT");
    }

    #[test]
    fn malformed_body_is_rejected_as_invalid_input() {
        // Missing the required `doc` field -> structuredDoc parse failure.
        let error = render_portable_export(json!({ "fileName": "x" }), "markdown").unwrap_err();
        assert_eq!(error.code, "INVALID_INPUT");
        assert_eq!(error.http_status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn unknown_top_level_field_is_rejected_by_strict_schema() {
        let mut body = export_body("Doc", "x");
        body.as_object_mut()
            .unwrap()
            .insert("unexpected".to_string(), json!(true));
        let error = render_portable_export(body, "json").unwrap_err();
        assert_eq!(error.code, "INVALID_INPUT");
    }

    #[test]
    fn filename_prefers_supplied_name_and_strips_extension() {
        let mut body = export_body("Doc Title", "x");
        body.as_object_mut()
            .unwrap()
            .insert("fileName".to_string(), json!("Final Report.MD"));
        let rendered = render_portable_export(body, "markdown").expect("renders");
        // Extension stripped (case-insensitive), spaces collapsed to `_`, new extension added.
        assert_eq!(rendered.filename, "Final_Report.md");
    }

    #[test]
    fn empty_supplied_name_falls_back_to_report() {
        let mut body = export_body("Doc Title", "x");
        body.as_object_mut()
            .unwrap()
            .insert("fileName".to_string(), json!(""));
        let rendered = render_portable_export(body, "json").expect("renders");
        // Empty fileName wins over doc.title (null-coalescing), then `|| 'report'` applies.
        assert_eq!(rendered.filename, "report.json");
    }

    #[test]
    fn title_with_only_disallowed_chars_falls_back_to_report() {
        let rendered = render_portable_export(export_body("@@@ !!!", "x"), "markdown")
            .expect("renders");
        // "@@@ !!!" -> "_" (single collapsed run) -> non-empty -> stem "_".
        assert_eq!(rendered.filename, "_.md");
    }

    #[test]
    fn strip_known_export_extension_is_case_insensitive_and_single() {
        assert_eq!(strip_known_export_extension("a.JSON"), "a");
        assert_eq!(strip_known_export_extension("a.markdown"), "a");
        assert_eq!(strip_known_export_extension("a.md"), "a");
        assert_eq!(strip_known_export_extension("a.docx"), "a");
        // A non-matching suffix is left intact.
        assert_eq!(strip_known_export_extension("a.txt"), "a.txt");
        // Only the trailing extension is stripped.
        assert_eq!(strip_known_export_extension("report.md.json"), "report.md");
    }

    #[test]
    fn sanitize_filename_stem_collapses_disallowed_runs() {
        assert_eq!(sanitize_filename_stem("a  b!!c"), "a_b_c");
        assert_eq!(sanitize_filename_stem("keep-me_1"), "keep-me_1");
        assert_eq!(sanitize_filename_stem("é ç ñ"), "_");
    }

    #[test]
    fn download_response_carries_the_reference_headers() {
        let rendered = RenderedExport {
            filename: "my_report.md".to_string(),
            content_type: "text/markdown; charset=utf-8",
            renderer: "markdown",
            body: b"Hello world".to_vec(),
        };
        let response = build_download_response(rendered);
        assert_eq!(response.status(), StatusCode::OK);
        let headers = response.headers();
        assert_eq!(
            headers.get(CONTENT_TYPE).unwrap(),
            "text/markdown; charset=utf-8"
        );
        assert_eq!(
            headers.get(CONTENT_DISPOSITION).unwrap(),
            "attachment; filename=\"my_report.md\""
        );
        assert_eq!(headers.get(CONTENT_LENGTH).unwrap(), "11");
        assert_eq!(headers.get(CACHE_CONTROL).unwrap(), "no-store");
        assert_eq!(headers.get(X_CONTENT_TYPE_OPTIONS).unwrap(), "nosniff");
        assert_eq!(
            headers.get(HeaderName::from_static(X_DOCUMENT_RENDERER)).unwrap(),
            "markdown"
        );
    }
}
