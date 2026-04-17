# Changes

> Each completed sprint appends an entry here. Format:
>
> ```markdown
> ## Sprint N: Title — YYYY-MM-DD
>
> **Files changed:**
> - `path/to/file` — description
>
> **Commit:** `<sha>`
> ```

## Sprint 1: Signalling foundation + teacher identity + lobby — 2026-04-17

**Files changed:**
- `Cargo.toml`, `server/Cargo.toml`, `rust-toolchain.toml` — single-crate Rust workspace scaffold (axum, tokio, sqlx).
- `server/migrations/0001_initial.sql` — teachers, magic_links, sessions, signup_attempts tables.
- `server/src/{main,lib,config,db,error,state}.rs` — binary entry, pool setup with WAL + busy_timeout, typed AppError with redacted internal messages + Retry-After, per-room AppState using `tokio::sync::RwLock` + atomic room-cap counter.
- `server/src/auth/{slug,magic_link,mailer,rate_limit,mod}.rs` — slug validator + reserved list, atomic consume UPDATE, dev-mode mail file sink (0600 files), transactional per-email + per-IP rate limit, session-cookie extractor with server-side expiry check.
- `server/src/http/{mod,signup,teach,static_assets,security_headers}.rs` — /signup, /auth/verify (CSP-safe external script), /auth/consume, /teach/<slug>, /assets/*; strict CSP (`script-src 'self'; connect-src 'self'`).
- `server/src/ws/{mod,protocol,connection,lobby,session}.rs` — WebSocket upgrade with Origin check, tagged-union ClientMsg/ServerMsg + PumpDirective, per-connection outbound pump as sole socket writer, slug-aware role resolution on first lobby message, explicit async cleanup (no `Drop` work).
- `web/{teacher,student}.html`, `web/assets/{signalling,teacher,student,verify,signup}.js`, `web/assets/styles.css` — vanilla-JS browser client with `signallingClient.connectTeacher` / `connectStudent`, textContent-only rendering of student-supplied strings, fragment-based verify flow.
- `server/tests/{common,http_signup,http_origin,http_csp,magic_link,ws_lobby,ws_lobby_cap,ws_lobby_rejection,ws_session_handshake,ws_shutdown,ws_signal_relay,state_concurrency}.rs` — 45 integration tests covering signup/consume, rate limiting, re-signup idempotency, cross-origin WS rejection, lobby join/admit/reject with close codes, signal relay + payload cap boundary, graceful shutdown ordering, concurrent magic-link consume exactly-once, concurrent room-cap enforcement.
- `knowledge/decisions/0001-mvp-architecture.md` — foundational ADR (committed earlier but referenced throughout Sprint 1).
- `CLAUDE.md`, `SPRINTS.md` — tier-3 index entry for ADR-0001, Sprint 1 status COMPLETE.
- `Documentation/archive/PLAN_Sprint1.md` — archived plan.

**Commit:** `b91a8c1` (plus R2 follow-ups)

