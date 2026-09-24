use axum::body::Body;
use axum::extract::{ConnectInfo, Request};
use axum::http::StatusCode;
use axum::response::Response;
use std::collections::HashMap;
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};
use tower::{Layer, Service};

/// Header carrying the caller identity. Mirrors the pipeline extractor
/// (`AUTHENTICATED_ACCOUNT_HEADER_NAME`): the BFF injects it from the verified
/// session, so keying on it rate-limits the real client rather than the shared
/// proxy connection (RUST-DOS-002(a) plan note: key on the injected identity,
/// not the proxy IP).
const CLIENT_IDENTITY_HEADER_NAME: &str = "x-account-email";

/// Bucket key used when a request carries neither an identity header nor a
/// resolvable peer address. All such requests share one window so a missing
/// key still counts against a limit rather than bypassing it entirely.
const UNIDENTIFIED_CLIENT_BUCKET_KEY: &str = "unidentified";

/// Fixed-window counter for a single client bucket. RUST-DOS-002(a): one of
/// these now lives per client key (see `resolve_bucket_key`) instead of a lone
/// global window, so one caller's burst can no longer 429 unrelated identities.
struct FixedWindowState {
    current_window_started_at: Instant,
    requests_observed_in_current_window: u32,
}

#[derive(Clone)]
pub struct RateLimitingLayer<const WINDOW_SECONDS: u64, const MAXIMUM_REQUESTS: u32> {
    windows_by_client_key: Arc<Mutex<HashMap<String, FixedWindowState>>>,
}

impl<const WINDOW_SECONDS: u64, const MAXIMUM_REQUESTS: u32>
    RateLimitingLayer<WINDOW_SECONDS, MAXIMUM_REQUESTS>
{
    pub fn construct() -> Self {
        Self {
            windows_by_client_key: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl<const WINDOW_SECONDS: u64, const MAXIMUM_REQUESTS: u32> Default
    for RateLimitingLayer<WINDOW_SECONDS, MAXIMUM_REQUESTS>
{
    fn default() -> Self {
        Self::construct()
    }
}

impl<InnerService, const WINDOW_SECONDS: u64, const MAXIMUM_REQUESTS: u32> Layer<InnerService>
    for RateLimitingLayer<WINDOW_SECONDS, MAXIMUM_REQUESTS>
{
    type Service = RateLimitingService<InnerService, WINDOW_SECONDS, MAXIMUM_REQUESTS>;

    fn layer(&self, inner_service: InnerService) -> Self::Service {
        RateLimitingService {
            inner_service,
            windows_by_client_key: Arc::clone(&self.windows_by_client_key),
        }
    }
}

#[derive(Clone)]
pub struct RateLimitingService<InnerService, const WINDOW_SECONDS: u64, const MAXIMUM_REQUESTS: u32>
{
    inner_service: InnerService,
    windows_by_client_key: Arc<Mutex<HashMap<String, FixedWindowState>>>,
}

/// Derive the per-client rate-limit bucket key. Prefer the BFF-injected
/// identity header; when absent (e.g. unauthenticated edge paths), fall back to
/// the peer socket IP, and finally to a shared sentinel. The `email:` / `ip:`
/// prefixes keep the two namespaces from colliding.
fn resolve_bucket_key(incoming_request: &Request) -> String {
    if let Some(account_email) = incoming_request
        .headers()
        .get(CLIENT_IDENTITY_HEADER_NAME)
        .and_then(|header_value| header_value.to_str().ok())
        .map(str::trim)
        .filter(|account_email| !account_email.is_empty())
    {
        return format!("email:{account_email}");
    }
    if let Some(ConnectInfo(peer_socket_address)) =
        incoming_request.extensions().get::<ConnectInfo<SocketAddr>>()
    {
        return format!("ip:{}", peer_socket_address.ip());
    }
    UNIDENTIFIED_CLIENT_BUCKET_KEY.to_string()
}

impl<InnerService, const WINDOW_SECONDS: u64, const MAXIMUM_REQUESTS: u32> Service<Request>
    for RateLimitingService<InnerService, WINDOW_SECONDS, MAXIMUM_REQUESTS>
where
    InnerService: Service<Request, Response = Response> + Send + 'static,
    InnerService::Future: Send + 'static,
{
    type Response = Response;
    type Error = InnerService::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, readiness_context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner_service.poll_ready(readiness_context)
    }

    fn call(&mut self, incoming_request: Request) -> Self::Future {
        let bucket_key = resolve_bucket_key(&incoming_request);
        let window_admission_was_granted = {
            let configured_window_duration = Duration::from_secs(WINDOW_SECONDS);
            let observation_instant = Instant::now();
            // RUST-DOS-002(b): recover from a poisoned lock instead of turning
            // every subsequent request into a 500 — parity with the storage /
            // event-store adapters.
            let mut acquired_guard = self
                .windows_by_client_key
                .lock()
                .unwrap_or_else(|poisoned_guard| poisoned_guard.into_inner());
            // Bound memory (RUST-DOS-002(a)): drop windows that have fully
            // elapsed so a churn of distinct identities/IPs cannot grow the map
            // without limit. A returning client whose window elapsed is pruned
            // here and re-created fresh below — the intended fixed-window reset.
            acquired_guard.retain(|_, window_state| {
                observation_instant.duration_since(window_state.current_window_started_at)
                    < configured_window_duration
            });
            let window_state =
                acquired_guard
                    .entry(bucket_key)
                    .or_insert_with(|| FixedWindowState {
                        current_window_started_at: observation_instant,
                        requests_observed_in_current_window: 0,
                    });
            if window_state.requests_observed_in_current_window >= MAXIMUM_REQUESTS {
                false
            } else {
                window_state.requests_observed_in_current_window += 1;
                true
            }
        };

        if !window_admission_was_granted {
            let rejection_body_text = format!(
                "rate limit of {MAXIMUM_REQUESTS} requests per {WINDOW_SECONDS} seconds exceeded"
            );
            return Box::pin(async move {
                let rejection_response = Response::builder()
                    .status(StatusCode::TOO_MANY_REQUESTS)
                    .body(Body::from(rejection_body_text))
                    .expect("a statically valid response is always constructible");
                Ok(rejection_response)
            });
        }

        let delegated_future = self.inner_service.call(incoming_request);
        Box::pin(delegated_future)
    }
}
