use alma_application::error::ApplicationError;
use alma_application::ports::ai::{
    ArtificialIntelligencePort, GeneratedCompletion, GenerationOutcome, GenerationRequest,
    GenerationThinkingConfig,
};
use alma_domain::value_objects::NonEmptyText;
use async_trait::async_trait;
use serde_json::{json, Map, Value};
use std::time::Duration;

pub struct DeterministicEchoingAiAdapter {
    configured_response_prefix: String,
}

impl DeterministicEchoingAiAdapter {
    pub fn construct_with_prefix(configured_response_prefix: String) -> Self {
        Self {
            configured_response_prefix,
        }
    }
}

impl Default for DeterministicEchoingAiAdapter {
    fn default() -> Self {
        Self::construct_with_prefix(String::from("completion"))
    }
}

#[async_trait]
impl ArtificialIntelligencePort for DeterministicEchoingAiAdapter {
    async fn generate_completion(
        &self,
        prompt_instruction: &NonEmptyText,
    ) -> Result<GeneratedCompletion, ApplicationError> {
        Ok(GeneratedCompletion {
            produced_text: format!(
                "{}: {}",
                self.configured_response_prefix,
                prompt_instruction.as_str()
            ),
        })
    }

    async fn generate(
        &self,
        generation_request: &GenerationRequest,
    ) -> Result<GenerationOutcome, ApplicationError> {
        // Deterministic echo of the full-config generation surface: mirror the
        // completion path's prefixing so the two surfaces stay consistent, and
        // when structured output is requested surface a deterministic JSON echo
        // so the `{ text, json? }` contract is honored end to end.
        let echoed_text = format!(
            "{}: {}",
            self.configured_response_prefix, generation_request.prompt
        );
        let json = generation_request.response_json_schema.as_ref().map(|_| {
            serde_json::json!({
                "model": generation_request.model,
                "echoed_prompt": generation_request.prompt,
            })
        });
        Ok(GenerationOutcome {
            text: echoed_text,
            json,
        })
    }
}

// ---------------------------------------------------------------------------
// GeminiAiAdapter — direct Google Gemini API adapter (ports the logic of
// `geminiChatCore` in `frontend_v3/app/lib/gemini.ts`).
// ---------------------------------------------------------------------------

/// Flash default `maxOutputTokens`, mirroring `getModelInfo(...)?.maxOutputTokens`
/// for the flash tier in `frontend_v3/app/lib/models.json`. Used by the legacy
/// `generate_completion` path (which has no per-step override) so it sends the
/// same output cap the reference does for a plain `geminiChat` call.
const DEFAULT_FLASH_MAX_OUTPUT_TOKENS: u32 = 65_536;

/// Number of attempts (initial + retries) for a `generateContent` call. Mirrors
/// the reference `maxRetries = 3`.
const MAXIMUM_GENERATION_ATTEMPTS: u32 = 3;

/// Base back-off (milliseconds) between retries. The reference uses
/// `2^attempt * 1000ms` exponential back-off; this is the `1000` base.
const DEFAULT_RETRY_BASE_DELAY_MILLISECONDS: u64 = 1_000;

/// Real Gemini adapter: issues `POST /v1beta/models/{model}:generateContent`
/// over `reqwest` (the API key travels in the `x-goog-api-key` header, never in
/// the URL — RUST-SECRET-002), mirroring `geminiChatCore`
/// (`frontend_v3/app/lib/gemini.ts`).
///
/// Behavioural parity carried over from the reference:
/// - the FULL `generationConfig` is always sent (temperature 0.1, topP 0.95,
///   topK 20, candidateCount 1, presence/frequency penalties 0, and
///   `maxOutputTokens`) — a temperature-only request would change sampling and
///   diverge from the main project;
/// - on the text path `thinkingConfig = { includeThoughts: <step value> }` and
///   `thinkingLevel` is emitted **only** when the step sets it (never a
///   hardcoded `low` — that default belongs to the retrieval path);
/// - `part.thought === true` parts are filtered out of the returned answer text;
/// - structured output is requested via `responseMimeType: "application/json"`
///   + `responseSchema`, and the returned text is parsed into `outcome.json`;
/// - transient failures (HTTP 429 and any 5xx, plus transport errors) are
///   retried with exponential back-off.
pub struct GeminiAiAdapter {
    http_client: reqwest::Client,
    gemini_api_key: String,
    gemini_base_url: String,
    default_model: String,
    default_max_output_tokens: u32,
    retry_base_delay_milliseconds: u64,
}

impl GeminiAiAdapter {
    /// Construct the adapter with a fresh `reqwest::Client`. `gemini_base_url`
    /// has any trailing slash trimmed so endpoint assembly stays canonical.
    pub fn construct(gemini_api_key: String, gemini_base_url: String, default_model: String) -> Self {
        Self::construct_with_http_client(
            reqwest::Client::new(),
            gemini_api_key,
            gemini_base_url,
            default_model,
        )
    }

    /// Construct the adapter with a caller-provided `reqwest::Client` (used by
    /// the mocked-HTTP unit tests, and available for shared-client wiring).
    pub fn construct_with_http_client(
        http_client: reqwest::Client,
        gemini_api_key: String,
        gemini_base_url: String,
        default_model: String,
    ) -> Self {
        Self {
            http_client,
            gemini_api_key,
            gemini_base_url: gemini_base_url.trim_end_matches('/').to_string(),
            default_model,
            default_max_output_tokens: DEFAULT_FLASH_MAX_OUTPUT_TOKENS,
            retry_base_delay_milliseconds: DEFAULT_RETRY_BASE_DELAY_MILLISECONDS,
        }
    }

    /// Override the `maxOutputTokens` used by the legacy `generate_completion`
    /// path (defaults to the flash tier's 65 536).
    pub fn with_default_max_output_tokens(mut self, default_max_output_tokens: u32) -> Self {
        self.default_max_output_tokens = default_max_output_tokens;
        self
    }

    /// Override the retry back-off base delay (milliseconds). Tests set this to
    /// `0` so retry paths do not sleep.
    pub fn with_retry_base_delay_milliseconds(mut self, retry_base_delay_milliseconds: u64) -> Self {
        self.retry_base_delay_milliseconds = retry_base_delay_milliseconds;
        self
    }

    /// Assemble the `generationConfig` object sent on every request. The full
    /// sampling config is always populated (reference defaults fill any field a
    /// caller left unset), `maxOutputTokens` is included when present, the
    /// thinking config is passed through verbatim (never hardcoding
    /// `thinkingLevel`), and structured-output fields are added when a schema is
    /// supplied.
    fn build_generation_config(generation_request: &GenerationRequest) -> Value {
        let mut generation_config = Map::new();
        generation_config.insert(
            "temperature".to_string(),
            json!(generation_request.temperature.unwrap_or(0.1)),
        );
        generation_config.insert(
            "topP".to_string(),
            json!(generation_request.top_p.unwrap_or(0.95)),
        );
        generation_config.insert(
            "topK".to_string(),
            json!(generation_request.top_k.unwrap_or(20)),
        );
        generation_config.insert(
            "candidateCount".to_string(),
            json!(generation_request.candidate_count.unwrap_or(1)),
        );
        generation_config.insert(
            "presencePenalty".to_string(),
            json!(generation_request.presence_penalty.unwrap_or(0.0)),
        );
        generation_config.insert(
            "frequencyPenalty".to_string(),
            json!(generation_request.frequency_penalty.unwrap_or(0.0)),
        );

        if let Some(maximum_output_tokens) = generation_request.max_output_tokens {
            generation_config.insert("maxOutputTokens".to_string(), json!(maximum_output_tokens));
        }

        if let Some(thinking) = &generation_request.thinking {
            generation_config.insert(
                "thinkingConfig".to_string(),
                Self::build_thinking_config(thinking),
            );
        }

        if let Some(response_schema) = &generation_request.response_json_schema {
            generation_config.insert(
                "responseMimeType".to_string(),
                json!("application/json"),
            );
            generation_config.insert("responseSchema".to_string(), response_schema.clone());
        }

        Value::Object(generation_config)
    }

    /// Build the `thinkingConfig` object with Gemini's camelCase wire keys.
    /// Each field is emitted only when set — in particular `thinkingLevel` is
    /// never defaulted, so the text path stays free of a hardcoded `low`.
    fn build_thinking_config(thinking: &GenerationThinkingConfig) -> Value {
        let mut thinking_config = Map::new();
        if let Some(include_thoughts) = thinking.include_thoughts {
            thinking_config.insert("includeThoughts".to_string(), json!(include_thoughts));
        }
        if let Some(thinking_budget) = thinking.thinking_budget {
            thinking_config.insert("thinkingBudget".to_string(), json!(thinking_budget));
        }
        if let Some(thinking_level) = thinking.thinking_level {
            // `ThinkingLevel` serializes lowercase (`"minimal"|"low"|"medium"|"high"`).
            thinking_config.insert(
                "thinkingLevel".to_string(),
                serde_json::to_value(thinking_level).unwrap_or(Value::Null),
            );
        }
        Value::Object(thinking_config)
    }

    /// Build the `contents` array: a single user turn whose first part is the
    /// prompt text, followed by any additional inputs (inline text / base64
    /// binary). Mirrors `formatMessage` in the reference, including its
    /// "no parts -> push empty text" fallback.
    fn build_contents(generation_request: &GenerationRequest) -> Value {
        let mut parts: Vec<Value> = Vec::new();

        if !generation_request.prompt.is_empty() {
            parts.push(json!({ "text": generation_request.prompt }));
        }

        if let Some(inputs) = &generation_request.inputs {
            for input in inputs {
                if let Some(text) = &input.text {
                    if !text.is_empty() {
                        parts.push(json!({ "text": text }));
                    }
                }
                if let Some(inline_data) = &input.inline_data {
                    parts.push(json!({
                        "inlineData": {
                            "mimeType": inline_data.mime_type,
                            "data": inline_data.base64_data,
                        }
                    }));
                }
            }
        }

        if parts.is_empty() {
            parts.push(json!({ "text": "" }));
        }

        json!([{ "role": "user", "parts": parts }])
    }

    /// Extract the answer text from a `generateContent` response: concatenate the
    /// `text` of every part where `thought !== true`, mirroring the reference's
    /// `joinParts((thought) => !thought)` (empty texts contribute nothing).
    fn extract_answer_text(response_body: &Value) -> String {
        response_body
            .get("candidates")
            .and_then(|candidates| candidates.get(0))
            .and_then(|candidate| candidate.get("content"))
            .and_then(|content| content.get("parts"))
            .and_then(|parts| parts.as_array())
            .map(|parts| {
                parts
                    .iter()
                    .filter(|part| {
                        part.get("thought").and_then(Value::as_bool) != Some(true)
                    })
                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                    .collect::<String>()
            })
            .unwrap_or_default()
    }

    /// Whether an HTTP status should be retried: 429 (rate limit) or any 5xx.
    fn status_is_retryable(status: reqwest::StatusCode) -> bool {
        status.as_u16() == 429 || status.is_server_error()
    }

    /// POST the assembled payload to `:generateContent`, retrying transient
    /// failures (429 / 5xx / transport errors) with exponential back-off, and
    /// return the parsed JSON response body on success.
    async fn post_generate_content(
        &self,
        model: &str,
        payload: &Value,
    ) -> Result<Value, ApplicationError> {
        let endpoint = format!(
            "{}/v1beta/models/{}:generateContent",
            self.gemini_base_url, model
        );

        let mut last_failure_description: Option<String> = None;

        for attempt in 0..MAXIMUM_GENERATION_ATTEMPTS {
            let send_result = self
                .http_client
                .post(&endpoint)
                // RUST-SECRET-002: send the key as a header, not `.query(&[("key",…)])`.
                // reqwest attaches the full (key-bearing) URL to transport-error
                // Display, which the error path echoes to clients — the header
                // keeps the secret out of that URL entirely.
                .header("x-goog-api-key", self.gemini_api_key.as_str())
                .json(payload)
                .send()
                .await;

            match send_result {
                Ok(response) => {
                    let status = response.status();
                    if status.is_success() {
                        return response.json::<Value>().await.map_err(|error| {
                            ApplicationError::ArtificialIntelligenceAdapterFailure {
                                failure_description: format!(
                                    "failed to decode Gemini response body: {error}"
                                ),
                            }
                        });
                    }

                    let upstream_text = response.text().await.unwrap_or_default();
                    let failure_description =
                        format!("Gemini API {status}: {upstream_text}");

                    if Self::status_is_retryable(status)
                        && attempt < MAXIMUM_GENERATION_ATTEMPTS - 1
                    {
                        self.sleep_for_backoff(attempt).await;
                        last_failure_description = Some(failure_description);
                        continue;
                    }

                    return Err(ApplicationError::ArtificialIntelligenceAdapterFailure {
                        failure_description,
                    });
                }
                Err(transport_error) => {
                    // Transport-level errors (connection reset/refused, timeouts)
                    // are retryable, matching the reference network-error branch.
                    if attempt < MAXIMUM_GENERATION_ATTEMPTS - 1 {
                        self.sleep_for_backoff(attempt).await;
                        last_failure_description =
                            Some(format!("Gemini request transport error: {transport_error}"));
                        continue;
                    }
                    return Err(ApplicationError::ArtificialIntelligenceAdapterFailure {
                        failure_description: format!(
                            "Gemini request transport error: {transport_error}"
                        ),
                    });
                }
            }
        }

        Err(ApplicationError::ArtificialIntelligenceAdapterFailure {
            failure_description: last_failure_description
                .unwrap_or_else(|| "all Gemini API retry attempts failed".to_string()),
        })
    }

    /// Sleep for the exponential back-off delay of the given attempt index
    /// (`2^attempt * base`). A base of `0` (tests) makes this a no-op.
    async fn sleep_for_backoff(&self, attempt: u32) {
        let delay_milliseconds = self
            .retry_base_delay_milliseconds
            .saturating_mul(2u64.saturating_pow(attempt));
        if delay_milliseconds > 0 {
            tokio::time::sleep(Duration::from_millis(delay_milliseconds)).await;
        }
    }
}

#[async_trait]
impl ArtificialIntelligencePort for GeminiAiAdapter {
    async fn generate_completion(
        &self,
        prompt_instruction: &NonEmptyText,
    ) -> Result<GeneratedCompletion, ApplicationError> {
        // Legacy single-prompt path: mirror a plain `geminiChat` call — the full
        // DEFAULT_GENERATION_CONFIG (via reference sampling defaults) plus the
        // flash output cap and `thinkingConfig: { includeThoughts: true }`.
        let mut generation_request = GenerationRequest::with_reference_sampling_defaults(
            self.default_model.clone(),
            prompt_instruction.as_str().to_string(),
        );
        generation_request.max_output_tokens = Some(self.default_max_output_tokens);
        generation_request.thinking = Some(GenerationThinkingConfig {
            include_thoughts: Some(true),
            thinking_budget: None,
            thinking_level: None,
        });

        let outcome = self.generate(&generation_request).await?;
        Ok(GeneratedCompletion {
            produced_text: outcome.text,
        })
    }

    async fn generate(
        &self,
        generation_request: &GenerationRequest,
    ) -> Result<GenerationOutcome, ApplicationError> {
        let mut payload = Map::new();
        payload.insert(
            "contents".to_string(),
            Self::build_contents(generation_request),
        );
        payload.insert(
            "generationConfig".to_string(),
            Self::build_generation_config(generation_request),
        );

        if let Some(system_instruction) = &generation_request.system {
            payload.insert(
                "systemInstruction".to_string(),
                json!({
                    "role": "system",
                    "parts": [{ "text": system_instruction }],
                }),
            );
        }

        let payload = Value::Object(payload);
        let response_body = self
            .post_generate_content(&generation_request.model, &payload)
            .await?;

        let text = Self::extract_answer_text(&response_body);

        // Structured output was requested (responseMimeType application/json):
        // the answer text is a JSON document — parse it into `outcome.json`.
        // A parse failure leaves `json = None` (the text is still returned),
        // matching the port's lenient default contract.
        let json = generation_request
            .response_json_schema
            .as_ref()
            .and_then(|_| serde_json::from_str::<Value>(&text).ok());

        Ok(GenerationOutcome { text, json })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alma_application::ports::ai::ThinkingLevel;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }

    /// Read a full HTTP request (headers + Content-Length body) from the socket
    /// and return it as a string.
    async fn read_http_request(socket: &mut TcpStream) -> String {
        let mut buffer: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            if let Some(header_end) = find_subsequence(&buffer, b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&buffer[..header_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        let lowercased = line.to_ascii_lowercase();
                        lowercased
                            .strip_prefix("content-length:")
                            .and_then(|value| value.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if buffer.len() >= header_end + 4 + content_length {
                    break;
                }
            }
            let read_count = socket.read(&mut chunk).await.unwrap();
            if read_count == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..read_count]);
        }
        String::from_utf8_lossy(&buffer).to_string()
    }

    fn http_reason(status: u16) -> &'static str {
        match status {
            200 => "OK",
            429 => "Too Many Requests",
            500 => "Internal Server Error",
            503 => "Service Unavailable",
            _ => "Error",
        }
    }

    fn build_http_response(status: u16, body: &str) -> String {
        format!(
            "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            status,
            http_reason(status),
            body.as_bytes().len(),
            body
        )
    }

    /// Spawn a single-request mock server. Returns the base URL and a handle
    /// that resolves to the captured raw request once the connection is served.
    async fn spawn_single_request_mock(
        status: u16,
        response_body: String,
    ) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let captured = read_http_request(&mut socket).await;
            let response = build_http_response(status, &response_body);
            socket.write_all(response.as_bytes()).await.unwrap();
            socket.flush().await.unwrap();
            captured
        });
        (base_url, handle)
    }

    /// Spawn a mock server that serves a sequence of responses across
    /// successive connections (for exercising the retry path).
    async fn spawn_sequenced_mock(responses: Vec<(u16, String)>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            for (status, body) in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let _ = read_http_request(&mut socket).await;
                let response = build_http_response(status, &body);
                socket.write_all(response.as_bytes()).await.unwrap();
                socket.flush().await.unwrap();
            }
        });
        base_url
    }

    fn request_body_json(captured_request: &str) -> Value {
        let body_start = captured_request.find("\r\n\r\n").unwrap() + 4;
        serde_json::from_str(&captured_request[body_start..]).unwrap()
    }

    #[tokio::test]
    async fn filters_thought_parts_and_sends_full_generation_config() {
        let response_body = json!({
            "candidates": [{
                "content": { "parts": [
                    { "text": "internal reasoning", "thought": true },
                    { "text": "Hello " },
                    { "text": "world" }
                ] },
                "finishReason": "STOP"
            }]
        })
        .to_string();

        let (base_url, handle) = spawn_single_request_mock(200, response_body).await;
        let adapter = GeminiAiAdapter::construct(
            "test-key".to_string(),
            base_url,
            "gemini-3-flash-preview".to_string(),
        );

        let mut generation_request = GenerationRequest::with_reference_sampling_defaults(
            "gemini-3-flash-preview".to_string(),
            "hi".to_string(),
        );
        generation_request.max_output_tokens = Some(65_536);
        generation_request.thinking = Some(GenerationThinkingConfig {
            include_thoughts: Some(false),
            thinking_budget: None,
            thinking_level: None,
        });

        let outcome = adapter.generate(&generation_request).await.unwrap();
        // thought part dropped; non-thought parts concatenated.
        assert_eq!(outcome.text, "Hello world");
        assert!(outcome.json.is_none());

        let captured = handle.await.unwrap();
        // endpoint on the URL; api key carried in the x-goog-api-key header,
        // never in the query string (RUST-SECRET-002).
        assert!(captured.contains("/v1beta/models/gemini-3-flash-preview:generateContent"));
        assert!(captured.contains("x-goog-api-key: test-key"));
        assert!(!captured.contains("key=test-key"));

        let body = request_body_json(&captured);
        let generation_config = &body["generationConfig"];
        assert_eq!(generation_config["temperature"], 0.1);
        assert_eq!(generation_config["topP"], 0.95);
        assert_eq!(generation_config["topK"], 20);
        assert_eq!(generation_config["candidateCount"], 1);
        assert_eq!(generation_config["presencePenalty"], 0.0);
        assert_eq!(generation_config["frequencyPenalty"], 0.0);
        assert_eq!(generation_config["maxOutputTokens"], 65_536);
        assert_eq!(generation_config["thinkingConfig"]["includeThoughts"], false);
        // thinkingLevel is NOT hardcoded when the step does not set it.
        assert!(generation_config["thinkingConfig"]
            .get("thinkingLevel")
            .is_none());
        // single user turn carrying the prompt.
        assert_eq!(body["contents"][0]["role"], "user");
        assert_eq!(body["contents"][0]["parts"][0]["text"], "hi");
    }

    #[tokio::test]
    async fn emits_thinking_level_only_when_set() {
        let response_body = json!({
            "candidates": [{ "content": { "parts": [{ "text": "ok" }] } }]
        })
        .to_string();
        let (base_url, handle) = spawn_single_request_mock(200, response_body).await;
        let adapter =
            GeminiAiAdapter::construct("k".to_string(), base_url, "gemini-3.6-flash".to_string());

        let mut generation_request = GenerationRequest::with_reference_sampling_defaults(
            "gemini-3.6-flash".to_string(),
            "hi".to_string(),
        );
        generation_request.thinking = Some(GenerationThinkingConfig {
            include_thoughts: Some(true),
            thinking_budget: None,
            thinking_level: Some(ThinkingLevel::High),
        });

        let outcome = adapter.generate(&generation_request).await.unwrap();
        assert_eq!(outcome.text, "ok");

        let captured = handle.await.unwrap();
        let body = request_body_json(&captured);
        // ThinkingLevel serializes lowercase on the wire.
        assert_eq!(
            body["generationConfig"]["thinkingConfig"]["thinkingLevel"],
            "high"
        );
        assert_eq!(
            body["generationConfig"]["thinkingConfig"]["includeThoughts"],
            true
        );
    }

    #[tokio::test]
    async fn structured_output_sets_schema_and_parses_json() {
        let response_body = json!({
            "candidates": [{
                "content": { "parts": [{ "text": "{\"answer\":42}" }] }
            }]
        })
        .to_string();
        let (base_url, handle) = spawn_single_request_mock(200, response_body).await;
        let adapter =
            GeminiAiAdapter::construct("k".to_string(), base_url, "gemini-3.6-flash".to_string());

        let mut generation_request = GenerationRequest::with_reference_sampling_defaults(
            "gemini-3.6-flash".to_string(),
            "give me json".to_string(),
        );
        generation_request.response_json_schema = Some(json!({
            "type": "object",
            "properties": { "answer": { "type": "integer" } }
        }));

        let outcome = adapter.generate(&generation_request).await.unwrap();
        assert_eq!(outcome.text, "{\"answer\":42}");
        assert_eq!(outcome.json, Some(json!({ "answer": 42 })));

        let captured = handle.await.unwrap();
        let body = request_body_json(&captured);
        assert_eq!(
            body["generationConfig"]["responseMimeType"],
            "application/json"
        );
        assert_eq!(
            body["generationConfig"]["responseSchema"]["type"],
            "object"
        );
    }

    #[tokio::test]
    async fn retries_on_rate_limit_then_succeeds() {
        let ok_body = json!({
            "candidates": [{ "content": { "parts": [{ "text": "recovered" }] } }]
        })
        .to_string();
        let base_url = spawn_sequenced_mock(vec![
            (429, "{\"error\":\"rate limited\"}".to_string()),
            (200, ok_body),
        ])
        .await;

        let adapter =
            GeminiAiAdapter::construct("k".to_string(), base_url, "gemini-3.6-flash".to_string())
                .with_retry_base_delay_milliseconds(0);

        let generation_request = GenerationRequest::with_reference_sampling_defaults(
            "gemini-3.6-flash".to_string(),
            "hi".to_string(),
        );

        let outcome = adapter.generate(&generation_request).await.unwrap();
        assert_eq!(outcome.text, "recovered");
    }

    #[tokio::test]
    async fn surfaces_error_on_non_retryable_status() {
        let (base_url, _handle) =
            spawn_single_request_mock(400, "{\"error\":\"bad request\"}".to_string()).await;
        let adapter =
            GeminiAiAdapter::construct("k".to_string(), base_url, "gemini-3.6-flash".to_string());

        let generation_request = GenerationRequest::with_reference_sampling_defaults(
            "gemini-3.6-flash".to_string(),
            "hi".to_string(),
        );

        let error = adapter.generate(&generation_request).await.unwrap_err();
        match error {
            ApplicationError::ArtificialIntelligenceAdapterFailure {
                failure_description,
            } => {
                assert!(failure_description.contains("400"));
            }
            other => panic!("expected AI adapter failure, got {other:?}"),
        }
    }
}
