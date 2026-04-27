// File: server/src/main.rs
// Purpose: Binary entry — wire up Config, DB pool, AppState, router, shutdown.
// Role: Production binary.
// Exports: main
// Depends: axum, tokio, tracing_subscriber
// Invariants: binds ConnectInfo so /ws upgrade can read the peer IP.
//             Selects mailer based on MailerKind. Spawns WS join rate sweeper
//             and aborts it on shutdown. AppState.ws_join_rate_sweeper is
//             always a valid JoinHandle for the life of the process.
// Last updated: Sprint 22 (2026-04-26) -- select AzureBlobStore vs DevBlobStore at startup

use std::{net::SocketAddr, sync::Arc};

use dashmap::DashMap;
use tokio_util::sync::CancellationToken;

use singing_bridge_server::{
    auth::mailer::{AcsMailer, DevMailer, Mailer},
    blob::{AzureBlobStore, BlobStore, DevBlobStore},
    cleanup::cleanup_loop,
    config::{Config, MailerKind},
    db::{init_pool, run_migrations},
    http::{media_token::MediaTokenStore, router},
    sidecar::SidecarClient,
    state::AppState,
    ws::rate_limit::sweep_stale,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,singing_bridge_server=debug".into()),
        )
        .init();

    let config = Config::from_env().map_err(|e| anyhow::anyhow!("config error: {e}"))?;

    let mailer: Arc<dyn Mailer> = match config.mailer_kind {
        MailerKind::Dev => {
            tokio::fs::create_dir_all(&config.dev_mail_dir).await.ok();
            Arc::new(DevMailer::new(&config.dev_mail_dir).await?)
        }
        MailerKind::Acs => {
            let conn = config
                .acs_connection_string
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("missing SB_ACS_CONNECTION_STRING"))?;
            Arc::new(
                AcsMailer::from_connection_string(conn.expose())
                    .map_err(|e| anyhow::anyhow!("ACS mailer init: {e}"))?,
            )
        }
    };

    if let Some(ref migrate_url) = config.migrate_url {
        tracing::info!("running database migrations");
        run_migrations(migrate_url).await
            .map_err(|e| anyhow::anyhow!("migration failed: {e}"))?;
        tracing::info!("migrations complete");
    }

    let pool = init_pool(&config.db_url).await?;
    let shutdown = CancellationToken::new();

    let blob: Arc<dyn BlobStore> = match &config.azure_storage_connection_string {
        Some(conn) => {
            let container = config.azure_storage_container.as_deref()
                .expect("azure_storage_container set when connection_string is set");
            let ttl = std::time::Duration::from_secs(config.media_token_ttl_secs);
            tracing::info!(container, "using Azure Blob Storage");
            Arc::new(
                AzureBlobStore::new(conn.expose(), container, ttl)
                    .map_err(|e| anyhow::anyhow!("Azure blob store init: {e}"))?,
            )
        }
        None => {
            tokio::fs::create_dir_all(&config.dev_blob_dir).await.ok();
            tracing::info!(dir = %config.dev_blob_dir.display(), "using DevBlobStore");
            Arc::new(
                DevBlobStore::new(&config.dev_blob_dir)
                    .await
                    .map_err(|e| anyhow::anyhow!("blob store init: {e}"))?,
            )
        }
    };

    // Spawn cleanup loop.
    let cleanup_blob = Arc::clone(&blob);
    let cleanup_db = pool.clone();
    let cleanup_shutdown = shutdown.clone();
    tokio::spawn(async move {
        cleanup_loop(cleanup_db, cleanup_blob, config.gate_rate_limit_window_secs, cleanup_shutdown).await;
    });

    let session_log_pepper = config.session_log_pepper.clone();

    // Spawn the WS join rate-limit sweeper. Use Arc<DashMap> so the sweeper
    // and AppState share the same underlying map without deep-copying.
    let ws_join_rate_limits: Arc<DashMap<_, _>> = Arc::new(DashMap::new());
    let sweeper_map = Arc::clone(&ws_join_rate_limits);
    let sweeper_shutdown = shutdown.clone();
    let sweep_window = config.ws_join_rate_limit_window_secs;
    let ws_join_rate_sweeper = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = sweeper_shutdown.cancelled() => break,
                _ = tokio::time::sleep(std::time::Duration::from_secs(60)) => {
                    let now = time::OffsetDateTime::now_utc().unix_timestamp();
                    sweep_stale(&sweeper_map, now, sweep_window);
                }
            }
        }
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
        turn_cred_rate_limits: Arc::new(DashMap::new()),
        session_log_pepper,
        active_bots: Arc::new(DashMap::new()),
        #[cfg(debug_assertions)]
        token_store: Arc::new(singing_bridge_server::http::test_peer::TokenStore::new()),
    });

    // Sweep OMR jobs that have been sitting for > 10 minutes (Done/Failed and
    // never polled, or Running tasks that hung).
    let jobs_state = Arc::clone(&state);
    let jobs_shutdown = shutdown.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = jobs_shutdown.cancelled() => break,
                _ = tokio::time::sleep(std::time::Duration::from_secs(600)) => {
                    let cutoff = std::time::Instant::now()
                        - std::time::Duration::from_secs(600);
                    jobs_state.omr_jobs.retain(|_, job| job.created_at > cutoff);
                }
            }
        }
    });

    let app = router(state.clone()).into_make_service_with_connect_info::<SocketAddr>();

    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    tracing::info!(addr = %config.bind, "listening");

    let shutdown_token = shutdown.clone();
    let shutdown_signal = async move {
        let _ = tokio::signal::ctrl_c().await;
        shutdown_token.cancel();
    };

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal)
        .await?;

    // Abort the sweeper after server stops accepting connections.
    state.ws_join_rate_sweeper.abort();

    Ok(())
}
