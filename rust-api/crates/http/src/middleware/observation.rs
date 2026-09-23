use axum::extract::Request;
use axum::response::Response;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use tower::{Layer, Service};

#[derive(Clone)]
pub struct RequestObservationLayer;

impl RequestObservationLayer {
    pub fn construct() -> Self {
        Self
    }
}

impl Default for RequestObservationLayer {
    fn default() -> Self {
        Self::construct()
    }
}

impl<InnerService> Layer<InnerService> for RequestObservationLayer {
    type Service = RequestObservationService<InnerService>;

    fn layer(&self, inner_service: InnerService) -> Self::Service {
        RequestObservationService { inner_service }
    }
}

#[derive(Clone)]
pub struct RequestObservationService<InnerService> {
    inner_service: InnerService,
}

impl<InnerService> Service<Request> for RequestObservationService<InnerService>
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
        let observed_http_method = incoming_request.method().clone();
        let observed_request_path = incoming_request.uri().path().to_string();
        tracing::info!(
            http_method = %observed_http_method,
            request_path = %observed_request_path,
            "an inbound request entered the observation middleware"
        );
        let delegated_future = self.inner_service.call(incoming_request);
        Box::pin(delegated_future)
    }
}
