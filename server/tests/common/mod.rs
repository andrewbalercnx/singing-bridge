// File: server/tests/common/mod.rs
// Purpose: Shared test harness — spawn_app, dev-mail reader, WS client.
// Role: Keep integration-test bodies short and behaviour-focused.
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

#![allow(dead_code)]

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use singing_bridge_server::{
    auth::mailer::{DevMailer, Mailer},
    config::Config,
    db::init_pool,
    http::router,
    state::AppState,
};
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
    pub shutdown: CancellationToken,
    pub server_handle: tokio::task::JoinHandle<()>,
    pub state: Arc<AppState>,
    pub client: reqwest::Client,
}

pub struct TestOpts {
    pub lobby_cap_per_room: usize,
    pub max_active_rooms: usize,
    pub signup_rate_limit_per_email: usize,
    pub signup_rate_limit_per_ip: usize,
}

impl Default for TestOpts {
    fn default() -> Self {
        Self {
            lobby_cap_per_room: 32,
            max_active_rooms: 1024,
            signup_rate_limit_per_email: 999_999,
            signup_rate_limit_per_ip: 999_999,
        }
    }
}

pub async fn spawn_app() -> TestApp {
    spawn_app_with(TestOpts::default()).await
}

pub async fn spawn_app_with(opts: TestOpts) -> TestApp {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let base_url = Url::parse(&format!("http://{addr}")).unwrap();
    let mail_dir = tempfile::tempdir().unwrap();

    let mut config = Config::dev_default();
    config.bind = addr;
    config.base_url = base_url.clone();
    config.db_url = "sqlite::memory:".into();
    config.dev_mail_dir = mail_dir.path().to_path_buf();
    config.static_dir = std::env::current_dir()
        .unwrap()
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("web");
    // Also try sibling workspace root web/ if running from server/.
    if !config.static_dir.join("teacher.html").exists() {
        config.static_dir = std::env::current_dir().unwrap().join("web");
    }
    // Fall back further: search upward for `web/teacher.html`.
    let mut probe = std::env::current_dir().unwrap();
    while !probe.join("web").join("teacher.html").exists() {
        if !probe.pop() {
            break;
        }
    }
    if probe.join("web").join("teacher.html").exists() {
        config.static_dir = probe.join("web");
    }

    config.lobby_cap_per_room = opts.lobby_cap_per_room;
    config.max_active_rooms = opts.max_active_rooms;
    config.signup_rate_limit_per_email = opts.signup_rate_limit_per_email;
    config.signup_rate_limit_per_ip = opts.signup_rate_limit_per_ip;

    let pool = init_pool(&config.db_url).await.unwrap();
    let mailer: Arc<dyn Mailer> = Arc::new(DevMailer::new(&config.dev_mail_dir).unwrap());
    let shutdown = CancellationToken::new();

    let state = Arc::new(AppState {
        db: pool,
        config: config.clone(),
        mailer,
        rooms: DashMap::new(),
        shutdown: shutdown.clone(),
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
        shutdown,
        server_handle,
        state,
        client,
    }
}

impl TestApp {
    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path.trim_start_matches('/'))
    }

    pub async fn signup(&self, email: &str, slug: &str) -> reqwest::Response {
        self.client
            .post(self.url("/signup"))
            .json(&serde_json::json!({"email": email, "slug": slug}))
            .send()
            .await
            .unwrap()
    }

    /// End-to-end teacher signup: POST /signup, read the magic link from the
    /// dev mail sink, POST /auth/consume, return the session cookie value.
    pub async fn signup_teacher(&self, email: &str, slug: &str) -> String {
        let r = self.signup(email, slug).await;
        assert!(
            r.status().is_success(),
            "signup failed: {} {}",
            r.status(),
            r.text().await.unwrap_or_default()
        );
        let url = self.latest_magic_link(email).await;
        let token = url.fragment().unwrap().strip_prefix("token=").unwrap().to_string();
        let r = self
            .client
            .post(self.url("/auth/consume"))
            .json(&serde_json::json!({"token": token}))
            .send()
            .await
            .unwrap();
        assert!(r.status().is_success(), "consume failed: {}", r.status());
        let set_cookie = r
            .headers()
            .get(reqwest::header::SET_COOKIE)
            .expect("Set-Cookie")
            .to_str()
            .unwrap()
            .to_string();
        let cookie_value = set_cookie
            .split(';')
            .next()
            .unwrap()
            .trim()
            .strip_prefix("sb_session=")
            .unwrap()
            .to_string();
        cookie_value
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

    pub async fn shutdown(self) {
        self.shutdown.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(3), self.server_handle).await;
    }
}

pub type Ws = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

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
