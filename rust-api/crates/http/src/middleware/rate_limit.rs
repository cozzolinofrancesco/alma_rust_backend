use axum::body::Body;
use axum::extract::Request;
use axum::http::StatusCode;
use axum::response::Response;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};
use tower::{Layer, Service};

struct FixedWindowState {
    current_window_started_at: Instant,
    requests_observed_in_current_window: u32,
}

#[derive(Clone)]
pub struct RateLimitingLayer<const WINDOW_SECONDS: u64, const MAXIMUM_REQUESTS: u32> {
    shared_window_state: Arc<Mutex<FixedWindowState>>,
}

impl<const WINDOW_SECONDS: u64, const MAXIMUM_REQUESTS: u32>
    RateLimitingLayer<WINDOW_SECONDS, MAXIMUM_REQUESTS>
{
    pub fn construct() -> Self {
        Self {
            shared_window_state: Arc::new(Mutex::new(FixedWindowState {
                current_window_started_at: Instant::now(),
                requests_observed_in_current_window: 0,
            })),
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
            shared_window_state: Arc::clone(&self.shared_window_state),
        }
    }
}

#[derive(Clone)]
pub struct RateLimitingService<InnerService, const WINDOW_SECONDS: u64, const MAXIMUM_REQUESTS: u32>
{
    inner_service: InnerService,
    shared_window_state: Arc<Mutex<FixedWindowState>>,
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
        let window_admission_was_granted = {
            let mut acquired_guard = self
                .shared_window_state
                .lock()
                .expect("the rate limiting window mutex was poisoned");
            let configured_window_duration = Duration::from_secs(WINDOW_SECONDS);
            if acquired_guard.current_window_started_at.elapsed() >= configured_window_duration {
                acquired_guard.current_window_started_at = Instant::now();
                acquired_guard.requests_observed_in_current_window = 0;
            }
            if acquired_guard.requests_observed_in_current_window >= MAXIMUM_REQUESTS {
                false
            } else {
                acquired_guard.requests_observed_in_current_window += 1;
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
