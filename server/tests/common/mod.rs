// File: server/tests/common/mod.rs
// Purpose: Shared test harness — spawn_app, dev-mail reader, WS client.
// Role: Keep integration-test bodies short and behaviour-focused.
// Last updated: Sprint 19 (2026-04-26) -- template DB per process; skip per-test migrations

#![allow(dead_code)]

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

static DB_COUNTER: AtomicU64 = AtomicU64::new(0);
static TEMPLATE_DB: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use argon2::Params;
use singing_bridge_server::{
    auth::{
        mailer::{DevMailer, Mailer},
        password::hash_password_with_params,
    },
    blob::{BlobStore, DevBlobStore},
    config::Config,
    db::{init_pool, run_migrations},
    http::{media_token::MediaTokenStore, router},
    sidecar::SidecarClient,
    state::AppState,
};
use sqlx::postgres::PgPoolOptions;
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;
use url::Url;

pub struct TestApp {
    pub addr: SocketAddr,
    pub base_url: Url,
    pub mail_dir: TempDir,
    pub blob_dir: TempDir,
    pub shutdown: CancellationToken,
    /// Wrapped in Option so Drop can take it (abort) without moving out of the struct.
    server_handle: Option<tokio::task::JoinHandle<()>>,
    pub state: Arc<AppState>,
    pub client: reqwest::Client,
    pub db_name: String,
    pub admin_url: String,
    /// Set to true by explicit `shutdown()` so the Drop impl skips double-cleanup.
    db_dropped: Arc<AtomicBool>,
}

/// Panic-safe cleanup: if the test panics before calling `shutdown()`, Drop
/// cancels the server and drops the per-test database via a dedicated runtime.
impl Drop for TestApp {
    fn drop(&mut self) {
        self.shutdown.cancel();
        if let Some(h) = self.server_handle.take() {
            h.abort();
        }
        if self.db_dropped.compare_exchange(
            false, true, Ordering::AcqRel, Ordering::Acquire,
        ).is_ok() {
            let db_name = self.db_name.clone();
            let admin_url = self.admin_url.clone();
            let pool = self.state.db.clone();
            // Do NOT call pool.close().await — same cross-runtime deadlock risk as
            // TestDb::Drop. DROP WITH (FORCE) terminates connections server-side.
            let _ = pool; // drop the pool reference; actual cleanup via FORCE below
            std::thread::spawn(move || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("TestApp Drop runtime")
                    .block_on(async move {
                        if let Ok(admin) = PgPoolOptions::new()
                            .max_connections(1)
                            .connect(&admin_url)
                            .await
                        {
                            let _ = sqlx::query(
                                &format!("DROP DATABASE \"{db_name}\" WITH (FORCE)"),
                            )
                            .execute(&admin)
                            .await;
                            admin.close().await;
                        }
                    });
            })
            .join()
            .ok();
        }
    }
}

pub struct TestOpts {
    pub lobby_cap_per_room: usize,
    pub max_active_rooms: usize,
    pub signup_rate_limit_per_email: usize,
    pub signup_rate_limit_per_ip: usize,
    pub dev: bool,
    /// Override the static file directory (defaults to the workspace `web/`).
    pub static_dir: Option<std::path::PathBuf>,
    /// Override blob store (defaults to a temp-dir DevBlobStore).
    pub blob: Option<Arc<dyn BlobStore>>,
    /// Enable the magic-link password-reset escape hatch (default: false).
    pub password_reset_enabled: bool,
    /// Login rate-limit settings (default: very high to avoid interfering).
    pub login_ip_max_attempts: u32,
    pub login_account_max_failures: u32,
    /// Override sidecar base URL (defaults to config dev_default: 127.0.0.1:5050).
    pub sidecar_url: Option<url::Url>,
}

impl Default for TestOpts {
    fn default() -> Self {
        Self {
            lobby_cap_per_room: 32,
            max_active_rooms: 1024,
            signup_rate_limit_per_email: 999_999,
            signup_rate_limit_per_ip: 999_999,
            dev: true,
            static_dir: None,
            blob: None,
            password_reset_enabled: false,
            login_ip_max_attempts: 999_999,
            login_account_max_failures: 999_999,
            sidecar_url: None,
        }
    }
}

/// Return (or lazily create) a per-process template database with migrations applied.
async fn ensure_template_db(admin_url: &str) -> String {
    if let Some(name) = TEMPLATE_DB.lock().unwrap().as_ref() {
        return name.clone();
    }
    let admin_url = admin_url.to_string();
    tokio::task::spawn_blocking(move || {
        let mut guard = TEMPLATE_DB.lock().unwrap();
        if let Some(name) = guard.as_ref() {
            return name.clone();
        }
        let pid = std::process::id();
        let name = format!("singing_bridge_test_template_{pid}");
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("template DB init runtime");
        rt.block_on(async {
            let admin = PgPoolOptions::new()
                .max_connections(1)
                .connect(&admin_url)
                .await
                .expect("template: connect admin");
            let _ = sqlx::query(&format!("DROP DATABASE IF EXISTS \"{name}\""))
                .execute(&admin)
                .await;
            sqlx::query(&format!("CREATE DATABASE \"{name}\""))
                .execute(&admin)
                .await
                .expect("template: create");
            admin.close().await;
            let db_url = match Url::parse(&admin_url) {
                Ok(mut u) => { u.set_path(&format!("/{name}")); u.to_string() }
                Err(_) => match admin_url.rfind('/') {
                    Some(idx) => format!("{}/{}", &admin_url[..idx], name),
                    None => format!("{}/{}", admin_url, name),
                },
            };
            run_migrations(&db_url).await.expect("template: run_migrations");
        });
        *guard = Some(name.clone());
        name
    })
    .await
    .expect("ensure_template_db")
}

pub async fn spawn_app() -> TestApp {
    spawn_app_with(TestOpts::default()).await
}

/// Search upward from the current working directory for the workspace-root
/// `web/` directory. Used by the test harness — kept tiny so `spawn_app_with`
/// stays focused on wiring.
fn locate_web_dir() -> std::path::PathBuf {
    let mut probe = std::env::current_dir().expect("cwd");
    loop {
        let candidate = probe.join("web").join("teacher.html");
        if candidate.exists() {
            return probe.join("web");
        }
        if !probe.pop() {
            panic!("could not locate web/ dir from {:?}", std::env::current_dir());
        }
    }
}

pub async fn spawn_app_with(opts: TestOpts) -> TestApp {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let base_url = Url::parse(&format!("http://{addr}")).unwrap();
    let mail_dir = tempfile::tempdir().unwrap();

    // Create a unique per-test PostgreSQL database from the per-process template
    // (migrations already applied — no per-test migration overhead).
    let admin_url = std::env::var("DATABASE_TEST_URL")
        .expect("DATABASE_TEST_URL must be set for integration tests");
    let template = ensure_template_db(&admin_url).await;
    let n = DB_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let db_name = format!("singing_bridge_test_{pid}_{n}");

    let admin = PgPoolOptions::new()
        .max_connections(1)
        .connect(&admin_url)
        .await
        .expect("connect admin pool");
    let _ = sqlx::query(&format!("DROP DATABASE IF EXISTS \"{db_name}\""))
        .execute(&admin)
        .await;
    sqlx::query(&format!(
        "CREATE DATABASE \"{db_name}\" TEMPLATE \"{template}\""
    ))
    .execute(&admin)
    .await
    .expect("create test database from template");
    admin.close().await;

    let db_url = match Url::parse(&admin_url) {
        Ok(mut u) => {
            u.set_path(&format!("/{db_name}"));
            u.to_string()
        }
        Err(_) => match admin_url.rfind('/') {
            Some(idx) => format!("{}/{}", &admin_url[..idx], db_name),
            None => format!("{}/{}", admin_url, db_name),
        },
    };

    let mut config = Config::dev_default();
    config.bind = addr;
    config.base_url = base_url.clone();
    config.db_url = db_url.clone();
    config.dev_mail_dir = mail_dir.path().to_path_buf();
    config.static_dir = opts.static_dir.unwrap_or_else(locate_web_dir);
    config.lobby_cap_per_room = opts.lobby_cap_per_room;
    config.max_active_rooms = opts.max_active_rooms;
    config.signup_rate_limit_per_email = opts.signup_rate_limit_per_email;
    config.signup_rate_limit_per_ip = opts.signup_rate_limit_per_ip;
    config.dev = opts.dev;
    config.password_reset_enabled = opts.password_reset_enabled;
    config.login_ip_max_attempts = opts.login_ip_max_attempts;
    config.login_account_max_failures = opts.login_account_max_failures;
    if let Some(url) = opts.sidecar_url {
        config.sidecar_url = url;
    }

    let pool = init_pool(&db_url).await.unwrap();
    let mailer: Arc<dyn Mailer> = Arc::new(DevMailer::new(&config.dev_mail_dir).await.unwrap());
    let blob_dir = tempfile::tempdir().unwrap();
    let blob: Arc<dyn BlobStore> = match opts.blob {
        Some(b) => b,
        None => Arc::new(DevBlobStore::new(blob_dir.path()).await.unwrap()),
    };
    let shutdown = CancellationToken::new();

    let ws_join_rate_limits = std::sync::Arc::new(DashMap::new());
    let sweeper_shutdown = shutdown.clone();
    let sweeper_map = std::sync::Arc::clone(&ws_join_rate_limits);
    let ws_join_rate_sweeper = tokio::spawn(async move {
        sweeper_shutdown.cancelled().await;
        drop(sweeper_map);
    });
    let sidecar = Arc::new(SidecarClient::new(
        config.sidecar_url.clone(),
        config.sidecar_secret.clone(),
    ));
    let media_tokens = Arc::new(MediaTokenStore::new());

    let state = Arc::new(AppState {
        db: pool,
        config: config.clone(),
        mailer,
        blob,
        sidecar,
        media_tokens,
        omr_jobs: DashMap::new(),
        rooms: DashMap::new(),
        active_rooms: std::sync::atomic::AtomicUsize::new(0),
        shutdown: shutdown.clone(),
        ws_join_rate_limits,
        ws_join_rate_sweeper,
        turn_cred_rate_limits: std::sync::Arc::new(DashMap::new()),
        session_log_pepper: None,
    });

    let app = router(state.clone()).into_make_service_with_connect_info::<SocketAddr>();

    let (ready_tx, ready_rx) = oneshot::channel();
    let shutdown_for_task = shutdown.clone();
    let server_handle = tokio::spawn(async move {
        let _ = ready_tx.send(());
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                shutdown_for_task.cancelled().await;
            })
            .await;
    });
    let _ = ready_rx.await;

    let client = reqwest::Client::builder()
        .cookie_store(true)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();

    TestApp {
        addr,
        base_url,
        mail_dir,
        blob_dir,
        shutdown,
        server_handle: Some(server_handle),
        state,
        client,
        db_name,
        admin_url,
        db_dropped: Arc::new(AtomicBool::new(false)),
    }
}

impl TestApp {
    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path.trim_start_matches('/'))
    }

    pub async fn get_html(
        &self,
        path: &str,
        cookie: Option<&str>,
    ) -> (reqwest::StatusCode, reqwest::header::HeaderMap, String) {
        let client = reqwest::Client::builder()
            .cookie_store(false)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let mut req = client.get(self.url(path));
        if let Some(c) = cookie {
            req = req.header("cookie", format!("sb_session={c}"));
        }
        let r = req.send().await.unwrap();
        let status = r.status();
        let headers = r.headers().clone();
        let body = r.text().await.unwrap_or_default();
        (status, headers, body)
    }

    /// Cheap Argon2 params used by all test fixtures — never in production.
    pub fn cheap_params() -> Params {
        Params::new(8, 1, 1, None).expect("valid cheap params")
    }

    /// Register a teacher via POST /auth/register using cheap Argon2 params
    /// injected directly into the DB, bypassing production hash cost.
    /// Returns the session cookie value.
    pub async fn register_teacher(&self, email: &str, slug: &str, password: &str) -> String {
        let hash = hash_password_with_params(password, Self::cheap_params())
            .expect("cheap hash");
        let created = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let (tid,): (i64,) = sqlx::query_as(
            "INSERT INTO teachers (email, slug, created_at, password_hash) VALUES ($1, $2, $3, $4) RETURNING id",
        )
        .bind(email)
        .bind(slug)
        .bind(created)
        .bind(&hash)
        .fetch_one(&self.state.db)
        .await
        .expect("insert teacher");
        let cookie = singing_bridge_server::auth::issue_session_cookie(
            &self.state.db,
            tid,
            self.state.config.session_ttl_secs,
        )
        .await
        .expect("issue session");
        cookie
    }

    /// Insert a teacher row with no password_hash (NULL). Used to test the
    /// NULL-hash login branch. Returns the teacher id.
    pub async fn insert_teacher_no_password(&self, email: &str, slug: &str) -> i64 {
        let created = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let (tid,): (i64,) = sqlx::query_as(
            "INSERT INTO teachers (email, slug, created_at) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(email)
        .bind(slug)
        .bind(created)
        .fetch_one(&self.state.db)
        .await
        .expect("insert teacher no password");
        tid
    }

    /// Insert a student + session_event row directly via SQL (no WS calls).
    pub async fn make_session_event(
        &self,
        teacher_id: i64,
        email: &str,
        started_at: i64,
        ended_at: Option<i64>,
    ) -> i64 {
        // Upsert student.
        sqlx::query(
            "INSERT INTO students (teacher_id, email, first_seen_at) VALUES ($1, lower($2), $3) ON CONFLICT DO NOTHING",
        )
        .bind(teacher_id)
        .bind(email)
        .bind(started_at)
        .execute(&self.state.db)
        .await
        .expect("upsert student");
        let (student_id,): (i64,) =
            sqlx::query_as("SELECT id FROM students WHERE teacher_id = $1 AND email = lower($2)")
                .bind(teacher_id)
                .bind(email)
                .fetch_one(&self.state.db)
                .await
                .expect("select student");

        let duration = ended_at.map(|e| (e - started_at).max(0));
        let ended_reason = ended_at.map(|_| "hangup");
        let (event_id,): (i64,) = sqlx::query_as(
            "INSERT INTO session_events (teacher_id, student_id, started_at, ended_at, duration_secs, ended_reason) \
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        )
        .bind(teacher_id)
        .bind(student_id)
        .bind(started_at)
        .bind(ended_at)
        .bind(duration)
        .bind(ended_reason)
        .fetch_one(&self.state.db)
        .await
        .expect("insert session event");
        event_id
    }

    /// Legacy helper — delegates to register_teacher with a fixed password.
    /// All existing tests continue working; new tests should call register_teacher directly.
    pub async fn signup_teacher(&self, email: &str, slug: &str) -> String {
        self.register_teacher(email, slug, "test-passphrase-12").await
    }

    pub async fn signup(&self, email: &str, slug: &str) -> reqwest::Response {
        self.client
            .post(self.url("/auth/register"))
            .json(&serde_json::json!({"email": email, "slug": slug, "password": "test-passphrase-12"}))
            .send()
            .await
            .unwrap()
    }

    pub async fn latest_magic_link(&self, email: &str) -> Url {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(email.to_ascii_lowercase().as_bytes());
        let name = hex::encode(h.finalize());
        let path = self.mail_dir.path().join(format!("{name}.jsonl"));
        for _ in 0..20 {
            if path.exists() {
                let text = tokio::fs::read_to_string(&path).await.unwrap();
                let last = text.trim().lines().last().unwrap();
                #[derive(Deserialize)]
                struct Entry {
                    url: String,
                }
                let e: Entry = serde_json::from_str(last).unwrap();
                return Url::parse(&e.url).unwrap();
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        panic!("no magic link written");
    }

    pub async fn open_ws(
        &self,
        cookie: Option<&str>,
        origin: Option<&str>,
    ) -> tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    > {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let url = format!("ws://{}/ws", self.addr);
        let mut req = url.into_client_request().unwrap();
        let origin = origin
            .map(|s| s.to_string())
            .unwrap_or_else(|| self.base_url.origin().ascii_serialization());
        req.headers_mut().insert(
            reqwest::header::ORIGIN,
            origin.parse().unwrap(),
        );
        if let Some(c) = cookie {
            req.headers_mut().insert(
                reqwest::header::COOKIE,
                format!("sb_session={c}").parse().unwrap(),
            );
        }
        let (ws, _resp) = tokio_tungstenite::connect_async(req).await.unwrap();
        ws
    }

    /// Full teardown: stop the server, close the pool, and drop the per-test database.
    /// Safe to call explicitly; the Drop impl is the panic-safe fallback and skips
    /// double-cleanup when `shutdown()` has already run.
    pub async fn shutdown(mut self) {
        // Mark as done before async work so that when `self` is consumed at the
        // end of this function and Drop runs, it sees db_dropped = true and skips.
        self.db_dropped.store(true, Ordering::Release);
        self.shutdown.cancel();
        if let Some(h) = self.server_handle.take() {
            let _ = tokio::time::timeout(Duration::from_secs(3), h).await;
        }
        self.state.db.close().await;
        let admin_url = self.admin_url.clone();
        let db_name = self.db_name.clone();
        if let Ok(admin) = PgPoolOptions::new()
            .max_connections(1)
            .connect(&admin_url)
            .await
        {
            let _ = sqlx::query(&format!("DROP DATABASE \"{db_name}\" WITH (FORCE)"))
                .execute(&admin)
                .await;
            admin.close().await;
        }
    }
}

pub type Ws = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

/// A teacher with a signed-in session cookie and their room slug.
pub struct TeacherFixture {
    pub email: String,
    pub slug: String,
    pub cookie: String,
}

/// Sign up two teachers in the given app and return their fixtures.
/// Useful for cross-teacher authorization tests.
pub async fn make_two_teachers(app: &TestApp) -> (TeacherFixture, TeacherFixture) {
    let cookie_a = app.signup_teacher("teacher_a@test.com", "room-a").await;
    let cookie_b = app.signup_teacher("teacher_b@test.com", "room-b").await;
    (
        TeacherFixture {
            email: "teacher_a@test.com".into(),
            slug: "room-a".into(),
            cookie: cookie_a,
        },
        TeacherFixture {
            email: "teacher_b@test.com".into(),
            slug: "room-b".into(),
            cookie: cookie_b,
        },
    )
}

/// Seed fixture data for WS accompaniment tests.
pub struct AccompanimentFixture {
    pub asset_id: i64,
    pub variant_id: i64,
    pub wav_blob_key: String,
    pub page_blob_key: String,
}

/// Insert an accompaniment + variant into the DB and write stub blobs.
/// Returns IDs and blob keys for use in WS tests.
pub async fn seed_accompaniment_asset(app: &TestApp, teacher_id: i64) -> AccompanimentFixture {
    let wav_blob_key = format!("wav-test-{teacher_id}");
    let page_blob_key = format!("page-test-{teacher_id}");

    // Write stub blobs so the media endpoint can serve them.
    let wav_data: &'static [u8] = b"RIFF\x00\x00\x00\x00WAVEfake";
    let page_data: &'static [u8] = b"PNG_FAKE";
    app.state
        .blob
        .put(&wav_blob_key, Box::pin(std::io::Cursor::new(wav_data)))
        .await
        .expect("put wav blob");
    app.state
        .blob
        .put(&page_blob_key, Box::pin(std::io::Cursor::new(page_data)))
        .await
        .expect("put page blob");

    let page_blob_keys_json = serde_json::to_string(&[&page_blob_key]).unwrap();
    let bar_coords_json = serde_json::to_string(&serde_json::json!([
        {"bar": 1, "page": 0, "x_frac": 0.1, "y_frac": 0.2, "w_frac": 0.5, "h_frac": 0.1},
        {"bar": 2, "page": 0, "x_frac": 0.1, "y_frac": 0.4, "w_frac": 0.5, "h_frac": 0.1},
    ])).unwrap();
    let bar_timings_json = serde_json::to_string(&serde_json::json!([
        {"bar": 1, "time_s": 0.0},
        {"bar": 2, "time_s": 2.0},
    ])).unwrap();

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    let (asset_id,): (i64,) = sqlx::query_as(
        "INSERT INTO accompaniments (teacher_id, title, page_blob_keys_json, bar_coords_json, bar_timings_json, created_at)
         VALUES ($1, 'Test Asset', $2, $3, $4, $5) RETURNING id",
    )
    .bind(teacher_id)
    .bind(&page_blob_keys_json)
    .bind(&bar_coords_json)
    .bind(&bar_timings_json)
    .bind(now)
    .fetch_one(&app.state.db)
    .await
    .expect("insert accompaniment");

    let (variant_id,): (i64,) = sqlx::query_as(
        "INSERT INTO accompaniment_variants (accompaniment_id, label, wav_blob_key, tempo_pct, transpose_semitones, respect_repeats, created_at)
         VALUES ($1, 'Normal', $2, 100, 0, 0, $3) RETURNING id",
    )
    .bind(asset_id)
    .bind(&wav_blob_key)
    .bind(now)
    .fetch_one(&app.state.db)
    .await
    .expect("insert variant");

    AccompanimentFixture { asset_id, variant_id, wav_blob_key, page_blob_key }
}

/// Establish a teacher+student session. Returns (teacher_ws, student_ws, teacher_id).
pub async fn make_session(
    app: &TestApp,
    slug: &str,
    cookie: &str,
) -> (Ws, Ws) {
    let mut teacher = app.open_ws(Some(cookie), None).await;
    send_ws(&mut teacher, &serde_json::json!({"type":"lobby_watch","slug":slug})).await;
    let lobby_init = recv_json(&mut teacher).await;
    assert_eq!(lobby_init["type"], "lobby_state", "expected initial lobby_state");

    let mut student = app.open_ws(None, None).await;
    send_ws(&mut student, &serde_json::json!({
        "type":"lobby_join","slug":slug,
        "email":"s@test.example","browser":"F/1","device_class":"desktop"
    })).await;

    let update = recv_json(&mut teacher).await;
    assert_eq!(update["type"], "lobby_state", "expected lobby_state with student");
    let entry_id = update["entries"][0]["id"].as_str().unwrap().to_string();
    send_ws(&mut teacher, &serde_json::json!({"type":"lobby_admit","slug":slug,"entry_id":entry_id})).await;

    let admitted = recv_json(&mut student).await;
    assert_eq!(admitted["type"], "admitted", "expected admitted for student");
    let pc_student = recv_json(&mut student).await;
    assert_eq!(pc_student["type"], "peer_connected", "expected peer_connected for student");
    let pc_teacher = recv_json(&mut teacher).await;
    assert_eq!(pc_teacher["type"], "peer_connected", "expected peer_connected for teacher");
    let lobby_update = recv_json(&mut teacher).await;
    assert_eq!(lobby_update["type"], "lobby_state", "expected lobby_state after admit");

    (teacher, student)
}

pub async fn send_ws(ws: &mut Ws, msg: &serde_json::Value) {
    ws.send(Message::Text(msg.to_string())).await.unwrap();
}

pub async fn recv_json(ws: &mut Ws) -> serde_json::Value {
    for _ in 0..20 {
        match tokio::time::timeout(Duration::from_secs(2), ws.next()).await {
            Ok(Some(Ok(Message::Text(s)))) => return serde_json::from_str(&s).unwrap(),
            Ok(Some(Ok(Message::Ping(_)))) | Ok(Some(Ok(Message::Pong(_)))) => continue,
            Ok(Some(Ok(Message::Close(frame)))) => {
                return serde_json::json!({
                    "__close_code": frame.as_ref().map(|f| f.code.into()).unwrap_or(0u16),
                    "__close_reason": frame.map(|f| f.reason.to_string()).unwrap_or_default(),
                });
            }
            Ok(Some(Ok(_))) => continue,
            Ok(Some(Err(e))) => panic!("ws error: {e}"),
            Ok(None) => panic!("ws closed unexpectedly"),
            Err(_) => panic!("recv_json timeout"),
        }
    }
    panic!("recv_json: no content");
}
