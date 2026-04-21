# PLAN: Sprint 11 — Persistent student records + session history

## Problem statement

The teacher currently has no way to review past sessions. `session_log` stores privacy-preserving hashed email; it is not suitable as a teacher-visible history because the hash is irreversible. Sprint 11 adds a parallel persistence path using plain email (visible only to the owning teacher) and a `/teach/<slug>/history` page showing the teacher who they taught, when, and for how long.

---

## Current state (from codegraph)

| Layer | File(s) | Summary |
|-------|---------|---------|
| DB | `migrations/0001_initial.sql` | `teachers`, `sessions`, `magic_links`, `signup_attempts` |
| DB | `migrations/0002_session_log.sql` | `session_log` — hashed email, metrics, ended_reason |
| DB | `migrations/0003_recordings.sql` | `recordings`, `recording_gate_attempts` |
| DB | `migrations/0004_password_auth.sql` | `login_attempts`, `password_hash` on teachers |
| WS | `ws/lobby.rs` | `admit()` — creates ActiveSession, opens session_log row |
| WS | `ws/mod.rs` | `close_row()` called at all session-end paths (~line 759) |
| WS | `ws/session_log.rs` | `open_row`, `close_row`, `record_peak` |
| HTTP | `http/recordings.rs` | `post_upload` — creates recordings row after blob upload |
| HTTP | `http/teach.rs` | `get_teach` — teacher/student view |
| Cleanup | `cleanup.rs` | `run_one_cleanup_cycle` — prunes gate_attempts, login_attempts |
| State | `state.rs` | `ActiveSession` — holds `log_id: Option<SessionLogId>` |

`session_log` uses `student_email_hash` (irreversible). `recordings` has `student_email`. The new `session_events` table mirrors `session_log` but stores plain email (via `students` table), supports recording linkage, and soft-deletes.

---

## Deployment precondition

No existing session events or students. Migration 0005 creates new tables and alters existing ones; no existing data rows are changed.

---

## Proposed solution

### Migration 0005 — `server/migrations/0005_session_history.sql`

```sql
-- Typed ids for session history
CREATE TABLE students (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id    INTEGER NOT NULL REFERENCES teachers(id),
  email         TEXT    NOT NULL COLLATE NOCASE,  -- stored normalized (lowercase)
  first_seen_at INTEGER NOT NULL,
  UNIQUE(teacher_id, email)
);
CREATE INDEX idx_students_teacher ON students(teacher_id);

CREATE TABLE session_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id    INTEGER NOT NULL REFERENCES teachers(id),
  student_id    INTEGER NOT NULL REFERENCES students(id),
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,           -- NULL while live
  duration_secs INTEGER,           -- MAX(0, ended_at - started_at); set on close
  recording_id  INTEGER REFERENCES recordings(id),
  ended_reason  TEXT,              -- 'hangup'|'disconnect'|'server_shutdown'|'floor_violation'|'blocked'
  archived_at   INTEGER            -- soft-delete: set by cleanup when completion time < now - 90d
);
CREATE INDEX idx_session_events_teacher ON session_events(teacher_id, started_at DESC);
CREATE INDEX idx_session_events_student ON session_events(student_id);

-- One-shot recording linkage slot: written at consent time, consumed at upload.
-- Ensures upload can link to the right session even if the session has already ended.
CREATE TABLE recording_sessions (
  teacher_id       INTEGER PRIMARY KEY REFERENCES teachers(id),
  session_event_id INTEGER NOT NULL REFERENCES session_events(id),
  created_at       INTEGER NOT NULL
);
```

**`students.email` normalization**: stored as `lower(email)`. UNIQUE(teacher_id, email) with COLLATE NOCASE handles existing rows; new inserts always lowercase first.

**Known limitation**: plain student emails persist in `students` until a future erasure path is added. Documented as a known gap; no GDPR-mandated deletion path in MVP scope.

### Named constants

```rust
const SESSION_ARCHIVE_DAYS: i64 = 90;
const HISTORY_PAGE_LIMIT: i64 = 100;
const RECORDING_SLOT_TTL_SECS: i64 = 86400; // max gap between consent and upload
```

### New module: `ws/session_history.rs`

All public functions own an `EndedReason` parameter (not `&str`) where applicable, matching the existing `session_log` contract. All mutating operations include `teacher_id` in both the Rust signature and the SQL predicate.

```rust
pub type StudentId = i64;
pub type SessionEventId = i64;

/// Upsert student. Two-step: INSERT OR IGNORE then SELECT.
/// Email normalized to lowercase before insertion.
pub async fn upsert_student(pool: &SqlitePool, teacher_id: TeacherId, email: &str) -> Result<StudentId>

/// Open a session_event row (ended_at, duration_secs, ended_reason all NULL).
pub async fn open_event(pool: &SqlitePool, teacher_id: TeacherId, student_id: StudentId, started_at: i64) -> Result<SessionEventId>

/// Close event: first-writer-wins (WHERE ended_at IS NULL). Sets duration_secs = MAX(0, ended_at - started_at).
/// teacher_id enforced in SQL: WHERE id = ? AND teacher_id = ?
pub async fn close_event(pool: &SqlitePool, event_id: SessionEventId, teacher_id: TeacherId, ended_at: i64, reason: EndedReason) -> Result<()>

/// Store the recording-linkage slot (upsert: one slot per teacher).
pub async fn set_recording_slot(pool: &SqlitePool, teacher_id: TeacherId, event_id: SessionEventId) -> Result<()>

/// Consume and clear the slot; returns None if expired or absent.
/// Only returns the event_id if created_at > now - RECORDING_SLOT_TTL_SECS.
pub async fn consume_recording_slot(pool: &SqlitePool, teacher_id: TeacherId) -> Result<Option<SessionEventId>>

/// Link a recording to its session event. teacher_id enforced in SQL.
pub async fn link_recording(pool: &SqlitePool, event_id: SessionEventId, teacher_id: TeacherId, recording_id: i64) -> Result<()>
```

**`upsert_student` — conflict-safe id return**:
```sql
INSERT OR IGNORE INTO students (teacher_id, email, first_seen_at) VALUES (?, lower(?), ?);
SELECT id FROM students WHERE teacher_id = ? AND email = lower(?);
```
Always returns the correct `id` regardless of whether the INSERT fired.

**`close_event` — first-writer-wins + ownership**:
```sql
UPDATE session_events
SET ended_at = ?, duration_secs = MAX(0, ? - started_at), ended_reason = ?
WHERE id = ? AND teacher_id = ? AND ended_at IS NULL
```

### State changes (`state.rs`)

`ActiveSession` gains:
```rust
pub session_event_id: Option<SessionEventId>,
pub student_id: Option<StudentId>,
```
Both start as `None`, filled after async DB calls outside the room lock — same lifecycle as `log_id`.

### Admission flow changes (`ws/lobby.rs` → `admit`)

After `session_log::open_row` succeeds, on the same `Ok` branch:
1. `upsert_student(pool, teacher_id, &email)` → `student_id`
2. `open_event(pool, teacher_id, student_id, started_at)` → `event_id`
3. Re-acquire room write lock (same pattern as `log_id`):
   - If `active_session` still exists: set `session_event_id` and `student_id`
   - If not (orphan race): call `close_event(pool, event_id, teacher_id, now, EndedReason::Disconnect)` immediately (mirrors orphan `close_row` pattern)

If either DB call fails: log warning and continue — history is best-effort; the session proceeds regardless.

### Session close flow changes (`ws/mod.rs`)

At the point where `close_row` is called (~line 759):
```rust
if let Some((event_id, teacher_id)) = session.session_event_id.zip(session.teacher_id) {
    if let Err(e) = session_history::close_event(&state.db, event_id, teacher_id, ended_at, ended_reason).await {
        tracing::warn!(error = %e, "session_history close_event failed");
    }
}
```

### Recording linkage — durable slot pattern

**Problem with naive "most recent open event" lookup**: if the session ends before the upload finishes, or a new session starts before upload arrives, the lookup returns the wrong event.

**Solution**: at `handle_record_consent(granted=true)`, write a durable slot:
```rust
session_history::set_recording_slot(&state.db, teacher_id, event_id).await?
```

In `post_upload`:
```rust
if let Some(event_id) = session_history::consume_recording_slot(&state.db, teacher_id).await? {
    let _ = session_history::link_recording(&state.db, event_id, teacher_id, recording_id).await;
}
```

The slot is keyed by teacher_id (one per teacher). Consuming clears it atomically. Expiry is 24 h (RECORDING_SLOT_TTL_SECS). Recordings uploaded more than 24 h after consent remain unlinked — acceptable for MVP.

### Email validation at WS join

`handle_lobby_join` (currently validates only length) gains a format check:
```rust
if !email.contains('@') || email.len() < 3 {
    close_malformed(ctx, "invalid email").await;
    return false;
}
```
The email is also normalized to lowercase before storage in LobbyEntry. This is consistent with existing teacher email handling.

### History page HTML escaping

`http/history.rs` builds HTML server-side. All user-derived values (email, ended_reason) are HTML-escaped using a `html_escape(s: &str) -> String` helper (replaces `&`, `<`, `>`, `"`, `'` with entities). No templating library required.

### Archive semantics (`cleanup.rs`)

Cutoff is based on session **completion** time, not start time:
```sql
UPDATE session_events
SET archived_at = ?
WHERE COALESCE(ended_at, started_at) < ?
  AND archived_at IS NULL
```
Where the cutoff is `now - SESSION_ARCHIVE_DAYS * 86400`.

### New HTTP handler: `http/history.rs`

Route: `GET /teach/<slug>/history`

Auth: same as `get_recordings_page` — valid session cookie for the owning teacher (401 otherwise).

Query:
```sql
SELECT se.id, se.started_at, se.ended_at, se.duration_secs, se.ended_reason,
       s.email, r.id AS recording_id
FROM session_events se
JOIN students s ON s.id = se.student_id
LEFT JOIN recordings r ON r.id = se.recording_id
WHERE se.teacher_id = ?
  AND se.archived_at IS NULL
ORDER BY se.started_at DESC
LIMIT ?
```
Using the `HISTORY_PAGE_LIMIT` constant.

Response: server-rendered HTML table. Every value inserted into HTML uses `html_escape`. Duration formatted as `mm:ss` or `"-"` if `ended_at IS NULL`.

### Route table addition

| Method | Path | Handler | Auth |
|--------|------|---------|------|
| GET | `/teach/<slug>/history` | `get_history` | session required (owning teacher) |

---

## Alternatives considered

**Extend `session_log`**: `session_log` is privacy-preserving by design; adding plain email violates its invariant. New table is the right call.

**Hard-delete sessions**: Soft-delete gives recovery path; no data loss risk.

**`last_insert_rowid()` for upsert**: Unreliable on `INSERT OR IGNORE` when the row exists. Two-step `INSERT OR IGNORE` + `SELECT` is correct.

**Memory-only recording link**: Room may be evicted before upload; DB slot is durable.

---

## Test strategy

### Property / invariant coverage

- `upsert_student` twice with same (teacher_id, email) → same student_id both times
- `upsert_student` with mixed-case email variants (e.g. `"ALICE@test"`, `"alice@TEST"`) → same student_id
- `open_event` → row has `ended_at IS NULL`, `duration_secs IS NULL`
- `close_event` → row has correct `ended_at` and `duration_secs = MAX(0, ended_at - started_at)`
- `close_event` with `ended_at < started_at` (negative) → `duration_secs = 0` (clamped)
- `close_event` twice → second call is a no-op (first-writer-wins; no error)
- `link_recording` → `session_events.recording_id` is set
- `link_recording` with wrong `teacher_id` → row unchanged (ownership enforced)
- `consume_recording_slot` after TTL → returns None (slot expired)

### Failure-path coverage

- `GET /teach/<slug>/history` without session cookie → 401
- `GET /teach/<slug>/history` with another teacher's cookie → 401
- `GET /teach/<slug>/history` with no events → 200, empty table
- `GET /teach/<slug>/history` with 150 events → only 100 returned in DESC order
- History page: student email containing `<script>` is HTML-escaped, not executed
- WS `lobby_join` with email missing `@` → malformed close
- Archive cutoff: event where `ended_at = now - 90d - 1s` → archived; `ended_at = now - 90d` (boundary) → not archived (strict `<` predicate)
- Archive cutoff for live session (ended_at IS NULL): uses `started_at` via COALESCE → only archived if started 90+ days ago
- `consume_recording_slot` when no slot exists → None (no error)
- Best-effort: `open_event` DB failure during admission → session proceeds, no crash

### Regression guards

- `resolve_teacher_from_cookie` resolves after migration 0005 (sessions table unchanged)
- `POST /auth/login` still works after migration 0005 (no conflict with new tables)
- Existing recording upload flow works when no recording slot exists (best-effort skip)
- `run_one_cleanup_cycle` still prunes `login_attempts` and `recording_gate_attempts` as before
- Ended-reason enum mapping: all four `EndedReason` variants map to the correct stored string

### Fixture reuse plan

`common::make_session_event(app, teacher_id, email, started_at, ended_at) -> SessionEventId` — inserts a student + session_event directly via SQL with no WS calls. Uses the direct-SQL pattern from `insert_teacher_no_password`. Available from `server/tests/common/mod.rs`.

All existing WS tests use `signup_teacher` (delegates to `register_teacher`); no changes to WS fixtures needed.

### Test runtime budget + flaky policy

All new tests are DB-only (no Argon2, no WS, no HTTP). Total new test runtime: < 1 s. No real-time sleeps. Archive boundary tests insert rows with synthetic `started_at`/`ended_at` values. The WS lifecycle integration test (`ws_session_handshake.rs`) is extended by one assertion (session_event row has non-NULL `ended_at` after clean hangup).
