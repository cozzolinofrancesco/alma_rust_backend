//! `POST /api/export/docx` — render a `StructuredDoc` to a downloadable `.docx`.
//!
//! Ports `frontend_v3/app/api/export/docx/route.ts` (`structuredDocToDocxBuffer`)
//! for the canvas-272 export button. Given a validated `{ doc, fileName? }` body
//! it renders the document to an OOXML `.docx` byte buffer via the shared domain
//! renderer [`structured_doc_to_docx`] and returns it as an attachment download.
//!
//! Unlike the reference (which shells out to the `pandoc` binary and falls back to
//! a pure-JS `docx` library), this uses a native `docx-rs` renderer — equivalent
//! to the reference's non-pandoc fallback. Pure rendering lives in
//! [`render_docx_export`]; the axum handler is the thin wrapper that enforces the
//! auth perimeter and frames the binary download response (mirroring
//! `agentnodes/handlers/export_document_handler.rs`).

use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::agentnodes::error::{AgentExecutionError, stage};
use alma_domain::agentnodes::export::docx::structured_doc_to_docx;
use alma_domain::agentnodes::export::structured_doc::StructuredDoc;
use alma_macros::route;
use axum::Json;
use axum::body::Body;
use axum::extract::State;
use axum::response::Response;
use http::header::{
    CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE, X_CONTENT_TYPE_OPTIONS,
};
use http::{HeaderMap, HeaderValue, StatusCode};
use serde::Deserialize;
use serde_json::Value;

use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;

/// Maximum rendered export size, mirroring the reference 32MB guard
/// (`OUTPUT_TOO_LARGE`, HTTP 413).
const MAX_EXPORT_BYTES: usize = 32 * 1024 * 1024;

/// OOXML Word document MIME type (with no charset — it is binary).
const DOCX_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/// `{ doc, fileName? }.strict()` — `doc` is validated by deserializing into the
/// domain [`StructuredDoc`] (its `camelCase` shape is the wire shape canvas-272
/// sends). `deny_unknown_fields` enforces the top-level strictness.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExportDocxRequest {
    doc: StructuredDoc,
    #[serde(default)]
    file_name: Option<String>,
}

/// `POST /api/export/docx`.
#[route(method = "POST", path = "/api/export/docx")]
pub async fn export_docx_handler<TransactionalUnitOfWork>(
    State(_application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Response, AgentExecutionError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let (filename, body) = render_docx_export(submitted_body)?;
    Ok(build_docx_download_response(&filename, body))
}

/// Pure: parse the request, render the docx bytes, compute the filename, enforce
/// the size cap. Returns `(filename, bytes)` or the matching error.
fn render_docx_export(raw: Value) -> Result<(String, Vec<u8>), AgentExecutionError> {
    let request: ExportDocxRequest = serde_json::from_value(raw).map_err(|error| {
        AgentExecutionError::new(
            "INVALID_INPUT",
            format!("Invalid export request: {error}"),
            StatusCode::BAD_REQUEST,
            stage::VALIDATION,
        )
    })?;

    let filename = build_docx_filename(&request);
    let body = structured_doc_to_docx(&request.doc)
        .map_err(|error| AgentExecutionError::export_failed(format!("docx rendering error: {error}")))?;

    if body.len() > MAX_EXPORT_BYTES {
        return Err(AgentExecutionError::output_too_large(
            "The exported document exceeds 32MB.",
        ));
    }

    Ok((filename, body))
}

/// Compute the `.docx` download filename: `(fileName ?? doc.title)` → strip a
/// trailing known export extension → collapse `[^A-Za-z0-9_-]+` to `_` → cap at
/// 180 chars → `|| "report"` → append `.docx`. Mirrors the sibling export handler.
fn build_docx_filename(request: &ExportDocxRequest) -> String {
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
    format!("{stem}.docx")
}

/// Strip a single trailing known export extension (case-insensitive).
fn strip_known_export_extension(name: &str) -> String {
    let lowercased = name.to_ascii_lowercase();
    for candidate in [".markdown", ".json", ".docx", ".md"] {
        if lowercased.ends_with(candidate) {
            return name[..name.len() - candidate.len()].to_string();
        }
    }
    name.to_string()
}

/// Replace every maximal run outside `[A-Za-z0-9_-]` with a single `_`.
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

/// Frame the rendered docx bytes as an attachment download response.
fn build_docx_download_response(filename: &str, body: Vec<u8>) -> Response {
    let mut response_headers = HeaderMap::new();
    response_headers.insert(CONTENT_TYPE, HeaderValue::from_static(DOCX_CONTENT_TYPE));
    response_headers.insert(
        CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"{filename}\""))
            .unwrap_or_else(|_| HeaderValue::from_static("attachment; filename=\"report.docx\"")),
    );
    response_headers.insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&body.len().to_string())
            .unwrap_or_else(|_| HeaderValue::from_static("0")),
    );
    response_headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response_headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));

    let mut response = Response::new(Body::from(body));
    *response.status_mut() = StatusCode::OK;
    *response.headers_mut() = response_headers;
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
    fn renders_a_docx_zip_with_derived_filename() {
        let (filename, body) = render_docx_export(export_body("My Report", "Hello")).expect("renders");
        assert_eq!(filename, "My_Report.docx");
        assert_eq!(&body[0..4], b"PK\x03\x04", "docx must be a ZIP package");
    }

    #[test]
    fn supplied_filename_wins_and_extension_is_stripped() {
        let mut body = export_body("Doc Title", "x");
        body.as_object_mut()
            .unwrap()
            .insert("fileName".to_string(), json!("Final Report.DOCX"));
        let (filename, _bytes) = render_docx_export(body).expect("renders");
        assert_eq!(filename, "Final_Report.docx");
    }

    #[test]
    fn malformed_body_is_rejected_as_invalid_input() {
        let error = render_docx_export(json!({ "fileName": "x" })).unwrap_err();
        assert_eq!(error.code, "INVALID_INPUT");
        assert_eq!(error.http_status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn download_response_has_docx_headers() {
        let response = build_docx_download_response("r.docx", b"PK\x03\x04zz".to_vec());
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers().get(CONTENT_TYPE).unwrap(), DOCX_CONTENT_TYPE);
        assert_eq!(
            response.headers().get(CONTENT_DISPOSITION).unwrap(),
            "attachment; filename=\"r.docx\""
        );
    }
}
