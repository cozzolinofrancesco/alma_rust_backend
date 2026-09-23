use crate::categories::auth::handlers::*;
use crate::state::ApplicationState;
use alma_application::ports::unit_of_work::UnitOfWork;
use axum::Router;
use axum::routing::{get, post};

pub fn build_auth_router<TransactionalUnitOfWork>()
-> Router<ApplicationState<TransactionalUnitOfWork>>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    Router::new()
        .route(
            "/api/auth/refresh-token",
            post(rotate_refresh_token_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/auth/session",
            get(retrieve_authenticated_session_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/allowed-emails",
            get(list_allowed_emails_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/debug-oauth-scopes",
            get(list_oauth_scopes_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/rate-limit/check",
            get(check_rate_limit_quota_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/auth/*nextauth_action",
            get(handle_nextauth_action_via_get::<TransactionalUnitOfWork>)
                .post(handle_nextauth_action_via_post::<TransactionalUnitOfWork>),
        )
}
