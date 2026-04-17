// File: server/src/main.rs
// Purpose: Binary entry — wire up Config, DB pool, AppState, router, shutdown.
// Role: Production binary.
// Exports: main
// Depends: axum, tokio, tracing_subscriber
// Invariants: binds ConnectInfo so /ws upgrade can read the peer IP.
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

use std::{net::SocketAddr, sync::Arc};

use dashmap::DashMap;
use tokio_util::sync::CancellationToken;

use singing_bridge_server::{
    auth::mailer::DevMailer,
    config::Config,
    db::init_pool,
    http::router,
    state::AppState,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,singing_bridge_server=debug".into()),
        )
        .init();

    let config = Config::dev_default();
    tokio::fs::create_dir_all(&config.dev_mail_dir).await.ok();
    let mailer = Arc::new(DevMailer::new(&config.dev_mail_dir)?);

    let pool = init_pool(&config.db_url).await?;

    let state = Arc::new(AppState {
        db: pool,
        config: config.clone(),
        mailer,
        rooms: DashMap::new(),
        active_rooms: std::sync::atomic::AtomicUsize::new(0),
        shutdown: CancellationToken::new(),
    });

    let app = router(state.clone()).into_make_service_with_connect_info::<SocketAddr>();

    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    tracing::info!(addr = %config.bind, "listening");

    let shutdown_token = state.shutdown.clone();
    let shutdown_signal = async move {
        let _ = tokio::signal::ctrl_c().await;
        shutdown_token.cancel();
    };

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal)
        .await?;

    Ok(())
}
