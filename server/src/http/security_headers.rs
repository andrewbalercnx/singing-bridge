// File: server/src/http/security_headers.rs
// Purpose: Strict CSP + browser-hardening headers on every response.
// Role: One place to audit the security posture of HTML responses.
// Exports: apply_headers middleware fn, EXPECTED_CSP
// Depends: axum
// Invariants: CSP is byte-equal to EXPECTED_CSP in the test assertion;
//             HSTS only emitted outside dev.
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

use axum::{
    extract::Request,
    http::{header, HeaderName, HeaderValue},
    middleware::Next,
    response::Response,
};

pub const EXPECTED_CSP: &str = "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

pub async fn apply_headers(dev: bool, req: Request, next: Next) -> Response {
    let mut resp = next.run(req).await;
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(EXPECTED_CSP),
    );
    h.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(
        HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
    h.insert(
        HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static("camera=(self), microphone=(self), geolocation=()"),
    );
    if !dev {
        h.insert(
            HeaderName::from_static("strict-transport-security"),
            HeaderValue::from_static("max-age=31536000; includeSubDomains"),
        );
    }
    resp
}
