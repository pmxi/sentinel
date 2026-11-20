use anyhow::Result;
use sent_core::{config::Config, db, repository::Repository};
use std::sync::Arc;

mod app;
mod auth;
mod validation;

#[tokio::main]
async fn main() -> Result<()> {
    let config = Config::from_env()?;
    Config::required(&config.password_hash, "SENT_PASSWORD_HASH")?;
    let secret = Config::required(&config.session_secret, "SESSION_SECRET")?;
    anyhow::ensure!(
        secret.len() >= 32,
        "SESSION_SECRET must contain at least 32 characters"
    );
    let pool = db::pool(&config.database_url, config.node_env == "test").await?;
    db::migrate(&pool, &config.migrations_path).await?;
    let address = format!("{}:{}", config.host, config.port);
    let listener = tokio::net::TcpListener::bind(&address).await?;
    let state = Arc::new(app::State::new(config, Repository(pool)));
    println!("Sent Rust API listening on {address}");
    axum::serve(
        listener,
        app::router(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        tokio::signal::ctrl_c().await.ok();
    })
    .await?;
    Ok(())
}
