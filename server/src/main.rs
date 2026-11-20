use anyhow::Result;
use axum::serve::{ListenerExt, TapIo};
use sent_core::{config::Config, db, repository::Repository};
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};

mod app;
mod auth;
mod sync;
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
    let listener = bind_listener(&address).await?;
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

async fn bind_listener(address: &str) -> Result<TapIo<TcpListener, fn(&mut TcpStream)>> {
    Ok(TcpListener::bind(address)
        .await?
        .tap_io(configure_http_connection as fn(&mut TcpStream)))
}

fn configure_http_connection(stream: &mut TcpStream) {
    if let Err(error) = stream.set_nodelay(true) {
        eprintln!("Failed to set TCP_NODELAY on HTTP connection: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::serve::Listener;

    #[tokio::test]
    async fn every_accepted_http_connection_disables_nagle() {
        let mut listener = bind_listener("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        for _ in 0..2 {
            let _client = TcpStream::connect(address).await.unwrap();
            let (stream, _) = listener.accept().await;
            assert!(stream.nodelay().unwrap());
        }
    }

    #[tokio::test]
    async fn invalid_and_unavailable_bind_addresses_return_errors() {
        assert!(bind_listener("").await.is_err());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        assert!(
            bind_listener(&listener.local_addr().unwrap().to_string())
                .await
                .is_err()
        );
    }
}
