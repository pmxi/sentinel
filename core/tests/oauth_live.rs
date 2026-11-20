use anyhow::Result;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use sent_core::db::Uuid;
use sent_core::{
    config::Config,
    db,
    providers::{Endpoints, Providers},
};
use serde_json::json;
use sqlx::Row;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{body_string_contains, method, path},
};

#[tokio::test]
async fn oauth_account_and_cursor_commit_before_notification_and_rollback_together() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let pool = db::pool(
        directory.path().join("oauth.sqlite").to_str().unwrap(),
        true,
    )
    .await?;
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
    let mut listener = pool.acquire().await?;
    let mut version: i64 = sqlx::query_scalar("pragma data_version")
        .fetch_one(&mut *listener)
        .await?;
    for _ in 0..2 {
        providers.exchange_code("microsoft", "accepted").await?;
        let current: i64 = sqlx::query_scalar("pragma data_version")
            .fetch_one(&mut *listener)
            .await?;
        let row = sqlx::query("select a.id,a.display_name,exists(select 1 from sync_cursors c where c.account_id=a.id) has_cursor from accounts a where a.provider='microsoft' and a.email=?1").bind(&email).fetch_one(&pool).await?;
        assert_eq!(row.get::<String, _>("display_name"), "Connected account");
        assert!(row.get::<bool, _>("has_cursor"));
        assert_ne!(current, version);
        version = current;
    }
    assert!(
        providers
            .exchange_code("microsoft", "rejected")
            .await
            .is_err()
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("pragma data_version")
            .fetch_one(&mut *listener)
            .await?,
        version
    );
    sqlx::query("create trigger fail_cursor before insert on sync_cursors begin select raise(abort,'fixture failure'); end").execute(&pool).await?;
    sqlx::query("update accounts set display_name='Before failed connect' where email=?1")
        .bind(&email)
        .execute(&pool)
        .await?;
    version = sqlx::query_scalar("pragma data_version")
        .fetch_one(&mut *listener)
        .await?;
    let failing = Providers::with_endpoints(config, pool.clone(), endpoints);
    assert!(
        failing
            .exchange_code("microsoft", "accepted")
            .await
            .is_err()
    );
    let name: String = sqlx::query_scalar("select display_name from accounts where email=?1")
        .bind(&email)
        .fetch_one(&pool)
        .await?;
    assert_eq!(name, "Before failed connect");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("pragma data_version")
            .fetch_one(&mut *listener)
            .await?,
        version
    );
    sqlx::query("delete from accounts where email=?1")
        .bind(&email)
        .execute(&pool)
        .await?;
    Ok(())
}
