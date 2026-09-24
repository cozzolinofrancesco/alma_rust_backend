use std::path::PathBuf;

pub const RATE_LIMIT_WINDOW_SECONDS: u64 = 60;
pub const RATE_LIMIT_MAXIMUM_REQUESTS: u32 = 1000;
pub const DEFAULT_BIND_ADDRESS: &str = "127.0.0.1:8811";

/// Base URL for the direct Google Gemini API. Auth is `?key=` (no OAuth),
/// mirroring `frontend_v3/app/lib/gemini.ts`. Overridable via `GEMINI_BASE_URL`
/// for local proxies or mocked-HTTP tests.
pub const DEFAULT_GEMINI_BASE_URL: &str = "https://generativelanguage.googleapis.com";

/// Default text-generation model id. Mirrors `DEFAULT_MODEL` in
/// `frontend_v3/app/lib/modelConfig.ts`. `runs/plan` seeds `maxInputTokens`
/// for this id, so it must always be part of the available set.
pub const DEFAULT_GENERATION_MODEL: &str = "gemini-2.5-flash";

/// Model ids the engine may resolve against, mirroring the (non-image) values
/// in `frontend_v3/app/lib/models.json`. Image ids are omitted because v1
/// stubs image generation (plan C1 / Phase 2 explicit cuts); Galileo ids are
/// never resolved (`isGalileoModel -> false`). Overridable via the
/// comma-separated `GEMINI_AVAILABLE_MODELS`.
pub const DEFAULT_AVAILABLE_MODELS: &[&str] = &[
    "gemini-2.5-flash",
    "gemini-3.5-flash",
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite",
];

/// Directory the file-backed durable `DocumentCollectionPort` persists into.
/// Overridable via `ALMA_RUST_DATA_DIR`.
pub const DEFAULT_DATA_DIRECTORY: &str = "./data";

/// Process-wide runtime settings resolved once at boot from the environment.
///
/// The AI / retrieval / durable-store credentials live here so the bootstrap
/// can perform its env-driven real-vs-stub adapter selection (plan Phase 0):
/// with a `GEMINI_API_KEY` present it wires the real Gemini + File Search
/// adapters, otherwise it falls back to the hermetic echo / lexical / in-memory
/// stubs.
pub struct RuntimeConfiguration {
    /// Address the HTTP server binds to (`ALMA_RUST_BIND_ADDRESS`).
    pub bind_address: String,
    /// Personal Gemini API key (`GEMINI_API_KEY`). Absent (or empty) selects
    /// the deterministic stub adapters instead of the real Gemini surface.
    pub gemini_api_key: Option<String>,
    /// Base URL for the Gemini API (`GEMINI_API_URL`, then `GEMINI_BASE_URL`),
    /// trailing slash trimmed.
    pub gemini_base_url: String,
    /// Default generation model id (`GEMINI_DEFAULT_MODEL`). Guaranteed to be
    /// present in `available_model_ids`.
    pub default_model_id: String,
    /// Model ids the engine may resolve against (`GEMINI_AVAILABLE_MODELS`).
    pub available_model_ids: Vec<String>,
    /// Shared-secret header value guarding the API (`SERVICE_API_KEY`). Absent
    /// disables the service-key check (localhost only). Net-new — plan C7.
    pub service_api_key: Option<String>,
    /// Explicit opt-in (`ALMA_ALLOW_INSECURE`) to run WITHOUT a `SERVICE_API_KEY`
    /// on a non-loopback bind. Off by default so the shared-secret perimeter
    /// cannot silently fail open on a reachable port (RUST-AUTHN-001).
    pub allow_insecure: bool,
    /// Browser origins permitted for cross-origin requests
    /// (`ALMA_ALLOWED_ORIGINS`, comma-separated). Empty (the default) allows NO
    /// cross-origin access — the BFF calls this API server-to-server, which is
    /// not subject to CORS (MISC-CORS-001). Replaces the former wildcard.
    pub allowed_cors_origins: Vec<String>,
    /// Directory the file-backed durable store persists into
    /// (`ALMA_RUST_DATA_DIR`).
    pub data_directory: PathBuf,
}

impl RuntimeConfiguration {
    pub fn resolve_from_environment() -> Self {
        let bind_address = read_environment_string("ALMA_RUST_BIND_ADDRESS")
            .unwrap_or_else(|| String::from(DEFAULT_BIND_ADDRESS));

        let gemini_api_key = read_environment_string("GEMINI_API_KEY");

        // Accept `GEMINI_API_URL` (the name used in the project .env) first, then
        // `GEMINI_BASE_URL`, then fall back to the direct-Google default.
        let gemini_base_url = read_environment_string("GEMINI_API_URL")
            .or_else(|| read_environment_string("GEMINI_BASE_URL"))
            .map(|configured_url| configured_url.trim_end_matches('/').to_string())
            .filter(|configured_url| !configured_url.is_empty())
            .unwrap_or_else(|| String::from(DEFAULT_GEMINI_BASE_URL));

        let default_model_id = read_environment_string("GEMINI_DEFAULT_MODEL")
            .unwrap_or_else(|| String::from(DEFAULT_GENERATION_MODEL));

        let mut available_model_ids = read_environment_string("GEMINI_AVAILABLE_MODELS")
            .map(|comma_separated_models| parse_comma_separated_values(&comma_separated_models))
            .filter(|parsed_models| !parsed_models.is_empty())
            .unwrap_or_else(default_available_model_ids);

        // The default model must be resolvable (its `maxInputTokens` is seeded
        // during `runs/plan`); prepend it when an override list omits it so the
        // planner never rejects the default with `UNSUPPORTED_MODEL`.
        if !available_model_ids
            .iter()
            .any(|model_id| model_id == &default_model_id)
        {
            available_model_ids.insert(0, default_model_id.clone());
        }

        let service_api_key = read_environment_string("SERVICE_API_KEY");

        let allow_insecure = read_environment_string("ALMA_ALLOW_INSECURE")
            .map(|raw_value| environment_flag_is_truthy(&raw_value))
            .unwrap_or(false);

        let allowed_cors_origins = read_environment_string("ALMA_ALLOWED_ORIGINS")
            .map(|raw_value| parse_comma_separated_values(&raw_value))
            .unwrap_or_default();

        let data_directory = read_environment_string("ALMA_RUST_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_DATA_DIRECTORY));

        Self {
            bind_address,
            gemini_api_key,
            gemini_base_url,
            default_model_id,
            available_model_ids,
            service_api_key,
            allow_insecure,
            allowed_cors_origins,
            data_directory,
        }
    }

    /// Whether a usable Gemini credential is present. Drives the bootstrap's
    /// real-vs-stub adapter selection (plan Phase 0).
    pub fn gemini_is_configured(&self) -> bool {
        self.gemini_api_key.is_some()
    }

    /// Whether inbound requests must carry a matching `SERVICE_API_KEY`.
    pub fn service_key_is_enforced(&self) -> bool {
        self.service_api_key.is_some()
    }

    /// Refuse to run in a configuration where the shared-secret perimeter fails
    /// open on a reachable port (RUST-AUTHN-001). The perimeter is allowed to be
    /// disabled ONLY when the service is bound to loopback (unreachable from off
    /// host), or when an operator has explicitly opted in with
    /// `ALMA_ALLOW_INSECURE`. A configured `SERVICE_API_KEY` always satisfies the
    /// invariant. Returns `Err(reason)` describing how to fix an unsafe config.
    pub fn verify_security_invariants(&self) -> Result<(), String> {
        if self.service_key_is_enforced() || self.allow_insecure {
            return Ok(());
        }
        if bind_host_is_loopback(&self.bind_address) {
            return Ok(());
        }
        Err(format!(
            "SERVICE_API_KEY is not set while binding to a non-loopback address ({}). \
             Refusing to start: the shared-secret perimeter would fail open on a reachable port. \
             Set SERVICE_API_KEY, bind to loopback (127.0.0.1), or set ALMA_ALLOW_INSECURE=1 for an \
             explicitly insecure local run.",
            self.bind_address
        ))
    }
}

/// Whether a `host:port` bind string targets a loopback interface (unreachable
/// from off host). Parses an IP `SocketAddr` first; falls back to recognising the
/// `localhost` hostname for non-IP binds.
fn bind_host_is_loopback(bind_address: &str) -> bool {
    if let Ok(socket_address) = bind_address.parse::<std::net::SocketAddr>() {
        return socket_address.ip().is_loopback();
    }
    let host = bind_address
        .rsplit_once(':')
        .map(|(host_part, _port)| host_part)
        .unwrap_or(bind_address)
        .trim_start_matches('[')
        .trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost")
}

/// Interpret a boolean-ish environment flag (`1`/`true`/`yes`/`on`, any case).
fn environment_flag_is_truthy(raw_value: &str) -> bool {
    matches!(
        raw_value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

/// Read an environment variable, treating unset and whitespace-only values as
/// absent. An exported-but-empty `GEMINI_API_KEY`/`SERVICE_API_KEY` must not be
/// mistaken for a real credential (falsy/null trap).
fn read_environment_string(variable_name: &str) -> Option<String> {
    std::env::var(variable_name)
        .ok()
        .map(|raw_value| raw_value.trim().to_string())
        .filter(|trimmed_value| !trimmed_value.is_empty())
}

/// Split a comma-separated model list, trimming entries and dropping blanks.
fn parse_comma_separated_values(raw_value: &str) -> Vec<String> {
    raw_value
        .split(',')
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
        .collect()
}

fn default_available_model_ids() -> Vec<String> {
    DEFAULT_AVAILABLE_MODELS
        .iter()
        .map(|model_id| (*model_id).to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_available_models_include_the_default_generation_model() {
        assert!(DEFAULT_AVAILABLE_MODELS.contains(&DEFAULT_GENERATION_MODEL));
    }

    #[test]
    fn comma_separated_models_are_trimmed_and_compacted() {
        let parsed = parse_comma_separated_values(" gemini-3.6-flash , ,gemini-3-flash-preview ");
        assert_eq!(
            parsed,
            vec![
                String::from("gemini-3.6-flash"),
                String::from("gemini-3-flash-preview"),
            ]
        );
    }

    #[test]
    fn blank_model_list_produces_no_entries() {
        assert!(parse_comma_separated_values("  , ,").is_empty());
    }

    #[test]
    fn default_model_id_list_is_non_empty() {
        assert!(!default_available_model_ids().is_empty());
    }

    fn configuration_with(
        bind_address: &str,
        service_api_key: Option<&str>,
        allow_insecure: bool,
    ) -> RuntimeConfiguration {
        RuntimeConfiguration {
            bind_address: bind_address.to_string(),
            gemini_api_key: None,
            gemini_base_url: String::from(DEFAULT_GEMINI_BASE_URL),
            default_model_id: String::from(DEFAULT_GENERATION_MODEL),
            available_model_ids: default_available_model_ids(),
            service_api_key: service_api_key.map(str::to_string),
            allow_insecure,
            allowed_cors_origins: Vec::new(),
            data_directory: PathBuf::from(DEFAULT_DATA_DIRECTORY),
        }
    }

    #[test]
    fn loopback_without_a_service_key_is_allowed() {
        assert!(configuration_with("127.0.0.1:8811", None, false)
            .verify_security_invariants()
            .is_ok());
        assert!(configuration_with("localhost:8811", None, false)
            .verify_security_invariants()
            .is_ok());
        assert!(configuration_with("[::1]:8811", None, false)
            .verify_security_invariants()
            .is_ok());
    }

    #[test]
    fn non_loopback_without_a_service_key_is_refused() {
        assert!(configuration_with("0.0.0.0:8811", None, false)
            .verify_security_invariants()
            .is_err());
    }

    #[test]
    fn non_loopback_with_a_service_key_is_allowed() {
        assert!(configuration_with("0.0.0.0:8811", Some("a-secret"), false)
            .verify_security_invariants()
            .is_ok());
    }

    #[test]
    fn non_loopback_without_a_key_but_explicit_insecure_opt_in_is_allowed() {
        assert!(configuration_with("0.0.0.0:8811", None, true)
            .verify_security_invariants()
            .is_ok());
    }

    #[test]
    fn boolean_environment_flags_parse_case_insensitively() {
        for truthy in ["1", "true", "TRUE", "Yes", "on"] {
            assert!(environment_flag_is_truthy(truthy));
        }
        for falsy in ["0", "false", "no", "off", ""] {
            assert!(!environment_flag_is_truthy(falsy));
        }
    }
}
