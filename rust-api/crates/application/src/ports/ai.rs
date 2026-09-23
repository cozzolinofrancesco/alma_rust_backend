use crate::error::ApplicationError;
use alma_domain::value_objects::NonEmptyText;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GeneratedCompletion {
    pub produced_text: String,
}

/// Discrete reasoning-effort level for Gemini's `thinkingConfig.thinkingLevel`
/// field. Mirrors the reference union `'minimal' | 'low' | 'medium' | 'high'`
/// (`frontend_v3/app/lib/gemini.ts`). Serialized lowercase to match the wire
/// vocabulary the adapter maps onto `generationConfig`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingLevel {
    Minimal,
    Low,
    Medium,
    High,
}

/// Thinking / reasoning configuration for a single generation. Every field is
/// optional so a caller can express exactly the reference's conditional shape:
/// the text path always sends `{ includeThoughts }` and only adds
/// `thinkingLevel` when the step explicitly sets it (it is never a hardcoded
/// default — that default belongs to the retrieval path).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GenerationThinkingConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_thoughts: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_budget: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<ThinkingLevel>,
}

/// Inline binary attachment carried on a generation input part. Large-file
/// uploads (Gemini Files API) are cut in v1; small files are inlined as base64
/// per the plan's KEEP path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InlineBinaryData {
    pub mime_type: String,
    pub base64_data: String,
}

/// One additional input part appended to the user turn alongside `prompt`.
/// Carries text and/or inline binary data (e.g. an inlined small document).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GenerationInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inline_data: Option<InlineBinaryData>,
}

/// Full generation request carrying the complete sampling configuration the
/// reference always sends (see `DEFAULT_GENERATION_CONFIG` in
/// `frontend_v3/app/lib/gemini.ts`): temperature, topP, topK, candidateCount,
/// presence / frequency penalties, plus per-step `maxOutputTokens` and thinking
/// config. A temperature-only request would change sampling and diverge from
/// the main project, so callers are expected to populate the full config
/// (`GenerationRequest::with_reference_sampling_defaults` seeds it).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GenerationRequest {
    /// Model identifier to target, e.g. `gemini-3-flash-preview`.
    pub model: String,
    /// Optional system instruction sent as `systemInstruction`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    /// The user prompt sent as the final user turn.
    pub prompt: String,
    /// When present, requests structured output: `responseMimeType` set to
    /// `application/json` with this value as `responseSchema`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_json_schema: Option<serde_json::Value>,
    /// Sampling temperature (reference default 0.1).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    /// Nucleus sampling probability (reference default 0.95).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,
    /// Top-k sampling (reference default 20).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_k: Option<u32>,
    /// Number of candidates to generate (reference default 1).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_count: Option<u32>,
    /// Presence penalty (reference default 0.0).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presence_penalty: Option<f64>,
    /// Frequency penalty (reference default 0.0).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency_penalty: Option<f64>,
    /// Hard cap on output tokens (`step.maxTokens ?? modelInfo`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    /// Thinking configuration; `thinking_level` is only emitted when set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<GenerationThinkingConfig>,
    /// Additional multimodal input parts appended to the user turn (inline
    /// base64 data kept; large-file uploads are cut in v1).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inputs: Option<Vec<GenerationInput>>,
}

impl GenerationRequest {
    /// Construct a request pre-filled with the reference `DEFAULT_GENERATION_CONFIG`
    /// sampling values (temperature 0.1, topP 0.95, topK 20, candidateCount 1,
    /// presence / frequency penalties 0.0). All other fields are left unset for
    /// the caller to populate.
    pub fn with_reference_sampling_defaults(model: String, prompt: String) -> Self {
        Self {
            model,
            system: None,
            prompt,
            response_json_schema: None,
            temperature: Some(0.1),
            top_p: Some(0.95),
            top_k: Some(20),
            candidate_count: Some(1),
            presence_penalty: Some(0.0),
            frequency_penalty: Some(0.0),
            max_output_tokens: None,
            thinking: None,
            inputs: None,
        }
    }
}

/// Result of a `generate` call: the joined non-thought text (thought parts are
/// filtered by the adapter) and, when structured output was requested via
/// `response_json_schema`, the parsed JSON value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GenerationOutcome {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub json: Option<serde_json::Value>,
}

#[async_trait]
pub trait ArtificialIntelligencePort: Send + Sync {
    async fn generate_completion(
        &self,
        prompt_instruction: &NonEmptyText,
    ) -> Result<GeneratedCompletion, ApplicationError>;

    /// Full-config generation surface mirroring `geminiChatCore`
    /// (`frontend_v3/app/lib/gemini.ts`). Carries the complete sampling
    /// configuration and optional structured-output schema, returning both the
    /// filtered text and, when a schema was requested, the parsed JSON.
    ///
    /// The default implementation routes the prompt through
    /// `generate_completion` so adapters that only implement the completion
    /// path stay coherent until a full-config adapter (e.g. the Gemini adapter)
    /// overrides it. Real sampling config and structured output are honored only
    /// by an overriding implementation.
    async fn generate(
        &self,
        generation_request: &GenerationRequest,
    ) -> Result<GenerationOutcome, ApplicationError> {
        let prompt_instruction = NonEmptyText::parse(generation_request.prompt.clone())?;
        let completion = self.generate_completion(&prompt_instruction).await?;
        let json = generation_request
            .response_json_schema
            .as_ref()
            .and_then(|_| serde_json::from_str::<serde_json::Value>(&completion.produced_text).ok());
        Ok(GenerationOutcome {
            text: completion.produced_text,
            json,
        })
    }
}
