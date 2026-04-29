# Simulator — Bot Peer for Manual UX Testing

The simulator lets you test the session UI solo: a headless Chromium bot plays the opposite role (teacher or student) while you use the real browser UI.

---

## Prerequisites

**Python dependencies** (one-time):

```bash
pip install -r scripts/requirements-test-peer.txt
playwright install chromium
```

> **Note:** pip may print warnings about `vvp-issuer` or `typer` version conflicts from unrelated
> packages in your environment. These are harmless — the install still succeeds.

**PostgreSQL** must be reachable and `SB_DATABASE_URL` set. For local dev, export it before running:

```bash
export SB_DATABASE_URL=postgres://localhost:5432/singing_bridge
```

Or point it at your deployed database URL (no `sslmode=verify-full` required in dev).

**Server must be running in dev mode** (the routes are compiled out of release builds):

```bash
SB_TEST_PEER=true cargo run
```

---

## Two modes

### Student mode — you are the teacher

The bot joins your room as a student. You admit it from the lobby and run the session as normal.

**Trigger via HTTP:**

```bash
curl "http://localhost:8080/test-peer?slug=YOUR_ROOM&mode=student"
```

What happens:
1. Bot navigates to `http://localhost:8080/teach/YOUR_ROOM`
2. Fills the join form with `test-bot@singing-bridge.dev`
3. Waits in the lobby until you admit it (up to 90 s)
4. Once admitted, speaks three TTS phrases through a fake microphone:
   - *"Hello, I'm ready."*
   - *"Sorry, can we slow that down a little?"*
   - *"Thank you, that was really helpful."*
5. Exits after ~75 s

---

### Teacher mode — you are the student

The bot signs in as the teacher for your room, waits for you to join the lobby, admits you, and starts the accompaniment.

**Prerequisites:** your room must have at least one WAV variant uploaded in the accompaniment library.

**Trigger via HTTP:**

```bash
curl "http://localhost:8080/test-peer?slug=YOUR_ROOM&mode=teacher"
```

What happens:
1. Bot exchanges a one-time token for a 180 s teacher session cookie
2. Navigates to the session page for your room
3. Waits for you to join the lobby (up to 60 s)
4. Clicks **Admit** on your lobby entry
5. Starts the first WAV variant via `accompaniment_play`
6. Speaks three teacher phrases through a fake microphone:
   - *"Good morning. Let's begin with Somewhere Over the Rainbow."*
   - *"Well done. Let's try that again from the top."*
   - *"That's all for today. Great work."*
7. Exits after ~165 s

---

## Checking status

The HTTP response tells you immediately whether the bot launched:

| Status | Meaning |
|--------|---------|
| `202 Accepted` | Bot subprocess started |
| `409 Conflict` | A bot is already running for that slug — wait for it to finish |
| `404 Not Found` | `no_teacher` — slug not in DB; or `no_wav_variant` — no WAV uploaded (teacher mode only) |
| `503 Service Unavailable` | `bot_unavailable` — Playwright not installed; or `bot_capacity` — 100 bots already running |

A second request for the same slug while a bot is still running returns `409`. Once the bot exits (or times out after 180 s), the slot clears automatically.

---

## Disabling the simulator

The routes are only compiled in debug builds. To disable at runtime without rebuilding:

```bash
# omit SB_TEST_PEER=true when starting the server
cargo run   # simulator endpoints return 404
```

The simulator is rejected entirely in production config: `validate_prod_config()` refuses to start if `SB_TEST_PEER=true` is set.
