use anyhow::Result;
use sent_core::{config::Config, db, ingest::NormalizedMessage, repository::Repository};
use serde_json::json;
use uuid::Uuid;

#[tokio::test]
async fn ingest_and_repository_ports() -> Result<()> {
    let Ok(url) = std::env::var("SENT_TEST_DATABASE_URL") else {
        return Ok(());
    };
    anyhow::ensure!(
        reqwest::Url::parse(&url)?.path().starts_with("/sent_test_"),
        "Use an isolated database named sent_test_*"
    );
    let pool = db::pool(&url, true).await?;
    db::migrate(&pool, &Config::from_env()?.migrations_path).await?;
    let repo = Repository(pool);
    let email = format!("{}@example.test", Uuid::new_v4());
    let account = repo.upsert_account("gmail", &email, "Name", "fake").await?;
    assert_eq!(
        repo.upsert_account("gmail", &email, "Updated", "fake")
            .await?,
        account
    );
    assert_eq!(
        repo.get_stored_account(account)
            .await?
            .unwrap()
            .display_name,
        "Updated"
    );
    repo.update_credentials(account, "replacement").await?;
    assert_eq!(
        repo.get_stored_account(account)
            .await?
            .unwrap()
            .encrypted_credentials,
        "replacement"
    );
    assert!(
        repo.list_stored_accounts()
            .await?
            .iter()
            .any(|a| a.id == account)
    );
    assert_eq!(repo.get_sync_cursor(account).await?, (None, false));
    repo.finish_sync(account, Some("cursor"), true).await?;
    assert_eq!(
        repo.get_sync_cursor(account).await?,
        (Some("cursor".into()), true)
    );
    let mut message: NormalizedMessage = serde_json::from_value(
        json!({"providerMessageId":"message","providerThreadId":"thread","internetMessageId":null,"subject":"Project","from":[{"address":"sender@example.test"}],"to":[],"cc":[],"bcc":[],"sentAt":null,"receivedAt":"2025-01-01T00:00:00Z","snippet":"Project","textBody":"Project body","htmlBody":null,"headers":{},"attachments":[],"direction":"inbound","read":false,"flagged":false,"archived":false,"deleted":false,"nativeState":{},"providerUpdatedAt":null,"containers":[{"id":"INBOX","name":"Inbox","kind":"label"}]}),
    )?;
    let (id, changed) = repo.upsert_message(account, &message).await?;
    assert!(changed);
    assert_eq!(repo.upsert_message(account, &message).await?, (id, false));
    message.text_body = "Updated body".into();
    message.containers.clear();
    assert_eq!(repo.upsert_message(account, &message).await?, (id, true));
    assert_eq!(
        repo.get_provider_message_reference(id).await?,
        Some(("message".into(), account))
    );
    assert_eq!(
        repo.get_analysis_message(id).await?.unwrap()["textBody"],
        "Updated body"
    );
    assert_eq!(repo.newest_unclassified(10, Some(&email)).await?, vec![id]);
    assert_eq!(repo.newest_inbound(10, Some(&email)).await?, vec![id]);
    assert!(
        repo.newest_inbound(10, Some("missing@example.test"))
            .await?
            .is_empty()
    );
    assert!(repo.unembedded(100, None).await?.contains(&id));
    repo.save_classification_failure(id, "failure").await?;
    repo.save_classification_failure(id, "again").await?;
    repo.save_embedding(id, &vec![0.1; 3072], "fixture", "hash")
        .await?;
    assert!(!repo.unembedded(100, None).await?.contains(&id));
    repo.tombstone_messages(account, &[]).await?;
    repo.tombstone_messages(account, &["message".into()])
        .await?;
    assert!(repo.get_message(id).await?.is_none());
    assert!(repo.get_analysis_message(id).await?.is_none());
    assert!(repo.get_stored_account(Uuid::new_v4()).await?.is_none());
    assert!(
        repo.get_provider_message_reference(Uuid::new_v4())
            .await?
            .is_none()
    );
    assert!(repo.upsert_message(Uuid::new_v4(), &message).await.is_err());
    sqlx::query("delete from accounts where id=$1")
        .bind(account)
        .execute(&repo.0)
        .await?;
    repo.0.close().await;
    Ok(())
}
