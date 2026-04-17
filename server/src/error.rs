// File: server/src/error.rs
// Purpose: Typed application error with IntoResponse mapping so handlers can
//          use `?` without collapsing every failure to a generic 500.
// Role: Shared error type for all HTTP handlers and service code.
// Exports: AppError, Result, ErrorBody
// Depends: axum, serde, thiserror, sqlx
// Invariants: every variant maps to a stable (status, code) pair; JSON body
//             always carries {code, message}.
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

use std::borrow::Cow;

use axum::{
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

/// Rate-limit Retry-After window advertised on 429 responses. Matches the
/// sliding-window cap in Config::signup_rate_limit_window_secs.
pub const RATE_LIMIT_RETRY_AFTER_SECS: u64 = 600;

pub type Result<T> = std::result::Result<T, AppError>;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("bad request: {0}")]
    BadRequest(Cow<'static, str>),
    #[error("conflict: {0}")]
    Conflict(Cow<'static, str>),
    #[error("not found")]
    NotFound,
    #[error("forbidden")]
    Forbidden,
    #[error("unauthorized")]
    Unauthorized,
    #[error("too many requests")]
    TooManyRequests,
    #[error("session in progress")]
    SessionInProgress,
    #[error("service unavailable")]
    ServiceUnavailable,
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("internal error: {0}")]
    Internal(Cow<'static, str>),
}

#[derive(Serialize)]
pub struct ErrorBody {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<String>,
}

impl AppError {
    fn parts(&self) -> (StatusCode, &'static str) {
        match self {
            AppError::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            AppError::Conflict(_) => (StatusCode::CONFLICT, "conflict"),
            AppError::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            AppError::Forbidden => (StatusCode::FORBIDDEN, "forbidden"),
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            AppError::TooManyRequests => (StatusCode::TOO_MANY_REQUESTS, "rate_limited"),
            AppError::SessionInProgress => (StatusCode::CONFLICT, "session_in_progress"),
            AppError::ServiceUnavailable => (StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
            AppError::Sqlx(_) | AppError::Io(_) | AppError::Internal(_) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "internal")
            }
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code) = self.parts();
        // Redact internal error details from the response body so schema /
        // stack information never leaves the server (R1 code-review
        // finding #50). We still log the full error server-side.
        let (message, log_internal) = match &self {
            AppError::Sqlx(_) | AppError::Io(_) | AppError::Internal(_) => {
                (String::from("internal error"), true)
            }
            other => (other.to_string(), false),
        };
        if log_internal {
            tracing::error!(error = %self, "internal error");
        }
        let body = ErrorBody {
            code,
            message,
            suggestion: None,
        };
        let mut resp = (status, Json(body)).into_response();
        if matches!(self, AppError::TooManyRequests) {
            resp.headers_mut().insert(
                header::RETRY_AFTER,
                HeaderValue::from_str(&RATE_LIMIT_RETRY_AFTER_SECS.to_string())
                    .unwrap_or_else(|_| HeaderValue::from_static("600")),
            );
        }
        resp
    }
}
