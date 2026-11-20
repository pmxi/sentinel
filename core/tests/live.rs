use anyhow::Result;
use sent_core::{
    db,
    live::{CHANNEL, notify_changed, notify_logout},
};
use sqlx::postgres::PgListener;
use std::time::Duration;

#[tokio::test]
async fn durable_revocations_are_scoped_and_expire_without_affecting_worker_health() -> Result<()> {
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
    let session = uuid::Uuid::new_v4().to_string();
    let expired = uuid::Uuid::new_v4().to_string();
    let health = sent_core::repository::Repository(pool.clone())
        .health()
        .await?;
    assert!(!sent_core::live::session_revoked(&pool, "").await?);
    assert!(!sent_core::live::session_revoked(&pool, &session).await?);
    sent_core::live::revoke_session(&pool, &expired, chrono::Utc::now().timestamp() - 60).await?;
    assert!(!sent_core::live::session_revoked(&pool, &expired).await?);
    sent_core::live::revoke_session(&pool, &session, chrono::Utc::now().timestamp() + 60).await?;
    assert!(sent_core::live::session_revoked(&pool, &session).await?);
    assert!(!sent_core::live::session_revoked(&pool, &expired).await?);
    assert_eq!(
        sent_core::repository::Repository(pool.clone())
            .health()
            .await?["workerHeartbeat"],
        health["workerHeartbeat"]
    );
    let expired_rows: i64 = sqlx::query_scalar("select count(*) from worker_state where name=$1")
        .bind(format!("session-revoked:{expired}"))
        .fetch_one(&pool)
        .await?;
    assert_eq!(expired_rows, 0);
    sqlx::query("delete from worker_state where name=$1")
        .bind(format!("session-revoked:{session}"))
        .execute(&pool)
        .await?;
    Ok(())
}

#[tokio::test]
async fn notifications_follow_commit_and_rollback_and_never_contain_credentials() -> Result<()> {
    let Ok(url) = std::env::var("SENT_TEST_DATABASE_URL") else {
        return Ok(());
    };
    anyhow::ensure!(
        reqwest::Url::parse(&url)?.path().starts_with("/sent_test_"),
        "Use an isolated database named sent_test_*"
    );
    let pool = db::pool(&url, true).await?;
    let mut listener = PgListener::connect_with(&pool).await?;
    listener.listen(CHANNEL).await?;
    let mut tx = pool.begin().await?;
    notify_changed(&mut *tx).await?;
    notify_changed(&mut *tx).await?;
    assert!(
        tokio::time::timeout(Duration::from_millis(25), listener.recv())
            .await
            .is_err()
    );
    tx.commit().await?;
    let notification = tokio::time::timeout(Duration::from_secs(2), listener.recv()).await??;
    assert_eq!(notification.payload(), "changed");
    assert!(
        tokio::time::timeout(Duration::from_millis(25), listener.recv())
            .await
            .is_err()
    );
    let mut tx = pool.begin().await?;
    notify_changed(&mut *tx).await?;
    tx.rollback().await?;
    assert!(
        tokio::time::timeout(Duration::from_millis(25), listener.recv())
            .await
            .is_err()
    );
    notify_logout(&pool, "opaque-session-id", 123).await?;
    let notification = tokio::time::timeout(Duration::from_secs(2), listener.recv()).await??;
    let value: serde_json::Value = serde_json::from_str(notification.payload())?;
    assert_eq!(
        value,
        serde_json::json!({"logout":"opaque-session-id","expires":123})
    );
    Ok(())
}
