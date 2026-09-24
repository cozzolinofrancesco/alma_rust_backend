//! `POST /api/claim-validation/validate` — claim-level document validation.
//!
//! Implements the workflow of *"Document Validation: A Theoretical Framework for
//! Checking Statements Against Documentary Evidence"* (Cozzolino & Abbiati, 2025),
//! Algorithm 1, in the **inline-source** mode: the caller supplies the text under
//! review plus a single reference `source` document, and each extracted claim is
//! checked against that document.
//!
//! Pipeline (all generation through the real `ArtificialIntelligencePort`):
//! 1. **Extract** atomic claims from `text` (Prompt 1).
//! 2. For each claim (bounded by `maxClaims`):
//!    - **Locate** evidence in `source.document` (Prompt 2).
//!    - No evidence → `insufficient_evidence` finding, skip the judge (Algorithm 1
//!      line 7-8: `HasComparableEvidence` false).
//!    - Else **judge** the claim against the evidence (Prompt 3) and map the
//!      verdict onto one of the four outcomes.
//!    - Any generation/parse failure for a claim → `not_assessed` (recorded, never
//!      dropped — paper §3.6).
//! 3. Return the findings plus an outcome summary.
//!
//! The pure logic (prompts, tolerant parsing, verdict→outcome mapping, summary)
//! lives in [`alma_domain::qc`]; this handler is the async orchestration around it.

use alma_application::ports::ai::GenerationRequest;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::qc::dto::{Finding, ValidationReport};
use alma_domain::qc::{parse, prompts};
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde::Deserialize;
use serde_json::Value;

use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;

/// Fallback generation model when neither the request nor `GEMINI_DEFAULT_MODEL`
/// supplies one. Mirrors `bootstrap/config.rs` `DEFAULT_GENERATION_MODEL`
/// (resolvable on the personal key).
const FALLBACK_DEFAULT_MODEL: &str = "gemini-2.5-flash";

/// Default and hard ceiling on the number of claims validated per request. The
/// cap is logged when it truncates (no silent cap).
///
/// LLM-DOS-001: each retained claim fans out to up to two upstream Gemini calls
/// (evidence + judgment), so the absolute max bounds total per-request fan-out
/// to ~1 + 2·MAX_MAX_CLAIMS calls. Kept deliberately small (was 50/500, i.e.
/// ~1001 calls) so a single request cannot amplify into ~1000 upstream calls.
const DEFAULT_MAX_CLAIMS: usize = 25;
const MAX_MAX_CLAIMS: usize = 50;

/// The inline reference document each claim is checked against (paper's `source`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceInput {
    source_id: String,
    document: String,
}

/// `POST /api/claim-validation/validate` request body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ValidateRequest {
    /// The document under review.
    text: String,
    /// The reference document to check claims against (inline mode).
    source: SourceInput,
    /// Optional generation model override.
    #[serde(default)]
    model: Option<String>,
    /// Optional cap on claims validated (default 25, max 50).
    #[serde(default)]
    max_claims: Option<usize>,
}

#[route(method = "POST", path = "/api/claim-validation/validate")]
pub async fn validate_document_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let request: ValidateRequest = serde_json::from_value(submitted_body).map_err(|error| {
        HttpError::RequestBodyWasMalformed {
            explanation: format!("invalid claim-validation request: {error}"),
        }
    })?;

    if request.text.trim().is_empty() {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from("`text` must be a non-empty document under review"),
        });
    }
    if request.source.document.trim().is_empty() {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from("`source.document` must be a non-empty reference document"),
        });
    }
    let source_id = if request.source.source_id.trim().is_empty() {
        String::from("source-1")
    } else {
        request.source.source_id.clone()
    };

    let model = resolve_model(request.model.as_deref());
    let max_claims = request
        .max_claims
        .unwrap_or(DEFAULT_MAX_CLAIMS)
        .clamp(1, MAX_MAX_CLAIMS);

    let ai = &application_state.artificial_intelligence_adapter;

    // 1. Extract atomic claims (Prompt 1).
    let extraction_request =
        GenerationRequest::with_reference_sampling_defaults(model.clone(), prompts::build_extraction_prompt(&request.text));
    let extraction = ai.generate(&extraction_request).await?;
    let mut claims = parse::parse_claims(&extraction.text).map_err(|error| {
        HttpError::UpstreamApplicationFailure {
            explanation: format!("could not parse the claim-extraction response: {error}"),
        }
    })?;

    if claims.len() > max_claims {
        tracing::warn!(
            extracted = claims.len(),
            cap = max_claims,
            "claim-validation truncated the extracted claims to the maxClaims cap"
        );
        claims.truncate(max_claims);
    }

    // 2. Per-claim: locate evidence -> (gap | judge). Failures become not_assessed.
    let mut findings: Vec<Finding> = Vec::with_capacity(claims.len());
    for claim in claims {
        let evidence_request = GenerationRequest::with_reference_sampling_defaults(
            model.clone(),
            prompts::build_evidence_prompt(&claim.claim_text, &source_id, &request.source.document),
        );
        let evidence = match ai.generate(&evidence_request).await {
            // A SUCCESSFUL generation whose text can't be parsed is a technical
            // failure ("could not check"), not the substantive verdict
            // insufficient_evidence ("checked, found nothing"). Record it as
            // not_assessed — mirroring the judgment branch below — instead of
            // collapsing the Err into an empty Vec, which the evidence-gap branch
            // would then mislabel and mis-count in the summary (paper §3.6).
            Ok(outcome) => match parse::parse_evidence(&outcome.text, &source_id) {
                Ok(parsed_evidence) => parsed_evidence,
                Err(error) => {
                    findings.push(Finding::not_assessed(
                        claim,
                        Vec::new(),
                        format!("The evidence response could not be parsed: {error}"),
                    ));
                    continue;
                }
            },
            Err(error) => {
                findings.push(Finding::not_assessed(
                    claim,
                    Vec::new(),
                    format!("Evidence retrieval failed: {error}"),
                ));
                continue;
            }
        };

        if evidence.is_empty() {
            findings.push(Finding::evidence_gap(
                claim,
                "No relevant evidence was located in the supplied source.",
            ));
            continue;
        }

        let judgment_request = GenerationRequest::with_reference_sampling_defaults(
            model.clone(),
            prompts::build_judgment_prompt(&claim.claim_text, &evidence),
        );
        match ai.generate(&judgment_request).await {
            Ok(outcome) => match parse::parse_judgment(&outcome.text) {
                Ok(judgment) => findings.push(Finding::from_judgment(claim, evidence, judgment)),
                Err(error) => findings.push(Finding::not_assessed(
                    claim,
                    evidence,
                    format!("The judgment response could not be parsed: {error}"),
                )),
            },
            Err(error) => findings.push(Finding::not_assessed(
                claim,
                evidence,
                format!("The judgment generation failed: {error}"),
            )),
        }
    }

    // 3. Assemble the report (findings + outcome summary).
    let report = ValidationReport::new(findings);
    let response_body = serde_json::to_value(&report).map_err(|error| {
        HttpError::UpstreamApplicationFailure {
            explanation: format!("could not serialize the validation report: {error}"),
        }
    })?;
    Ok(Json(response_body))
}

/// Resolve the generation model: request override → `GEMINI_DEFAULT_MODEL` env →
/// the fallback default (unset / whitespace-only values read as absent).
fn resolve_model(requested: Option<&str>) -> String {
    if let Some(model) = requested.map(str::trim).filter(|model| !model.is_empty()) {
        return model.to_string();
    }
    std::env::var("GEMINI_DEFAULT_MODEL")
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|model| !model.is_empty())
        .unwrap_or_else(|| FALLBACK_DEFAULT_MODEL.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_model_prefers_request_then_env_then_fallback() {
        assert_eq!(resolve_model(Some("gemini-x")), "gemini-x");
        assert_eq!(resolve_model(Some("   ")), FALLBACK_DEFAULT_MODEL);
        // (env-dependent branch is exercised in integration; here the None path
        // falls through to the fallback when GEMINI_DEFAULT_MODEL is unset.)
        if std::env::var("GEMINI_DEFAULT_MODEL").is_err() {
            assert_eq!(resolve_model(None), FALLBACK_DEFAULT_MODEL);
        }
    }
}
