use anyhow::Result;
use sent_core::{
    db,
    live::{notify_changed, notify_logout},
};

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
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("live.sqlite");
    let pool = db::pool(path.to_str().unwrap(), true).await?;
    db::migrate(
        &pool,
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../migrations"),
    )
    .await?;
    let observer = db::read_only_pool(&path).await?;
    let mut listener = observer.acquire().await?;
    let initial: i64 = sqlx::query_scalar("pragma data_version")
        .fetch_one(&mut *listener)
        .await?;
    let mut tx = pool.begin().await?;
    notify_changed(&mut *tx).await?;
    notify_changed(&mut *tx).await?;
    let during: i64 = sqlx::query_scalar("pragma data_version")
        .fetch_one(&mut *listener)
        .await?;
    assert_eq!(initial, during);
    tx.commit().await?;
    let committed: i64 = sqlx::query_scalar("pragma data_version")
        .fetch_one(&mut *listener)
        .await?;
    assert_ne!(initial, committed);
    let mut tx = pool.begin().await?;
    notify_changed(&mut *tx).await?;
    tx.rollback().await?;
    let rolled_back: i64 = sqlx::query_scalar("pragma data_version")
        .fetch_one(&mut *listener)
        .await?;
    assert_eq!(committed, rolled_back);
    notify_logout(
        &pool,
        "opaque-session-id",
        chrono::Utc::now().timestamp() + 60,
    )
    .await?;
    let key: String = sqlx::query_scalar("select session from sent_live_revocations")
        .fetch_one(&mut *listener)
        .await?;
    assert_eq!(key, "opaque-session-id");
    let revoked: i64 = sqlx::query_scalar("pragma data_version")
        .fetch_one(&mut *listener)
        .await?;
    assert_ne!(revoked, committed);
    Ok(())
}
