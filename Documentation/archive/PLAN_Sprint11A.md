# PLAN: Sprint 11A — Sprint 11 findings remediation

## Problem statement

Sprint 11 was archived with 30 council findings all in OPEN state. A subsequent triage
(see `Documentation/findings-archive/FINDINGS_Sprint11.md`) proved 16 already addressed in
code and marked 4 more as addressed once test files were examined. The 10 remaining OPEN
items are addressed here. No new features or migrations.

---

## Current state (from codegraph)

| Finding | Severity | File(s) | Problem |
|---------|----------|---------|---------|
| #3, #26 | High / Medium | `http/history.rs:130` | `Html(html).into_response()` carries no `Cache-Control` header; PII-bearing page is cacheable by browsers and proxies |
| #9, #15, #25 | Medium (×3) | `ws/session_history.rs:23-24`, `state.rs:35` | `StudentId` and `SessionEventId` are `pub type … = i64` — transparent aliases; compiler cannot catch cross-type misuse |
| #22, #27, #28 | Low (×3) | `ws/lobby.rs:382-464` | Session-history wiring is 7 levels deep inside `admit()`; inner `if let Some(tid) = teacher_id` at line 423 is redundant (already inside the same bind at line 383) |
| #11, #29, #30 | Low (×3) | `http/history.rs:96`, `state.rs:120` | `duration_s` is a misleading name for a formatted string; `ActiveSession::student_id` breaks the `session_*` naming convention of its siblings |
| #24 | Medium | `tests/ws_session_handshake.rs:190` | `tokio::time::sleep(100ms)` used as synchronisation; makes test brittle and violates no-real-sleep policy |
| #12 | Low | — | No erasure path for `students` table — deliberate MVP gap |
| #14 | Medium | — | Recording-slot overwrite on new consent — deliberate one-slot-per-teacher design |

---

## Proposed solution

### 1 — Cache-Control header on history page (#3, #26)

**File:** `server/src/http/history.rs`

Replace the final `Html(html).into_response()` with a typed response that adds the header:

```rust
use axum::http::header;

(
    [(header::CACHE_CONTROL, "no-store")],
    Html(html),
)
    .into_response()
```

Add a test in `http/history.rs`:

```rust
#[tokio::test]
async fn get_history_has_cache_control_no_store() {
    // Spin up app, sign in, GET /teach/<slug>/history, assert header value.
    // Uses the existing `spawn_app` + reqwest pattern from `tests/http_history.rs`.
}
```

### 2 — Opaque newtypes for `StudentId` / `SessionEventId` (#9, #15, #25)

**File:** `server/src/ws/session_history.rs` (definitions), `server/src/state.rs` (import)

Replace transparent aliases with `#[sqlx(transparent)]` newtypes:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, sqlx::Type)]
#[sqlx(transparent)]
pub struct StudentId(pub i64);

#[derive(Clone, Copy, Debug, PartialEq, Eq, sqlx::Type)]
#[sqlx(transparent)]
pub struct SessionEventId(pub i64);
```

`#[sqlx(transparent)]` makes sqlx encode/decode these as their inner `i64` — no manual `impl` needed.
All call sites that bind these via `.bind(student_id)` or `.bind(event_id)` already pass the newtype;
`.bind()` on sqlx accepts any type implementing `sqlx::Encode`, which the derive provides.

**Sites to update:**
- `ws/session_history.rs`: function signatures and return types already use these names; just change the definition
- `state.rs:119-120`: `Option<SessionEventId>` / `Option<StudentId>` already reference the types; unchanged
- `ws/lobby.rs:433-434`: `session.session_event_id = Some(event_id)` / `session.student_id = Some(sid)` — will need `.student_id` renamed in step 3 below
- Any tests that construct literal ids via `upsert_student` / `open_event` return values — no change needed since newtypes are returned by those functions

The `sqlx::query_as` decode sites in test code (e.g. `let (id,): (StudentId,) = …`) will also work because `#[sqlx(transparent)]` implements `sqlx::FromRow` for single-column decodes.

### 3 — Refactor `admit()` session-history block (#22, #27, #28)

**File:** `server/src/ws/lobby.rs`

Extract lines 422–458 into a private async fn:

```rust
async fn open_history_row(
    state: &Arc<AppState>,
    ctx: &ConnContext,
    teacher_id: TeacherId,
    email: &str,
    started_at: i64,
) {
    let Ok(sid) = session_history::upsert_student(&state.db, teacher_id, email).await else {
        tracing::warn!("session_history upsert_student failed; session continues");
        return;
    };
    let Ok(event_id) = session_history::open_event(&state.db, teacher_id, sid, started_at).await else {
        tracing::warn!("session_history open_event failed; session continues");
        return;
    };
    let mut orphan = true;
    if let Some(slug) = ctx.slug.as_ref() {
        if let Some(room) = state.room(slug) {
            let mut rs = room.write().await;
            if let Some(ref mut session) = rs.active_session {
                session.session_event_id = Some(event_id);
                session.session_student_id = Some(sid);
                orphan = false;
            }
        }
    }
    if orphan {
        let ended_at = time::OffsetDateTime::now_utc().unix_timestamp();
        if let Err(e) = session_history::close_event(
            &state.db, event_id, teacher_id, ended_at,
            session_log::EndedReason::Disconnect,
        ).await {
            tracing::warn!(error = %e, "session_history orphan close failed");
        }
    }
}
```

In `admit()`, replace the inner block (lines 422–458) with:

```rust
open_history_row(state, ctx, tid, &email, started_at).await;
```

This also eliminates the redundant `if let Some(tid) = teacher_id` at line 423 (finding #28) — `tid` from the outer bind is passed directly as a parameter.

The nesting depth of `admit()` at the session-history path drops from 7 to ≤ 4.

### 4 — Naming fixes (#11, #29, #30)

**`server/src/http/history.rs:96`** — rename local variable:
```rust
// Before
let duration_s = format_duration(*duration_secs);
// After
let duration_display = format_duration(*duration_secs);
```
Update the one format string reference at line 106.

**`server/src/state.rs:120`** — rename field:
```rust
// Before
pub student_id: Option<StudentId>,
// After
pub session_student_id: Option<StudentId>,
```
Update all references:
- `ws/lobby.rs`: `session.student_id = Some(sid)` → `session.session_student_id = Some(sid)` (now inside `open_history_row` from step 3)
- `ws/mod.rs`: search for any `student_id` reads on `ActiveSession` — none exist; the field is only written in lobby.rs and read nowhere else yet

### 5 — Remove real sleep from WS integration test (#24)

**File:** `server/tests/ws_session_handshake.rs`

Replace lines 189-191 (the `tokio::time::sleep` and first query) with a polling loop:

```rust
// Poll until ended_at is set (max 500 ms). Avoids a fixed real-time sleep.
let row = {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
    loop {
        let r: Option<(Option<i64>,)> = sqlx::query_as(
            "SELECT ended_at FROM session_events WHERE teacher_id = ? ORDER BY id DESC LIMIT 1",
        )
        .bind(teacher_id)
        .fetch_optional(&app.state.db)
        .await
        .unwrap();
        if matches!(r, Some((Some(_),))) || std::time::Instant::now() > deadline {
            break r;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
};
```

Maximum wall time is 500 ms; typical is < 20 ms. No fixed sleep.

### 6 — WONTFIX disposals (#12, #14)

These are updated directly in `Documentation/findings-archive/FINDINGS_Sprint11.md` during implementation (no code change):

- **#12**: WONTFIX — `students` table has no erasure path. Deliberate MVP gap; a future GDPR/right-to-erasure sprint will add a `DELETE /teach/<slug>/students/:id` endpoint. Documented in `knowledge/decisions/0001-mvp-architecture.md`.
- **#14**: WONTFIX — One slot per teacher means a new consent overwrites an unconsumed slot. Deliberate design: concurrent sessions are not supported (≤ 1 active session per room), so a new consent in the same room implies the previous slot is stale. Documented in plan and in `session_history.rs` header.

---

## Alternatives considered

**Newtype without `sqlx::Type` derive**: implementing `Encode`/`Decode`/`Type` manually. More verbose, no benefit — `#[sqlx(transparent)]` is the idiomatic approach.

**`Arc<Mutex<…>>` channel for the test instead of polling**: over-engineered for a single DB assertion; the polling loop is simpler and equivalent.

**`Cache-Control: private, no-cache` instead of `no-store`**: `no-store` is stricter (no storage at all). For PII-bearing pages `no-store` is the correct directive.

---

## Test strategy

### Property / invariant coverage

- `StudentId(1) != SessionEventId(1)` — types are distinct at compile time (no test needed; enforced by Rust type system after the newtype change)
- `Cache-Control: no-store` present on `GET /teach/<slug>/history` response

### Failure-path coverage

- `GET /teach/<slug>/history` still returns 401 for unauthenticated request (regression check)
- `session_event_row_has_ended_at_after_disconnect`: ended_at is set within 500 ms, not relying on a fixed sleep

### Regression guards

- All existing `session_history` unit tests pass after the newtype change (sqlx encode/decode still works)
- All existing `ws_session_handshake` tests pass after the refactor
- `cargo clippy` produces no warnings in `ws/lobby.rs` after the `admit()` refactor

### Fixture reuse plan

- `spawn_app` + `signup_teacher` used by the new cache-control test in `tests/http_history.rs` (same pattern as existing tests in that file)
- No new fixtures required

### Test runtime budget + flaky policy

All changes are in-process or in-memory DB. Total new test time < 1 s. No fixed real-time sleeps after this sprint. The polling loop in `session_event_row_has_ended_at_after_disconnect` has a 500 ms timeout; if it fires consistently the test is failing for a real reason, not a flake.
