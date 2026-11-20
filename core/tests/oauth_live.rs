use anyhow::Result;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use sent_core::{
    config::Config,
    db,
    live::CHANNEL,
    providers::{Endpoints, Providers},
};
use serde_json::json;
use sqlx::{
    Row,
    postgres::{PgListener, PgPoolOptions},
};
use std::time::Duration;
use uuid::Uuid;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{body_string_contains, method, path},
};

#[tokio::test]
async fn oauth_account_and_cursor_commit_before_notification_and_rollback_together() -> Result<()> {
    let Ok(url) = std::env::var("SENT_TEST_DATABASE_URL") else {
        return Ok(());
    };
    anyhow::ensure!(reqwest::Url::parse(&url)?.path().starts_with("/sent_test_"));
    let pool = db::pool(&url, true).await?;
    db::migrate(
        &pool,
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../migrations"),
    )
    .await?;
    let mock = MockServer::start().await;
    let email = format!("oauth-{}@example.test", Uuid::new_v4());
    let identity = URL_SAFE_NO_PAD.encode(
        json!({"preferred_username":email,"name":"Connected account","tid":"realm","oid":"owner"})
            .to_string(),
    );
    let client_info = URL_SAFE_NO_PAD.encode(json!({"uid":"owner","utid":"realm"}).to_string());
    Mock::given(method("POST")).and(path("/token")).and(body_string_contains("code=accepted"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"id_token":format!("e30.{identity}.signature"),"client_info":client_info,"access_token":"mock-access","refresh_token":"mock-refresh","expires_in":3600}))).mount(&mock).await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .and(body_string_contains("code=rejected"))
        .respond_with(ResponseTemplate::new(400))
        .mount(&mock)
        .await;
    let mut config = Config::from_env()?;
    config.fake_providers = false;
    config.token_encryption_key = Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".into());
    config.microsoft_client_id = Some("mock-client".into());
    config.microsoft_client_secret = Some("mock-secret".into());
    let endpoints = Endpoints {
        gmail: mock.uri(),
        graph: mock.uri(),
        google_token: format!("{}/token", mock.uri()),
        microsoft_token: format!("{}/token", mock.uri()),
    };
    let providers = Providers::with_endpoints(config.clone(), pool.clone(), endpoints.clone());
    let mut listener = PgListener::connect_with(&pool).await?;
    listener.listen(CHANNEL).await?;
    for _ in 0..2 {
        providers.exchange_code("microsoft", "accepted").await?;
        let notification = tokio::time::timeout(Duration::from_secs(2), listener.recv()).await;
        let row = sqlx::query("select a.id,a.display_name,exists(select 1 from sync_cursors c where c.account_id=a.id) has_cursor from accounts a where a.provider='microsoft' and a.email=$1").bind(&email).fetch_one(&pool).await?;
        assert_eq!(row.get::<String, _>("display_name"), "Connected account");
        assert!(row.get::<bool, _>("has_cursor"));
        if notification.is_err() {
            sqlx::query("delete from accounts where email=$1")
                .bind(&email)
                .execute(&pool)
                .await?;
        }
        assert_eq!(notification??.payload(), "changed");
    }
    assert!(
        providers
            .exchange_code("microsoft", "rejected")
            .await
            .is_err()
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.recv())
            .await
            .is_err()
    );
    let schema = format!("oauth_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("create schema {schema}"))
        .execute(&pool)
        .await?;
    sqlx::query(&format!(
        "create table {schema}.sync_cursors(account_id uuid primary key check(false))"
    ))
    .execute(&pool)
    .await?;
    sqlx::query("update accounts set display_name='Before failed connect' where email=$1")
        .bind(&email)
        .execute(&pool)
        .await?;
    let search_path = schema.clone();
    let failing_pool = PgPoolOptions::new()
        .max_connections(1)
        .after_connect(move |connection, _| {
            let statement = format!("set search_path to {search_path},public");
            Box::pin(async move {
                sqlx::query(&statement).execute(connection).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await?;
    let failing = Providers::with_endpoints(config, failing_pool.clone(), endpoints);
    assert!(
        failing
            .exchange_code("microsoft", "accepted")
            .await
            .is_err()
    );
    failing_pool.close().await;
    let name: String = sqlx::query_scalar("select display_name from accounts where email=$1")
        .bind(&email)
        .fetch_one(&pool)
        .await?;
    assert_eq!(name, "Before failed connect");
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.recv())
            .await
            .is_err()
    );
    sqlx::query(&format!("drop schema {schema} cascade"))
        .execute(&pool)
        .await?;
    sqlx::query("delete from accounts where email=$1")
        .bind(&email)
        .execute(&pool)
        .await?;
    Ok(())
}
