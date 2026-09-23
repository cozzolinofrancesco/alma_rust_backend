//! Error contract for the `agentnodes` execution engine.
//!
//! The portable Next.js API (`app/lib/agentExecution/*`) returns a uniform
//! `{ error: { code, message, stage, … } }` body across ~10 distinct HTTP
//! statuses (400/401/403/409/413/415/422/429/499/502/504). The workspace's
//! [`crate::error::DomainError`] and the HTTP crate's `HttpError` cannot express
//! that spread without being shoehorned, so — per the port plan (Phase 2, "build
//! the error contract FIRST") — the engine carries its own [`AgentExecutionError`]
//! with an [`axum::response::IntoResponse`] impl that emits the portable body at
//! an arbitrary status.
//!
//! Mirrors `frontend_v3/app/lib/agentExecution/errors.ts` (the class carries
//! `code`, `message`, `status`, `stage`) and the throw-sites across
//! `planner.server.ts`, `schema.ts`, `step.server.ts`, `runner.server.ts`,
//! `documents.server.ts`, and `http.server.ts`. Equivalent-behavior parity:
//! same `code`/`status`/`stage` semantics, not byte-identical wire framing (the
//! extra `attemptId`/`retryable`/`outcome` fields are layered on by the HTTP
//! handler's request context, not by the error itself).

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

/// Execution stage the error occurred in — surfaced verbatim in the response
/// body's `error.stage`. Matches the closed set of `stage` strings used by the
/// portable API (`errors.ts` default is `"validation"`).
pub mod stage {
    /// Request/schema validation, plan derivation, checkpoint checks. Default.
    pub const VALIDATION: &str = "validation";
    /// Credential / service-key / provider-auth checks.
    pub const AUTHORIZATION: &str = "authorization";
    /// Input assembly (source resolution, corpus binding, prompt build).
    pub const INPUT: &str = "input";
    /// Model inference (generateContent) and its response parsing.
    pub const INFERENCE: &str = "inference";
    /// Document assembly / markdown / docx export.
    pub const EXPORT: &str = "export";
    /// 272 source-summary preparation (`272/prepare-source`).
    pub const SOURCE_PREPARATION: &str = "source_preparation";
}

/// A typed failure raised anywhere in the `agentnodes` execution engine.
///
/// Ported from `AgentExecutionError` (`errors.ts`). `code` is a stable
/// `SCREAMING_SNAKE_CASE` string (see [`codes`]); `http_status` is the exact
/// status the portable route returns; `stage` is one of [`stage`].
///
/// Construct with a named helper (e.g. [`AgentExecutionError::duplicate_step`])
/// to inherit the canonical status + stage, or with [`AgentExecutionError::new`]
/// for an arbitrary status.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{code}: {message}")]
pub struct AgentExecutionError {
    /// Stable machine-readable error code (e.g. `"CYCLIC_DEPENDENCY"`).
    pub code: &'static str,
    /// Human-readable explanation shown to the caller.
    pub message: String,
    /// HTTP status the portable API returns for this failure.
    pub http_status: StatusCode,
    /// Execution stage the failure occurred in (see [`stage`]).
    pub stage: &'static str,
}

impl AgentExecutionError {
    /// Construct an error with a fully explicit code, status, and stage.
    ///
    /// Use this for arbitrary statuses; prefer the named constructors for the
    /// enumerated codes so the canonical status/stage stay consistent.
    pub fn new(
        code: &'static str,
        message: impl Into<String>,
        http_status: StatusCode,
        stage: &'static str,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            http_status,
            stage,
        }
    }

    /// Override the stage on an existing error (builder style).
    #[must_use]
    pub fn with_stage(mut self, stage: &'static str) -> Self {
        self.stage = stage;
        self
    }
}

/// Generates the [`codes`] string constants and a matching named constructor on
/// [`AgentExecutionError`] for every enumerated error, baking in its canonical
/// HTTP status and stage.
macro_rules! execution_error_codes {
    ($( $const_name:ident => $ctor:ident, $status:expr, $stage:expr );+ $(;)?) => {
        /// The complete set of `agentnodes` error `code` strings, 1:1 with the
        /// portable API's `error.code` values (plus the Rust-side additions
        /// `INVALID_CITATION`, `UNSUPPORTED`, `UNSUPPORTED_INPUT`).
        pub mod codes {
            $(
                #[doc = concat!("`\"", stringify!($const_name), "\"`")]
                pub const $const_name: &str = stringify!($const_name);
            )+
        }

        impl AgentExecutionError {
            $(
                #[doc = concat!("Construct a [`", stringify!($const_name), "`](codes::", stringify!($const_name), ") execution error.")]
                pub fn $ctor(message: impl Into<String>) -> Self {
                    Self::new(codes::$const_name, message, $status, $stage)
                }
            )+
        }
    };
}

execution_error_codes! {
    // ── Plan derivation & bundle validation (`createExecutionPlan`/`normalizeBundle`) ──
    DUPLICATE_STEP              => duplicate_step,              StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    DUPLICATE_SOURCE           => duplicate_source,           StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    DUPLICATE_SKILL            => duplicate_skill,            StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    DUPLICATE_TEMPLATE         => duplicate_template,         StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    INVALID_SOURCE_BINDING     => invalid_source_binding,     StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    UNBOUND_FILE               => unbound_file,               StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    UNBOUND_SOURCE             => unbound_source,             StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    UNBOUND_INPUT              => unbound_input,              StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    UNBOUND_DOCUMENT_SELECTION => unbound_document_selection, StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    UNRESOLVED_SKILL           => unresolved_skill,           StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    DANGLING_REFERENCE         => dangling_reference,         StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    INVALID_GRAPH              => invalid_graph,              StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    UNSUPPORTED_GRAPH_EDGE     => unsupported_graph_edge,     StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    CYCLIC_DEPENDENCY          => cyclic_dependency,          StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    INVALID_PINNED_OUTPUT      => invalid_pinned_output,      StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    INVALID_STEP_SELECTION     => invalid_step_selection,     StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    INVALID_OUTPUT_SELECTION   => invalid_output_selection,   StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    AMBIGUOUS_OUTPUT_SELECTION => ambiguous_output_selection, StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    AMBIGUOUS_SOURCE_MODE      => ambiguous_source_mode,      StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    UNSUPPORTED_MODEL          => unsupported_model,          StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    MISSING_PREREQUISITE       => missing_prerequisite,       StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    MISSING_INSTRUCTION        => missing_instruction,        StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    MISSING_SOURCE             => missing_source,             StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    MISSING_OUTPUT             => missing_output,             StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    UNSUPPORTED_STEP_BEHAVIOR  => unsupported_step_behavior,  StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    REFERENCE_CONTEXT_TOO_LARGE => reference_context_too_large, StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    UNEXPECTED_FILE            => unexpected_file,            StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    // Distinct statuses within the plan/executability path:
    INACTIVE_STEP              => inactive_step,              StatusCode::CONFLICT,             stage::VALIDATION;
    SOURCE_MISMATCH            => source_mismatch,            StatusCode::CONFLICT,             stage::VALIDATION;
    INPUT_TOO_LARGE            => input_too_large,            StatusCode::PAYLOAD_TOO_LARGE,    stage::VALIDATION;

    // ── Checkpoint / run concurrency & versioning (`advancePortableRun`/`recordAgentOutput`) ──
    CHECKPOINT_CONFLICT        => checkpoint_conflict,        StatusCode::CONFLICT,             stage::VALIDATION;
    PLAN_CONFLICT              => plan_conflict,              StatusCode::CONFLICT,             stage::VALIDATION;
    ATTEMPT_CONFLICT           => attempt_conflict,           StatusCode::CONFLICT,             stage::VALIDATION;
    VERSION_NOT_FOUND          => version_not_found,          StatusCode::CONFLICT,             stage::VALIDATION;
    OUTPUT_VERSION_NOT_FOUND   => output_version_not_found,   StatusCode::CONFLICT,             stage::VALIDATION;
    RUN_FAILED                 => run_failed,                 StatusCode::CONFLICT,             stage::VALIDATION;

    // ── Step execution / inference (`executePortableStep`/`executeAgentInputStep`) ──
    // INVALID_CITATION is a Rust-side addition: citation-integrity gate
    // (`\[(\d+)\]` outside the retrieved index set → 502) — see plan Phase 2.
    INVALID_CITATION           => invalid_citation,          StatusCode::BAD_GATEWAY,          stage::INFERENCE;
    INVALID_ANALYSIS_OUTPUT    => invalid_analysis_output,    StatusCode::UNPROCESSABLE_ENTITY, stage::INFERENCE;
    EMPTY_IMAGE_RESPONSE       => empty_image_response,       StatusCode::BAD_GATEWAY,          stage::INFERENCE;
    IMAGE_PROMPT_MISSING       => image_prompt_missing,       StatusCode::BAD_GATEWAY,          stage::INFERENCE;
    UNSUPPORTED_IMAGE_SETTINGS => unsupported_image_settings, StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    // Rust-side explicit stubs (v1 cuts): Files-API upload ≥5MB, binary PDF.
    UNSUPPORTED                => unsupported,                StatusCode::UNPROCESSABLE_ENTITY, stage::INPUT;
    UNSUPPORTED_INPUT          => unsupported_input,          StatusCode::UNPROCESSABLE_ENTITY, stage::INPUT;

    // ── Document assembly / export (`assemblePortableDocument`/`canvas-272` exporters) ──
    EXPORT_FAILED              => export_failed,              StatusCode::BAD_GATEWAY,          stage::EXPORT;
    OUTPUT_TOO_LARGE           => output_too_large,           StatusCode::PAYLOAD_TOO_LARGE,    stage::EXPORT;
    UNSAFE_DOCUMENT_RESOURCE   => unsafe_document_resource,   StatusCode::UNPROCESSABLE_ENTITY, stage::EXPORT;
    UNSUPPORTED_EXPORT         => unsupported_export,         StatusCode::BAD_REQUEST,          stage::VALIDATION;

    // ── 272 report compilation (`reportCreation/*`) ──
    INVALID_REPORT             => invalid_report,             StatusCode::BAD_REQUEST,          stage::VALIDATION;
    INVALID_TEMPLATES          => invalid_templates,          StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    TEMPLATES_REQUIRED         => templates_required,         StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    TEMPLATES_UNAVAILABLE      => templates_unavailable,      StatusCode::FORBIDDEN,            stage::INPUT;
    TEMPLATE_NOT_FOUND         => template_not_found,         StatusCode::UNPROCESSABLE_ENTITY, stage::VALIDATION;
    INVALID_SOURCE_SUMMARY     => invalid_source_summary,     StatusCode::UNPROCESSABLE_ENTITY, stage::SOURCE_PREPARATION;
    BIOMATERIAL_REQUIRED       => biomaterial_required,       StatusCode::BAD_REQUEST,          stage::VALIDATION;
    INVALID_BIOMATERIAL_SELECTION => invalid_biomaterial_selection, StatusCode::BAD_REQUEST,    stage::VALIDATION;

    // ── Request parsing / content negotiation / auth (`http.server.ts`) ──
    INVALID_REQUEST            => invalid_request,            StatusCode::BAD_REQUEST,          stage::VALIDATION;
    INVALID_MULTIPART          => invalid_multipart,          StatusCode::BAD_REQUEST,          stage::VALIDATION;
    UNSUPPORTED_CONTENT_TYPE   => unsupported_content_type,   StatusCode::UNSUPPORTED_MEDIA_TYPE, stage::VALIDATION;
    SOURCE_ACCESS_DENIED       => source_access_denied,       StatusCode::FORBIDDEN,            stage::AUTHORIZATION;
    GOOGLE_AUTH_REQUIRED       => google_auth_required,       StatusCode::FORBIDDEN,            stage::AUTHORIZATION;
    INVALID_GOOGLE_AUTH        => invalid_google_auth,        StatusCode::UNAUTHORIZED,         stage::AUTHORIZATION;
    API_KEY_REQUIRED           => api_key_required,           StatusCode::UNAUTHORIZED,         stage::AUTHORIZATION;

    // ── Upstream / transport mapping (top-level `executionFailure`) ──
    EXECUTION_FAILED           => execution_failed,           StatusCode::BAD_GATEWAY,          stage::INFERENCE;
    UPSTREAM_RATE_LIMITED      => upstream_rate_limited,      StatusCode::TOO_MANY_REQUESTS,    stage::INFERENCE;
    // Reference `http.server.ts` executionFailure leaves `status` at its 502
    // default for the 401/403 upstream branch (only `code`/`message` are
    // reassigned), so an upstream/gateway auth failure surfaces as HTTP 502, not
    // 401. Mirror that (review fix): BAD_GATEWAY, not UNAUTHORIZED.
    UPSTREAM_AUTH_FAILED       => upstream_auth_failed,       StatusCode::BAD_GATEWAY,          stage::INFERENCE;
    UPSTREAM_REJECTED          => upstream_rejected,          StatusCode::UNPROCESSABLE_ENTITY, stage::INFERENCE;
    REQUEST_TIMEOUT            => request_timeout,            StatusCode::GATEWAY_TIMEOUT,      stage::INFERENCE;
    // 499 (Client Closed Request) has no named StatusCode constant.
    REQUEST_CANCELLED          => request_cancelled,          StatusCode::from_u16(499).expect("499 is a valid HTTP status code"), stage::INFERENCE;
}

/// Portable error envelope: `{ "error": { code, message, stage } }`.
#[derive(Serialize)]
struct ExecutionErrorEnvelope<'a> {
    error: ExecutionErrorBody<'a>,
}

#[derive(Serialize)]
struct ExecutionErrorBody<'a> {
    code: &'a str,
    message: &'a str,
    stage: &'a str,
}

impl IntoResponse for AgentExecutionError {
    fn into_response(self) -> Response {
        let status = self.http_status;
        let body = ExecutionErrorEnvelope {
            error: ExecutionErrorBody {
                code: self.code,
                message: &self.message,
                stage: self.stage,
            },
        };
        (status, Json(body)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_constants_match_their_literal_names() {
        assert_eq!(codes::DUPLICATE_STEP, "DUPLICATE_STEP");
        assert_eq!(codes::UNBOUND_FILE, "UNBOUND_FILE");
        assert_eq!(codes::CYCLIC_DEPENDENCY, "CYCLIC_DEPENDENCY");
        assert_eq!(codes::CHECKPOINT_CONFLICT, "CHECKPOINT_CONFLICT");
        assert_eq!(codes::INVALID_CITATION, "INVALID_CITATION");
    }

    #[test]
    fn named_constructor_bakes_in_code_status_and_stage() {
        let error = AgentExecutionError::duplicate_step("step id `a` appears twice");
        assert_eq!(error.code, codes::DUPLICATE_STEP);
        assert_eq!(error.http_status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error.stage, stage::VALIDATION);
        assert_eq!(error.message, "step id `a` appears twice");
    }

    #[test]
    fn distinct_statuses_are_preserved_per_code() {
        assert_eq!(
            AgentExecutionError::input_too_large("x").http_status,
            StatusCode::PAYLOAD_TOO_LARGE
        );
        assert_eq!(
            AgentExecutionError::checkpoint_conflict("x").http_status,
            StatusCode::CONFLICT
        );
        assert_eq!(
            AgentExecutionError::invalid_citation("x").http_status,
            StatusCode::BAD_GATEWAY
        );
        assert_eq!(
            AgentExecutionError::unsupported_content_type("x").http_status,
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
        assert_eq!(
            AgentExecutionError::invalid_google_auth("x").http_status,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            AgentExecutionError::request_cancelled("x").http_status.as_u16(),
            499
        );
        assert_eq!(
            AgentExecutionError::invalid_source_summary("x").stage,
            stage::SOURCE_PREPARATION
        );
    }

    #[test]
    fn new_accepts_an_arbitrary_status() {
        let error = AgentExecutionError::new(
            codes::UNSUPPORTED_MODEL,
            "galileo models are unsupported in v1",
            StatusCode::from_u16(418).expect("teapot is a valid status"),
            stage::INFERENCE,
        );
        assert_eq!(error.http_status.as_u16(), 418);
        assert_eq!(error.stage, stage::INFERENCE);
    }

    #[test]
    fn with_stage_overrides_the_stage() {
        let error = AgentExecutionError::unsupported_model("image models cut in v1")
            .with_stage(stage::INFERENCE);
        assert_eq!(error.stage, stage::INFERENCE);
        assert_eq!(error.http_status, StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[test]
    fn display_includes_code_and_message() {
        let rendered = AgentExecutionError::unbound_file("source `s1` is not bound").to_string();
        assert_eq!(rendered, "UNBOUND_FILE: source `s1` is not bound");
    }
}
